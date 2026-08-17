//! The tool-deciding loop: approve, dispatch, settle, budget.

use super::context_budget::fit_prompt_to_window;
use super::coverage::{push_unique, CoverageAcc};
use super::playlist::{handle_empty_tool_turn, playlist_preflight, LoopControl, PlaylistLoopState};
use super::session::ChatSession;
use super::settlement::{
    emit_tool_call, emit_tool_result, playlist_failure_reason, settle_skipped, settlement_for,
    RefusedCall, SkippedCall, ToolSettlement,
};
use super::usage::EmissionGuard;
use super::PARTIAL_RUN_CANCELLED;
use crate::ai::approval::{self, ApprovalContext, ApprovalDecision, ApprovalGate, ApprovedCall};
use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{Completion, LlmMessage, LlmRequest, ToolCall};
use crate::ai::plan::RunPlan;
use crate::ai::skills::ActiveSkills;
use crate::ai::tools::{self, dispatch, ToolOutcome};
use crate::ai::write_policy::WriteSession;
use crate::ai::youtube::YoutubeToolSession;
use crate::error::CoreResult;
use std::time::Duration;

pub(super) enum EvidenceCollection {
    Answer { guard_tripped: bool },
    CompleteTurn,
}

#[derive(Default)]
struct ToolBatchControl {
    budget_hit: bool,
    complete_turn: bool,
    cancelled: bool,
}

