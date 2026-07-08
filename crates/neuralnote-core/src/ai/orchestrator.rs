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

const SYSTEM_PROMPT: &str =
    "You are NeuralNote's research assistant. You answer questions strictly from the \
user's own notes, using the tools provided to search and read them.\n\n\
Rules you must follow:\n\
- Answer ONLY from evidence you retrieved with the tools. Never use outside \
knowledge and never guess.\n\
- Before answering, issue 3 to 8 varied searches: try synonyms, tags, note titles, \
and the user's own wording. Keyword search is literal, so rephrase generously.\n\
- The vault is organised into folders. Call `list_folders` to see them (each with its \
note count). When the user asks about a specific folder — e.g. \"what's in my Recipes \
folder\" or \"search my Work notes\" — pass that folder's path as the `folder` argument \
to `search_notes` or `list_notes` to scope to it and its subfolders; omit `folder` to \
cover the whole vault.\n\
- Cite every claim with the evidence id in square brackets, e.g. [e1] or [e2]. \
Cite ids only — never a file path, and never a quote you did not retrieve.\n\
- If the notes do not contain the answer, say so plainly. Do not invent a citation \
or an answer.\n\
- Keep the answer concise and grounded in the cited evidence.";

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

impl ChatSession<'_> {
    async fn drive(
        &self,
        user_prompt: &str,
        history: &[LlmMessage],
        sink: &mut dyn EventSink,
    ) -> CoreResult<()> {
        let mut messages = Vec::with_capacity(history.len() + 2);
        messages.push(LlmMessage::system(SYSTEM_PROMPT));
        messages.extend_from_slice(history);
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
        let answer = self.stream_final_answer(&messages, sink).await?;

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
    sink.send(ChatEvent::Coverage {
        searched_terms: coverage.searched_terms,
        notes_read: coverage.notes_read,
        // "Partial coverage" = the sweep was genuinely cut short: a loop guard
        // stopped it, OR the vault search hit its own global cap (`coverage.truncated`
        // now carries only that, not a routine per-search `max_results` clip).
        truncated: coverage.truncated || guard_tripped,
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
                before_answer: None,
            }
        }

        fn failing() -> Self {
            Self {
                completions: Mutex::new(VecDeque::new()),
                answer: String::new(),
                fail: true,
                streaming_tools_len: Mutex::new(None),
                before_answer: None,
            }
        }

        fn with_hook(mut self, f: impl Fn() + Send + Sync + 'static) -> Self {
            self.before_answer = Some(Box::new(f));
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
        let coverage_empty = events.iter().any(|e| {
            matches!(e,
            ChatEvent::Coverage { searched_terms, notes_read, .. }
            if searched_terms.is_empty() && notes_read.is_empty())
        });
        assert!(coverage_empty);
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
