//! OpenAI-compatible wire mapping and SSE parsing.
//!
//! Pure, network-free glue between the core's [`LlmRequest`] / [`Completion`]
//! shape and the OpenAI-compatible chat wire: request serialisation, response
//! tool-call mapping, redaction, and streamed answer frame parsing. This lives in
//! core (not the Tauri shell) so coverage is measured where the behaviour is
//! owned, and so a later Ollama client can reuse the same protocol plumbing.

use crate::ai::events::{ChatEvent, EventSink, TokenUsage};
use crate::ai::tool_stream::{self, ToolCallDelta, ToolTurnAccumulator};
use crate::ai::{Completion, LlmMessage, LlmRequest, Role, ToolCall};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};

/// Redact the API key from provider/proxy error text before it reaches the user or
/// a log. OpenRouter shouldn't echo the Authorization header, but a proxy or a
/// verbose gateway error might — and a leaked key is catastrophic.
pub fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        text.to_string()
    } else {
        text.replace(key, "***")
    }
}

/// What one streamed answer turn has accumulated so far: the answer text, and
/// whether the provider's usage frame has been seen.
///
/// The two travel together because the caller needs both at end of stream and
/// neither is derivable from the other. `usage_reported` is what lets the client
/// report `None` exactly once for a turn the provider never metered — without it
/// an unmetered turn would be indistinguishable from one whose report is still
/// coming, and the run's total would silently omit it.
#[derive(Debug, Default)]
pub struct AnswerStream {
    text: String,
    usage_reported: bool,
}

impl AnswerStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the provider reported this turn's token usage.
    pub fn usage_reported(&self) -> bool {
        self.usage_reported
    }

    /// The answer accumulated so far — byte-equal to the streamed `Answer` deltas.
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn into_text(self) -> String {
        self.text
    }

    /// Pass a frame's usage on to the sink, at most once per turn. A provider
    /// that repeats the frame must not double-count the run.
    fn report(&mut self, usage: Option<&WireUsage>, sink: &mut dyn EventSink) {
        report_usage_once(&mut self.usage_reported, usage, sink);
    }
}

/// Report a frame's usage to the sink unless this turn already reported.
///
/// Shared by both turns so they cannot drift on the one property the total
/// depends on: **exactly one report per model call.** Two reports would double
/// a turn's tokens; none would silently drop them from the run's total.
fn report_usage_once(reported: &mut bool, usage: Option<&WireUsage>, sink: &mut dyn EventSink) {
    if *reported {
        return;
    }
    let Some(usage) = usage.and_then(WireUsage::to_token_usage) else {
        return;
    };
    *reported = true;
    sink.record_usage(Some(usage));
}

/// Process one SSE line into the sink + accumulator. `Ok(Some(answer))` means a
/// terminal `[DONE]` was seen (stop reading); `Ok(None)` means keep reading; `Err`
/// surfaces a mid-stream error frame. Shared by the newline loop and the EOF flush
/// so the returned string stays byte-equal to the streamed deltas.
pub fn consume_sse_line(
    line_bytes: &[u8],
    sink: &mut dyn EventSink,
    stream: &mut AnswerStream,
) -> CoreResult<Option<String>> {
    let line = String::from_utf8_lossy(line_bytes);
    let classified = classify_sse_line(&line);
    // Read usage off the raw chunk, before the answer classification: the usage
    // frame carries an empty content delta (and, on the local lane, no choices at
    // all), so every classification below resolves it to `Other` and would drop it.
    if let SseLine::Chunk(chunk) = &classified {
        stream.report(chunk.usage.as_ref(), sink);
    }
    let full = &mut stream.text;
    match sse_event(classified) {
        SseEvent::Delta(delta) => {
            sink.send(ChatEvent::Answer {
                delta: delta.clone(),
            });
            full.push_str(&delta);
            Ok(None)
        }
        SseEvent::Reasoning(delta) => {
            // Streamed to the UI like an Answer delta, but deliberately NOT pushed to
            // `full`: the returned string must stay byte-equal to the Answer deltas
            // (the orchestrator verifies citations against it), and reasoning is not an
            // answer. This also keeps `finish_answer`'s empty-answer guard honest — a
            // stream that only reasons leaves `full` empty and still surfaces as Err.
            sink.send(ChatEvent::Thinking { delta });
            Ok(None)
        }
        SseEvent::ReasoningAndDelta { reasoning, delta } => {
            // Reasoning first: it precedes the answer token within the frame. Only the
            // answer content reaches `full`, keeping the returned string byte-equal to
            // the Answer deltas the orchestrator verifies citations against.
            sink.send(ChatEvent::Thinking { delta: reasoning });
            sink.send(ChatEvent::Answer {
                delta: delta.clone(),
            });
            full.push_str(&delta);
            Ok(None)
        }
        SseEvent::Truncated { delta } => {
            // Stream the trailing token (if any) into the answer FIRST, so the returned
            // string stays byte-equal to the Answer deltas the orchestrator verifies
            // citations against — a severed `[eN]` is preserved verbatim here and dropped
            // later by the citation parser, never emitted as a citation. Then surface the
            // truncation. Non-terminal: `[DONE]`/EOF still ends the stream.
            if let Some(delta) = delta {
                sink.send(ChatEvent::Answer {
                    delta: delta.clone(),
                });
                full.push_str(&delta);
            }
            sink.send(ChatEvent::AnswerTruncated);
            Ok(None)
        }
        SseEvent::Done => Ok(Some(full.clone())),
        SseEvent::Error(msg) => Err(CoreError::Llm(msg)),
        SseEvent::Other => Ok(None),
    }
}

/// Final guard on a streamed answer: an empty answer on the (no-tools) answer turn
/// is always a failure — whether the stream ended via `[DONE]` (loop early-return)
/// or plain EOF, a blank result must surface as an error, never be returned as a
/// successful empty answer the UI would mark `Done`. Both return sites route here.
pub fn finish_answer(full: String) -> CoreResult<String> {
    if full.is_empty() {
        Err(CoreError::Llm(
            "the model returned an empty answer (the stream ended without content)".into(),
        ))
    } else {
        Ok(full)
    }
}

/// Sane output ceiling for the streamed answer turn; tool-deciding turns stay uncapped so long tool-call JSON is never truncated.
///
/// When the model hits this ceiling the provider sends `finish_reason: "length"` before
/// `[DONE]`; [`parse_sse_line`] maps that to [`SseEvent::Truncated`] and [`consume_sse_line`]
/// surfaces a [`ChatEvent::AnswerTruncated`], so a capped answer is never shown as a complete
/// one. A citation marker severed by the cut simply goes uncited (an incomplete `[eN]` never
/// parses) — never mis-cited.
pub const ANSWER_MAX_TOKENS: u32 = 4096;

/// Build the OpenAI-compatible request body. `num_ctx` is set only by the local
/// (Ollama) client, where it becomes `options.num_ctx`; OpenRouter passes `None`.
/// `reasoning` asks the provider to stream reasoning tokens — set only by the
/// OpenRouter client, which speaks it, and only when the user has opted in; the
/// local (Ollama) endpoint would ignore or reject the field.
pub fn to_wire_request(
    req: &LlmRequest,
    stream: bool,
    num_ctx: Option<u32>,
    max_tokens: Option<u32>,
    reasoning: bool,
) -> serde_json::Value {
    serde_json::to_value(WireRequest::from_core(
        req, stream, num_ctx, max_tokens, reasoning,
    ))
    .expect("wire request serialises to JSON")
}

