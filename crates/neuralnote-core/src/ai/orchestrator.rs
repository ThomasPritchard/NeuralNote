//! The agentic tool-search chat loop.
//!
//! Flow: build the message list → run non-streamed [`LlmClient::complete`] turns,
//! dispatching each tool call and emitting live search/read events → stop when the
//! model stops calling tools or a guard trips → verify the citations the model made
//! → stream the final answer → emit surviving citations and a coverage footer →
//! `Done`. Any error is surfaced as a [`ChatEvent::Error`] and stops the run — never
//! a panic, never silent.

use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{Completion, LlmClient, LlmMessage, LlmRequest, Role, ToolCall, UserPrompt};
use crate::ai::retrieval::RetrievalProvider;
use crate::ai::skills::{ActiveSkills, SkillEnvironment, SkillRegistry};
use crate::ai::tools::{self, dispatch, ToolOutcome};
use crate::ai::verify::CitationVerifier;
use crate::ai::write_policy::{NoteWriteBackend, UndoLedger, WriteSession};
use crate::ai::youtube::{
    CaptureCancellation, ExtractorUpdateSession, YoutubeIo, YoutubeToolSession,
    UNAVAILABLE_YOUTUBE_IO,
};
use crate::capture::{PricingInput, UnavailableVaultProfileIo, VaultProfileIo};
use crate::error::CoreResult;
use async_trait::async_trait;
use std::path::Path;
use std::time::Duration;

const MAX_PLAYLIST_TURNS_PER_ITEM: usize = 8;

/// The default OpenRouter model — BYO-key, OpenAI-compatible, user-editable in the
/// shell. Kept here as the client-agnostic default the host can override.
pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4.5";

/// Marker substring the frontend keys activation-failure rendering on.
/// TS mirror: app/desktop/src/workspace/ChatMessages.tsx `ACTIVATION_FAILURE_MARK`.
/// A wording change is a two-site edit; the tripwire is
/// `disabled_fixture_preload_surfaces_a_recoverable_error_without_activation`
/// in `tests/skill_orchestrator.rs`, which asserts the emitted `SkillStep`
/// message contains this constant.
pub const SKILL_ACTIVATION_FAILURE_MARK: &str = "could not be activated";

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

const SYSTEM_PROMPT: &str = r#"You are NeuralNote's assistant. You help the user think with, and about, their own notes.

Choose a mode for each message.

CONVERSE — answer directly, call no tools:
- greetings, thanks, small talk
- questions about you, your abilities, or something you just said
- follow-ups that need only your own previous answer

RESEARCH — you MUST search before answering:
- any question about facts, or about anything in the user's notes or material
- Issue 3 to 8 varied searches: try synonyms, tags, note titles, and the user's own
  wording. Keyword search is literal, so rephrase generously.
- The vault is organised into folders. Call `list_folders` to see them (each with its
  note count). When the user asks about a specific folder — e.g. "what's in my Recipes
  folder" — pass that folder's path as the `folder` argument to `search_notes` or
  `list_notes` to scope to it and its subfolders; omit `folder` to cover the whole vault.
- Cite every claim with the evidence id in square brackets, e.g. [e1] or [e2]. Cite ids
  only — never a file path, and never a quote you did not retrieve.

These hold in both modes:
- Never answer a factual question from your own knowledge. Your knowledge is for
  conversation, not for facts.
- If your searches find nothing relevant, say so plainly: name what you searched for,
  and invite the user to add a note on the topic so you can answer it next time. Never
  invent a citation or an answer.
- Keep answers concise and grounded in the cited evidence."#;

/// Host seam for the retry backoff pause. The core owns *how long* to wait (its retry
/// policy) but never owns a clock — every timer in the app lives in the host — so it
/// hands the duration to this seam and awaits it. The shell backs it with its async
/// runtime timer; tests supply a deterministic double so backoff is exercised without
/// real time passing.
#[async_trait]
pub trait RetryDelay: Send + Sync {
    /// Await `duration` before the caller retries. Must not block the executor thread.
    async fn delay(&self, duration: Duration);
}

/// The no-op default: retry immediately. Used by non-host callers and any run that does
/// not wire a real timer; the desktop shell overrides it with a runtime-backed delay.
pub struct NoRetryDelay;

#[async_trait]
impl RetryDelay for NoRetryDelay {
    async fn delay(&self, _duration: Duration) {}
}

static NO_RETRY_DELAY: NoRetryDelay = NoRetryDelay;

/// Shell-supplied seams and pure skill policy for one chat run.
pub struct SkillServices<'a> {
    registry: &'a SkillRegistry,
    environment: &'a SkillEnvironment,
    user_prompt: &'a dyn UserPrompt,
    note_writer: &'a dyn NoteWriteBackend,
    work_items: usize,
    youtube_io: &'a dyn YoutubeIo,
    youtube_requirements: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    vault_profile_io: &'a dyn VaultProfileIo,
    capture_cancellation: CaptureCancellation,
    pricing: Option<&'a PricingInput>,
    extractor_updates: ExtractorUpdateSession,
    retry_delay: &'a dyn RetryDelay,
}

static UNAVAILABLE_VAULT_PROFILE_IO: UnavailableVaultProfileIo = UnavailableVaultProfileIo;

impl<'a> SkillServices<'a> {
    pub fn new(
        registry: &'a SkillRegistry,
        environment: &'a SkillEnvironment,
        user_prompt: &'a dyn UserPrompt,
        note_writer: &'a dyn NoteWriteBackend,
        work_items: usize,
    ) -> Self {
        Self {
            registry,
            environment,
            user_prompt,
            note_writer,
            work_items,
            youtube_io: &UNAVAILABLE_YOUTUBE_IO,
            youtube_requirements: &crate::ai::youtube::UNAVAILABLE_YOUTUBE_REQUIREMENT_INSTALLER,
            vault_profile_io: &UNAVAILABLE_VAULT_PROFILE_IO,
            capture_cancellation: CaptureCancellation::default(),
            pricing: None,
            // Non-host callers get an isolated allowance; the desktop shell overrides
            // this with its app-session-owned update state through the builder below.
            extractor_updates: ExtractorUpdateSession::default(),
            // No-op backoff by default; the desktop shell wires its runtime timer.
            retry_delay: &NO_RETRY_DELAY,
        }
    }

    pub fn with_youtube_io(mut self, youtube_io: &'a dyn YoutubeIo) -> Self {
        self.youtube_io = youtube_io;
        self
    }

    pub fn with_youtube_requirements(
        mut self,
        installer: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    ) -> Self {
        self.youtube_requirements = installer;
        self
    }

    pub fn with_vault_profile_io(mut self, profile_io: &'a dyn VaultProfileIo) -> Self {
        self.vault_profile_io = profile_io;
        self
    }

    pub fn with_capture_cancellation(mut self, cancellation: CaptureCancellation) -> Self {
        self.capture_cancellation = cancellation;
        self
    }

    pub fn with_pricing(mut self, pricing: &'a PricingInput) -> Self {
        self.pricing = Some(pricing);
        self
    }

    /// Override the current per-run default with update state retained by a host.
    pub fn with_extractor_update_session(mut self, updates: ExtractorUpdateSession) -> Self {
        self.extractor_updates = updates;
        self
    }

    /// Wire the host's runtime-backed retry backoff. Without this, retries fire
    /// immediately (the [`NoRetryDelay`] default).
    pub fn with_retry_delay(mut self, retry_delay: &'a dyn RetryDelay) -> Self {
        self.retry_delay = retry_delay;
        self
    }
}

fn system_prompt(registry: &SkillRegistry) -> String {
    let catalogue = registry.catalogue();
    let catalogue = if catalogue.is_empty() {
        "(none)"
    } else {
        &catalogue
    };
    format!("{SYSTEM_PROMPT}\n\nAVAILABLE SKILLS\n{catalogue}")
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
    let mut writes = match WriteSession::new(skill_services.work_items) {
        Ok(writes) => writes,
        Err(error) => {
            sink.send(ChatEvent::Error {
                message: error.to_string(),
            });
            return Ok(UndoLedger::default());
        }
    };
    sink.send(ChatEvent::Processing);
    if let Err(e) = session
        .drive(user_input, history, &active_skills, &mut writes, sink)
        .await
    {
        // Surface the failure explicitly and stop — never a panic, never silent.
        sink.send(ChatEvent::Error {
            message: e.to_string(),
        });
    }
    Ok(writes.into_ledger())
}

/// The collaborators for one run, bundled so the loop's helpers stay small.
struct ChatSession<'a> {
    root: &'a Path,
    model: &'a str,
    provider: &'a dyn RetrievalProvider,
    llm: &'a dyn LlmClient,
    skill_services: &'a SkillServices<'a>,
    guards: &'a Guards,
}

/// The coverage footer accumulated across the run (so partial coverage is visible).
#[derive(Default)]
struct CoverageAcc {
    searched_terms: Vec<String>,
    notes_read: Vec<String>,
    truncated: bool,
    skipped_files: u32,
}

struct ThinkingCounter<'a> {
    inner: &'a mut dyn EventSink,
    count: usize,
}

#[derive(Default)]
struct PlaylistLoopState {
    context_chars: usize,
    announced_item: Option<usize>,
    summary_emitted: bool,
}

impl PlaylistLoopState {
    fn sync(
        &mut self,
        messages: &mut Vec<LlmMessage>,
        youtube_session: &mut YoutubeToolSession,
        sink: &mut dyn EventSink,
    ) {
        sync_playlist_control(
            messages,
            youtube_session,
            sink,
            &mut self.context_chars,
            &mut self.announced_item,
            &mut self.summary_emitted,
        );
    }
}

enum LoopControl {
    Proceed,
    Continue,
    Return(bool),
}

enum EvidenceCollection {
    Answer { guard_tripped: bool },
    CompleteTurn,
}

#[derive(Default)]
struct ToolBatchControl {
    budget_hit: bool,
    complete_turn: bool,
}

impl EventSink for ThinkingCounter<'_> {
    fn send(&mut self, event: ChatEvent) {
        if matches!(&event, ChatEvent::Thinking { .. }) {
            self.count += 1;
        }
        self.inner.send(event);
    }
}

