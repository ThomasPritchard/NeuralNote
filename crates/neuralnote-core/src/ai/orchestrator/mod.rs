//! The agentic tool-search chat loop.
//!
//! Flow: build the message list → run non-streamed [`LlmClient::complete`] turns,
//! dispatching each tool call and emitting live search/read events → stop when the
//! model stops calling tools or a guard trips → verify the citations the model made
//! → stream the final answer → emit surviving citations and a coverage footer →
//! `Done`. Any error is surfaced as a [`ChatEvent::Error`] and stops the run — never
//! a panic, never silent.

use crate::ai::approval::ApprovalGate;
use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::llm::{LlmClient, LlmMessage};
use crate::ai::retrieval::RetrievalProvider;
use crate::ai::write_policy::{UndoLedger, WriteSession};
use crate::error::CoreResult;
use std::path::Path;
use std::time::Instant;

mod citations;
mod collect;
mod context_budget;
mod coverage;
mod history;
mod playlist;
mod prompt;
mod services;
mod session;
mod settlement;
mod tool_batch;
mod usage;

pub use services::{NoRetryDelay, RetryDelay, SkillServices};

use session::ChatSession;
use usage::UsageMeter;

/// The default OpenRouter model — BYO-key, OpenAI-compatible, user-editable in the
/// shell. Kept here as the client-agnostic default the host can override.
pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4.5";

pub use crate::ai::skill_activation::SKILL_ACTIVATION_FAILURE_MARK;

/// Why a run ended short. Both are the orchestrator's own knowledge — a guard it
/// tripped, or a stop it honoured — so neither is ever inferred from model prose.
pub(super) const PARTIAL_RUN_GUARD_TRIPPED: &str =
    "the run reached a work limit before finishing, so it covered only part of the task";
pub(super) const PARTIAL_RUN_CANCELLED: &str = "the run was stopped before it finished every item";

/// Loop guards — cost- and runaway-protection (spec §4). Defaults suit a single
/// own-vault user; the host may tune them.
#[derive(Debug, Clone)]
pub struct Guards {
    /// Max tool-deciding turns before we force the answer.
    pub max_iterations: usize,
    /// Max distinct evidence spans to gather before we force the answer.
    pub max_spans: usize,
    /// Max total chars of tool-result content to feed back before we force the answer.
    pub max_context_chars: usize,
}

impl Default for Guards {
    fn default() -> Self {
        Self {
            max_iterations: 8,
            // Bumped 40 → 60 in lockstep with the 8 → 12 default search results
            // (tools.rs): ~5 searches of 12 spans, so richer per-search evidence
            // doesn't spend the budget in 3 searches and starve query diversity.
            max_spans: 60,
            max_context_chars: 60_000,
        }
    }
}

/// Run one chat turn end-to-end, streaming [`ChatEvent`]s to `sink`.
///
/// `history` is prior turns (system prompt is prepended here). `root` is the vault
/// root (used to re-verify citations). `model` is the model id to request. The run
/// always resolves via the event stream: success ends with `Done`, a surfaced
/// failure ends with `Error`.
//
// An orchestration entrypoint: each parameter is a distinct, meaningful input the
// shell supplies, so grouping them into a struct would only obscure the call site.
#[allow(clippy::too_many_arguments)]
pub async fn run_chat(
    user_input: &str,
    history: &[LlmMessage],
    active_skills: Vec<String>,
    root: &Path,
    model: &str,
    provider: &dyn RetrievalProvider,
    llm: &dyn LlmClient,
    skill_services: &SkillServices<'_>,
    sink: &mut dyn EventSink,
    guards: &Guards,
) -> CoreResult<UndoLedger> {
    let session = ChatSession {
        root,
        model,
        provider,
        llm,
        skill_services,
        guards,
    };
    // Started before anything else so the elapsed time in the footer is the run
    // the user waited for, not the part of it after setup. Reading a monotonic
    // clock is a measurement, not a timer — the core still owns no waiting; that
    // stays behind `RetryDelay`.
    let started = Instant::now();
    let mut meter = UsageMeter::new(sink, started, model);
    let sink = &mut meter;
    let mut writes = match WriteSession::new(skill_services.work_items) {
        Ok(writes) => writes,
        Err(error) => {
            sink.send(ChatEvent::Error {
                message: error.to_string(),
            });
            return Ok(UndoLedger::default());
        }
    };
    // Per-run, and deliberately never serialised: an approval cannot survive a
    // restart, and a verdict cached across runs would have been derived from a
    // vault state that no longer exists.
    let mut gate = ApprovalGate::new(skill_services.approval_policy.clone());
    sink.send(ChatEvent::Processing);
    if let Err(e) = session
        .drive(
            user_input,
            history,
            &active_skills,
            &mut writes,
            &mut gate,
            sink,
        )
        .await
    {
        // Surface the failure explicitly and stop — never a panic, never silent.
        sink.send(ChatEvent::Error {
            message: e.to_string(),
        });
    }
    Ok(writes.into_ledger())
}

#[cfg(test)]
mod tests;