pub fn parse_completion(value: serde_json::Value) -> CoreResult<Completion> {
    let parsed: WireResponse = serde_json::from_value(value)
        .map_err(|e| CoreError::Llm(format!("could not parse OpenRouter response: {e}")))?;
    let msg = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message)
        .ok_or_else(|| CoreError::Llm("OpenRouter returned no choices".into()))?;
    Ok(Completion {
        content: msg.content,
        tool_calls: msg
            .tool_calls
            .into_iter()
            .map(|t| ToolCall {
                id: t.id,
                name: t.function.name,
                arguments: t.function.arguments,
            })
            .collect(),
    })
}

/// One parsed SSE line's meaning.
pub enum SseEvent {
    /// A content chunk to stream to the UI.
    Delta(String),
    /// A model reasoning-token chunk to surface as a live "thinking" step. Streamed
    /// like [`SseEvent::Delta`] but NEVER folded into the returned answer — reasoning
    /// is not an answer delta (see [`consume_sse_line`]).
    Reasoning(String),
    /// One frame carrying reasoning AND answer content. The wire does not promise the
    /// two arrive in separate frames, so this case must be represented rather than
    /// short-circuited: dropping the content would silently lose an answer token — and
    /// with it, possibly a leading `[eN]` citation marker.
    ReasoningAndDelta { reasoning: String, delta: String },
    /// A `finish_reason: "length"` frame — the provider hit its output-token ceiling
    /// and cut the answer short. Carries any trailing content in the SAME frame so a
    /// final token (and any `[eN]` marker riding on it) is never dropped. Non-fatal:
    /// the partial answer is kept and flagged, then `[DONE]`/EOF ends the stream.
    Truncated { delta: Option<String> },
    /// The `data: [DONE]` terminator.
    Done,
    /// A mid-stream OpenRouter `error` frame (HTTP was already 200) — fatal, must
    /// surface as a `ChatEvent::Error`, never be swallowed into an empty answer.
    Error(String),
    /// A heartbeat comment, blank line, non-`data:` field, empty delta, or a
    /// malformed chunk — all skipped, none fatal.
    Other,
}

/// Parse one line of the OpenRouter SSE stream on the ANSWER turn. Pure (no I/O)
/// so it is unit-tested directly. A malformed `data:` payload is skipped, not
/// surfaced — mid-stream JSON noise (e.g. keep-alive artifacts) must not sink an
/// otherwise-good answer.
pub fn parse_sse_line(line: &str) -> SseEvent {
    sse_event(classify_sse_line(line))
}

/// What a classified line means on the answer turn. Split from
/// [`parse_sse_line`] so [`consume_sse_line`] can read the frame's usage on the
/// way past without classifying the line twice.
fn sse_event(classified: SseLine) -> SseEvent {
    match classified {
        SseLine::Ignorable => SseEvent::Other,
        SseLine::Done => SseEvent::Done,
        SseLine::Failed(message) => SseEvent::Error(message),
        SseLine::Chunk(chunk) => answer_event(chunk),
    }
}

/// What a `data:` line means before either turn interprets it.
///
/// The two turns read different things out of a frame, but they agree completely
/// on comments, the terminator, and the in-band failure frame. Resolving those
/// once is what stops the answer path and the tool path drifting apart on them —
/// a stream error swallowed on one path and surfaced on the other would be the
/// worst of both.
enum SseLine {
    Ignorable,
    Done,
    Failed(String),
    Chunk(StreamChunk),
}

fn classify_sse_line(line: &str) -> SseLine {
    let line = line.trim_end_matches(['\r', '\n']).trim();
    // `:`-prefixed lines are SSE comments (OpenRouter sends `: OPENROUTER PROCESSING`).
    if line.is_empty() || line.starts_with(':') {
        return SseLine::Ignorable;
    }
    let Some(data) = line.strip_prefix("data:") else {
        return SseLine::Ignorable;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseLine::Done;
    }
    let Ok(mut chunk) = serde_json::from_str::<StreamChunk>(data) else {
        return SseLine::Ignorable;
    };
    // Check the error frame BEFORE anything else: the failure frame carries an
    // empty `delta.content`, so an empty-delta filter would drop it.
    let Some(err) = chunk.error.take() else {
        return SseLine::Chunk(chunk);
    };
    let msg = err.message.unwrap_or_else(|| "unknown error".into());
    SseLine::Failed(match err.code {
        Some(code) => {
            // Render a string code without JSON quotes (`rate_limited`, not
            // `"rate_limited"`); numbers/other Values use Display.
            let code = code
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| code.to_string());
            format!("OpenRouter stream error {code}: {msg}")
        }
        None => format!("OpenRouter stream error: {msg}"),
    })
}

fn answer_event(chunk: StreamChunk) -> SseEvent {
    let Some(choice) = chunk.choices.into_iter().next() else {
        return SseEvent::Other;
    };
    let finish_reason = choice.finish_reason;
    let delta = choice.delta;
    // This is the no-tools final-answer path. A provider that continues the prior
    // tool protocol has violated that boundary; surface the real cause immediately
    // instead of discarding every fragment and later reporting a generic empty stream.
    if finish_reason.as_deref() == Some("tool_calls") || !delta.tool_calls.is_empty() {
        return SseEvent::Error(
            "the model tried to call a tool while NeuralNote was generating the final answer"
                .into(),
        );
    }
    // Read reasoning BEFORE the empty-content filter — the same reason the error
    // frame is read first. A reasoning-only chunk carries an empty `delta.content`,
    // so filtering first would silently drop every reasoning token, the exact
    // mechanism that nearly ate the error frame.
    //
    // Both are read from the same frame and matched exhaustively rather than
    // short-circuiting on reasoning: a frame may carry both, and returning early
    // on reasoning would drop the answer token beside it.
    let reasoning = extract_reasoning(&delta);
    let content = delta.content.filter(|s| !s.is_empty());
    // A `length` finish means the provider hit its output-token ceiling. Surface
    // it, but keep any content token on the same frame (the wire may carry the
    // final token beside the finish reason) — dropping it would lose an answer
    // token, and any citation marker riding on it. `stop`, `tool_calls`, and a
    // null finish are all ordinary and fall through to the content/reasoning
    // classification below.
    if finish_reason.as_deref() == Some("length") {
        return SseEvent::Truncated { delta: content };
    }
    match (reasoning, content) {
        (Some(reasoning), Some(delta)) => SseEvent::ReasoningAndDelta { reasoning, delta },
        (Some(reasoning), None) => SseEvent::Reasoning(reasoning),
        (None, Some(delta)) => SseEvent::Delta(delta),
        (None, None) => SseEvent::Other,
    }
}

/* ──────────────────────  The streamed TOOL-DECIDING turn  ───────────────────── */

/// One parsed SSE line's meaning on a tool-deciding turn.
pub enum ToolSseEvent {
    /// What the frame carried for this turn. Both parts, because the wire does
    /// not promise prose and tool-call fragments arrive in separate frames, and
    /// returning early on either would drop the other.
    Delta {
        content: Option<String>,
        fragments: Vec<ToolCallDelta>,
    },
    /// The `data: [DONE]` terminator.
    Done,
    /// The turn cannot be trusted or completed: an in-band error frame, a
    /// provider-declared failure, or a fragment there is no way to place.
    Failed(String),
    /// A heartbeat, reasoning, an empty delta, or malformed noise.
    Other,
}

/// The message for a fragment with no `index`, which is the one wire deviation
/// that would silently corrupt a note body rather than merely lose one.
const MISSING_TOOL_CALL_INDEX: &str =
    "the provider streamed a tool-call fragment with no index, so NeuralNote cannot tell which call it belongs to";