impl ChatSession<'_> {
    async fn drive(
        &self,
        user_input: &str,
        history: &[LlmMessage],
        preloaded_skills: &[String],
        writes: &mut WriteSession,
        sink: &mut dyn EventSink,
    ) -> CoreResult<()> {
        // Sanitise history in the core (strip stale `[eN]` markers, window to a char
        // budget) so the grounding rules + evidence can't be silently front-truncated
        // out of a local model's context window, and a stale marker can't mis-cite —
        // regardless of which client built the history. See `prepare_history`.
        let history = prepare_history(history);
        let mut messages = Vec::with_capacity(history.len() + preloaded_skills.len() + 2);
        messages.push(LlmMessage::system(system_prompt(
            self.skill_services.registry,
        )));
        let mut active_skills = ActiveSkills::new(self.guards.max_iterations);
        for id in preloaded_skills {
            let activation = match active_skills.activate(
                id,
                self.skill_services.registry,
                self.skill_services.environment,
            ) {
                Ok(activation) => activation,
                Err(error) => {
                    sink.send(ChatEvent::SkillStep {
                        message: format!(
                            "Skill '{id}' {SKILL_ACTIVATION_FAILURE_MARK}: {error} — continuing without it"
                        ),
                    });
                    // A preload has no genuine tool-call id. Preserve protocol order
                    // with system context carrying the same recoverable JSON error a
                    // rejected `use_skill` call would return, then continue ungranted.
                    messages.push(LlmMessage::system(format!(
                        "A preloaded skill could not be activated; continue without it.\n{}",
                        serde_json::json!({ "error": error })
                    )));
                    continue;
                }
            };
            if activation.newly_activated {
                sink.send(ChatEvent::SkillActivated {
                    id: activation.manifest.id.clone(),
                    name: activation.manifest.name.clone(),
                });
                // Preloads have no genuine tool-call id, so instructions enter as a
                // system turn. Synthesising assistant/tool messages would violate
                // the chat protocol; activation policy and grants remain shared.
                messages.push(LlmMessage::system(format!(
                    "Activated skill `{}`:\n\n{}",
                    activation.manifest.id, activation.manifest.instructions
                )));
            }
        }
        messages.extend(history);
        messages.push(LlmMessage::user(user_input));

        let mut registry = EvidenceRegistry::new();
        let mut coverage = CoverageAcc::default();
        let mut youtube_session = YoutubeToolSession::new_with_update_session(
            self.skill_services.capture_cancellation.clone(),
            self.skill_services.extractor_updates.clone(),
        );
        let collection = self
            .collect_evidence(
                &mut messages,
                &mut active_skills,
                writes,
                &mut youtube_session,
                &mut registry,
                &mut coverage,
                sink,
            )
            .await?;
        let guard_tripped = match collection {
            EvidenceCollection::Answer { guard_tripped } => guard_tripped,
            EvidenceCollection::CompleteTurn => {
                sink.send(ChatEvent::Done);
                return Ok(());
            }
        };

        // Verify + answer phase. Verifying is the UI cue that the answer is being
        // grounded; the actual citation checks run once we have the streamed text.
        sink.send(ChatEvent::Verifying);
        // A fresh streaming generation produces the final answer. It re-generates
        // rather than reusing the loop's last (non-streamed) turn — the deliberate
        // cost of keeping tool-parsing non-streamed while the answer streams live.
        // No tools are advertised on this turn: it is unambiguously an answer, so the
        // model can't emit a tool call that streaming would silently swallow.
        // The answer turn carries all accumulated evidence, so it is the send most
        // likely to overflow a small local window — budget it before streaming.
        let budgeted = fit_prompt_to_window(&messages, self.model);
        coverage.truncated |= budgeted.lost;
        let (answer, thinking_count) = {
            let mut counting_sink = ThinkingCounter {
                inner: sink,
                count: 0,
            };
            let answer = self
                .stream_final_answer(&budgeted.messages, &mut counting_sink)
                .await?;
            (answer, counting_sink.count)
        };

        if answer.trim().is_empty() {
            let message = if thinking_count > 0 {
                "the model returned only reasoning and no answer — try again or switch model"
            } else {
                "the model returned an empty answer"
            };
            // Don't let the empty-answer return drop the truncation/skip signal — a
            // tripped guard is often WHY the answer came back empty. emit_coverage
            // otherwise runs only on the success path below; surface it here too, but
            // only when it carries that signal, so a plain searched-but-empty turn
            // stays a bare Error (whitespace_only_answer_after_search_emits_error_and_stops).
            if guard_tripped || coverage.truncated || coverage.skipped_files > 0 {
                emit_coverage(coverage, guard_tripped, sink);
            }
            sink.send(ChatEvent::Error {
                message: message.to_string(),
            });
            return Ok(());
        }

        self.emit_citations(&answer, &registry, sink);
        emit_coverage(coverage, guard_tripped, sink);
        sink.send(ChatEvent::Done);
        Ok(())
    }

    fn request(&self, messages: &[LlmMessage], tools: &[serde_json::Value]) -> LlmRequest {
        LlmRequest {
            model: self.model.to_string(),
            messages: messages.to_vec(),
            tools: tools.to_vec(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn collect_evidence(
        &self,
        messages: &mut Vec<LlmMessage>,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
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
            let budgeted = fit_prompt_to_window(messages, self.model);
            coverage.truncated |= budgeted.lost;
            // This tool-DECIDING turn is idempotent (no tool has run yet), so a single
            // transient transport failure is retried once rather than aborting the run.
            let completion = self
                .complete_tool_turn(&self.request(&budgeted.messages, &tools))
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
                    &authorized_tools,
                    registry,
                    coverage,
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
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
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
            if playlist_batch_closed {
                push_stale_playlist_tool_result(messages, call);
                continue;
            }
            if !playlist_cancelled
                && youtube_session.playlist_is_active()
                && youtube_session.cancellation().is_cancelled()
            {
                youtube_session.cancel_playlist_remaining();
                playlist_cancelled = true;
            }
            if playlist_cancelled {
                push_cancelled_tool_result(messages, call);
                continue;
            }
            if control.budget_hit {
                push_skipped_tool_result(messages, call);
                continue;
            }
            control.complete_turn |= self
                .push_tool_result(
                    messages,
                    call,
                    active_skills,
                    writes,
                    youtube_session,
                    authorized_tools,
                    registry,
                    coverage,
                    sink,
                    context_chars,
                )
                .await
                == tools::ToolControl::CompleteTurn;
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
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
        context_chars: &mut usize,
    ) -> tools::ToolControl {
        let result = self
            .handle_tool_call(
                call,
                active_skills,
                writes,
                youtube_session,
                authorized_tools,
                registry,
                coverage,
                sink,
            )
            .await;
        if result.outcome == ToolOutcome::Rejected
            && youtube_session.playlist_is_active()
            && call.name != tools::TOOL_SELECT_PLAYLIST_VIDEOS
        {
            youtube_session.fail_playlist_item(format!("tool '{}' was rejected", call.name));
        }
        *context_chars += result.content.len();
        messages.push(LlmMessage::tool_result(
            &call.id,
            &call.name,
            result.content,
        ));
        result.control
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

    async fn stream_final_answer(
        &self,
        messages: &[LlmMessage],
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        self.llm
            .complete_streaming(&self.request(messages, &[]), sink)
            .await
    }

    /// Run one idempotent tool-DECIDING `complete` turn with a single bounded retry on a
    /// transient transport failure. The call only decides tool calls — no tool has
    /// executed yet at this point in the loop (dispatch happens after this returns) — so
    /// a retry can never double-execute a tool. A non-transient failure or a user-stopped
    /// run is never retried, and this is the non-streamed path, so the streamed answer
    /// turn is untouched.
    async fn complete_tool_turn(&self, request: &LlmRequest) -> CoreResult<Completion> {
        let mut retries = MAX_COMPLETE_RETRIES;
        loop {
            match self.llm.complete(request).await {
                Ok(completion) => return Ok(completion),
                Err(error) => {
                    let retryable = retries > 0 && error.is_retryable() && !self.run_cancelled();
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
        call: &ToolCall,
        active_skills: &mut ActiveSkills,
        writes: &mut WriteSession,
        youtube_session: &mut YoutubeToolSession,
        authorized_tools: &std::collections::BTreeSet<String>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
    ) -> tools::ToolResult {
        // The "searching…" cue precedes the search so the UI shows it live.
        if call.name == tools::TOOL_SEARCH_NOTES {
            if let Some(query) = peek_query(&call.arguments) {
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
            .with_vault_profile_io(self.skill_services.vault_profile_io);
            if let Some(pricing) = self.skill_services.pricing {
                context = context.with_pricing(pricing);
            }
            dispatch(
                &call.id,
                &call.name,
                &call.arguments,
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
            // Metadata listing needs no event; a rejected call's error is in the tool
            // result the model reads.
            ToolOutcome::Listed | ToolOutcome::Action | ToolOutcome::Rejected => {}
        }
        result
    }

    /// Verify each evidence id the answer cited and emit a `Citation` for survivors,
    /// a `CitationDropped` (with reason) for the rest — a wrong citation is worse
    /// than no answer.
    fn emit_citations(&self, answer: &str, registry: &EvidenceRegistry, sink: &mut dyn EventSink) {
        let verifier = CitationVerifier::new(self.root);
        for id in extract_cited_ids(answer) {
            match registry.get(&id) {
                None => sink.send(ChatEvent::CitationDropped {
                    reason: format!("the answer cited an unknown evidence id '{id}'"),
                }),
                Some(span) => match verifier.verify(span) {
                    Ok(()) => sink.send(ChatEvent::Citation {
                        id: span.id.clone(),
                        rel_path: span.rel_path.clone(),
                        start_line: span.start_line,
                        end_line: span.end_line,
                        text: span.text.clone(),
                    }),
                    Err(reason) => sink.send(ChatEvent::CitationDropped { reason }),
                },
            }
        }
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

fn playlist_preflight(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    state: &mut PlaylistLoopState,
) -> LoopControl {
    if !youtube_session.playlist_is_active() {
        return LoopControl::Proceed;
    }
    if youtube_session.cancellation().is_cancelled() {
        youtube_session.cancel_playlist_remaining();
        state.sync(messages, youtube_session, sink);
        return LoopControl::Return(true);
    }
    let over_turn_limit = youtube_session
        .record_playlist_turn()
        .is_some_and(|turns| turns > MAX_PLAYLIST_TURNS_PER_ITEM);
    if !over_turn_limit {
        return LoopControl::Proceed;
    }
    youtube_session.fail_playlist_item(format!(
        "exceeded the bounded {MAX_PLAYLIST_TURNS_PER_ITEM}-turn work-item allowance"
    ));
    state.sync(messages, youtube_session, sink);
    if youtube_session.playlist_is_finished() {
        LoopControl::Return(false)
    } else {
        LoopControl::Continue
    }
}

fn handle_empty_tool_turn(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    state: &mut PlaylistLoopState,
) -> LoopControl {
    if !youtube_session.playlist_is_active() {
        return LoopControl::Return(false);
    }
    youtube_session.fail_playlist_item(
        "model stopped before both literature and transcript notes were written",
    );
    state.sync(messages, youtube_session, sink);
    if youtube_session.playlist_is_finished() {
        LoopControl::Return(false)
    } else {
        LoopControl::Continue
    }
}

#[allow(clippy::too_many_arguments)]
fn sync_playlist_control(
    messages: &mut Vec<LlmMessage>,
    youtube_session: &mut YoutubeToolSession,
    sink: &mut dyn EventSink,
    context_chars: &mut usize,
    announced_item: &mut Option<usize>,
    summary_emitted: &mut bool,
) {
    let outcomes = youtube_session.take_unreported_playlist_outcomes();
    if !outcomes.is_empty() {
        compact_completed_playlist_context(messages, context_chars);
        for outcome in outcomes {
            let message = match outcome {
                crate::ai::youtube::PlaylistItemOutcome::Succeeded { video_id } => {
                    format!("Playlist video {video_id} succeeded")
                }
                crate::ai::youtube::PlaylistItemOutcome::Failed { video_id, reason } => {
                    format!("Playlist video {video_id} failed: {reason}")
                }
                crate::ai::youtube::PlaylistItemOutcome::Cancelled { video_id } => {
                    format!("Playlist video {video_id} cancelled")
                }
            };
            sink.send(ChatEvent::SkillStep { message });
        }
    }

    if youtube_session.playlist_is_finished() {
        if !*summary_emitted {
            messages.push(LlmMessage::system(format!(
                "PLAYLIST EXECUTION SUMMARY\n{}",
                youtube_session.playlist_summary().unwrap_or_default()
            )));
            *summary_emitted = true;
        }
        return;
    }

    if let Some((index, total, video_id)) = youtube_session.playlist_current() {
        if *announced_item != Some(index) {
            messages.push(LlmMessage::system(format!(
                "Implementation control: process playlist video {}/{} with id '{}'. Use write_note work_item {}. Do not move to another video until both its literature and transcript notes have been written; failures are recorded explicitly by the host.",
                index + 1,
                total,
                video_id,
                index
            )));
            *announced_item = Some(index);
        }
    }
}

fn compact_completed_playlist_context(messages: &mut [LlmMessage], context_chars: &mut usize) {
    for message in messages.iter_mut() {
        if message.role == Role::Assistant {
            for call in &mut message.tool_calls {
                if call.arguments.len() > 512 {
                    call.arguments = r#"{"context_evicted":"completed playlist work item"}"#.into();
                }
            }
        }
        if message.role == Role::Tool
            && message
                .content
                .as_ref()
                .is_some_and(|content| content.len() > 512)
        {
            message.content = Some(
                r#"{"context_evicted":"completed playlist work item; report-card events and Undo ledger preserved"}"#
                    .into(),
            );
        }
    }
    *context_chars = messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.content.as_ref())
        .map(String::len)
        .sum();
}

fn push_skipped_tool_result(messages: &mut Vec<LlmMessage>, call: &ToolCall) {
    // Over budget already this turn: don't dispatch further, but the protocol
    // still needs a result for every declared call, so the model is told the call
    // was skipped rather than left dangling.
    messages.push(LlmMessage::tool_result(
        &call.id,
        &call.name,
        r#"{"error":"skipped: evidence budget reached"}"#,
    ));
}

fn push_cancelled_tool_result(messages: &mut Vec<LlmMessage>, call: &ToolCall) {
    messages.push(LlmMessage::tool_result(
        &call.id,
        &call.name,
        r#"{"error":{"kind":"capture_cancelled","message":"skipped: playlist capture was cancelled before this call"}}"#,
    ));
}

fn push_stale_playlist_tool_result(messages: &mut Vec<LlmMessage>, call: &ToolCall) {
    messages.push(LlmMessage::tool_result(
        &call.id,
        &call.name,
        r#"{"error":{"kind":"stale_playlist_batch","message":"skipped: the playlist work item for this assistant batch has already resolved"}}"#,
    ));
}

fn emit_coverage(coverage: CoverageAcc, guard_tripped: bool, sink: &mut dyn EventSink) {
    let truncated = coverage.truncated || guard_tripped;

    // A conversational turn searched and read nothing, so an empty footer would be a
    // lie of precision — say nothing instead. But suppress only when the footer would
    // carry *no* information: a run can trip a guard (or skip files) having called
    // only `list_notes`/`list_folders`, which populate neither vector, and dropping
    // the footer there would hide the truncation. Partial coverage is visible, never
    // hidden (see `ChatEvent::Coverage`).
    if coverage.searched_terms.is_empty()
        && coverage.notes_read.is_empty()
        && !truncated
        && coverage.skipped_files == 0
    {
        return;
    }

    sink.send(ChatEvent::Coverage {
        searched_terms: coverage.searched_terms,
        notes_read: coverage.notes_read,
        // "Partial coverage" = the sweep was genuinely cut short: a loop guard
        // stopped it, OR the vault search hit its own global cap (`coverage.truncated`
        // now carries only that, not a routine per-search `max_results` clip).
        truncated,
        skipped_files: coverage.skipped_files,
    });
}

fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_string());
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

/// Extract the evidence ids the answer cited, in first-appearance order, deduped.
/// A citation is a `[eN]` marker (case-insensitive `e`, then ASCII digits). Byte
/// scanning is UTF-8-safe here: only ASCII bytes are ever matched or sliced on.
fn extract_cited_ids(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut ids = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some((id, next)) = citation_at(text, bytes, i) {
            if !ids.contains(&id) {
                ids.push(id);
            }
            i = next;
        } else {
            i += 1;
        }
    }
    ids
}

fn citation_at(text: &str, bytes: &[u8], open: usize) -> Option<(String, usize)> {
    if bytes[open] != b'[' {
        return None;
    }
    let mut j = open + 1;
    if !is_evidence_prefix(bytes, j) {
        return None;
    }
    j += 1;
    let digits_start = j;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start || j >= bytes.len() || bytes[j] != b']' {
        return None;
    }
    Some((format!("e{}", &text[digits_start..j]), j + 1))
}

fn is_evidence_prefix(bytes: &[u8], pos: usize) -> bool {
    pos < bytes.len() && (bytes[pos] == b'e' || bytes[pos] == b'E')
}

/// Max chars of prior-conversation history carried into a chat request. History is
/// otherwise unbounded — a long conversation resends every turn — and, combined with
/// the base tool-result budget (`Guards::max_context_chars`, 60k chars; a bounded
/// source-heavy skill may raise it), could push a local model's prompt past its
/// context window. Ollama then silently truncates from the
/// FRONT, dropping the grounding rules (sent first) and the earliest evidence — which
/// breaks cited recall, the moat. Sized conservatively so
/// `system + history + the active tool-result ceiling + the answer` stay within the smallest
/// supported local window (`local::OLLAMA_NUM_CTX` = 32_768 tokens) with headroom; the
/// large-context cloud provider is unaffected in practice, and the cap also bounds
/// per-turn token cost. Keeps the most recent turns; older ones drop (each turn
/// re-runs retrieval and re-grounds, so dropping old context never corrupts citations).
//
// This char cap is a COARSE first pass: it bounds cloud token *cost* and keeps history
// sane, but it can't see that CJK/symbol-dense text tokenises ~4× denser than the ~4
// chars/token it implicitly assumes. The authoritative window-fit is the token-aware
// second pass in `fit_prompt_to_window` (PA-029), applied to the fully assembled prompt
// right before each send.
const MAX_HISTORY_CHARS: usize = 12_000;

/// Remove every `[eN]` citation marker (and a single leading space) from prior-turn
/// text. Uses the same grammar as [`citation_at`], so it strips exactly what the
/// verifier would parse. Evidence ids are assigned fresh per run, so a marker carried
/// into a later turn refers to nothing in that turn's registry — and if the model
/// echoes it, the verifier can re-validate it against an *unrelated* freshly-retrieved
/// span, surfacing as a "verified" citation whose source text doesn't match the prose
/// claim (the exact mis-citation the moat forbids). History is plain context for the
/// model, so the markers add nothing; dropping them all closes the hole in the core,
/// not just the client. UTF-8-safe: markers are ASCII, so slices land on boundaries.
fn strip_cited_markers(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied_from = 0;
    let mut i = 0;
    while i < bytes.len() {
        if let Some((_, next)) = citation_at(text, bytes, i) {
            // Copy up to the marker, dropping one preceding space so
            // "a claim [e1]." becomes "a claim." (not "a claim .").
            let mut end = i;
            if end > copied_from && bytes[end - 1] == b' ' {
                end -= 1;
            }
            out.push_str(&text[copied_from..end]);
            copied_from = next;
            i = next;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[copied_from..]);
    out
}

/// Sanitise prior-conversation history before it re-enters a request: strip stale
/// `[eN]` markers (see [`strip_cited_markers`]) and window to the most recent
/// `MAX_HISTORY_CHARS` (see the const). This is the client-agnostic backstop for both
/// guards — a thin client can drop them for payload/cost, but correctness lives here in
/// the core so every client (and every provider) gets the same protection.
fn prepare_history(history: &[LlmMessage]) -> Vec<LlmMessage> {
    let mut kept: Vec<LlmMessage> = Vec::with_capacity(history.len());
    let mut used = 0usize;
    // Walk most-recent-first, keeping whole turns while the budget lasts; the newest
    // turn is always kept (never send empty history just because one turn is huge).
    for msg in history.iter().rev() {
        let mut msg = msg.clone();
        if let Some(content) = &msg.content {
            let cleaned = strip_cited_markers(content);
            let cost = cleaned.len();
            if !kept.is_empty() && used.saturating_add(cost) > MAX_HISTORY_CHARS {
                break;
            }
            used = used.saturating_add(cost);
            msg.content = Some(cleaned);
        }
        kept.push(msg);
    }
    kept.reverse();
    kept
}

// ── Token-aware context budgeting (PA-029) ──────────────────────────────────
//
// The char guards above (MAX_HISTORY_CHARS, Guards::max_context_chars) bound cloud
// token *cost* and keep the assembled prompt sane, but they measure CHARS. A CJK- or
// symbol-dense vault tokenises far denser than the ~4 chars/token those budgets assume,
// so the SUM of system + history + evidence can still blow past a small local window
// even with every char budget respected — at which point Ollama silently truncates from
// the FRONT, dropping the grounding rules (sent first) and breaking cited recall (the
// moat). `fit_prompt_to_window` is the authoritative second pass: it budgets the fully
// assembled prompt against the active model's window in *tokens* right before each send,
// deterministically dropping the OLDEST evidence/history while always preserving the
// grounding prefix and the newest evidence, and reporting any loss so it is never silent.

/// The local (Ollama) context window in tokens. Mirrors the shell's `OLLAMA_NUM_CTX`
/// (app/desktop/src-tauri/src/local.rs) — the value the sidecar is told to size its
/// window to. The core can't import it (host crate), so it is duplicated here with this
/// cross-reference; every curated local model supports it.
const LOCAL_CONTEXT_WINDOW_TOKENS: usize = 32_768;

/// Tokens held back from the window for the streamed answer, which shares the same
/// `num_ctx`. Mirrors [`crate::ai::openai::ANSWER_MAX_TOKENS`].
const ANSWER_RESERVE_TOKENS: usize = crate::ai::openai::ANSWER_MAX_TOKENS as usize;

/// Fixed headroom for chat-template special tokens plus the residual imprecision of a
/// char-classified estimate (rare multi-token CJK scalars / emoji that exceed 1 token).
/// Over-reserving only trims slightly early; under-reserving risks the silent
/// front-truncation this whole pass exists to prevent — so we err high.
const PROMPT_OVERHEAD_TOKENS: usize = 1_024;

/// Per-message framing overhead (the role marker and delimiters the chat template adds
/// around every message).
const PER_MESSAGE_OVERHEAD_TOKENS: usize = 8;

/// Chars of ASCII alphanumeric/whitespace text per token — the easy ~4:1 case.
const ASCII_CHARS_PER_TOKEN: usize = 4;

/// Appended to any single message head-truncated to fit the window, so the loss is
/// visible in-band as well as in the Coverage footer.
const TRUNCATION_MARKER: &str = "\n\n[older content trimmed to fit the model's context window]";

/// A conservative, script-aware UPPER-BOUND estimate of the BPE token count of `text`.
/// ASCII letters/digits/whitespace tokenise at ~4 chars/token; every other scalar —
/// ASCII punctuation/symbols AND all non-ASCII (CJK, etc.) — is counted as a whole
/// token, because dense scripts and symbol runs tokenise close to 1 token/char, far
/// above the flat ~4:1 the char budgets assume. We deliberately OVER-count so the budget
/// errs toward trimming a little early rather than letting Ollama silently front-truncate
/// the grounding (the moat). Accumulated in quarter-tokens to keep the 4:1 ratio without
/// floats, then rounded up.
fn estimate_tokens(text: &str) -> usize {
    let sub_tokens: usize = text.chars().map(char_sub_tokens).sum();
    sub_tokens.div_ceil(ASCII_CHARS_PER_TOKEN)
}

/// Sub-token weight of one scalar, in units of 1/[`ASCII_CHARS_PER_TOKEN`] of a token
/// (see [`estimate_tokens`]): 1 sub-token for easy ASCII (so `ASCII_CHARS_PER_TOKEN` of
/// them make a token), a whole token's worth for everything denser.
fn char_sub_tokens(ch: char) -> usize {
    if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
        1
    } else {
        ASCII_CHARS_PER_TOKEN
    }
}

/// Estimated tokens of one assembled message: its framing overhead plus its content,
/// tool-call names/arguments, and tool-result name — everything that reaches the wire.
fn message_tokens(message: &LlmMessage) -> usize {
    let mut tokens = PER_MESSAGE_OVERHEAD_TOKENS;
    if let Some(content) = &message.content {
        tokens += estimate_tokens(content);
    }
    for call in &message.tool_calls {
        tokens += estimate_tokens(&call.name) + estimate_tokens(&call.arguments);
    }
    if let Some(name) = &message.name {
        tokens += estimate_tokens(name);
    }
    tokens
}

fn total_tokens(messages: &[LlmMessage]) -> usize {
    messages.iter().map(message_tokens).sum()
}

/// The active model's context window in tokens, or `None` when this layer can't (and
/// needn't) clamp it. Only the local (Ollama) provider has the small fixed window that
/// silently front-truncates, and the shell refuses any non-curated local tag — so a
/// curated tag here IS the local path. Cloud (OpenRouter) ids never match the curated
/// list; their window is large, lives in the OpenRouter catalogue (unreachable from this
/// network-free core), and their cost is already bounded by the char guards — so cloud
/// returns `None` and is left to those guards.
fn context_window_tokens(model: &str) -> Option<usize> {
    crate::ai::local::is_curated_model(model).then_some(LOCAL_CONTEXT_WINDOW_TOKENS)
}

/// The assembled prompt after budgeting to the window, plus whether any content was
/// dropped or truncated (a coverage loss the caller must surface).
struct BudgetOutcome {
    messages: Vec<LlmMessage>,
    lost: bool,
}

/// Budget the fully assembled prompt to the active model's context window (see the
/// section comment above [`LOCAL_CONTEXT_WINDOW_TOKENS`]). Grounding (the leading system
/// prefix) and the newest evidence are always preserved; the oldest history/evidence is
/// dropped deterministically as whole protocol units; a lone evidence span larger than
/// the whole window is head-truncated with an explicit marker rather than allowed to push
/// grounding out. Cloud models are returned unchanged. The persistent `messages`
/// accumulator is never mutated — this returns the trimmed copy for one request.
fn fit_prompt_to_window(messages: &[LlmMessage], model: &str) -> BudgetOutcome {
    let Some(window) = context_window_tokens(model) else {
        return BudgetOutcome {
            messages: messages.to_vec(),
            lost: false,
        };
    };
    let budget = window
        .saturating_sub(ANSWER_RESERVE_TOKENS)
        .saturating_sub(PROMPT_OVERHEAD_TOKENS);
    if total_tokens(messages) <= budget {
        return BudgetOutcome {
            messages: messages.to_vec(),
            lost: false,
        };
    }
    trim_to_budget(messages, budget)
}

fn trim_to_budget(messages: &[LlmMessage], budget: usize) -> BudgetOutcome {
    let prefix_len = messages
        .iter()
        .take_while(|m| m.role == Role::System)
        .count();
    let (prefix, rest) = messages.split_at(prefix_len);
    let units = group_units(rest);
    let unit_tokens: Vec<usize> = units
        .iter()
        .map(|u| rest[u.clone()].iter().map(message_tokens).sum())
        .collect();
    // The current user question — the newest User-role unit — anchors the model's
    // intent and is pinned like the grounding prefix.
    let pinned_question = units.iter().rposition(|u| rest[u.start].role == Role::User);

    let mut keep = vec![false; units.len()];
    let mut used: usize = prefix.iter().map(message_tokens).sum();

    // The newest unit (freshest evidence, or the question itself on a conversational
    // turn) and the question are force-kept even if they alone overflow — a single
    // oversized span is head-truncated below, never dropped in favour of older evidence.
    for forced in [units.len().checked_sub(1), pinned_question]
        .into_iter()
        .flatten()
    {
        if !keep[forced] {
            keep[forced] = true;
            used += unit_tokens[forced];
        }
    }
    // Fill the remaining budget with the newest still-fitting history/evidence.
    for i in (0..units.len()).rev() {
        if !keep[i] && used + unit_tokens[i] <= budget {
            used += unit_tokens[i];
            keep[i] = true;
        }
    }

    let mut out = prefix.to_vec();
    let mut lost = false;
    for (i, unit) in units.iter().enumerate() {
        if keep[i] {
            out.extend_from_slice(&rest[unit.clone()]);
        } else {
            lost = true;
        }
    }
    // A single message larger than the whole window still overflows after unit
    // selection. Grounding is the hard invariant, so head-truncate the largest
    // non-system message instead of letting it push grounding out of the window.
    if total_tokens(&out) > budget {
        lost |= truncate_largest_to_fit(&mut out, budget);
    }
    BudgetOutcome {
        messages: out,
        lost,
    }
}

/// Group messages into protocol units so an assistant tool-call turn is never split
/// from its tool results: a unit starts at any non-`Tool` message; `Tool` results
/// attach to the unit before them. Returns index ranges into `messages`.
fn group_units(messages: &[LlmMessage]) -> Vec<std::ops::Range<usize>> {
    let mut units: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, message) in messages.iter().enumerate() {
        if message.role == Role::Tool {
            if let Some(last) = units.last_mut() {
                last.end = i + 1;
                continue;
            }
        }
        units.push(i..i + 1);
    }
    units
}

/// Head-truncate the largest non-system message until the whole prompt fits `budget`,
/// appending [`TRUNCATION_MARKER`]. Returns whether it truncated anything. Never touches
/// a system (grounding) message — grounding is the invariant the whole pass protects.
fn truncate_largest_to_fit(messages: &mut [LlmMessage], budget: usize) -> bool {
    let total = total_tokens(messages);
    if total <= budget {
        return false;
    }
    let Some(idx) = largest_droppable(messages) else {
        return false;
    };
    let content = messages[idx].content.as_deref().unwrap_or_default();
    let current = estimate_tokens(content);
    let overflow = total - budget;
    let marker_tokens = estimate_tokens(TRUNCATION_MARKER);
    let keep_tokens = current
        .saturating_sub(overflow)
        .saturating_sub(marker_tokens);
    messages[idx].content = Some(truncate_content_to_tokens(content, keep_tokens));
    true
}

fn largest_droppable(messages: &[LlmMessage]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role != Role::System && m.content.is_some())
        .max_by_key(|(_, m)| estimate_tokens(m.content.as_deref().unwrap_or_default()))
        .map(|(i, _)| i)
}

/// Keep the longest head of `content` whose estimate stays within `max_tokens`, then
/// append [`TRUNCATION_MARKER`]. UTF-8-safe: the cut always lands on a char boundary.
fn truncate_content_to_tokens(content: &str, max_tokens: usize) -> String {
    let cap = max_tokens.saturating_mul(ASCII_CHARS_PER_TOKEN);
    let mut sub_tokens = 0usize;
    let mut cut = 0usize;
    for (offset, ch) in content.char_indices() {
        let weight = char_sub_tokens(ch);
        if sub_tokens + weight > cap {
            break;
        }
        sub_tokens += weight;
        cut = offset + ch.len_utf8();
    }
    let mut out = String::with_capacity(cut + TRUNCATION_MARKER.len());
    out.push_str(&content[..cut]);
    out.push_str(TRUNCATION_MARKER);
    out
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
const RETRY_BACKOFF: Duration = Duration::from_millis(500);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::events::VecSink;
    use crate::ai::llm::{Completion, NoUserPrompt};
    use crate::ai::local::HardwareSpec;
    use crate::ai::retrieval::KeywordRetriever;
    use crate::ai::skills::{SkillEnvironment, SkillRegistry};
    use crate::ai::write_policy::UnavailableNoteWriter;
    use crate::ai::{
        CaptionPayload, CaptionRequest, CaptureCancellation, Elicitation, MetadataPayload,
        NotePathState, NoteWriteBackend, NoteWriteParent, OpenedNoteParent, PlaylistPayload,
        ThumbnailPayload, VideoId, YoutubeIo, YoutubeUrl, YOUTUBE_DISTIL_SKILL_ID,
    };
    use crate::capture::{CaptureError, PricingInput};
    use crate::error::CoreError;
    use async_trait::async_trait;
    use futures::executor::block_on;
    use std::collections::{BTreeSet, VecDeque};
    use std::fs;
    use std::fs::OpenOptions;
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[test]
    fn system_prompt_defines_converse_and_research_modes() {
        assert!(SYSTEM_PROMPT.contains("CONVERSE"));
        assert!(SYSTEM_PROMPT.contains("RESEARCH"));
    }

    #[test]
    fn system_prompt_scopes_the_search_mandate_to_research_mode() {
        let research = SYSTEM_PROMPT.find("RESEARCH").expect("RESEARCH mode");
        let search_mandate = SYSTEM_PROMPT
            .find("Issue 3 to 8 varied searches")
            .expect("research search mandate");

        assert!(search_mandate > research);
    }

    #[test]
    fn system_prompt_does_not_promise_unavailable_capture_skills() {
        let prompt = SYSTEM_PROMPT.to_lowercase();

        assert!(!prompt.contains("youtube"));
        assert!(!prompt.contains("distil"));
        assert!(!prompt.contains("pdf"));
    }

    #[test]
    fn coverage_is_suppressed_on_a_conversational_turn() {
        // "hello" searches nothing and reads nothing. An empty footer is a lie of
        // precision, so emit no footer at all.
        let mut sink = VecSink::default();
        emit_coverage(CoverageAcc::default(), false, &mut sink);
        assert!(sink.events.is_empty());
    }

    #[test]
    fn coverage_still_reports_a_tripped_guard_with_no_searches() {
        // `list_notes` / `list_folders` yield `ToolOutcome::Listed`, populating neither
        // `searched_terms` nor `notes_read` — yet they can still trip `max_iterations`
        // or `max_context_chars`. Suppressing the footer there would hide the
        // truncation, and "partial coverage is visible, never hidden" (events.rs).
        let mut sink = VecSink::default();
        emit_coverage(CoverageAcc::default(), true, &mut sink);
        assert!(
            matches!(
                sink.events.as_slice(),
                [ChatEvent::Coverage {
                    truncated: true,
                    ..
                }]
            ),
            "a cut-short run must surface its truncation, got {:?}",
            sink.events
        );
    }

    #[test]
    fn coverage_still_reports_skipped_files_with_no_searches() {
        let coverage = CoverageAcc {
            skipped_files: 3,
            ..CoverageAcc::default()
        };
        let mut sink = VecSink::default();
        emit_coverage(coverage, false, &mut sink);
        assert!(
            matches!(
                sink.events.as_slice(),
                [ChatEvent::Coverage {
                    skipped_files: 3,
                    ..
                }]
            ),
            "skipped files must never be silently dropped, got {:?}",
            sink.events
        );
    }

    /// A scripted, network-free [`LlmClient`]. `completions` are popped by each
    /// `complete` turn; `answer` is streamed by `complete_streaming`. An optional
    /// `before_answer` hook fires just before streaming, letting a test mutate the
    /// vault to simulate an external edit landing mid-answer.
    struct MockLlmClient {
        completions: Mutex<VecDeque<Completion>>,
        answer: String,
        fail: bool,
        /// The number of tools the last `complete_streaming` call was handed — so a
        /// test can assert the answer turn advertises none.
        streaming_tools_len: Mutex<Option<usize>>,
        /// Reasoning deltas streamed as `Thinking` events before the answer, so a test
        /// can assert reasoning reaches the sink without polluting the answer string.
        reasoning: Vec<String>,
        #[allow(clippy::type_complexity)]
        before_answer: Option<Box<dyn Fn() + Send + Sync>>,
        max_request_chars: std::sync::atomic::AtomicUsize,
        completion_requests: Mutex<Vec<Vec<LlmMessage>>>,
        streaming_messages: Mutex<Vec<LlmMessage>>,
        /// Errors returned by successive `complete` calls before normal scripting takes
        /// over — lets a test script a transient failure then a success.
        pending_complete_errors: Mutex<VecDeque<CoreError>>,
        /// If set, every `complete_streaming` call returns this error (to prove the
        /// streamed answer turn is never retried).
        streaming_error: Mutex<Option<CoreError>>,
        streaming_attempts: std::sync::atomic::AtomicUsize,
    }

    impl MockLlmClient {
        fn new(completions: Vec<Completion>, answer: &str) -> Self {
            Self {
                completions: Mutex::new(completions.into()),
                answer: answer.into(),
                fail: false,
                streaming_tools_len: Mutex::new(None),
                reasoning: Vec::new(),
                before_answer: None,
                max_request_chars: std::sync::atomic::AtomicUsize::new(0),
                completion_requests: Mutex::new(Vec::new()),
                streaming_messages: Mutex::new(Vec::new()),
                pending_complete_errors: Mutex::new(VecDeque::new()),
                streaming_error: Mutex::new(None),
                streaming_attempts: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn failing() -> Self {
            Self {
                completions: Mutex::new(VecDeque::new()),
                answer: String::new(),
                fail: true,
                streaming_tools_len: Mutex::new(None),
                reasoning: Vec::new(),
                before_answer: None,
                max_request_chars: std::sync::atomic::AtomicUsize::new(0),
                completion_requests: Mutex::new(Vec::new()),
                streaming_messages: Mutex::new(Vec::new()),
                pending_complete_errors: Mutex::new(VecDeque::new()),
                streaming_error: Mutex::new(None),
                streaming_attempts: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        /// Script the first N `complete` calls to fail with these errors (in order),
        /// then fall through to the normal completion queue.
        fn with_complete_failures(self, errors: Vec<CoreError>) -> Self {
            *self.pending_complete_errors.lock().unwrap() = errors.into();
            self
        }

        /// Make every `complete_streaming` call fail with this error.
        fn with_streaming_failure(self, error: CoreError) -> Self {
            *self.streaming_error.lock().unwrap() = Some(error);
            self
        }

        fn streaming_attempts(&self) -> usize {
            self.streaming_attempts
                .load(std::sync::atomic::Ordering::SeqCst)
        }

        fn with_hook(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
            self.before_answer = Some(Box::new(f));
            self
        }

        fn with_reasoning(mut self, deltas: &[&str]) -> Self {
            self.reasoning = deltas.iter().map(|d| d.to_string()).collect();
            self
        }

        fn max_request_chars(&self) -> usize {
            self.max_request_chars
                .load(std::sync::atomic::Ordering::SeqCst)
        }

        fn completion_requests(&self) -> Vec<Vec<LlmMessage>> {
            self.completion_requests.lock().unwrap().clone()
        }

        fn streaming_messages(&self) -> Vec<LlmMessage> {
            self.streaming_messages.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl LlmClient for MockLlmClient {
        async fn complete(&self, req: &LlmRequest) -> CoreResult<Completion> {
            let request_chars = serde_json::to_string(&req.messages).unwrap().len();
            self.max_request_chars
                .fetch_max(request_chars, std::sync::atomic::Ordering::SeqCst);
            self.completion_requests
                .lock()
                .unwrap()
                .push(req.messages.clone());
            if let Some(error) = self.pending_complete_errors.lock().unwrap().pop_front() {
                return Err(error);
            }
            if self.fail {
                return Err(CoreError::Llm("mock transport failure: boom".into()));
            }
            // Default to a no-tool-call turn if the script runs dry (ends the loop).
            Ok(self
                .completions
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Completion {
                    content: Some(String::new()),
                    tool_calls: Vec::new(),
                }))
        }

        async fn complete_streaming(
            &self,
            req: &LlmRequest,
            sink: &mut dyn EventSink,
        ) -> CoreResult<String> {
            self.streaming_attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *self.streaming_tools_len.lock().unwrap() = Some(req.tools.len());
            *self.streaming_messages.lock().unwrap() = req.messages.clone();
            if let Some(error) = self.streaming_error.lock().unwrap().clone() {
                return Err(error);
            }
            if let Some(hook) = &self.before_answer {
                hook();
            }
            // Reasoning, if any, streams as Thinking before the answer — mirroring the
            // real client, and never folded into the returned answer string.
            for delta in &self.reasoning {
                sink.send(ChatEvent::Thinking {
                    delta: delta.clone(),
                });
            }
            for chunk in self.answer.split_inclusive(' ') {
                sink.send(ChatEvent::Answer {
                    delta: chunk.to_string(),
                });
            }
            Ok(self.answer.clone())
        }
    }

    fn tool_call(id: &str, name: &str, args: &str) -> Completion {
        Completion {
            content: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.into(),
            }],
        }
    }

    fn final_turn() -> Completion {
        Completion {
            content: Some("ready".into()),
            tool_calls: Vec::new(),
        }
    }

    /// One turn that issues several search calls at once (to exercise the mid-turn
    /// cap check).
    fn multi_search(queries: &[&str]) -> Completion {
        Completion {
            content: None,
            tool_calls: queries
                .iter()
                .enumerate()
                .map(|(i, q)| ToolCall {
                    id: format!("c{i}"),
                    name: "search_notes".into(),
                    arguments: format!(r#"{{"query":"{q}"}}"#),
                })
                .collect(),
        }
    }

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Research")).unwrap();
        fs::write(
            dir.path().join("Research/widgets.md"),
            "# Widgets\n\nWidgets are small components.\nThey snap together.\n",
        )
        .unwrap();
        dir
    }

    struct PlaylistPrompt(Mutex<VecDeque<Option<Vec<String>>>>);

    #[async_trait]
    impl UserPrompt for PlaylistPrompt {
        async fn ask(&self, _elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
            Ok(self.0.lock().unwrap().pop_front().flatten())
        }
    }

    struct PlaylistIo(usize);

    #[async_trait]
    impl YoutubeIo for PlaylistIo {
        async fn inspect_metadata(
            &self,
            _url: &YoutubeUrl,
        ) -> Result<MetadataPayload, CaptureError> {
            Err(CaptureError::MetadataUnavailable(
                "unused in this script".into(),
            ))
        }

        async fn fetch_caption_vtt(
            &self,
            _request: &CaptionRequest,
        ) -> Result<CaptionPayload, CaptureError> {
            Err(CaptureError::CaptionsAbsent("unused in this script".into()))
        }

        async fn enumerate_playlist(
            &self,
            _url: &YoutubeUrl,
        ) -> Result<PlaylistPayload, CaptureError> {
            let entries = (0..self.0)
                .map(|index| {
                    serde_json::json!({
                        "id": format!("V{index:010}"),
                        "title": format!("Realistic lecture {index}"),
                        "duration": 3600,
                    })
                })
                .collect::<Vec<_>>();
            Ok(PlaylistPayload {
                json: serde_json::to_vec(&serde_json::json!({
                    "_type": "playlist",
                    "id": "PL-orchestrator_21",
                    "title": "Twenty-one lectures",
                    "entries": entries,
                }))
                .unwrap(),
            })
        }

        async fn fetch_thumbnail(
            &self,
            _video_id: &VideoId,
        ) -> Result<ThumbnailPayload, CaptureError> {
            Err(CaptureError::ThumbnailRejected(
                "fixture has no image".into(),
            ))
        }

        async fn transcribe_audio(
            &self,
            _url: &YoutubeUrl,
            _model: &str,
            _cancellation: &CaptureCancellation,
        ) -> Result<CaptionPayload, CaptureError> {
            Err(CaptureError::TranscriptionFailed(
                "unused in this script".into(),
            ))
        }

        async fn update_extractor(&self) -> Result<(), CaptureError> {
            Err(CaptureError::ExtractorStale("unused in this script".into()))
        }
    }

    #[derive(Default)]
    struct GuardedPlaylistIo {
        enumerations: std::sync::atomic::AtomicUsize,
        capture_calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl YoutubeIo for GuardedPlaylistIo {
        async fn inspect_metadata(
            &self,
            _url: &YoutubeUrl,
        ) -> Result<MetadataPayload, CaptureError> {
            self.capture_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(CaptureError::MetadataUnavailable(
                "host capture should not be reached".into(),
            ))
        }

        async fn fetch_caption_vtt(
            &self,
            _request: &CaptionRequest,
        ) -> Result<CaptionPayload, CaptureError> {
            self.capture_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(CaptureError::CaptionsAbsent(
                "host capture should not be reached".into(),
            ))
        }

        async fn enumerate_playlist(
            &self,
            _url: &YoutubeUrl,
        ) -> Result<PlaylistPayload, CaptureError> {
            self.enumerations
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(PlaylistPayload {
                json: serde_json::to_vec(&serde_json::json!({
                    "_type": "playlist",
                    "id": "PL-guarded_2",
                    "title": "Guarded playlist",
                    "entries": [
                        {"id":"V0000000000","title":"First","duration":60},
                        {"id":"V0000000001","title":"Second","duration":60}
                    ],
                }))
                .unwrap(),
            })
        }

        async fn fetch_thumbnail(
            &self,
            _video_id: &VideoId,
        ) -> Result<ThumbnailPayload, CaptureError> {
            Err(CaptureError::ThumbnailRejected(
                "fixture has no image".into(),
            ))
        }

        async fn transcribe_audio(
            &self,
            _url: &YoutubeUrl,
            _model: &str,
            _cancellation: &CaptureCancellation,
        ) -> Result<CaptionPayload, CaptureError> {
            self.capture_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(CaptureError::TranscriptionFailed(
                "host capture should not be reached".into(),
            ))
        }

        async fn update_extractor(&self) -> Result<(), CaptureError> {
            Ok(())
        }
    }

    struct FsParent(PathBuf);

    impl NoteWriteParent for FsParent {
        fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
            match fs::symlink_metadata(self.0.join(leaf)) {
                Ok(metadata) if metadata.file_type().is_file() => Ok(NotePathState::RegularFile {
                    actual_name: leaf.to_string(),
                }),
                Ok(_) => Ok(NotePathState::Other),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(NotePathState::Missing)
                }
                Err(error) => Err(CoreError::Io(error.to_string())),
            }
        }

        fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.0.join(leaf))
                .map_err(|error| CoreError::Io(error.to_string()))?;
            file.write_all(content.as_bytes())
                .map_err(|error| CoreError::Io(error.to_string()))
        }
    }

    struct FsWriter;

    impl NoteWriteBackend for FsWriter {
        fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
            fs::canonicalize(path).map_err(|error| CoreError::Io(error.to_string()))
        }

        fn open_parent(
            &self,
            canonical_root: &Path,
            canonical_parent: &Path,
        ) -> CoreResult<OpenedNoteParent> {
            let opened = fs::canonicalize(canonical_parent)
                .map_err(|error| CoreError::Io(error.to_string()))?;
            if !opened.starts_with(canonical_root) {
                return Err(CoreError::OutsideVault(opened.display().to_string()));
            }
            Ok(OpenedNoteParent::new(
                opened.clone(),
                Box::new(FsParent(opened)),
            ))
        }
    }

    struct CancellingParent {
        path: PathBuf,
        cancellation: CaptureCancellation,
    }

    impl NoteWriteParent for CancellingParent {
        fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
            FsParent(self.path.clone()).probe(leaf)
        }

        fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
            FsParent(self.path.clone()).create_new_all_or_nothing(leaf, content)?;
            self.cancellation.cancel();
            Ok(())
        }
    }

    struct CancellingWriter(CaptureCancellation);

    impl NoteWriteBackend for CancellingWriter {
        fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
            FsWriter.canonicalize(path)
        }

        fn open_parent(
            &self,
            canonical_root: &Path,
            canonical_parent: &Path,
        ) -> CoreResult<OpenedNoteParent> {
            let opened = fs::canonicalize(canonical_parent)
                .map_err(|error| CoreError::Io(error.to_string()))?;
            if !opened.starts_with(canonical_root) {
                return Err(CoreError::OutsideVault(opened.display().to_string()));
            }
            Ok(OpenedNoteParent::new(
                opened.clone(),
                Box::new(CancellingParent {
                    path: opened,
                    cancellation: self.0.clone(),
                }),
            ))
        }
    }

    fn realistic_transcript(video_id: &str) -> String {
        let cues = (0..120)
            .map(|cue| {
                format!(
                    "[00:{:02}:{:02}](https://youtu.be/{video_id}?t={}) Lecture sentence {cue} explains a concrete idea with enough detail for distillation.",
                    cue / 60,
                    cue % 60,
                    cue
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("---\nnn:\n  source:\n    youtubeId: {video_id}\n---\n\n{cues}\n")
    }

    fn youtube_test_environment() -> SkillEnvironment {
        SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 8 * 1024 * 1024 * 1024,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 2_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
        }
    }

    #[test]
    fn playlist_orchestrator_processes_21_transcripts_with_bounded_context_and_full_partial_ledger()
    {
        let vault = tempfile::tempdir().unwrap();
        let selected = (0..21)
            .map(|index| format!("V{index:010}"))
            .collect::<Vec<_>>();
        let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([
            Some(selected.clone()),
            Some(vec!["continue".into()]),
        ])));
        let mut script = vec![tool_call(
            "select",
            "select_playlist_videos",
            r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_21"}"#,
        )];
        for (work_item, video_id) in selected.iter().enumerate() {
            let transcript = realistic_transcript(video_id);
            script.push(Completion {
                content: None,
                tool_calls: vec![
                    ToolCall {
                        id: format!("literature-{work_item}"),
                        name: "write_note".into(),
                        arguments: serde_json::json!({
                            "rel_path": format!("literature-{work_item}.md"),
                            "content": format!("# Lecture {work_item}\n\nDistilled from {video_id}."),
                            "kind": "literature",
                            "work_item": work_item,
                        })
                        .to_string(),
                    },
                    ToolCall {
                        id: format!("transcript-{work_item}"),
                        name: "write_note".into(),
                        arguments: serde_json::json!({
                            "rel_path": format!("transcript-{work_item}.md"),
                            "content": transcript,
                            "kind": "transcript",
                            "work_item": work_item,
                        })
                        .to_string(),
                    },
                ],
            });
        }
        let llm = MockLlmClient::new(script, "Playlist complete.");
        let retriever = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 8 * 1024 * 1024 * 1024,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 2_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
        };
        let pricing = PricingInput::Local;
        let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
            .with_youtube_io(&PlaylistIo(21))
            .with_pricing(&pricing);
        let mut sink = VecSink::default();
        let ledger = block_on(run_chat(
            "Distil this playlist",
            &[],
            vec![YOUTUBE_DISTIL_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        ))
        .unwrap();

        assert_eq!(
            ledger.entries().len(),
            42,
            "every item keeps both Undo entries"
        );
        assert_eq!(
            count(&sink.events, |event| matches!(
                event,
                ChatEvent::NoteWritten { .. }
            )),
            42,
            "context eviction must not discard partial report-card events"
        );
        for video_id in selected {
            assert!(sink.events.iter().any(|event| {
                matches!(event, ChatEvent::SkillStep { message } if message.contains(&video_id) && message.contains("succeeded"))
            }), "missing explicit outcome for {video_id}");
        }
        assert!(
            llm.max_request_chars() < 120_000,
            "completed transcript context was not evicted: {} chars",
            llm.max_request_chars()
        );
        let streaming_messages = llm.streaming_messages();
        let work_item_turns = streaming_messages
            .iter()
            .filter(|message| message.role == Role::Assistant)
            .filter_map(|message| {
                let ids = message
                    .tool_calls
                    .iter()
                    .map(|call| call.id.clone())
                    .collect::<Vec<_>>();
                ids.iter()
                    .any(|id| id.starts_with("literature-"))
                    .then_some(ids)
            })
            .collect::<Vec<_>>();
        assert_eq!(work_item_turns.len(), 21);
        for (index, ids) in work_item_turns.iter().enumerate() {
            assert_eq!(
                ids,
                &vec![format!("literature-{index}"), format!("transcript-{index}"),],
                "work item {index} must finish both required writes before the next item"
            );
        }
        let final_context = streaming_messages
            .iter()
            .filter_map(|message| message.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(final_context.contains("PLAYLIST EXECUTION SUMMARY"));
        assert!(final_context.contains("V0000000000: succeeded"));
        assert!(final_context.contains("V0000000020: succeeded"));
        assert_eq!(llm.completion_requests().len(), 22);
    }

    #[test]
    fn playlist_cancellation_inside_a_batched_turn_skips_later_calls_and_keeps_partial_ledger() {
        let vault = tempfile::tempdir().unwrap();
        let selected = vec!["V0000000000".to_string(), "V0000000001".to_string()];
        let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(selected)])));
        let batch = Completion {
            content: None,
            tool_calls: (0..2)
                .flat_map(|work_item| {
                    ["literature", "transcript"].map(move |kind| ToolCall {
                        id: format!("{kind}-{work_item}"),
                        name: "write_note".into(),
                        arguments: serde_json::json!({
                            "rel_path": format!("{kind}-{work_item}.md"),
                            "content": format!("# {kind} {work_item}"),
                            "kind": kind,
                            "work_item": work_item,
                        })
                        .to_string(),
                    })
                })
                .collect(),
        };
        let llm = MockLlmClient::new(
            vec![
                tool_call(
                    "select",
                    "select_playlist_videos",
                    r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_2"}"#,
                ),
                batch,
            ],
            "Cancelled with partial results.",
        );
        let retriever = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 8 * 1024 * 1024 * 1024,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 2_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
        };
        let cancellation = CaptureCancellation::default();
        let writer = CancellingWriter(cancellation.clone());
        let services = SkillServices::new(&skills, &environment, &prompt, &writer, 1)
            .with_youtube_io(&PlaylistIo(2))
            .with_capture_cancellation(cancellation);
        let mut sink = VecSink::default();
        let ledger = block_on(run_chat(
            "Distil this playlist",
            &[],
            vec![YOUTUBE_DISTIL_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        ))
        .unwrap();

        assert_eq!(ledger.entries().len(), 1);
        assert_eq!(
            count(&sink.events, |event| matches!(
                event,
                ChatEvent::NoteWritten { .. }
            )),
            1
        );
        assert!(vault.path().join("literature-0.md").exists());
        assert!(!vault.path().join("transcript-0.md").exists());
        assert!(!vault.path().join("literature-1.md").exists());
        assert!(!vault.path().join("transcript-1.md").exists());
        for video_id in ["V0000000000", "V0000000001"] {
            assert!(sink.events.iter().any(|event| {
                matches!(event, ChatEvent::SkillStep { message } if message.contains(video_id) && message.contains("cancelled"))
            }));
        }
        let final_context = llm
            .streaming_messages()
            .iter()
            .filter_map(|message| message.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(final_context.matches("capture_cancelled").count(), 3);
    }

    #[test]
    fn rejected_playlist_batch_cannot_cascade_into_the_next_work_item() {
        let vault = tempfile::tempdir().unwrap();
        let selected = vec!["V0000000000".to_string(), "V0000000001".to_string()];
        let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(selected)])));
        let stale_old_item_write = |kind: &str| ToolCall {
            id: format!("stale-{kind}"),
            name: "write_note".into(),
            arguments: serde_json::json!({
                "rel_path": format!("stale-{kind}.md"),
                "content": "must never be written",
                "kind": kind,
                "work_item": 0,
            })
            .to_string(),
        };
        let hostile_batch = Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: "reject-item-0".into(),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": "../escape.md",
                        "content": "reject this",
                        "kind": "literature",
                        "work_item": 0,
                    })
                    .to_string(),
                },
                stale_old_item_write("literature"),
                stale_old_item_write("transcript"),
            ],
        };
        let next_item = Completion {
            content: None,
            tool_calls: ["literature", "transcript"]
                .into_iter()
                .map(|kind| ToolCall {
                    id: format!("next-{kind}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("next-{kind}.md"),
                        "content": format!("# Next {kind}"),
                        "kind": kind,
                        "work_item": 1,
                    })
                    .to_string(),
                })
                .collect(),
        };
        let llm = MockLlmClient::new(
            vec![
                tool_call(
                    "select",
                    "select_playlist_videos",
                    r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-orchestrator_2"}"#,
                ),
                hostile_batch,
                next_item,
            ],
            "Partial playlist complete.",
        );
        let retriever = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 8 * 1024 * 1024 * 1024,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 2_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::from([PathBuf::from("/app-data/bin/yt-dlp")]),
        };
        let services = SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1)
            .with_youtube_io(&PlaylistIo(2));
        let mut sink = VecSink::default();
        let ledger = block_on(run_chat(
            "Distil this playlist",
            &[],
            vec![YOUTUBE_DISTIL_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        ))
        .unwrap();

        assert_eq!(ledger.entries().len(), 2);
        assert!(!vault.path().join("stale-literature.md").exists());
        assert!(!vault.path().join("stale-transcript.md").exists());
        assert!(vault.path().join("next-literature.md").exists());
        assert!(vault.path().join("next-transcript.md").exists());
        let steps = sink
            .events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::SkillStep { message } => Some(message.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            steps
                .iter()
                .filter(|message| message.contains("V0000000000 failed"))
                .count(),
            1
        );
        assert!(steps
            .iter()
            .any(|message| message.contains("V0000000001 succeeded")));
        assert!(!steps
            .iter()
            .any(|message| message.contains("V0000000001 failed")));
        let final_context = llm
            .streaming_messages()
            .iter()
            .filter_map(|message| message.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(final_context.matches("stale_playlist_batch").count(), 2);
    }

    #[test]
    fn playlist_capture_rejects_cross_video_and_unselected_urls_before_host_io() {
        let vault = tempfile::tempdir().unwrap();
        let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(vec![
            "V0000000000".into(),
            "V0000000001".into(),
        ])])));
        let hostile_batch = Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: "prefetch-next".into(),
                    name: "fetch_video_info".into(),
                    arguments: r#"{"url":"https://youtu.be/V0000000001"}"#.into(),
                },
                ToolCall {
                    id: "arbitrary-unselected".into(),
                    name: "fetch_captions".into(),
                    arguments: r#"{"url":"https://youtu.be/jNQXAC9IVRw","lang":"en"}"#.into(),
                },
            ],
        };
        let next_item = Completion {
            content: None,
            tool_calls: ["literature", "transcript"]
                .into_iter()
                .map(|kind| ToolCall {
                    id: format!("item-1-{kind}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("item-1-{kind}.md"),
                        "content": format!("# Item 1 {kind}"),
                        "kind": kind,
                        "work_item": 1,
                    })
                    .to_string(),
                })
                .collect(),
        };
        let llm = MockLlmClient::new(
            vec![
                tool_call(
                    "select",
                    "select_playlist_videos",
                    r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-guarded_2"}"#,
                ),
                hostile_batch,
                next_item,
            ],
            "Partial playlist complete.",
        );
        let io = GuardedPlaylistIo::default();
        let retriever = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = youtube_test_environment();
        let services =
            SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1).with_youtube_io(&io);
        let mut sink = VecSink::default();
        let ledger = block_on(run_chat(
            "Distil this playlist",
            &[],
            vec![YOUTUBE_DISTIL_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        ))
        .unwrap();

        assert_eq!(
            io.capture_calls.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(ledger.entries().len(), 2);
        assert!(vault.path().join("item-1-literature.md").exists());
        assert!(vault.path().join("item-1-transcript.md").exists());
        assert!(sink.events.iter().any(|event| {
            matches!(event, ChatEvent::SkillStep { message } if message.contains("V0000000000 failed"))
        }));
        assert!(sink.events.iter().any(|event| {
            matches!(event, ChatEvent::SkillStep { message } if message.contains("V0000000001 succeeded"))
        }));
        let final_context = llm
            .streaming_messages()
            .iter()
            .filter_map(|message| message.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(final_context.matches("stale_playlist_batch").count(), 1);
    }

    #[test]
    fn nested_playlist_batch_is_stale_without_replacing_or_advancing_the_original_run() {
        let vault = tempfile::tempdir().unwrap();
        let prompt = PlaylistPrompt(Mutex::new(VecDeque::from([Some(vec![
            "V0000000000".into(),
            "V0000000001".into(),
        ])])));
        let nested_batch = Completion {
            content: None,
            tool_calls: vec![
                ToolCall {
                    id: "nested-select".into(),
                    name: "select_playlist_videos".into(),
                    arguments: r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-replacement"}"#.into(),
                },
                ToolCall {
                    id: "stale-after-nested".into(),
                    name: "write_note".into(),
                    arguments: r#"{"rel_path":"must-not-exist.md","content":"stale","kind":"literature","work_item":0}"#.into(),
                },
            ],
        };
        let write_turn = |work_item: usize| Completion {
            content: None,
            tool_calls: ["literature", "transcript"]
                .into_iter()
                .map(|kind| ToolCall {
                    id: format!("item-{work_item}-{kind}"),
                    name: "write_note".into(),
                    arguments: serde_json::json!({
                        "rel_path": format!("item-{work_item}-{kind}.md"),
                        "content": format!("# Item {work_item} {kind}"),
                        "kind": kind,
                        "work_item": work_item,
                    })
                    .to_string(),
                })
                .collect(),
        };
        let llm = MockLlmClient::new(
            vec![
                tool_call(
                    "select",
                    "select_playlist_videos",
                    r#"{"playlist_url":"https://www.youtube.com/playlist?list=PL-guarded_2"}"#,
                ),
                nested_batch,
                write_turn(0),
                write_turn(1),
            ],
            "Playlist complete.",
        );
        let io = GuardedPlaylistIo::default();
        let retriever = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = youtube_test_environment();
        let services =
            SkillServices::new(&skills, &environment, &prompt, &FsWriter, 1).with_youtube_io(&io);
        let mut sink = VecSink::default();
        let ledger = block_on(run_chat(
            "Distil this playlist",
            &[],
            vec![YOUTUBE_DISTIL_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        ))
        .unwrap();

        assert_eq!(io.enumerations.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(ledger.entries().len(), 4);
        assert!(!vault.path().join("must-not-exist.md").exists());
        assert!(!sink.events.iter().any(|event| {
            matches!(event, ChatEvent::SkillStep { message } if message.contains("failed"))
        }));
        let final_context = llm
            .streaming_messages()
            .iter()
            .filter_map(|message| message.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(final_context.matches("stale_playlist_batch").count(), 1);
        assert!(final_context.contains("V0000000000: succeeded"));
        assert!(final_context.contains("V0000000001: succeeded"));
    }

    fn run(root: &Path, mock: &MockLlmClient, guards: &Guards) -> Vec<ChatEvent> {
        let retriever = KeywordRetriever::new(root);
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 1,
                cpu_cores: 1,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 1,
            },
            app_data_bin_dir: std::path::PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::new(),
        };
        let services = SkillServices::new(
            &skills,
            &environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let mut sink = VecSink::default();
        block_on(run_chat(
            "how do widgets work?",
            &[],
            Vec::new(),
            root,
            "test-model",
            &retriever,
            mock,
            &services,
            &mut sink,
            guards,
        ))
        .unwrap();
        sink.events
    }

    #[test]
    fn terminal_skill_recovery_finishes_every_parallel_tool_result_before_stopping() {
        let vault = tempfile::tempdir().unwrap();
        let provider = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 16_000_000_000,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 10_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::new(),
        };
        let calls = vec![
            ToolCall {
                id: "missing-ytdlp".into(),
                name: tools::TOOL_USE_SKILL.into(),
                arguments: format!(r#"{{"id":"{YOUTUBE_DISTIL_SKILL_ID}"}}"#),
            },
            ToolCall {
                id: "sibling-skill".into(),
                name: tools::TOOL_USE_SKILL.into(),
                arguments: format!(r#"{{"id":"{}"}}"#, crate::ai::FIXTURE_SKILL_ID),
            },
        ];
        let llm = MockLlmClient::new(
            vec![Completion {
                content: None,
                tool_calls: calls.clone(),
            }],
            "must not stream",
        );
        let services = SkillServices::new(
            &skills,
            &environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let guards = Guards::default();
        let session = ChatSession {
            root: vault.path(),
            model: "test-model",
            provider: &provider,
            llm: &llm,
            skill_services: &services,
            guards: &guards,
        };
        let mut messages = vec![LlmMessage::system("system"), LlmMessage::user("capture")];
        let mut active_skills = ActiveSkills::new(guards.max_iterations);
        let mut writes = WriteSession::new(1).unwrap();
        let mut youtube_session = YoutubeToolSession::new_with_update_session(
            services.capture_cancellation.clone(),
            services.extractor_updates.clone(),
        );
        let mut registry = EvidenceRegistry::new();
        let mut coverage = CoverageAcc::default();
        let mut sink = VecSink::default();

        let outcome = block_on(session.collect_evidence(
            &mut messages,
            &mut active_skills,
            &mut writes,
            &mut youtube_session,
            &mut registry,
            &mut coverage,
            &mut sink,
        ))
        .unwrap();

        assert!(matches!(outcome, EvidenceCollection::CompleteTurn));
        assert_eq!(llm.completion_requests().len(), 1);
        assert!(llm.streaming_messages().is_empty());
        assert!(!sink
            .events
            .iter()
            .any(|event| matches!(event, ChatEvent::Verifying | ChatEvent::Answer { .. })));
        let result_ids = messages
            .iter()
            .filter(|message| message.role == Role::Tool)
            .filter_map(|message| message.tool_call_id.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(result_ids, ["missing-ytdlp", "sibling-skill"]);
        assert!(active_skills.contains(crate::ai::FIXTURE_SKILL_ID));
    }

    fn count(events: &[ChatEvent], pred: impl Fn(&ChatEvent) -> bool) -> usize {
        events.iter().filter(|e| pred(e)).count()
    }

    // ── §7 behavioural eval — plumbing tier ─────────────────────────────────
    // The five spec-§7 cases run against the scripted MockLlmClient. Because the
    // SCRIPT (not the model) decides whether a tool call fires, this tier proves
    // PLUMBING only: the orchestrator injects no mandatory retrieval before the
    // model's first turn (a no-tool script yields zero Searching), a zero-search
    // turn emits no Coverage, and search/citation counts flow through intact. It
    // CANNOT prove the model chooses to search — that is the network-gated
    // real-model tier in app/desktop/src-tauri/tests/behavioural_eval.rs.
    //
    // The zero-search-but-still-emit-Coverage guardrail (a list-only run tripping a
    // guard or skipping files) is already proven by
    // coverage_still_reports_a_tripped_guard_with_no_searches and
    // coverage_still_reports_skipped_files_with_no_searches — not duplicated here.
    #[test]
    fn eval_plumbs_the_five_section_7_cases_through_the_mock() {
        struct EvalCase {
            label: &'static str,
            script: Vec<Completion>,
            answer: &'static str,
            search_bounds: std::ops::RangeInclusive<usize>,
            citation_bounds: std::ops::RangeInclusive<usize>,
            coverage_bounds: std::ops::RangeInclusive<usize>,
        }

        let cases = [
            EvalCase {
                label: "Case 1 Greeting",
                script: vec![final_turn()],
                answer: "Hey! What would you like to explore?",
                search_bounds: 0..=0,
                citation_bounds: 0..=0,
                coverage_bounds: 0..=0,
            },
            EvalCase {
                label: "Case 2 Meta",
                script: vec![final_turn()],
                answer: "I can help you think with and search your notes.",
                search_bounds: 0..=0,
                citation_bounds: 0..=0,
                coverage_bounds: 0..=0,
            },
            EvalCase {
                label: "Case 3 Factual-in-vault",
                script: vec![
                    tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                    tool_call(
                        "c2",
                        "read_note_span",
                        r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
                    ),
                    final_turn(),
                ],
                answer: "Widgets are small components. [e1]",
                search_bounds: 1..=usize::MAX,
                citation_bounds: 1..=usize::MAX,
                coverage_bounds: 1..=usize::MAX,
            },
            EvalCase {
                label: "Case 4 Factual-not-in-vault",
                script: vec![
                    tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                    final_turn(),
                ],
                answer:
                    "Nothing in your notes covers this yet — add a note and I'll answer next time.",
                search_bounds: 1..=usize::MAX,
                citation_bounds: 0..=0,
                coverage_bounds: 1..=usize::MAX,
            },
            EvalCase {
                label: "Case 5 Follow-up",
                script: vec![final_turn()],
                answer: "Widgets are small parts.",
                search_bounds: 0..=0,
                citation_bounds: 0..=0,
                coverage_bounds: 0..=0,
            },
        ];

        for EvalCase {
            label,
            script,
            answer,
            search_bounds,
            citation_bounds,
            coverage_bounds,
        } in cases
        {
            let v = vault();
            let mock = MockLlmClient::new(script, answer);
            let events = run(v.path(), &mock, &Guards::default());

            let searches = count(&events, |event| {
                matches!(event, ChatEvent::Searching { .. })
            });
            let citations = count(&events, |event| matches!(event, ChatEvent::Citation { .. }));
            let coverage = count(&events, |event| matches!(event, ChatEvent::Coverage { .. }));

            assert!(
                search_bounds.contains(&searches),
                "{label}: expected Searching count in {search_bounds:?}, got {searches}"
            );
            assert!(
                citation_bounds.contains(&citations),
                "{label}: expected Citation count in {citation_bounds:?}, got {citations}"
            );
            assert!(
                coverage_bounds.contains(&coverage),
                "{label}: expected Coverage count in {coverage_bounds:?}, got {coverage}"
            );

            let last = events.last();
            assert!(
                matches!(last, Some(ChatEvent::Done)),
                "{label}: last event must be Done, got {last:?}"
            );
        }
    }

    #[test]
    fn happy_path_searches_reads_and_emits_a_verified_citation() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                tool_call(
                    "c2",
                    "read_note_span",
                    r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
                ),
                final_turn(),
            ],
            "Widgets are small components that snap together [e1].",
        );
        let events = run(v.path(), &mock, &Guards::default());

        assert!(matches!(events.first(), Some(ChatEvent::Processing)));
        assert_eq!(
            count(&events, |event| matches!(event, ChatEvent::Processing)),
            1
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Searching { query } if query == "components")));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Retrieved { hit_count, .. } if *hit_count == 1)));
        assert!(events.iter().any(
            |e| matches!(e, ChatEvent::Reading { rel_path, start_line, end_line }
            if rel_path == "Research/widgets.md" && *start_line == 1 && *end_line == 2)
        ));
        assert!(events.iter().any(|e| matches!(e, ChatEvent::Verifying)));
        assert!(count(&events, |e| matches!(e, ChatEvent::Answer { .. })) >= 1);
        assert!(events.iter().any(
            |e| matches!(e, ChatEvent::Citation { id, rel_path, start_line, text, .. }
            if id == "e1" && rel_path == "Research/widgets.md" && *start_line == 3
                && text == "Widgets are small components.")
        ));
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::CitationDropped { .. })),
            0
        );
        assert!(matches!(events.last(), Some(ChatEvent::Done)));

        // Event ordering: search cue precedes retrieval; verify precedes citation.
        let pos = |pred: fn(&ChatEvent) -> bool| events.iter().position(pred).unwrap();
        assert!(
            pos(|e| matches!(e, ChatEvent::Processing))
                < pos(|e| matches!(e, ChatEvent::Searching { .. }))
        );
        assert!(
            pos(|e| matches!(e, ChatEvent::Searching { .. }))
                < pos(|e| matches!(e, ChatEvent::Retrieved { .. }))
        );
        assert!(
            pos(|e| matches!(e, ChatEvent::Verifying))
                < pos(|e| matches!(e, ChatEvent::Citation { .. }))
        );
    }

    #[test]
    fn coverage_footer_reports_searched_terms_and_notes_read() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "Answer [e1].",
        );
        let events = run(v.path(), &mock, &Guards::default());
        let coverage = events
            .iter()
            .find_map(|e| match e {
                ChatEvent::Coverage {
                    searched_terms,
                    notes_read,
                    truncated,
                    skipped_files,
                } => Some((
                    searched_terms.clone(),
                    notes_read.clone(),
                    *truncated,
                    *skipped_files,
                )),
                _ => None,
            })
            .expect("a coverage footer must be emitted");
        assert_eq!(coverage.0, vec!["components".to_string()]);
        assert_eq!(coverage.1, vec!["Research/widgets.md".to_string()]);
        assert!(!coverage.2);
        assert_eq!(coverage.3, 0);
    }

    #[test]
    fn no_evidence_answer_emits_no_citations() {
        let v = vault();
        // The model answers immediately without searching.
        let mock = MockLlmClient::new(vec![final_turn()], "I couldn't find this in your vault.");
        let events = run(v.path(), &mock, &Guards::default());

        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
            0
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
            0
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Coverage { .. })),
            0,
            "a turn with no searches must not emit a coverage footer"
        );
        assert!(matches!(events.last(), Some(ChatEvent::Done)));
    }

    #[test]
    fn max_iterations_guard_stops_a_runaway_loop() {
        let v = vault();
        // The model would loop forever; the guard caps it at 2 tool turns.
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
                tool_call("c2", "search_notes", r#"{"query":"components"}"#),
                tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
            ],
            "Best effort [e1].",
        );
        let guards = Guards {
            max_iterations: 2,
            ..Guards::default()
        };
        let events = run(v.path(), &mock, &guards);

        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
            2,
            "the loop must stop after max_iterations tool turns"
        );
        assert!(
            matches!(events.last(), Some(ChatEvent::Done)),
            "still answers, never hangs"
        );
    }

    #[test]
    fn guard_trip_reports_partial_coverage() {
        let v = vault();
        // The model keeps issuing tool calls; max_iterations caps it mid-search, so
        // the footer must report partial coverage rather than a full-vault read.
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
                tool_call("c2", "search_notes", r#"{"query":"components"}"#),
                tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
            ],
            "Best effort [e1].",
        );
        let guards = Guards {
            max_iterations: 2,
            ..Guards::default()
        };
        let events = run(v.path(), &mock, &guards);
        assert!(
            events.iter().any(|e| matches!(
                e,
                ChatEvent::Coverage {
                    truncated: true,
                    ..
                }
            )),
            "an iteration-capped sweep must report truncated coverage"
        );
    }

    #[test]
    fn guard_tripped_empty_answer_still_reports_truncated_coverage() {
        let v = vault();
        // The model keeps issuing tool calls (max_iterations caps it → partial
        // coverage) and THEN streams an empty final answer — often a symptom of the
        // cut-short sweep. The truncation footer must survive the empty-answer error
        // path, never dropped (the "never drop truncation" invariant, one layer up
        // from emit_coverage).
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"widgets"}"#),
                tool_call("c2", "search_notes", r#"{"query":"components"}"#),
                tool_call("c3", "search_notes", r#"{"query":"snap"}"#),
            ],
            "",
        );
        let guards = Guards {
            max_iterations: 2,
            ..Guards::default()
        };
        let events = run(v.path(), &mock, &guards);

        assert!(
            events.iter().any(|e| matches!(
                e,
                ChatEvent::Coverage {
                    truncated: true,
                    ..
                }
            )),
            "a guard-tripped empty answer must still surface its truncation, got {:?}",
            events
        );
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Error { .. })),
            1,
            "the empty-answer error still fires — the footer complements it"
        );
        // The error is terminal: no Done.
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
    }

    #[test]
    fn span_cap_stops_dispatch_within_a_turn_and_reports_partial() {
        let v = vault();
        // One turn, three searches. max_spans=1: after the first search registers a
        // span the cap fires, so the remaining two searches in the SAME turn are not
        // dispatched (the cost spike the guard exists to prevent).
        let mock = MockLlmClient::new(
            vec![multi_search(&["components", "widgets", "snap"])],
            "Answer [e1].",
        );
        let guards = Guards {
            max_spans: 1,
            ..Guards::default()
        };
        let events = run(v.path(), &mock, &guards);
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Searching { .. })),
            1,
            "the span cap must stop further dispatch mid-turn"
        );
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::Coverage {
                truncated: true,
                ..
            }
        )));
    }

    #[test]
    fn answer_turn_advertises_no_tools() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "Answer [e1].",
        );
        let _ = run(v.path(), &mock, &Guards::default());
        assert_eq!(
            *mock.streaming_tools_len.lock().unwrap(),
            Some(0),
            "the final answer turn must be unambiguous — no tools advertised"
        );
    }

    #[test]
    fn reasoning_deltas_reach_the_sink_as_thinking_events() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "Widgets snap together [e1].",
        )
        .with_reasoning(&["Let me ", "check the notes."]);
        let events = run(v.path(), &mock, &Guards::default());

        let thinking: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Thinking { delta } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, vec!["Let me ", "check the notes."]);
        // Reasoning is surfaced but never conflated with the answer: the run still
        // ends cleanly and the answer's own citation verifies.
        assert!(matches!(events.last(), Some(ChatEvent::Done)));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Citation { id, .. } if id == "e1")));
    }

    #[test]
    fn whitespace_only_answer_after_search_emits_error_and_stops() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "   ",
        );
        let events = run(v.path(), &mock, &Guards::default());

        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Error { .. })), 1);
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::Error { message } if message == "the model returned an empty answer"
        )));
        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Coverage { .. })),
            0
        );
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
    }

    #[test]
    fn reasoning_only_answer_emits_reasoning_aware_error_and_stops() {
        let v = vault();
        let mock = MockLlmClient::new(vec![final_turn()], "")
            .with_reasoning(&["all the answer ", "went into reasoning"]);
        let events = run(v.path(), &mock, &Guards::default());

        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Error { .. })), 1);
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::Error { message } if message.contains("reasoning")
        )));
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
    }

    #[test]
    fn citing_an_unknown_evidence_id_is_dropped() {
        let v = vault();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "As noted [e9].", // e9 was never handed out (only e1 exists)
        );
        let events = run(v.path(), &mock, &Guards::default());

        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
            0
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::CitationDropped { reason }
            if reason.contains("unknown evidence id"))));
    }

    #[test]
    fn a_citation_whose_note_changed_mid_answer_is_dropped() {
        let v = vault();
        let path = v.path().join("Research/widgets.md");
        // The external edit lands while the answer is streaming — the recorded hash
        // no longer matches, so the citation must be dropped, not surfaced.
        let hook_path = path.clone();
        let mock = MockLlmClient::new(
            vec![
                tool_call("c1", "search_notes", r#"{"query":"components"}"#),
                final_turn(),
            ],
            "Widgets are small components [e1].",
        )
        .with_hook(move || {
            fs::write(&hook_path, "# Widgets\n\nCompletely rewritten now.\n").unwrap();
        });
        let events = run(v.path(), &mock, &Guards::default());

        assert_eq!(
            count(&events, |e| matches!(e, ChatEvent::Citation { .. })),
            0
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::CitationDropped { reason }
            if reason.contains("changed on disk"))));
    }

    #[test]
    fn an_llm_transport_error_surfaces_and_stops() {
        let v = vault();
        let mock = MockLlmClient::failing();
        let events = run(v.path(), &mock, &Guards::default());

        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Error { message } if message.contains("boom"))));
        // The error is terminal — no Done, no partial answer.
        assert_eq!(count(&events, |e| matches!(e, ChatEvent::Done)), 0);
    }

    #[test]
    fn extract_cited_ids_finds_markers_and_dedupes() {
        assert_eq!(
            extract_cited_ids("see [e1] and [e2], again [e1]; not [x] nor [e] nor [e1x]"),
            vec!["e1".to_string(), "e2".to_string()]
        );
        assert!(extract_cited_ids("no citations here").is_empty());
    }

    #[test]
    fn extract_cited_ids_drops_a_marker_severed_by_truncation() {
        // The moat guarantee under a `length` cut: when the answer is truncated mid
        // marker, the complete markers survive and the severed one — missing its closing
        // `]` — is never emitted as a citation. A wrong citation is worse than no answer.
        assert_eq!(
            extract_cited_ids("Sugar is sweet [e1] and salt [e2"),
            vec!["e1".to_string()]
        );
        // Cut at the bracket, at the prefix, and mid-digits — none of these parse.
        assert!(extract_cited_ids("cut at the bracket [").is_empty());
        assert!(extract_cited_ids("cut at the prefix [e").is_empty());
        assert!(extract_cited_ids("cut mid-digits [e12").is_empty());
    }

    fn assistant_msg(content: &str) -> LlmMessage {
        LlmMessage {
            role: crate::ai::llm::Role::Assistant,
            content: Some(content.to_string()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        }
    }

    #[test]
    fn strip_cited_markers_removes_markers_and_leading_space() {
        assert_eq!(
            strip_cited_markers("Spacing is 8px [e1] and grids use it [e2]."),
            "Spacing is 8px and grids use it."
        );
        // Case-insensitive `e`, multi-digit ids; non-markers are left untouched.
        assert_eq!(
            strip_cited_markers("A [E12] then [x] and [e] stay."),
            "A then [x] and [e] stay."
        );
        assert_eq!(strip_cited_markers("no markers here"), "no markers here");
    }

    #[test]
    fn prepare_history_strips_stale_markers_from_carried_turns() {
        // SUS-1 backstop in the core: a `[eN]` carried into a later turn can't survive
        // to re-validate against an unrelated fresh span.
        let history = vec![
            LlmMessage::user("what is spacing?"),
            assistant_msg("Spacing is 8px [e1] and grids use it [e2]."),
        ];
        let out = prepare_history(&history);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].content.as_deref(), Some("what is spacing?"));
        assert_eq!(
            out[1].content.as_deref(),
            Some("Spacing is 8px and grids use it.")
        );
    }

    #[test]
    fn prepare_history_windows_to_char_budget_keeping_most_recent() {
        // H1: bound history so system + history + evidence can't overflow a local
        // window. Each turn is ~5k chars, so only the newest that fit the 12k budget
        // survive; the oldest drop.
        let big = "x".repeat(5_000);
        let history: Vec<LlmMessage> = (0..6)
            .map(|i| assistant_msg(&format!("{i}{big}")))
            .collect();
        let out = prepare_history(&history);
        assert!(
            out.len() < history.len(),
            "oversized history must be windowed"
        );
        assert!(!out.is_empty());
        // The newest turn is always retained.
        assert_eq!(out.last().unwrap().content, history.last().unwrap().content);
    }

    #[test]
    fn prepare_history_keeps_newest_turn_even_when_it_exceeds_budget() {
        // Never send empty history just because the last turn alone is huge.
        let huge = assistant_msg(&"y".repeat(MAX_HISTORY_CHARS + 5_000));
        let out = prepare_history(std::slice::from_ref(&huge));
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn folder_scoped_search_flows_through_the_loop() {
        let v = vault();
        // The model discovers folders, scopes a search to Research, then reads a span —
        // the folder path must flow through dispatch to a verified citation.
        let mock = MockLlmClient::new(
            vec![
                tool_call("c0", "list_folders", "{}"),
                tool_call(
                    "c1",
                    "search_notes",
                    r#"{"query":"components","folder":"Research"}"#,
                ),
                tool_call(
                    "c2",
                    "read_note_span",
                    r#"{"rel_path":"Research/widgets.md","start_line":1,"end_line":2}"#,
                ),
                final_turn(),
            ],
            "Widgets are small components [e1].",
        );
        let events = run(v.path(), &mock, &Guards::default());
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Searching { query } if query == "components")));
        assert!(events.iter().any(|e| matches!(
            e,
            ChatEvent::Citation { rel_path, .. } if rel_path == "Research/widgets.md"
        )));
        assert!(matches!(events.last(), Some(ChatEvent::Done)));
    }

    // ── §4 token-aware context budgeting (PA-029) ───────────────────────────
    // The char guards can't see that CJK/symbol-dense text tokenises ~4× denser
    // than Latin, so the assembled prompt can overflow a small local window and be
    // silently front-truncated — dropping the grounding, breaking cited recall.
    // `fit_prompt_to_window` budgets the assembled prompt in *tokens* before send.

    fn input_budget() -> usize {
        LOCAL_CONTEXT_WINDOW_TOKENS - ANSWER_RESERVE_TOKENS - PROMPT_OVERHEAD_TOKENS
    }

    fn evidence_round(round: usize, body: String) -> [LlmMessage; 2] {
        [
            LlmMessage::assistant_tool_calls(vec![ToolCall {
                id: format!("c{round}"),
                name: "search_notes".into(),
                arguments: "{}".into(),
            }]),
            LlmMessage::tool_result(format!("c{round}"), "search_notes", body),
        ]
    }

    #[test]
    fn estimate_tokens_counts_dense_scripts_far_heavier_than_latin() {
        // Latin ~4 chars/token; CJK and symbol runs ~1 token/char. The old flat 4:1
        // char assumption undercounted the latter by ~4× — the overflow this fixes.
        assert_eq!(estimate_tokens(&"a".repeat(100)), 25);
        assert_eq!(estimate_tokens(&"配".repeat(100)), 100);
        assert_eq!(estimate_tokens(&"#".repeat(100)), 100);
    }

    #[test]
    fn context_window_tokens_clamps_local_models_only() {
        assert_eq!(
            context_window_tokens(crate::ai::DEFAULT_LOCAL_MODEL),
            Some(LOCAL_CONTEXT_WINDOW_TOKENS)
        );
        assert_eq!(context_window_tokens("anthropic/claude-sonnet-4.5"), None);
    }

    #[test]
    fn fit_prompt_to_window_is_inert_for_cloud_models() {
        // Cloud windows are large and bounded by the char guards; this layer leaves
        // them untouched so cloud cost ceilings stay intact.
        let messages = vec![
            LlmMessage::system("grounding"),
            LlmMessage::user("配".repeat(1_000_000)),
        ];
        let out = fit_prompt_to_window(&messages, "anthropic/claude-sonnet-4.5");
        assert!(!out.lost);
        assert_eq!(out.messages, messages);
    }

    #[test]
    fn fit_prompt_to_window_drops_oldest_keeping_grounding_and_newest() {
        let mut messages = vec![
            LlmMessage::system(SYSTEM_PROMPT),
            LlmMessage::user("question"),
        ];
        for round in 0..6 {
            messages.extend(evidence_round(
                round,
                format!("round{round} {}", "配".repeat(8_000)),
            ));
        }
        let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL);

        assert!(out.lost, "an over-window prompt must report coverage loss");
        assert_eq!(out.messages[0].role, Role::System);
        assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
        assert!(out
            .messages
            .iter()
            .any(|m| m.content.as_deref() == Some("question")));
        let joined: String = out
            .messages
            .iter()
            .filter_map(|m| m.content.as_deref())
            .collect();
        assert!(
            joined.contains("round5"),
            "the newest evidence must survive"
        );
        assert!(!joined.contains("round0"), "the oldest evidence must drop");
        assert!(total_tokens(&out.messages) <= input_budget());
    }

    #[test]
    fn fit_prompt_to_window_head_truncates_a_single_oversized_evidence() {
        // One span larger than the whole window: grounding is the hard invariant, so
        // the span is head-truncated with an explicit marker, never grounding.
        let mut messages = vec![
            LlmMessage::system(SYSTEM_PROMPT),
            LlmMessage::user("question"),
        ];
        messages.extend(evidence_round(0, "配".repeat(60_000)));

        let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL);

        assert!(out.lost);
        assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
        let evidence = out
            .messages
            .iter()
            .rev()
            .find(|m| m.role == Role::Tool)
            .unwrap();
        assert!(evidence
            .content
            .as_deref()
            .unwrap()
            .contains("trimmed to fit"));
        assert!(total_tokens(&out.messages) <= input_budget());
    }

    #[test]
    fn fit_prompt_to_window_trims_symbol_dense_content() {
        // Symbol-dense ASCII tokenises ~1 token/char, so it overflows even though its
        // char count sits comfortably under the char guards.
        let mut messages = vec![
            LlmMessage::system(SYSTEM_PROMPT),
            LlmMessage::user("question"),
        ];
        messages.extend(evidence_round(0, "#".repeat(40_000)));

        let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL);

        assert!(out.lost);
        assert_eq!(out.messages[0].content.as_deref(), Some(SYSTEM_PROMPT));
        assert!(total_tokens(&out.messages) <= input_budget());
    }

    #[test]
    fn fit_prompt_to_window_preserves_tool_call_result_pairing() {
        let mut messages = vec![LlmMessage::system(SYSTEM_PROMPT), LlmMessage::user("q")];
        for round in 0..6 {
            messages.extend(evidence_round(round, "配".repeat(8_000)));
        }
        let out = fit_prompt_to_window(&messages, crate::ai::DEFAULT_LOCAL_MODEL).messages;

        for (i, message) in out.iter().enumerate() {
            if message.role == Role::Tool {
                let prev = &out[i - 1];
                let paired = prev.role == Role::Tool
                    || (prev.role == Role::Assistant && !prev.tool_calls.is_empty());
                assert!(paired, "orphaned tool result at index {i}");
            }
        }
    }

    #[test]
    fn local_run_reports_budget_loss_and_never_front_truncates_grounding() {
        let vault = tempfile::tempdir().unwrap();
        let provider = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 16_000_000_000,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 10_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::new(),
        };
        let services = SkillServices::new(
            &skills,
            &environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let llm = MockLlmClient::new(vec![final_turn()], "answer");
        let guards = Guards::default();
        let session = ChatSession {
            root: vault.path(),
            model: crate::ai::DEFAULT_LOCAL_MODEL,
            provider: &provider,
            llm: &llm,
            skill_services: &services,
            guards: &guards,
        };
        let mut messages = vec![
            LlmMessage::system(SYSTEM_PROMPT),
            LlmMessage::user("question"),
        ];
        messages.extend(evidence_round(0, "配".repeat(50_000)));
        let mut active_skills = ActiveSkills::new(guards.max_iterations);
        let mut writes = WriteSession::new(1).unwrap();
        let mut youtube_session = YoutubeToolSession::new_with_update_session(
            services.capture_cancellation.clone(),
            services.extractor_updates.clone(),
        );
        let mut registry = EvidenceRegistry::new();
        let mut coverage = CoverageAcc::default();
        let mut sink = VecSink::default();

        block_on(session.collect_evidence(
            &mut messages,
            &mut active_skills,
            &mut writes,
            &mut youtube_session,
            &mut registry,
            &mut coverage,
            &mut sink,
        ))
        .unwrap();

        assert!(
            coverage.truncated,
            "budget loss must be recorded so the Coverage footer surfaces it"
        );
        let sent = &llm.completion_requests()[0];
        assert_eq!(
            sent[0].role,
            Role::System,
            "grounding must stay first, never front-truncated"
        );
        assert_eq!(sent[0].content.as_deref(), Some(SYSTEM_PROMPT));
        assert!(total_tokens(sent) <= input_budget());
    }

    // ── §4 bounded retry for idempotent tool-decision turns (PA-029) ────────
    // A single transient 429/5xx/dropped connection during an idempotent tool-DECIDING
    // `complete` turn must not abort the whole run. Exactly one bounded retry; never a
    // non-transient failure, a user-stopped turn, or the streamed answer turn. The retry
    // sits before tool dispatch, so it can never double-execute a tool.

    struct RetryEnv {
        _vault: tempfile::TempDir,
        provider: KeywordRetriever,
        skills: SkillRegistry,
        environment: SkillEnvironment,
        guards: Guards,
    }

    fn retry_env() -> RetryEnv {
        let vault = tempfile::tempdir().unwrap();
        let provider = KeywordRetriever::new(vault.path());
        let skills = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 16_000_000_000,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 10_000_000_000,
            },
            app_data_bin_dir: PathBuf::from("/app-data/bin"),
            available_binaries: BTreeSet::new(),
        };
        RetryEnv {
            _vault: vault,
            provider,
            skills,
            environment,
            guards: Guards::default(),
        }
    }

    fn tool_decision_request() -> LlmRequest {
        LlmRequest {
            model: "test-model".into(),
            messages: vec![LlmMessage::system("system"), LlmMessage::user("q")],
            tools: Vec::new(),
        }
    }

    /// A [`RetryDelay`] double that records every pause it was asked to await instead of
    /// sleeping — so a test can prove the backoff seam is exercised without real time
    /// passing (the recorded durations also confirm the core hands over the right value).
    #[derive(Default)]
    struct RecordingDelay {
        awaited: Mutex<Vec<Duration>>,
    }

    #[async_trait]
    impl RetryDelay for RecordingDelay {
        async fn delay(&self, duration: Duration) {
            self.awaited.lock().unwrap().push(duration);
        }
    }

    impl RecordingDelay {
        fn awaited(&self) -> Vec<Duration> {
            self.awaited.lock().unwrap().clone()
        }
    }

    #[test]
    fn tool_turn_awaits_injected_backoff_once_before_a_transient_retry() {
        let env = retry_env();
        let delay = RecordingDelay::default();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        )
        .with_retry_delay(&delay);
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm("openrouter returned 429 Too Many Requests".into()),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        block_on(session.complete_tool_turn(&tool_decision_request())).unwrap();

        assert_eq!(llm.completion_requests().len(), 2, "retried exactly once");
        assert_eq!(
            delay.awaited(),
            vec![RETRY_BACKOFF],
            "the retry awaits the injected backoff exactly once, at the policy value"
        );
    }

    #[test]
    fn tool_turn_does_not_await_backoff_for_a_non_transient_failure() {
        let env = retry_env();
        let delay = RecordingDelay::default();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        )
        .with_retry_delay(&delay);
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm("openrouter returned 400 Bad Request: bad model".into()),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        let result = block_on(session.complete_tool_turn(&tool_decision_request()));

        assert!(result.is_err(), "a 400 is permanent — no retry");
        assert_eq!(llm.completion_requests().len(), 1);
        assert!(
            delay.awaited().is_empty(),
            "a non-retryable failure never pauses for backoff"
        );
    }

    #[test]
    fn tool_turn_retries_a_single_transient_failure_then_succeeds() {
        let env = retry_env();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm("openrouter returned 429 Too Many Requests".into()),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        let completion = block_on(session.complete_tool_turn(&tool_decision_request())).unwrap();

        assert!(completion.content.is_some());
        assert_eq!(
            llm.completion_requests().len(),
            2,
            "one transient failure is retried exactly once"
        );
    }

    #[test]
    fn tool_turn_retries_a_dropped_connection() {
        let env = retry_env();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm(
                "request to openrouter failed: error sending request: connection reset by peer"
                    .into(),
            ),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        block_on(session.complete_tool_turn(&tool_decision_request())).unwrap();

        assert_eq!(llm.completion_requests().len(), 2);
    }

    #[test]
    fn tool_turn_does_not_retry_a_non_transient_failure() {
        let env = retry_env();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        );
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm("openrouter returned 400 Bad Request: bad model".into()),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        let result = block_on(session.complete_tool_turn(&tool_decision_request()));

        assert!(result.is_err(), "a 400 is permanent — no retry");
        assert_eq!(llm.completion_requests().len(), 1);
    }

    #[test]
    fn tool_turn_does_not_retry_when_the_run_is_cancelled() {
        let env = retry_env();
        let cancellation = CaptureCancellation::default();
        cancellation.cancel();
        let services = SkillServices::new(
            &env.skills,
            &env.environment,
            &NoUserPrompt,
            &UnavailableNoteWriter,
            1,
        )
        .with_capture_cancellation(cancellation);
        let llm = MockLlmClient::new(vec![final_turn()], "answer").with_complete_failures(vec![
            CoreError::Llm("openrouter returned 503 Service Unavailable".into()),
        ]);
        let session = ChatSession {
            root: env._vault.path(),
            model: "test-model",
            provider: &env.provider,
            llm: &llm,
            skill_services: &services,
            guards: &env.guards,
        };

        let result = block_on(session.complete_tool_turn(&tool_decision_request()));

        assert!(result.is_err(), "a cancelled run must not retry");
        assert_eq!(
            llm.completion_requests().len(),
            1,
            "cancellation short-circuits the retry"
        );
    }

    #[test]
    fn streamed_answer_turn_is_never_retried() {
        // The first `complete` returns no tool calls, so the loop proceeds straight to
        // the streamed answer, which fails transiently. Streaming is outside the retry
        // path, so it is attempted exactly once and surfaces a terminal error.
        let vault = vault();
        let mock = MockLlmClient::new(vec![final_turn()], "answer").with_streaming_failure(
            CoreError::Llm("openrouter returned 503 Service Unavailable".into()),
        );

        let events = run(vault.path(), &mock, &Guards::default());

        assert_eq!(
            mock.streaming_attempts(),
            1,
            "the streamed answer turn must not be retried"
        );
        assert!(events
            .iter()
            .any(|event| matches!(event, ChatEvent::Error { .. })));
        assert_eq!(count(&events, |event| matches!(event, ChatEvent::Done)), 0);
    }
}