impl ChatSession<'_> {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn collect_evidence(
        &self,
        messages: &mut Vec<LlmMessage>,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        plan: &mut RunPlan,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        gate: &mut ApprovalGate,
        sink: &mut dyn EventSink,
    ) -> CoreResult<EvidenceCollection> {
        let mut consumed = 0usize;
        let mut playlist = PlaylistLoopState::default();
        loop {
            match playlist_preflight(messages, youtube_session, sink, &mut playlist) {
                LoopControl::Proceed => {}
                LoopControl::Continue => continue,
                LoopControl::Return(guard_tripped) => {
                    return Ok(EvidenceCollection::Answer { guard_tripped });
                }
            }
            if iteration_guard_reached(youtube_session, active_skills, consumed) {
                // Out of turns while the previous turn still issued tool calls — the
                // model was mid-work, so coverage is partial, not complete.
                return Ok(EvidenceCollection::Answer {
                    guard_tripped: true,
                });
            }
            let tools = tools::tool_schemas(&active_skills.authorized_tools());
            // Freeze authorization for the whole model turn. If one parallel batch
            // calls `use_skill` then `write_note`, the write was not advertised in
            // this request and cannot consume the newly granted capability early.
            let authorized_tools = tools::advertised_tool_names(&tools);
            // Budget the fully assembled prompt to the model's context window before
            // send, so a dense-script vault can't push the grounding out of a small
            // local window (see `fit_prompt_to_window`). Only the request is trimmed;
            // the persistent `messages` accumulator is left intact for the loop.
            let budgeted =
                fit_prompt_to_window(messages, self.model, self.llm.context_window_tokens());
            coverage.truncated |= budgeted.lost;
            // This tool-DECIDING turn is idempotent (no tool has run yet), so a single
            // transient transport failure is retried once rather than aborting the run.
            let completion = self
                .complete_tool_turn(&self.request(&budgeted.messages, &tools), sink)
                .await?;
            consumed += 1;
            if completion.tool_calls.is_empty() {
                match handle_empty_tool_turn(messages, youtube_session, sink, &mut playlist) {
                    LoopControl::Continue => continue,
                    LoopControl::Return(guard_tripped) => {
                        return Ok(EvidenceCollection::Answer { guard_tripped });
                    }
                    LoopControl::Proceed => unreachable!("empty tool turn always resolves"),
                }
            }

            // The protocol requires the assistant's tool-call turn before its results,
            // and exactly one result per declared call.
            messages.push(LlmMessage::assistant_tool_calls(
                completion.tool_calls.clone(),
            ));
            let control = self
                .handle_tool_calls(
                    &completion.tool_calls,
                    messages,
                    active_skills,
                    writes,
                    youtube_session,
                    plan,
                    &authorized_tools,
                    registry,
                    coverage,
                    gate,
                    sink,
                    &mut playlist.context_chars,
                )
                .await;
            playlist.sync(messages, youtube_session, sink);
            if let Some(outcome) = collection_after_tool_batch(&control, youtube_session) {
                return Ok(outcome);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_tool_calls(
        &self,
        calls: &[ToolCall],
        messages: &mut Vec<LlmMessage>,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        plan: &mut RunPlan,
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        gate: &mut ApprovalGate,
        sink: &mut dyn EventSink,
        context_chars: &mut usize,
    ) -> ToolBatchControl {
        let mut control = ToolBatchControl::default();
        let mut playlist_cancelled = false;
        let batch_playlist_item = youtube_session
            .playlist_current()
            .map(|(index, _, _)| index);
        let mut playlist_batch_closed = false;
        for call in calls {
            // Announce the call BEFORE anything can go wrong with it, so one that
            // is skipped, cancelled, rejected or fails still reaches the timeline
            // instead of vanishing. Every branch below settles it exactly once.
            // This is also where the step affiliation is stamped — the plan as it
            // stands at THIS call's dispatch, not as it ends up.
            emit_tool_call(sink, call, plan);
            if playlist_batch_closed {
                settle_skipped(messages, sink, call, SkippedCall::StalePlaylistBatch);
                continue;
            }
            if !playlist_cancelled
                && youtube_session.playlist_is_active()
                && youtube_session.cancellation().is_cancelled()
            {
                youtube_session.cancel_playlist_remaining();
                playlist_cancelled = true;
                if !control.cancelled {
                    control.cancelled = true;
                    sink.send(ChatEvent::PartialRun {
                        reason: PARTIAL_RUN_CANCELLED.to_string(),
                    });
                }
            }
            if playlist_cancelled {
                settle_skipped(messages, sink, call, SkippedCall::PlaylistCancelled);
                continue;
            }
            if control.budget_hit {
                settle_skipped(messages, sink, call, SkippedCall::EvidenceBudgetSpent);
                continue;
            }
            let (tool_control, settlement) = self
                .push_tool_result(
                    messages,
                    call,
                    active_skills,
                    writes,
                    youtube_session,
                    plan,
                    authorized_tools,
                    registry,
                    coverage,
                    gate,
                    sink,
                    context_chars,
                )
                .await;
            control.complete_turn |= tool_control == tools::ToolControl::CompleteTurn;
            if settlement.status() == crate::ai::events::ToolStatus::Cancelled && !control.cancelled
            {
                control.cancelled = true;
                sink.send(ChatEvent::PartialRun {
                    reason: PARTIAL_RUN_CANCELLED.to_string(),
                });
            }
            emit_tool_result(sink, &call.id, settlement);
            let current_playlist_item = youtube_session
                .playlist_current()
                .map(|(index, _, _)| index);
            playlist_batch_closed = current_playlist_item != batch_playlist_item
                || (batch_playlist_item.is_some()
                    && call.name == tools::TOOL_SELECT_PLAYLIST_VIDEOS);
            // Check the caps INSIDE the per-call loop: one turn issuing many
            // search calls (each up to MAX_SEARCH_RESULTS spans) must not blow
            // past the caps before the guard fires — that is the token-cost spike
            // the guard exists to prevent (a BYO-key user pays for it).
            if self.evidence_budget_spent(registry, *context_chars, active_skills) {
                control.budget_hit = true;
            }
        }
        control
    }

    #[allow(clippy::too_many_arguments)]
    async fn push_tool_result(
        &self,
        messages: &mut Vec<LlmMessage>,
        call: &ToolCall,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        plan: &mut RunPlan,
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        gate: &mut ApprovalGate,
        sink: &mut dyn EventSink,
        context_chars: &mut usize,
    ) -> (tools::ToolControl, ToolSettlement) {
        // The gate is the single door in front of dispatch, and the ONLY producer
        // of the `ApprovedCall` dispatch requires. A refusal still pushes exactly
        // one result for this call and settles its node: denial is not
        // run-cancellation, and the remaining calls in the batch stay gated.
        let approved = match self.approve(gate, call, writes, sink).await {
            Ok(approved) => approved,
            Err(refusal) => {
                messages.push(LlmMessage::tool_result(
                    &call.id,
                    &call.name,
                    refusal.tool_result_content(),
                ));
                if youtube_session.playlist_is_active()
                    && call.name != tools::TOOL_SELECT_PLAYLIST_VIDEOS
                {
                    youtube_session
                        .fail_playlist_item(format!("tool '{}' was not approved", call.name));
                }
                return (tools::ToolControl::Continue, refusal.settlement());
            }
        };
        let result = self
            .handle_tool_call(
                &approved,
                active_skills,
                writes,
                youtube_session,
                plan,
                authorized_tools,
                registry,
                coverage,
                sink,
            )
            .await;
        if youtube_session.playlist_is_active() && call.name != tools::TOOL_SELECT_PLAYLIST_VIDEOS {
            if let Some(reason) = playlist_failure_reason(&result.outcome, &call.name) {
                youtube_session.fail_playlist_item(reason);
            }
        }
        let settlement = settlement_for(&result);
        *context_chars += result.content.len();
        messages.push(LlmMessage::tool_result(
            &call.id,
            &call.name,
            result.content,
        ));
        (result.control, settlement)
    }

    /// Take one declared call through the approval gate.
    ///
    /// An **ungated** tool needs no decision at all — the four read-only vault
    /// tools, `skill_step`, `ask_user`, and any name the model invented — so it is
    /// admitted by [`ApprovedCall::ungated`], the one constructor that provably
    /// cannot authorise a gated call. Everything the gate covers goes through
    /// [`approval::decide`], which is its only other constructor.
    async fn approve(
        &self,
        gate: &mut ApprovalGate,
        call: &ToolCall,
        writes: &WriteSession,
        sink: &mut dyn EventSink,
    ) -> Result<ApprovedCall, RefusedCall> {
        if let Some(approved) = ApprovedCall::ungated(call) {
            return Ok(approved);
        }
        // Budget headroom is one of the classified scalars and one clause of the
        // eligibility rule. It comes from the run's already-enforced budget, so
        // the gate reads the same number the write path will enforce.
        let budget = writes.budget();
        let writes_remaining = budget.total_cap().saturating_sub(budget.total_writes());
        let context = ApprovalContext {
            root: self.root,
            classifier: self.skill_services.approval_classifier,
            prompt: self.skill_services.approval_prompt,
        };
        match approval::decide(gate, &context, call, writes_remaining, sink).await {
            ApprovalDecision::Approved(approved) => Ok(approved),
            ApprovalDecision::Denied(resolution) => Err(RefusedCall::Denied(resolution)),
            ApprovalDecision::HardDenied(denial) => Err(RefusedCall::HardDenied(denial.message())),
        }
    }

    fn evidence_budget_spent(
        &self,
        registry: &EvidenceRegistry,
        context_chars: usize,
        active_skills: &ActiveSkills,
    ) -> bool {
        registry.len() >= self.guards.max_spans
            || context_chars >= active_skills.max_context_chars(self.guards.max_context_chars)
    }

    /// Run one tool-DECIDING turn with a single bounded retry on a transient
    /// transport failure.
    ///
    /// Retrying is safe on two counts, and BOTH have to hold. The turn only
    /// decides tool calls — no tool has executed yet at this point in the loop,
    /// dispatch happens after this returns — so a retry can never double-execute a
    /// tool. And, historically, the turn emitted nothing, so a retry was invisible.
    ///
    /// That second half no longer holds by construction: this turn is now streamed
    /// ([`LlmClient::complete_tool_streaming`]), and a client that streams it emits
    /// live note previews as it goes. **So the turn is never retried once anything
    /// has been emitted** — a replay would stream a second copy of a half-composed
    /// note over the first, and the user would watch their note rewind. The guard
    /// spans the whole loop, not one attempt: an attempt that emitted and then
    /// failed bars every later attempt too. A client on the default (non-streaming)
    /// implementation emits nothing, so its retry behaviour is unchanged.
    ///
    /// A non-transient failure or a user-stopped run is never retried either.
    ///
    /// **It opens by saying the run is working** (#126). Nothing else can reach the
    /// user during this turn — only a `write_note` preview can, and only on a
    /// provider that streams tool calls — so an answered question was followed by a
    /// whole round-trip of silence, and by TWO on a provider that does not stream
    /// tool turns and re-runs the turn buffered. The pane went on showing whichever
    /// phase word it last had ("searching", while the model was composing). One
    /// [`ChatEvent::Processing`] before the turn is the honest correction: it is the
    /// variant that already means "working", which the run genuinely is.
    pub(super) async fn complete_tool_turn(
        &self,
        request: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
        // Sent through the raw sink, BEFORE the guard below wraps it, and once for
        // the whole call rather than once per attempt. Both matter. The guard bars a
        // retry on anything the user can already SEE — a half-composed note — and
        // this beacon is neither the provider's output nor something a replay could
        // rewind, so counting it would silently disable the one bounded retry. Once
        // per call also keeps the turn to a single event no matter how it goes.
        sink.send(ChatEvent::Processing);
        let mut retries = MAX_COMPLETE_RETRIES;
        let mut sink = EmissionGuard {
            inner: sink,
            emitted: false,
        };
        loop {
            match self.llm.complete_tool_streaming(request, &mut sink).await {
                Ok(completion) => return Ok(completion),
                Err(error) => {
                    let retryable = retries > 0
                        && error.is_retryable()
                        && !self.run_cancelled()
                        && !sink.emitted;
                    if !retryable {
                        return Err(error);
                    }
                    retries -= 1;
                    // Bounded backoff before the retry, paced by a host-injected timer:
                    // the core owns the delay *value* (its retry policy) but never a
                    // clock — every timer in the app lives in the host. A single retry
                    // means one fixed pause. The retried `complete` then re-enters the
                    // host's cancellable wrapper, which surfaces a mid-flight stop as a
                    // non-transient `Conflict` — so we never spin past a cancellation.
                    self.skill_services.retry_delay.delay(RETRY_BACKOFF).await;
                }
            }
        }
    }

    /// Whether the run has been cancelled through the shared capture-cancellation token
    /// (the host cancels it when the vault/window closes or the user stops the run).
    fn run_cancelled(&self) -> bool {
        self.skill_services.capture_cancellation.is_cancelled()
    }

    /// Dispatch one tool call, emitting the live step events and folding its result
    /// into the coverage accumulator.
    #[allow(clippy::too_many_arguments)]
    async fn handle_tool_call(
        &self,
        call: &ApprovedCall,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        plan: &mut RunPlan,
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
    ) -> tools::ToolResult {
        // The "searching…" cue precedes the search so the UI shows it live.
        if call.name() == tools::TOOL_SEARCH_NOTES {
            if let Some(query) = peek_query(call.arguments()) {
                sink.send(ChatEvent::Searching { query });
            }
        }
        let result = {
            let mut context = tools::ToolContext::new(
                self.root,
                self.skill_services.registry,
                self.skill_services.environment,
                active_skills,
                self.skill_services.note_writer,
                writes,
                sink,
                authorized_tools,
            )
            .with_youtube(self.skill_services.youtube_io, youtube_session)
            .with_youtube_requirements(self.skill_services.youtube_requirements)
            .with_vault_profile_io(self.skill_services.vault_profile_io)
            // The same token `run_cancelled` reads. A call that comes apart
            // because the user pressed Stop must not be attributed to the vault.
            .with_cancellation(self.skill_services.capture_cancellation.clone())
            .with_plan(plan);
            if let Some(pricing) = self.skill_services.pricing {
                context = context.with_pricing(pricing);
            }
            dispatch(
                call,
                self.provider,
                registry,
                self.skill_services.user_prompt,
                &mut context,
            )
            .await
        };
        match &result.outcome {
            ToolOutcome::Searched {
                query,
                hit_count,
                truncated,
                skipped_files,
                notes_read,
            } => {
                sink.send(ChatEvent::Retrieved {
                    query: query.clone(),
                    hit_count: *hit_count,
                });
                push_unique(&mut coverage.searched_terms, query);
                for rel in notes_read {
                    push_unique(&mut coverage.notes_read, rel);
                }
                coverage.truncated |= *truncated;
                // max, not sum: each full search re-reports the same skip count, so
                // summing would inflate it.
                coverage.skipped_files = coverage.skipped_files.max(*skipped_files);
            }
            ToolOutcome::Read {
                rel_path,
                start_line,
                end_line,
            } => {
                sink.send(ChatEvent::Reading {
                    rel_path: rel_path.clone(),
                    start_line: *start_line,
                    end_line: *end_line,
                });
                push_unique(&mut coverage.notes_read, rel_path);
            }
            // Metadata listing needs no event; a refused or failed call's error
            // is in the tool result the model reads and in the settlement the
            // timeline node renders.
            ToolOutcome::Listed
            | ToolOutcome::Action
            | ToolOutcome::Rejected
            | ToolOutcome::Cancelled
            | ToolOutcome::Failed { .. } => {}
        }
        result
    }
}

fn iteration_guard_reached(
    youtube_session: &YoutubeToolSession,
    active_skills: &ActiveSkills,
    consumed: usize,
) -> bool {
    !youtube_session.playlist_is_active()
        && !youtube_session.playlist_is_finished()
        && consumed >= active_skills.max_iterations(consumed)
}

fn collection_after_tool_batch(
    control: &ToolBatchControl,
    youtube_session: &YoutubeToolSession,
) -> Option<EvidenceCollection> {
    if control.complete_turn {
        return Some(EvidenceCollection::CompleteTurn);
    }
    if control.cancelled {
        // PartialRun was already emitted with the cancelled reason. Do not
        // report this as a tripped work-limit — that sentence is false for Stop.
        return Some(EvidenceCollection::Answer {
            guard_tripped: false,
        });
    }
    if youtube_session.playlist_is_finished() {
        return Some(EvidenceCollection::Answer {
            guard_tripped: false,
        });
    }
    // An evidence/context budget ends only an ordinary run. An active playlist
    // owns its separate bounded per-item control loop.
    if control.budget_hit && !youtube_session.playlist_is_active() {
        return Some(EvidenceCollection::Answer {
            guard_tripped: true,
        });
    }
    None
}

/// Extract the `query` field from a search tool call's raw JSON arguments, if present.
fn peek_query(args_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(args_json)
        .ok()?
        .get("query")?
        .as_str()
        .map(str::to_string)
}

// ── Bounded retry for idempotent tool-decision turns (PA-029) ────────────────
//
// A tool-DECIDING `complete` turn only asks the model which tools to call — no tool has
// executed yet at that point in the loop (dispatch runs after `complete` returns), so
// the call is idempotent and safe to retry: a retry re-decides, it never re-executes a
// tool. A single transient transport failure (a 429, a 5xx, or a dropped connection)
// would otherwise abort the whole run. The streamed answer turn is deliberately NOT
// retried (regenerating a partially-streamed answer is not idempotent).

/// The number of extra attempts after the first for a tool-decision `complete` turn.
const MAX_COMPLETE_RETRIES: usize = 1;

/// The bounded pause before the single retry, awaited through the host-injected
/// [`RetryDelay`] seam. One retry today means one fixed pause: 500 ms gives a rate-limit
/// (429) or a server 5xx brief breathing room without a user-perceptible stall, and is
/// short enough that a mid-flight user stop is observed on the very next `complete`.
/// Retryability itself lives on [`crate::error::CoreError::is_retryable`] — the one place that decides
/// which transport failures are transient.
pub(super) const RETRY_BACKOFF: Duration = Duration::from_millis(500);