/// Parse one line of a streamed tool-deciding turn. Pure, like [`parse_sse_line`].
pub fn parse_tool_sse_line(line: &str) -> ToolSseEvent {
    tool_sse_event(classify_sse_line(line))
}

/// What a classified line means on the tool turn. Split for the same reason as
/// [`sse_event`]: the usage frame has to be read before the classification
/// resolves it to `Other`.
fn tool_sse_event(classified: SseLine) -> ToolSseEvent {
    match classified {
        SseLine::Ignorable => ToolSseEvent::Other,
        SseLine::Done => ToolSseEvent::Done,
        SseLine::Failed(message) => ToolSseEvent::Failed(message),
        SseLine::Chunk(chunk) => tool_event(chunk),
    }
}

fn tool_event(chunk: StreamChunk) -> ToolSseEvent {
    let Some(choice) = chunk.choices.into_iter().next() else {
        return ToolSseEvent::Other;
    };
    if let Some(message) = tool_turn_failure(choice.finish_reason.as_deref()) {
        return ToolSseEvent::Failed(message);
    }
    let mut fragments = Vec::with_capacity(choice.delta.tool_calls.len());
    for entry in choice.delta.tool_calls {
        let Some(index) = entry.index else {
            return ToolSseEvent::Failed(MISSING_TOOL_CALL_INDEX.to_string());
        };
        let (name, arguments) = match entry.function {
            Some(function) => (function.name, function.arguments),
            None => (None, None),
        };
        fragments.push(ToolCallDelta {
            index,
            id: entry.id,
            name,
            arguments,
        });
    }
    let content = choice.delta.content.filter(|s| !s.is_empty());
    if content.is_none() && fragments.is_empty() {
        return ToolSseEvent::Other;
    }
    ToolSseEvent::Delta { content, fragments }
}

/// A finish reason that means the model never finished deciding.
///
/// The completed calls of a cut-short turn are half a plan. The captured turn
/// asked for fifteen duplicate note writes and *then* errored; running the ones
/// that happened to close would execute a runaway the provider itself abandoned.
/// `stop`, `tool_calls` and a null finish are ordinary and yield `None`.
fn tool_turn_failure(finish_reason: Option<&str>) -> Option<String> {
    match finish_reason {
        Some("error") => Some(
            "the provider ended the tool turn with finish_reason \"error\", so its tool calls are an unfinished plan".into(),
        ),
        Some("length") => Some(
            "the provider hit its output ceiling mid tool-call, so the turn's tool calls are an unfinished plan".into(),
        ),
        _ => None,
    }
}

/// Process one SSE line of a tool-deciding turn into the accumulator and sink.
/// `Ok(true)` means a terminal `[DONE]` was seen (stop reading); `Ok(false)` means
/// keep reading; `Err` surfaces a failure — with every live preview already
/// cleared, so a failed turn can never leave a half-composed note on screen
/// looking like one that landed.
pub fn consume_tool_sse_line(
    line_bytes: &[u8],
    accumulator: &mut ToolTurnAccumulator,
    sink: &mut dyn EventSink,
) -> CoreResult<bool> {
    let line = String::from_utf8_lossy(line_bytes);
    let classified = classify_sse_line(&line);
    // Before classification, for the same reason as the answer turn: the captured
    // OpenRouter usage frame rides on the terminal `finish_reason: "error"` chunk,
    // which classifies as a turn failure and would take the measurement with it.
    if let SseLine::Chunk(chunk) = &classified {
        accumulator.report_usage(
            chunk.usage.as_ref().and_then(WireUsage::to_token_usage),
            sink,
        );
    }
    match tool_sse_event(classified) {
        ToolSseEvent::Delta { content, fragments } => {
            if let Some(content) = content {
                accumulator.push_content(&content);
            }
            for fragment in fragments {
                accumulator.push_fragment(fragment, sink);
            }
            Ok(false)
        }
        ToolSseEvent::Done => Ok(true),
        ToolSseEvent::Failed(message) => {
            accumulator.abandon(tool_stream::ABANDONED_TURN_FAILED, sink);
            Err(CoreError::Llm(message))
        }
        ToolSseEvent::Other => Ok(false),
    }
}

/// Pull streamed reasoning text from a delta, if any. Prefers the documented
/// structured `reasoning_details` array, concatenating consecutive `reasoning.text`
/// entries; `reasoning.summary` / `reasoning.encrypted` entries carry no display text
/// and are skipped. Falls back to a plain-string `reasoning` field — not documented as
/// deprecated, and some providers still emit it instead of the array. Returns `None`
/// when there is no reasoning text to surface (so the caller falls through to content).
fn extract_reasoning(delta: &StreamDelta) -> Option<String> {
    let text: String = delta
        .reasoning_details
        .iter()
        .filter(|d| d.kind.as_deref() == Some("reasoning.text"))
        .filter_map(|d| d.text.as_deref())
        .collect();
    if !text.is_empty() {
        return Some(text);
    }
    delta.reasoning.clone().filter(|s| !s.is_empty())
}

/* ───────────────────────────  Wire (OpenAI) shape  ─────────────────────── */
// The core's LlmMessage serialises camelCase (the IPC/UI contract). The OpenRouter
// wire is snake_case, so we map explicitly here rather than reuse the core's serde.

/// OpenRouter's unified reasoning request object. We only ever enable it — no
/// `effort` / `max_tokens` knobs (YAGNI); its presence is what tells OpenRouter to
/// stream reasoning tokens as `delta.reasoning_details`. Omitted entirely for
/// providers that don't speak it (Ollama's OpenAI-compatible endpoint).
#[derive(Serialize)]
struct ReasoningRequest {
    enabled: bool,
}

/// Ollama request options. OpenRouter has a large context and its own defaults, so
/// only the local (Ollama) client sets this.
#[derive(Serialize)]
struct WireOptions {
    /// Context window in tokens. Ollama otherwise falls back to a ~4096 default and
    /// **silently truncates from the front** — dropping the grounding rules (sent
    /// first) and earliest evidence, which breaks cited recall on the Local path.
    /// Sized to fit the retrieval budget (`orchestrator::max_context_chars`) with
    /// headroom; all curated models support it (see `ai::local` allowlist).
    num_ctx: u32,
}

/// The OpenAI-compatible ask for a usage frame on a streamed response.
///
/// **Not optional cosmetics on the local lane — it is the only way to get token
/// counts there at all.** Probed against Ollama 0.31.1 with the exact body this
/// client sends: without it, 249 frames and no `usage` object anywhere; with it,
/// a final `{"choices":[],"usage":{...}}` frame. OpenRouter reports usage on the
/// streaming path either way (its own docs now call both this and
/// `usage: {include: true}` deprecated and inert), so sending it always keeps one
/// code path instead of sniffing the provider.
///
/// Only ever sent on a streamed request: the OpenAI schema rejects
/// `stream_options` without `stream`, and on a buffered response the usage object
/// is already in the body.
#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// The provider's token report. Both counts are `Option` and neither is
/// defaulted: a frame missing one yields no measurement rather than a zero, so a
/// wire shape we did not anticipate degrades to *absent* and never to a number
/// the footer would show as real. (The pre-existing `"usage":{}` frame in the
/// answer-stream tests lands here and correctly produces nothing.)
#[derive(Debug, Deserialize)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

