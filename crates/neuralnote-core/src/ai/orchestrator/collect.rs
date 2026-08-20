//! The evidence loop: how many model turns to spend, and when to stop.
//!
//! One responsibility, at one altitude. Each turn is budgeted against the
//! model's context window, announced with the round it is about to run, and then
//! asked which tools to call. What happens to those calls — gating, dispatch,
//! settlement — is [`super::tool_batch`], one level down; this file only reads
//! back what the batch did and decides whether there is another turn in the run.
//!
//! The two ways a run ends are both here: an exhausted budget or iteration
//! ceiling, which is a partial answer, and the model deciding it has enough,
//! which is a complete one. Telling them apart is what the caller renders as
//! "coverage".

use super::context_budget::fit_prompt_to_window;
use super::coverage::CoverageAcc;
use super::playlist::{
    handle_empty_tool_turn, playlist_position, playlist_preflight, LoopControl, PlaylistLoopState,
};
use super::session::ChatSession;
use super::tool_batch::ToolBatchControl;
use super::usage::EmissionGuard;
use crate::ai::approval::ApprovalGate;
use crate::ai::events::{ChatEvent, EventSink, PlaylistPosition};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{Completion, LlmMessage, LlmRequest};
use crate::ai::plan::RunPlan;
use crate::ai::skills::ActiveSkills;
use crate::ai::tools;
use crate::ai::write_policy::WriteSession;
use crate::ai::youtube::YoutubeToolSession;
use crate::error::CoreResult;
use std::time::Duration;

pub(super) enum EvidenceCollection {
    Answer { guard_tripped: bool },
    CompleteTurn,
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
            // Announced here, through the raw sink, so it is structurally outside the
            // retry `EmissionGuard` that `complete_tool_turn` builds around the turn:
            // that guard bars a retry on anything the user can already SEE, and this
            // beacon is neither the provider's output nor something a replay could
            // rewind, so counting it would silently disable the one bounded retry.
            //
            // The ceiling is re-read every round on purpose — activating a skill
            // raises it — so the pair the UI renders is always this round's pair.
            sink.send(round_beacon(
                consumed,
                active_skills.max_iterations(consumed),
                playlist_position(youtube_session),
            ));
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
    /// **The caller announces the round before calling this** (#126). Nothing else
    /// can reach the user during this turn — only a `write_note` preview can, and
    /// only on a provider that streams tool calls — so an answered question was
    /// followed by a whole round-trip of silence, and by TWO on a provider that
    /// does not stream tool turns and re-runs the turn buffered. The pane went on
    /// showing whichever phase word it last had ("searching", while the model was
    /// composing). [`ChatEvent::PlanningRound`], emitted by `collect_evidence`
    /// outside the guard below, is the honest correction.
    pub(super) async fn complete_tool_turn(
        &self,
        request: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<Completion> {
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
}

/// The beacon for the round about to run: its 1-based number, and the ceiling to
/// show beside it.
///
/// **The ceiling is clamped to never sit below the round it accompanies**, and
/// that is not defensive padding — it is the difference between two things
/// [`ActiveSkills::max_iterations`](crate::ai::skills::ActiveSkills::max_iterations)
/// deliberately conflates. That function seeds its fold at
/// `base.max(consumed)`: a FLOOR, there so a late skill activation cannot
/// retroactively lower the ceiling below turns already spent. Read as a display
/// denominator it is wrong, because once `consumed` passes every declared cap it
/// returns `consumed` itself — one below the round being announced.
///
/// An ordinary run never gets there, because the iteration guard stops it first.
/// A playlist does: `iteration_guard_reached` is false while a playlist is
/// active, so the loop runs past the ceiling by design (each item may spend up
/// to `MAX_PLAYLIST_TURNS_PER_ITEM` turns, and a playlist has many items).
/// Unclamped, that puts "round 17 of 16" on the wire — arithmetically impossible,
/// and it would then have the denominator chase the numerator for the rest of
/// the run, telling the user they are permanently one round from finished.
///
/// The clamp stays as the backstop for the ordinary path, where what it says —
/// "at the ceiling" — is true, if thin. What it could never do is give a
/// playlist an honest denominator, because there isn't one to be had in rounds.
/// So the beacon carries `playlist` beside the pair: the number of videos the
/// user picked is fixed for the run and cannot be overtaken, which dissolves the
/// moving ceiling rather than clamping around it. Whoever renders these numbers
/// counts videos while `playlist` is present and rounds when it is not.
///
/// Both numbers saturate rather than wrap: a wrapped round would read as a run
/// starting over, the exact confusion `PlanningRound` replaced `Processing` to end.
pub(super) fn round_beacon(
    consumed: usize,
    max_iterations: usize,
    playlist: Option<PlaylistPosition>,
) -> ChatEvent {
    let round = u32::try_from(consumed)
        .unwrap_or(u32::MAX)
        .saturating_add(1);
    ChatEvent::PlanningRound {
        round,
        max_rounds: u32::try_from(max_iterations).unwrap_or(u32::MAX).max(round),
        playlist,
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
