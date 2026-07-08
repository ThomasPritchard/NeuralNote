//! OpenAI-compatible wire mapping and SSE parsing.
//!
//! Pure, network-free glue between the core's [`LlmRequest`] / [`Completion`]
//! shape and the OpenAI-compatible chat wire: request serialisation, response
//! tool-call mapping, redaction, and streamed answer frame parsing. This lives in
//! core (not the Tauri shell) so coverage is measured where the behaviour is
//! owned, and so a later Ollama client can reuse the same protocol plumbing.

use crate::ai::events::{ChatEvent, EventSink};
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

/// Process one SSE line into the sink + accumulator. `Ok(Some(answer))` means a
/// terminal `[DONE]` was seen (stop reading); `Ok(None)` means keep reading; `Err`
/// surfaces a mid-stream error frame. Shared by the newline loop and the EOF flush
/// so the returned string stays byte-equal to the streamed deltas.
pub fn consume_sse_line(
    line_bytes: &[u8],
    sink: &mut dyn EventSink,
    full: &mut String,
) -> CoreResult<Option<String>> {
    match parse_sse_line(&String::from_utf8_lossy(line_bytes)) {
        SseEvent::Delta(delta) => {
            sink.send(ChatEvent::Answer {
                delta: delta.clone(),
            });
            full.push_str(&delta);
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

pub fn to_wire_request(req: &LlmRequest, stream: bool) -> serde_json::Value {
    serde_json::to_value(WireRequest::from_core(req, stream))
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
    /// The `data: [DONE]` terminator.
    Done,
    /// A mid-stream OpenRouter `error` frame (HTTP was already 200) — fatal, must
    /// surface as a `ChatEvent::Error`, never be swallowed into an empty answer.
    Error(String),
    /// A heartbeat comment, blank line, non-`data:` field, empty delta, or a
    /// malformed chunk — all skipped, none fatal.
    Other,
}

/// Parse one line of the OpenRouter SSE stream. Pure (no I/O) so it is unit-tested
/// directly. A malformed `data:` payload is skipped, not surfaced — mid-stream JSON
/// noise (e.g. keep-alive artifacts) must not sink an otherwise-good answer.
pub fn parse_sse_line(line: &str) -> SseEvent {
    let line = line.trim_end_matches(['\r', '\n']).trim();
    // `:`-prefixed lines are SSE comments (OpenRouter sends `: OPENROUTER PROCESSING`).
    if line.is_empty() || line.starts_with(':') {
        return SseEvent::Other;
    }
    let Some(data) = line.strip_prefix("data:") else {
        return SseEvent::Other;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseEvent::Done;
    }
    match serde_json::from_str::<StreamChunk>(data) {
        Ok(chunk) => {
            // Check the error frame BEFORE the empty-delta filter: the failure frame
            // carries an empty `delta.content`, so filtering first would drop it.
            if let Some(err) = chunk.error {
                let msg = err.message.unwrap_or_else(|| "unknown error".into());
                return match err.code {
                    Some(code) => {
                        // Render a string code without JSON quotes (`rate_limited`,
                        // not `"rate_limited"`); numbers/other Values use Display.
                        let code = code
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| code.to_string());
                        SseEvent::Error(format!("OpenRouter stream error {code}: {msg}"))
                    }
                    None => SseEvent::Error(format!("OpenRouter stream error: {msg}")),
                };
            }
            chunk
                .choices
                .into_iter()
                .next()
                .and_then(|c| c.delta.content)
                .filter(|s| !s.is_empty())
                .map(SseEvent::Delta)
                .unwrap_or(SseEvent::Other)
        }
        Err(_) => SseEvent::Other,
    }
}

/* ───────────────────────────  Wire (OpenAI) shape  ─────────────────────── */
// The core's LlmMessage serialises camelCase (the IPC/UI contract). The OpenRouter
// wire is snake_case, so we map explicitly here rather than reuse the core's serde.

#[derive(Serialize)]
struct WireRequest<'a> {
    model: &'a str,
    messages: Vec<WireMessage>,
    /// Omitted entirely when empty — that is how the orchestrator's final answer
    /// turn (no tools) tells the model to prose, not tool-call.
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    tools: &'a [serde_json::Value],
    stream: bool,
}

impl<'a> WireRequest<'a> {
    fn from_core(req: &'a LlmRequest, stream: bool) -> Self {
        Self {
            model: &req.model,
            messages: req.messages.iter().map(WireMessage::from_core).collect(),
            tools: &req.tools,
            stream,
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
}
#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
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
    fn sse_toolcall_only_delta_is_ignored_on_answer_stream() {
        // A delta with no `content` field (e.g. a tool_calls fragment) is not text.
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
        let v = to_wire_request(&req, true);
        assert_eq!(v["model"], "anthropic/claude-sonnet-4.5");
        assert_eq!(v["stream"], true);
        assert!(
            v.get("tools").is_none(),
            "empty tools must be omitted (answer turn)"
        );
        assert_eq!(v["messages"][0]["role"], "user");
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
        let mut full = String::new();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert!(stop.is_none());
        assert_eq!(full, "Hi");
        assert_eq!(sink.0.len(), 1);
        match &sink.0[0] {
            ChatEvent::Answer { delta } => assert_eq!(delta.as_str(), "Hi"),
            _ => panic!("expected an Answer event"),
        }
    }

    #[test]
    fn consume_sse_line_error_frame_returns_err() {
        let mut sink = VecSink::default();
        let mut full = String::from("partial");
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
        let mut full = String::from("done text");
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
}