impl WireUsage {
    fn to_token_usage(&self) -> Option<TokenUsage> {
        Some(TokenUsage {
            tokens_in: self.prompt_tokens?,
            tokens_out: self.completion_tokens?,
        })
    }
}

/// The token usage a buffered (non-streamed) response reported, if any.
///
/// Read separately from [`parse_completion`] rather than folded into
/// [`Completion`]: what the model *said* and what the call *cost* are two
/// different facts, and the ~40 places that build a `Completion` have nothing to
/// say about the second.
pub fn parse_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    serde_json::from_value::<WireUsage>(value.get("usage")?.clone())
        .ok()?
        .to_token_usage()
}

#[derive(Serialize)]
struct WireRequest<'a> {
    model: &'a str,
    messages: Vec<WireMessage>,
    /// Omitted entirely when empty — that is how the orchestrator's final answer
    /// turn (no tools) tells the model to prose, not tool-call.
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    tools: &'a [serde_json::Value],
    stream: bool,
    /// Asks for the streamed turn's token usage. Present on every streamed
    /// request and omitted from every buffered one — see [`StreamOptions`].
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    /// Set only for the local (Ollama) provider to size its context window; omitted
    /// for OpenRouter.
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<WireOptions>,
    /// Optional output cap for streamed answer turns; omitted for tool-deciding turns.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// Set only by the OpenRouter client to request streamed reasoning tokens; omitted
    /// for the local (Ollama) provider, which doesn't speak it.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningRequest>,
}

impl<'a> WireRequest<'a> {
    fn from_core(
        req: &'a LlmRequest,
        stream: bool,
        num_ctx: Option<u32>,
        max_tokens: Option<u32>,
        reasoning: bool,
    ) -> Self {
        Self {
            model: &req.model,
            messages: req.messages.iter().map(WireMessage::from_core).collect(),
            tools: &req.tools,
            stream,
            stream_options: stream.then_some(StreamOptions {
                include_usage: true,
            }),
            options: num_ctx.map(|num_ctx| WireOptions { num_ctx }),
            max_tokens,
            reasoning: reasoning.then_some(ReasoningRequest { enabled: true }),
        }
    }
}

#[derive(Serialize)]
struct WireMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<WireToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl WireMessage {
    fn from_core(m: &LlmMessage) -> Self {
        Self {
            role: role_str(m.role),
            content: m.content.clone(),
            tool_calls: m
                .tool_calls
                .iter()
                .map(|t| WireToolCall {
                    id: t.id.clone(),
                    kind: "function",
                    function: WireFn {
                        name: t.name.clone(),
                        arguments: t.arguments.clone(),
                    },
                })
                .collect(),
            tool_call_id: m.tool_call_id.clone(),
            name: m.name.clone(),
        }
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

#[derive(Serialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: WireFn,
}

#[derive(Serialize)]
struct WireFn {
    name: String,
    arguments: String,
}

// ── Response (non-streamed) ──
#[derive(Deserialize)]
struct WireResponse {
    choices: Vec<WireChoice>,
}
#[derive(Deserialize)]
struct WireChoice {
    message: WireRespMessage,
}
#[derive(Deserialize)]
struct WireRespMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<WireRespToolCall>,
}
#[derive(Deserialize)]
struct WireRespToolCall {
    id: String,
    function: WireRespFn,
}
#[derive(Deserialize)]
struct WireRespFn {
    name: String,
    arguments: String,
}

// ── Response (streamed delta) ──
#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    /// The turn's token report, on the final chunk. On the local lane that chunk
    /// carries no choices at all; on OpenRouter it rides on the last content
    /// frame — so it is read off the chunk, never inferred from the choice.
    #[serde(default)]
    usage: Option<WireUsage>,
    /// Present on a mid-stream failure frame. OpenRouter commits HTTP 200 on the
    /// first token, so a later failure (rate-limit, out-of-credits, provider 5xx,
    /// content filter) arrives in-band here — it MUST be surfaced, not ignored.
    #[serde(default)]
    error: Option<StreamError>,
}
#[derive(Deserialize)]
struct StreamError {
    #[serde(default)]
    code: Option<serde_json::Value>,
    #[serde(default)]
    message: Option<String>,
}
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    /// Set on the final choice of a turn: `"stop"` (natural end), `"length"` (hit the
    /// output-token ceiling — a truncated answer), `"tool_calls"`, `"error"`, etc.
    /// Absent (`null`) on every mid-stream chunk. Only `"length"` changes behaviour
    /// here; the rest are informational on this streamed answer path.
    #[serde(default)]
    finish_reason: Option<String>,
}
#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    /// OpenRouter's unified streamed reasoning: an array of typed entries. Only
    /// `reasoning.text` entries carry display text; the rest (summary/encrypted) are
    /// skipped by [`extract_reasoning`]. Absent for providers that don't reason.
    #[serde(default)]
    reasoning_details: Vec<ReasoningDetail>,
    /// Secondary shape: a plain-string reasoning delta. Not documented as deprecated,
    /// and some providers still emit `delta.reasoning` instead of the structured
    /// `reasoning_details` array — so both are supported, the array preferred.
    #[serde(default)]
    reasoning: Option<String>,
    /// Streamed tool-call fragments. Accumulated by the tool-turn path
    /// ([`parse_tool_sse_line`]); rejected explicitly by the final-answer path,
    /// which advertises no tools and therefore cannot act on them.
    #[serde(default)]
    tool_calls: Vec<StreamToolCall>,
}

/// One streamed tool-call entry. Shapes verified against the captured turn in
/// `fixtures/openrouter_tool_stream.sse`: `index` on every entry, `id` and
/// `function.name` exactly once each, then `function.arguments` in fragments.
#[derive(Deserialize)]
struct StreamToolCall {
    /// The accumulation key. Deliberately NOT defaulted: defaulting it to 0 would
    /// silently fold every call of a runaway turn into one, which is a wrong note
    /// body rather than a visible failure.
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<StreamToolFn>,
}

