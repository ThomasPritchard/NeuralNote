//! One model turn's declared tool calls: gate each, dispatch it, settle it.
//!
//! The altitude below [`super::collect`], which decides how many turns to spend
//! and when to stop. Nothing here knows about rounds or budgets running out; it
//! is handed a batch and answers what happened to it, in
//! [`ToolBatchControl`].
//!
//! The ordering rule the whole module exists to keep: every declared call is
//! announced before anything can go wrong with it, and settled exactly once
//! afterwards — approved or refused, dispatched or skipped. A call that vanished
//! between those two points would leave a node spinning on the timeline forever.

use super::coverage::{push_unique, CoverageAcc};
use super::session::ChatSession;
use super::settlement::{
    emit_tool_call, emit_tool_result, playlist_failure_reason, settle_skipped, settlement_for,
    RefusedCall, SkippedCall, ToolSettlement,
};
use super::PARTIAL_RUN_CANCELLED;
use crate::ai::approval::{self, ApprovalContext, ApprovalDecision, ApprovalGate, ApprovedCall};
use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{LlmMessage, ToolCall};
use crate::ai::plan::RunPlan;
use crate::ai::skills::ActiveSkills;
use crate::ai::tools::{self, dispatch, ToolOutcome};
use crate::ai::write_policy::WriteSession;
use crate::ai::youtube::YoutubeToolSession;

/// What a whole batch did, as the loop above needs to read it.
#[derive(Default)]
pub(super) struct ToolBatchControl {
    pub(super) budget_hit: bool,
    pub(super) complete_turn: bool,
    pub(super) cancelled: bool,
}

impl ChatSession<'_> {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn handle_tool_calls(
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
            let dispatched = emit_tool_call(sink, call, plan);
            if playlist_batch_closed {
                settle_skipped(messages, sink, &dispatched, SkippedCall::StalePlaylistBatch);
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
                settle_skipped(messages, sink, &dispatched, SkippedCall::PlaylistCancelled);
                continue;
            }
            if control.budget_hit {
                settle_skipped(
                    messages,
                    sink,
                    &dispatched,
                    SkippedCall::EvidenceBudgetSpent,
                );
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
            emit_tool_result(sink, &dispatched, settlement);
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
        // The "searching…" cue precedes the search so the UI shows it live. It
        // names the call that runs it because arrival order is useless as a
        // correlation key once calls run in parallel — attributing one call's
        // query to another is a provenance lie in the surface whose whole job is
        // provenance.
        //
        // The timeline does not currently read that id: it renders the cue on
        // the run's activity trace only, having found that the node already
        // carries both of the cue's facts (amendment D2). The id stays on the
        // wire regardless — it is what makes the attribution correct at the
        // source, and recovering it later would mean re-deriving provenance that
        // had already shipped wrong.
        if call.name() == tools::TOOL_SEARCH_NOTES {
            if let Some(query) = peek_query(call.arguments()) {
                sink.send(ChatEvent::Searching {
                    query,
                    call_id: Some(call.call_id().to_string()),
                });
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
                    call_id: Some(call.call_id().to_string()),
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
                    call_id: Some(call.call_id().to_string()),
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

/// Extract the `query` field from a search tool call's raw JSON arguments, if present.
fn peek_query(args_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(args_json)
        .ok()?
        .get("query")?
        .as_str()
        .map(str::to_string)
}
