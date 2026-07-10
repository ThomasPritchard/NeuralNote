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
use crate::ai::llm::{LlmClient, LlmMessage, LlmRequest, ToolCall};
use crate::ai::retrieval::RetrievalProvider;
use crate::ai::tools::{self, dispatch, ToolOutcome};
use crate::ai::verify::CitationVerifier;
use crate::error::CoreResult;
use std::path::Path;

/// The default OpenRouter model — BYO-key, OpenAI-compatible, user-editable in the
/// shell. Kept here as the client-agnostic default the host can override.
pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4.5";

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
    user_prompt: &str,
    history: &[LlmMessage],
    root: &Path,
    model: &str,
    provider: &dyn RetrievalProvider,
    llm: &dyn LlmClient,
    sink: &mut dyn EventSink,
    guards: &Guards,
) -> CoreResult<()> {
    let session = ChatSession {
        root,
        model,
        provider,
        llm,
        guards,
    };
    if let Err(e) = session.drive(user_prompt, history, sink).await {
        // Surface the failure explicitly and stop — never a panic, never silent.
        sink.send(ChatEvent::Error {
            message: e.to_string(),
        });
    }
    Ok(())
}

/// The collaborators for one run, bundled so the loop's helpers stay small.
struct ChatSession<'a> {
    root: &'a Path,
    model: &'a str,
    provider: &'a dyn RetrievalProvider,
    llm: &'a dyn LlmClient,
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
        user_prompt: &str,
        history: &[LlmMessage],
        sink: &mut dyn EventSink,
    ) -> CoreResult<()> {
        // Sanitise history in the core (strip stale `[eN]` markers, window to a char
        // budget) so the grounding rules + evidence can't be silently front-truncated
        // out of a local model's context window, and a stale marker can't mis-cite —
        // regardless of which client built the history. See `prepare_history`.
        let history = prepare_history(history);
        let mut messages = Vec::with_capacity(history.len() + 2);
        messages.push(LlmMessage::system(SYSTEM_PROMPT));
        messages.extend(history);
        messages.push(LlmMessage::user(user_prompt));

        let tools = tools::tool_schemas();
        let mut registry = EvidenceRegistry::new();
        let mut coverage = CoverageAcc::default();
        let guard_tripped = self
            .collect_evidence(&mut messages, &tools, &mut registry, &mut coverage, sink)
            .await?;

        // Verify + answer phase. Verifying is the UI cue that the answer is being
        // grounded; the actual citation checks run once we have the streamed text.
        sink.send(ChatEvent::Verifying);
        // A fresh streaming generation produces the final answer. It re-generates
        // rather than reusing the loop's last (non-streamed) turn — the deliberate
        // cost of keeping tool-parsing non-streamed while the answer streams live.
        // No tools are advertised on this turn: it is unambiguously an answer, so the
        // model can't emit a tool call that streaming would silently swallow.
        let (answer, thinking_count) = {
            let mut counting_sink = ThinkingCounter {
                inner: sink,
                count: 0,
            };
            let answer = self
                .stream_final_answer(&messages, &mut counting_sink)
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

    async fn collect_evidence(
        &self,
        messages: &mut Vec<LlmMessage>,
        tools: &[serde_json::Value],
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
    ) -> CoreResult<bool> {
        let mut context_chars = 0usize;
        for _ in 0..self.guards.max_iterations {
            // TODO(llm-retry): add one bounded backoff retry for idempotent
            // tool-deciding `complete` turns on transient 429/5xx/dropped connection
            // (not the streaming answer, PA-029).
            let completion = self.llm.complete(&self.request(messages, tools)).await?;
            if completion.tool_calls.is_empty() {
                return Ok(false); // the model chose to answer — a clean stop
            }

            // The protocol requires the assistant's tool-call turn before its results,
            // and exactly one result per declared call.
            messages.push(LlmMessage::assistant_tool_calls(
                completion.tool_calls.clone(),
            ));
            if self.handle_tool_calls(
                &completion.tool_calls,
                messages,
                registry,
                coverage,
                sink,
                &mut context_chars,
            ) {
                return Ok(true); // evidence / context budget spent
            }
        }

        // Out of turns while the previous turn still issued tool calls — the model
        // was mid-search, so coverage is partial, not complete.
        Ok(true)
    }

    fn handle_tool_calls(
        &self,
        calls: &[ToolCall],
        messages: &mut Vec<LlmMessage>,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
        context_chars: &mut usize,
    ) -> bool {
        let mut budget_hit = false;
        for call in calls {
            if budget_hit {
                push_skipped_tool_result(messages, call);
                continue;
            }
            self.push_tool_result(messages, call, registry, coverage, sink, context_chars);
            // Check the caps INSIDE the per-call loop: one turn issuing many
            // search calls (each up to MAX_SEARCH_RESULTS spans) must not blow
            // past the caps before the guard fires — that is the token-cost spike
            // the guard exists to prevent (a BYO-key user pays for it).
            if self.evidence_budget_spent(registry, *context_chars) {
                budget_hit = true;
            }
        }
        budget_hit
    }

    fn push_tool_result(
        &self,
        messages: &mut Vec<LlmMessage>,
        call: &ToolCall,
        registry: &mut EvidenceRegistry,
        coverage: &mut CoverageAcc,
        sink: &mut dyn EventSink,
        context_chars: &mut usize,
    ) {
        let result = self.handle_tool_call(call, registry, coverage, sink);
        *context_chars += result.content.len();
        messages.push(LlmMessage::tool_result(
            &call.id,
            &call.name,
            result.content,
        ));
    }

    fn evidence_budget_spent(&self, registry: &EvidenceRegistry, context_chars: usize) -> bool {
        registry.len() >= self.guards.max_spans || context_chars >= self.guards.max_context_chars
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

    /// Dispatch one tool call, emitting the live step events and folding its result
    /// into the coverage accumulator.
    fn handle_tool_call(
        &self,
        call: &ToolCall,
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
        let result = dispatch(&call.name, &call.arguments, self.provider, registry);
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
            ToolOutcome::Listed | ToolOutcome::Rejected => {}
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
/// the tool-result budget (`Guards::max_context_chars`, 60k chars), could push a local
/// model's prompt past its context window. Ollama then silently truncates from the
/// FRONT, dropping the grounding rules (sent first) and the earliest evidence — which
/// breaks cited recall, the moat. Sized conservatively so
/// `system + history + max_context_chars + the answer` stay within the smallest
/// supported local window (`local::OLLAMA_NUM_CTX` = 32_768 tokens) with headroom; the
/// large-context cloud provider is unaffected in practice, and the cap also bounds
/// per-turn token cost. Keeps the most recent turns; older ones drop (each turn
/// re-runs retrieval and re-grounds, so dropping old context never corrupts citations).
//
// TODO(token-aware-context-budget): all budgets here are in CHARS with an implicit
// ~4-chars/token assumption. A CJK/symbol-dense vault tokenises closer to ~2 chars/token,
// so a near-max evidence turn (`max_context_chars` 60k) could still exceed a small local
// `num_ctx` and be silently front-truncated. The robust fix is a token-aware (or
// provider-aware) budget that counts the *assembled* prompt against the active window
// before send — deferred because it couples to the model's RAM sizing. The English/Latin
// common case has ample headroom after this cap (H1), so the residual is a narrow edge.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::events::VecSink;
    use crate::ai::llm::Completion;
    use crate::ai::retrieval::KeywordRetriever;
    use crate::error::CoreError;
    use async_trait::async_trait;
    use futures::executor::block_on;
    use std::collections::VecDeque;
    use std::fs;
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
            }
        }

        fn with_hook(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
            self.before_answer = Some(Box::new(f));
            self
        }

        fn with_reasoning(mut self, deltas: &[&str]) -> Self {
            self.reasoning = deltas.iter().map(|d| d.to_string()).collect();
            self
        }
    }

    #[async_trait]
    impl LlmClient for MockLlmClient {
        async fn complete(&self, _req: &LlmRequest) -> CoreResult<Completion> {
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
            *self.streaming_tools_len.lock().unwrap() = Some(req.tools.len());
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

    fn run(root: &Path, mock: &MockLlmClient, guards: &Guards) -> Vec<ChatEvent> {
        let retriever = KeywordRetriever::new(root);
        let mut sink = VecSink::default();
        block_on(run_chat(
            "how do widgets work?",
            &[],
            root,
            "test-model",
            &retriever,
            mock,
            &mut sink,
            guards,
        ))
        .unwrap();
        sink.events
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
}