#[derive(Deserialize)]
struct StreamToolFn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// One entry in `delta.reasoning_details`. Only `type` and `text` are read; the other
/// documented fields (`summary`, `data`, `signature`, `id`, `format`, `index`) are
/// ignored — serde skips unknown fields, so an encrypted/summary entry parses without
/// error and simply yields no display text.
#[derive(Deserialize)]
struct ReasoningDetail {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_content_line_yields_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Delta(d) if d == "Hello"));
    }

    #[test]
    fn sse_done_terminates() {
        assert!(matches!(parse_sse_line("data: [DONE]"), SseEvent::Done));
    }

    #[test]
    fn sse_heartbeat_and_blank_are_ignored() {
        assert!(matches!(
            parse_sse_line(": OPENROUTER PROCESSING"),
            SseEvent::Other
        ));
        assert!(matches!(parse_sse_line(""), SseEvent::Other));
    }

    #[test]
    fn sse_empty_delta_is_ignored() {
        // The final usage chunk carries an empty content delta — not a token.
        let line = r#"data: {"choices":[{"delta":{"content":""}}],"usage":{}}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Other));
    }

    #[test]
    fn sse_role_only_delta_is_ignored_on_answer_stream() {
        // A metadata-only delta with no content, reasoning, or tool call is not text.
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Other));
    }

    #[test]
    fn sse_malformed_json_is_skipped_not_fatal() {
        assert!(matches!(parse_sse_line("data: {not json"), SseEvent::Other));
    }

    #[test]
    fn wire_request_omits_empty_tools_and_maps_snake_case() {
        let req = LlmRequest {
            model: "anthropic/claude-sonnet-4.5".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        let v = to_wire_request(&req, true, None, None, false);
        assert_eq!(v["model"], "anthropic/claude-sonnet-4.5");
        assert_eq!(v["stream"], true);
        assert!(
            v.get("tools").is_none(),
            "empty tools must be omitted (answer turn)"
        );
        assert_eq!(v["messages"][0]["role"], "user");
        assert!(
            v.get("options").is_none(),
            "no options when num_ctx is None (OpenRouter)"
        );
        assert!(v.get("max_tokens").is_none());
        assert!(
            v.get("reasoning").is_none(),
            "reasoning must be omitted when not requested"
        );
    }

    #[test]
    fn a_streamed_request_asks_for_usage_and_a_buffered_one_does_not() {
        // The local lane reports no tokens at all without this — probed against
        // Ollama 0.31.1 with this exact body. It is confined to streamed requests
        // because the OpenAI schema rejects `stream_options` without `stream`,
        // and a buffered response already carries `usage` in its body.
        let req = LlmRequest {
            model: "qwen3.5:9b".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        let streamed = to_wire_request(&req, true, None, None, false);
        assert_eq!(streamed["stream_options"]["include_usage"], true);

        let buffered = to_wire_request(&req, false, None, None, false);
        assert!(
            buffered.get("stream_options").is_none(),
            "stream_options must never ride on a non-streamed request"
        );
    }

    #[test]
    fn wire_request_sets_num_ctx_only_when_provided() {
        let req = LlmRequest {
            model: "qwen2.5:7b".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        // Local (Ollama) path: options.num_ctx present so Ollama sizes its window
        // instead of front-truncating the grounding rules + evidence.
        let local = to_wire_request(&req, false, Some(32768), None, false);
        assert_eq!(local["options"]["num_ctx"], 32768);
        // OpenRouter path: no options object at all.
        let cloud = to_wire_request(&req, false, None, None, false);
        assert!(cloud.get("options").is_none());
    }

    #[test]
    fn wire_request_sets_max_tokens_only_when_provided() {
        let req = LlmRequest {
            model: "anthropic/claude-sonnet-4.5".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        let capped = to_wire_request(&req, true, None, Some(ANSWER_MAX_TOKENS), false);
        assert_eq!(capped["max_tokens"], 4096);
        let uncapped = to_wire_request(&req, true, None, None, false);
        assert!(uncapped.get("max_tokens").is_none());
    }

    #[test]
    fn wire_request_emits_reasoning_object_only_when_requested() {
        let req = LlmRequest {
            model: "anthropic/claude-sonnet-4.5".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        // OpenRouter answer turn: the unified reasoning object asks for streamed
        // reasoning tokens.
        let on = to_wire_request(&req, true, None, Some(ANSWER_MAX_TOKENS), true);
        assert_eq!(on["reasoning"]["enabled"], true);
        // Any turn that doesn't request it (all tool turns, and the whole Local path)
        // must omit the field entirely — Ollama would ignore or reject it.
        let off = to_wire_request(&req, true, None, Some(ANSWER_MAX_TOKENS), false);
        assert!(off.get("reasoning").is_none());
    }

    #[test]
    fn wire_message_maps_tool_call_to_snake_case_function_shape() {
        let m = LlmMessage::assistant_tool_calls(vec![ToolCall {
            id: "c1".into(),
            name: "search_notes".into(),
            arguments: r#"{"query":"x"}"#.into(),
        }]);
        let v = serde_json::to_value(WireMessage::from_core(&m)).unwrap();
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["tool_calls"][0]["id"], "c1");
        assert_eq!(v["tool_calls"][0]["type"], "function");
        assert_eq!(v["tool_calls"][0]["function"]["name"], "search_notes");
    }

    // A sink that records events, to exercise consume_sse_line without a network.
    #[derive(Default)]
    struct VecSink(Vec<ChatEvent>);
    impl EventSink for VecSink {
        fn send(&mut self, event: ChatEvent) {
            self.0.push(event);
        }
    }

    /// A sink that keeps every usage report in order, so a test can tell one
    /// report from two and `Some` from `None`.
    #[derive(Default)]
    struct MeteringSink {
        reports: Vec<Option<TokenUsage>>,
    }
    impl EventSink for MeteringSink {
        fn send(&mut self, _event: ChatEvent) {}
        fn record_usage(&mut self, usage: Option<TokenUsage>) {
            self.reports.push(usage);
        }
    }

    #[test]
    fn redact_removes_the_key_everywhere_it_appears() {
        let key = "sk-or-secret-123";
        let body = format!("401: bad key 'Bearer {key}' (also {key})");
        let out = redact(&body, key);
        assert!(!out.contains(key), "the key must never survive redaction");
        assert!(out.contains("***"));
    }

    #[test]
    fn redact_is_a_noop_for_an_empty_key() {
        assert_eq!(redact("some error", ""), "some error");
    }

    #[test]
    fn sse_error_frame_surfaces_even_with_empty_delta() {
        // The exact mid-stream shape: HTTP was 200, then a failure frame carrying an
        // error object and an empty content delta. It must NOT be filtered to Other.
        let line = r#"data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}"#;
        match parse_sse_line(line) {
            SseEvent::Error(msg) => {
                assert!(msg.contains("429") && msg.contains("Rate limit exceeded"));
            }
            _ => panic!("expected SseEvent::Error for a mid-stream error frame"),
        }
    }

    #[test]
    fn sse_error_frame_without_code_still_surfaces() {
        match parse_sse_line(r#"data: {"error":{"message":"Provider disconnected"}}"#) {
            SseEvent::Error(msg) => assert!(msg.contains("Provider disconnected")),
            _ => panic!("expected SseEvent::Error"),
        }
    }

    #[test]
    fn consume_sse_line_streams_delta_and_accumulates() {
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert!(stop.is_none());
        assert_eq!(full.text(), "Hi");
        assert_eq!(sink.0.len(), 1);
        match &sink.0[0] {
            ChatEvent::Answer { delta } => assert_eq!(delta.as_str(), "Hi"),
            _ => panic!("expected an Answer event"),
        }
    }

    #[test]
    fn consume_sse_line_error_frame_returns_err() {
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        assert!(
            consume_sse_line(
                br#"data: {"error":{"message":"boom"}}"#,
                &mut sink,
                &mut full
            )
            .is_err(),
            "a mid-stream error frame must surface as Err, not be swallowed"
        );
    }

    #[test]
    fn consume_sse_line_done_returns_the_accumulated_answer() {
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"done text"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        let stop = consume_sse_line(b"data: [DONE]", &mut sink, &mut full).unwrap();
        assert_eq!(stop.as_deref(), Some("done text"));
    }

    #[test]
    fn finish_answer_rejects_an_empty_stream_including_the_done_path() {
        // A `[DONE]`-terminated stream that produced zero content is still a failure —
        // the loop's early return routes through the same guard as plain EOF, so the
        // silent-empty-answer class can't leak through `[DONE]`.
        assert!(finish_answer(String::new()).is_err());
        assert_eq!(finish_answer("answer".into()).unwrap(), "answer");
    }

    #[test]
    fn sse_error_frame_string_code_renders_without_quotes() {
        let line = r#"data: {"error":{"code":"rate_limited","message":"slow down"}}"#;
        match parse_sse_line(line) {
            SseEvent::Error(msg) => {
                assert!(msg.contains("rate_limited") && !msg.contains("\"rate_limited\""));
            }
            _ => panic!("expected SseEvent::Error"),
        }
    }

    #[test]
    fn sse_reasoning_details_text_yields_reasoning_despite_empty_content() {
        // A reasoning-only chunk: structured `reasoning_details` text AND an empty
        // `delta.content`. It must NOT be filtered to Other — reasoning is parsed
        // before the empty-delta filter (the exact trap the ordering guards against).
        let line = r#"data: {"choices":[{"delta":{"content":"","reasoning_details":[{"type":"reasoning.text","text":"Let me think"}]}}]}"#;
        match parse_sse_line(line) {
            SseEvent::Reasoning(text) => assert_eq!(text, "Let me think"),
            _ => panic!("expected SseEvent::Reasoning for a reasoning-only chunk"),
        }
    }

    #[test]
    fn sse_reasoning_details_concatenates_consecutive_text_entries() {
        // Consecutive `reasoning.text` entries in one delta are concatenated.
        let line = r#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"one "},{"type":"reasoning.text","text":"two"}]}}]}"#;
        match parse_sse_line(line) {
            SseEvent::Reasoning(text) => assert_eq!(text, "one two"),
            _ => panic!("expected concatenated reasoning text"),
        }
    }

    #[test]
    fn sse_plain_string_reasoning_yields_reasoning() {
        // The secondary shape: a plain-string `delta.reasoning` (no structured array).
        let line = r#"data: {"choices":[{"delta":{"reasoning":"pondering"}}]}"#;
        match parse_sse_line(line) {
            SseEvent::Reasoning(text) => assert_eq!(text, "pondering"),
            _ => panic!("expected SseEvent::Reasoning for a plain-string reasoning delta"),
        }
    }

    #[test]
    fn sse_reasoning_summary_and_encrypted_produce_no_text() {
        // Non-text reasoning entries must not crash and must not emit garbage text:
        // with no `reasoning.text` and no content, the chunk is simply Other.
        let line = r#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"gist"},{"type":"reasoning.encrypted","data":"AbC123"}]}}]}"#;
        assert!(
            matches!(parse_sse_line(line), SseEvent::Other),
            "summary/encrypted entries carry no display text"
        );
    }

    #[test]
    fn sse_error_frame_with_reasoning_still_surfaces_as_error() {
        // Ordering regression guard: a frame carrying BOTH an error object and
        // reasoning must surface as Error — the error check precedes the reasoning
        // check, exactly as it precedes the content filter.
        let line = r#"data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"thinking"}]}}]}"#;
        match parse_sse_line(line) {
            SseEvent::Error(msg) => {
                assert!(msg.contains("429") && msg.contains("Rate limit exceeded"));
            }
            _ => panic!("expected SseEvent::Error to win over reasoning in a failure frame"),
        }
    }

    #[test]
    fn consume_sse_line_reasoning_emits_thinking_without_accumulating() {
        // Reasoning streams to the sink as Thinking, but never enters `full` — so the
        // returned answer stays byte-equal to the Answer deltas.
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"hmm"}]}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert!(stop.is_none());
        assert!(
            full.text().is_empty(),
            "reasoning must not accumulate into the answer"
        );
        match sink.0.as_slice() {
            [ChatEvent::Thinking { delta }] => assert_eq!(delta, "hmm"),
            other => panic!("expected a single Thinking event, got {other:?}"),
        }
    }

    #[test]
    fn a_frame_carrying_reasoning_and_content_keeps_both() {
        // The wire does not promise reasoning and content arrive in separate frames.
        // A frame carrying both must surface both — dropping the content would lose an
        // answer token, and with it any citation marker riding on it.
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"so"}],"content":"[e1] Plants"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert!(stop.is_none());
        assert_eq!(
            full.text(),
            "[e1] Plants",
            "the answer token must not be dropped"
        );
        match sink.0.as_slice() {
            [ChatEvent::Thinking { delta: thinking }, ChatEvent::Answer { delta: answer }] => {
                assert_eq!(thinking, "so");
                assert_eq!(answer, "[e1] Plants");
            }
            other => panic!("expected Thinking then Answer, got {other:?}"),
        }
    }

    #[test]
    fn a_plain_string_reasoning_frame_with_content_keeps_both() {
        // Same guarantee for the legacy plain-string `reasoning` shape.
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"reasoning":"weighing","content":"Sugar."}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert_eq!(full.text(), "Sugar.");
        assert_eq!(sink.0.len(), 2, "both a Thinking and an Answer event");
    }

    #[test]
    fn reasoning_only_stream_then_done_still_fails_the_empty_answer_guard() {
        // A stream that reasons at length and then produces no answer is still a
        // failure: reasoning never satisfies finish_answer's empty-answer guard.
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        for text in ["Let me ", "think about ", "this"] {
            let line = format!(
                r#"data: {{"choices":[{{"delta":{{"reasoning_details":[{{"type":"reasoning.text","text":"{text}"}}]}}}}]}}"#
            );
            let stop = consume_sse_line(line.as_bytes(), &mut sink, &mut full).unwrap();
            assert!(stop.is_none());
        }
        let stop = consume_sse_line(b"data: [DONE]", &mut sink, &mut full).unwrap();
        assert_eq!(
            stop.as_deref(),
            Some(""),
            "a reason-only stream carries no answer"
        );
        assert!(
            finish_answer(stop.unwrap()).is_err(),
            "reasoning-only must still surface as an empty-answer failure"
        );
        assert_eq!(
            count_thinking(&sink.0),
            3,
            "every reasoning chunk should have reached the sink as Thinking"
        );
    }

    fn count_thinking(events: &[ChatEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, ChatEvent::Thinking { .. }))
            .count()
    }

    #[test]
    fn sse_length_finish_yields_truncated_with_no_trailing_content() {
        // The provider hit its output-token ceiling. OpenAI-compatible streams put
        // `finish_reason: "length"` on a final choice whose delta is empty — it must
        // surface as Truncated, not be filtered to Other by the empty-delta guard.
        let line = r#"data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}"#;
        match parse_sse_line(line) {
            SseEvent::Truncated { delta } => assert_eq!(delta, None),
            _ => panic!("expected SseEvent::Truncated for a length-finish frame"),
        }
    }

    #[test]
    fn sse_length_finish_preserves_a_trailing_content_token() {
        // A frame may carry BOTH the final content token AND `finish_reason: "length"`.
        // Dropping the content would lose an answer token — and any `[eN]` marker riding
        // on it — the same guarantee the ReasoningAndDelta case protects.
        let line = r#"data: {"choices":[{"delta":{"content":" [e1"},"finish_reason":"length"}]}"#;
        match parse_sse_line(line) {
            SseEvent::Truncated { delta } => assert_eq!(delta.as_deref(), Some(" [e1")),
            _ => panic!("expected SseEvent::Truncated carrying the trailing token"),
        }
    }

    #[test]
    fn sse_stop_finish_is_not_truncated() {
        // Ordinary completion: `finish_reason: "stop"` is the happy path — never a
        // truncation. An empty-delta stop frame is simply Other; a content stop frame is
        // a plain Delta.
        assert!(matches!(
            parse_sse_line(
                r#"data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}"#
            ),
            SseEvent::Other
        ));
        assert!(matches!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"end."},"finish_reason":"stop"}]}"#),
            SseEvent::Delta(d) if d == "end."
        ));
    }

    #[test]
    fn sse_tool_call_on_the_answer_turn_is_an_explicit_error() {
        // Captured from GMICloud through OpenRouter: despite receiving no tool
        // schemas on NeuralNote's final-answer request, the provider continued the
        // preceding tool protocol. Silently classifying these frames as Other turns
        // the real provider violation into a misleading generic empty-answer error.
        let fragment = r#"data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_note","arguments":""}}]},"finish_reason":null}]}"#;
        assert!(matches!(
            parse_sse_line(fragment),
            SseEvent::Error(message) if message.contains("tried to call a tool")
        ));

        let finish = r#"data: {"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}]}"#;
        assert!(matches!(
            parse_sse_line(finish),
            SseEvent::Error(message) if message.contains("tried to call a tool")
        ));
    }

    #[test]
    fn consume_sse_line_length_finish_flags_truncation_without_content() {
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"partial answer"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        sink.0.clear();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        // Not terminal: `[DONE]`/EOF still ends the stream. The accumulated answer is
        // untouched, and a single AnswerTruncated event is surfaced.
        assert!(stop.is_none());
        assert_eq!(full.text(), "partial answer");
        match sink.0.as_slice() {
            [ChatEvent::AnswerTruncated] => {}
            other => panic!("expected a single AnswerTruncated event, got {other:?}"),
        }
    }

    #[test]
    fn consume_sse_line_length_finish_accumulates_trailing_token_then_flags() {
        // A trailing token on the length frame reaches both the sink and `full` BEFORE
        // the truncation flag — so the returned answer stays byte-equal to the streamed
        // Answer deltas, and a severed marker is preserved verbatim (to be dropped later
        // by the citation parser, never emitted as a citation).
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"Sugar is sweet"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        sink.0.clear();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":" and salt [e2"},"finish_reason":"length"}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert_eq!(full.text(), "Sugar is sweet and salt [e2");
        match sink.0.as_slice() {
            [ChatEvent::Answer { delta }, ChatEvent::AnswerTruncated] => {
                assert_eq!(delta, " and salt [e2");
            }
            other => panic!("expected Answer then AnswerTruncated, got {other:?}"),
        }
    }

    #[test]
    fn chunk_split_frames_reassemble_and_flag_truncation() {
        // Frames arrive split across arbitrary byte boundaries (the wire does not align
        // chunks to SSE lines). Reassembling by newline and consuming each complete line
        // must yield the same answer + truncation signal regardless of the split points.
        let wire = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Photosynthesis \"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"needs light [e1\"},\"finish_reason\":\"length\"}]}\n",
            "data: [DONE]\n",
        );
        // Split the byte stream at an awkward interior point (mid-JSON, mid-multibyte-safe
        // ASCII) to prove reassembly, exactly as the shell's byte-buffer loop does.
        let bytes = wire.as_bytes();
        let mut sink = VecSink::default();
        let mut full = AnswerStream::new();
        let mut buf: Vec<u8> = Vec::new();
        let mut answer: Option<String> = None;
        for chunk in [&bytes[..40], &bytes[40..95], &bytes[95..]] {
            buf.extend_from_slice(chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                if let Some(done) = consume_sse_line(&line, &mut sink, &mut full).unwrap() {
                    answer = Some(done);
                }
            }
        }
        assert_eq!(answer.as_deref(), Some("Photosynthesis needs light [e1"));
        assert_eq!(full.text(), "Photosynthesis needs light [e1");
        assert!(
            sink.0
                .iter()
                .any(|e| matches!(e, ChatEvent::AnswerTruncated)),
            "the length cut must be surfaced even when frames were chunk-split"
        );
    }

    /* ─────────────  The streamed tool-deciding turn (contract C6)  ───────────── */

    /// Every frame below is a line of the captured OpenRouter turn. Hand-writing
    /// one would test this author's idea of the wire, not the wire.
    const CAPTURE: &str = include_str!("fixtures/openrouter_tool_stream.sse");

    /// The first captured frame matching `predicate`.
    fn captured_frame(predicate: impl Fn(&str) -> bool) -> &'static str {
        CAPTURE
            .lines()
            .find(|line| line.starts_with("data:") && predicate(line))
            .expect("the capture still contains this frame")
    }

    fn fragments(line: &str) -> Vec<ToolCallDelta> {
        match parse_tool_sse_line(line) {
            ToolSseEvent::Delta { fragments, .. } => fragments,
            _ => panic!("expected tool-call fragments from {line}"),
        }
    }

    /* ─────────────────────────  What a turn actually cost  ───────────────────── */

    /// A real streamed answer turn from the LOCAL lane (Ollama 0.31.1), captured
    /// with the body this client sends plus `stream_options`. It is here for one
    /// wire fact the OpenRouter capture cannot settle: the local usage frame
    /// carries an EMPTY `choices` array, so any parse that reads the choice first
    /// throws the measurement away.
    const LOCAL_CAPTURE: &str = include_str!("fixtures/ollama_answer_stream.sse");

    fn captured_local_frame(predicate: impl Fn(&str) -> bool) -> &'static str {
        LOCAL_CAPTURE
            .lines()
            .find(|line| line.starts_with("data:") && predicate(line))
            .expect("the local capture still contains this frame")
    }

    #[test]
    fn the_captured_openrouter_usage_frame_reports_the_turn_it_priced() {
        // The capture's usage frame rides on the terminal `finish_reason: "error"`
        // chunk. The turn still fails — but its price is read off first, rather
        // than being thrown away with the failure.
        let frame = captured_frame(|line| line.contains(r#""usage""#));
        let mut sink = MeteringSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        let outcome = consume_tool_sse_line(frame.as_bytes(), &mut accumulator, &mut sink);

        assert!(outcome.is_err(), "the frame still fails the turn");
        assert_eq!(
            sink.reports,
            vec![Some(TokenUsage {
                tokens_in: 217,
                tokens_out: 17_572,
            })]
        );
        assert!(accumulator.usage_reported());
    }

    #[test]
    fn the_captured_local_usage_frame_is_read_despite_carrying_no_choices() {
        let frame = captured_local_frame(|line| line.contains(r#""usage""#));
        assert!(
            frame.contains(r#""choices":[]"#),
            "the local usage frame is the empty-choices shape this test exists for"
        );
        let mut sink = MeteringSink::default();
        let mut stream = AnswerStream::new();
        consume_sse_line(frame.as_bytes(), &mut sink, &mut stream).unwrap();

        assert_eq!(
            sink.reports,
            vec![Some(TokenUsage {
                tokens_in: 17,
                tokens_out: 153,
            })]
        );
        assert!(stream.usage_reported());
    }

    #[test]
    fn a_whole_local_answer_stream_reports_its_price_exactly_once() {
        let mut sink = MeteringSink::default();
        let mut stream = AnswerStream::new();
        for line in LOCAL_CAPTURE.lines() {
            if consume_sse_line(line.as_bytes(), &mut sink, &mut stream)
                .unwrap()
                .is_some()
            {
                break;
            }
        }
        // Exactly one report per model call is what makes a run's total addable.
        assert_eq!(sink.reports.len(), 1);
        assert!(!stream.text().is_empty(), "the answer still streamed");
    }

    #[test]
    fn an_unpriced_stream_reports_nothing_rather_than_a_zero() {
        // The pre-existing `"usage":{}` frame: an object with no counts in it is
        // not a measurement of nothing, it is the absence of a measurement.
        let mut sink = MeteringSink::default();
        let mut stream = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"hi"}}],"usage":{}}"#,
            &mut sink,
            &mut stream,
        )
        .unwrap();
        assert!(sink.reports.is_empty());
        assert!(!stream.usage_reported());
    }

    #[test]
    fn a_half_reported_usage_frame_is_no_measurement_at_all() {
        // Rather than defaulting the missing side to 0 — which would put a
        // fabricated number in a cost footer.
        let mut sink = MeteringSink::default();
        let mut stream = AnswerStream::new();
        consume_sse_line(
            br#"data: {"choices":[],"usage":{"prompt_tokens":17}}"#,
            &mut sink,
            &mut stream,
        )
        .unwrap();
        assert!(sink.reports.is_empty());
    }

    #[test]
    fn a_repeated_usage_frame_prices_the_turn_once() {
        let frame = captured_local_frame(|line| line.contains(r#""usage""#));
        let mut sink = MeteringSink::default();
        let mut stream = AnswerStream::new();
        consume_sse_line(frame.as_bytes(), &mut sink, &mut stream).unwrap();
        consume_sse_line(frame.as_bytes(), &mut sink, &mut stream).unwrap();
        assert_eq!(sink.reports.len(), 1, "a repeat must not double the turn");
    }

    #[test]
    fn a_buffered_response_is_priced_from_its_body_or_not_at_all() {
        let priced = serde_json::json!({
            "choices": [{ "message": { "content": "hi" } }],
            "usage": { "prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14 },
        });
        assert_eq!(
            parse_usage(&priced),
            Some(TokenUsage {
                tokens_in: 11,
                tokens_out: 3
            })
        );
        assert_eq!(
            parse_usage(&serde_json::json!({ "choices": [] })),
            None,
            "a response with no usage object prices nothing"
        );
    }

    #[test]
    fn a_first_sight_frame_carries_the_index_id_and_name_together() {
        let frame = captured_frame(|line| line.contains(r#""name":"search_notes""#));
        let fragment = fragments(frame).pop().unwrap();
        assert_eq!(fragment.index, 0);
        assert!(fragment
            .id
            .is_some_and(|id| id.starts_with("chatcmpl-tool-")));
        assert_eq!(fragment.name.as_deref(), Some("search_notes"));
        // First sight carries an EMPTY argument fragment, not a missing one.
        assert_eq!(fragment.arguments.as_deref(), Some(""));
    }

    #[test]
    fn a_continuation_frame_carries_only_the_index_and_an_argument_fragment() {
        let frame = captured_frame(|line| line.contains(r#"{\"query\""#));
        let fragment = fragments(frame).pop().unwrap();
        assert_eq!(fragment.index, 0);
        assert_eq!(fragment.id, None, "the id is sent once, on first sight");
        assert_eq!(fragment.name, None, "so is the name");
        assert!(fragment
            .arguments
            .is_some_and(|args| args.contains("query")));
    }

    #[test]
    fn the_terminal_provider_error_frame_fails_the_tool_turn() {
        // The capture ends `finish_reason: "error"` with its last call truncated.
        // Its completed calls are half a plan — fifteen duplicate note writes the
        // provider itself abandoned — so the turn fails rather than running them.
        let frame = captured_frame(|line| line.contains(r#""finish_reason":"error""#));
        match parse_tool_sse_line(frame) {
            ToolSseEvent::Failed(message) => {
                assert!(message.contains("unfinished plan"), "{message}");
            }
            _ => panic!("a provider-declared failure must not be swallowed"),
        }
    }

    #[test]
    fn an_output_ceiling_hit_mid_tool_call_fails_the_tool_turn_too() {
        // Same class as the error frame: the model never finished deciding. Not
        // observed in the capture, so it is derived from a captured frame rather
        // than invented — only the finish reason differs.
        let frame = captured_frame(|line| line.contains(r#""finish_reason":"error""#))
            .replace(r#""finish_reason":"error""#, r#""finish_reason":"length""#);
        match parse_tool_sse_line(&frame) {
            ToolSseEvent::Failed(message) => {
                assert!(message.contains("output ceiling"), "{message}")
            }
            _ => panic!("a turn cut off at the ceiling must not run its partial plan"),
        }
    }

    #[test]
    fn a_fragment_with_no_index_fails_rather_than_being_folded_onto_another_call() {
        // Defaulting a missing index to 0 would silently merge every call of a
        // runaway turn into one, which is a WRONG note body rather than a visible
        // failure. Derived by deleting the field from a real frame — the capture
        // cannot contain this case, since `index` was on all 3425 entries.
        let frame = captured_frame(|line| line.contains(r#""name":"search_notes""#))
            .replace(r#""index":0,"id""#, r#""id""#);
        assert!(
            !frame.contains(r#""index":0,"id""#),
            "the frame really lost its tool-call index"
        );
        match parse_tool_sse_line(&frame) {
            ToolSseEvent::Failed(message) => assert!(message.contains("no index"), "{message}"),
            _ => panic!("an unplaceable fragment must surface, not be guessed at"),
        }
    }

    #[test]
    fn the_tool_turn_agrees_with_the_answer_turn_on_comments_done_and_errors() {
        // Both turns read the same stream. A stream error swallowed on one path
        // and surfaced on the other is the worst of both, so the shared parts are
        // resolved once — this is the test that says so.
        assert!(matches!(
            parse_tool_sse_line(": OPENROUTER PROCESSING"),
            ToolSseEvent::Other
        ));
        assert!(matches!(parse_tool_sse_line(""), ToolSseEvent::Other));
        assert!(matches!(
            parse_tool_sse_line("data: [DONE]"),
            ToolSseEvent::Done
        ));
        assert!(matches!(
            parse_tool_sse_line("data: {not json"),
            ToolSseEvent::Other
        ));
        let error = r#"data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[]}"#;
        match parse_tool_sse_line(error) {
            ToolSseEvent::Failed(message) => assert!(message.contains("Rate limit exceeded")),
            _ => panic!("an in-band error frame is fatal on the tool turn too"),
        }
    }

    #[test]
    fn a_reasoning_frame_on_the_tool_turn_is_not_mistaken_for_a_tool_call() {
        let frame = captured_frame(|line| line.contains("reasoning.text"));
        assert!(matches!(parse_tool_sse_line(frame), ToolSseEvent::Other));
    }

    #[test]
    fn consuming_a_failure_frame_clears_the_live_previews_before_it_errors() {
        // Otherwise a half-composed note is left on screen looking like one that
        // landed, which is the exact failure NoteEditAbandoned exists to prevent.
        let mut sink = crate::ai::events::VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        accumulator.push_fragment(
            ToolCallDelta {
                index: 0,
                id: Some("call-1".into()),
                name: Some(crate::ai::tool_registry::TOOL_WRITE_NOTE.into()),
                arguments: Some(r#"{"content": "half"#.into()),
            },
            &mut sink,
        );
        let frame = captured_frame(|line| line.contains(r#""finish_reason":"error""#));

        let error = consume_tool_sse_line(frame.as_bytes(), &mut accumulator, &mut sink)
            .expect_err("the failure is surfaced");

        assert!(error.to_string().contains("unfinished plan"));
        assert!(sink.events.iter().any(|event| matches!(
            event,
            ChatEvent::NoteEditAbandoned { reason, .. } if reason == tool_stream::ABANDONED_TURN_FAILED
        )));
    }

    #[test]
    fn consuming_the_capture_ends_on_its_terminator() {
        let mut sink = crate::ai::events::VecSink::default();
        let mut accumulator = ToolTurnAccumulator::new();
        assert!(
            !consume_tool_sse_line(b"data: [not json", &mut accumulator, &mut sink).unwrap(),
            "noise is skipped, never fatal"
        );
        assert!(
            consume_tool_sse_line(b"data: [DONE]", &mut accumulator, &mut sink).unwrap(),
            "the terminator stops the read"
        );
    }
}
