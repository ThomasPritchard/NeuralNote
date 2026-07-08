//! The LLM transport seam — the boundary between the orchestrator (network-free,
//! here) and the host's real HTTP client (the Tauri shell's OpenRouter client).
//!
//! The message/tool-call types are the OpenAI-compatible chat shape the shell maps
//! to the wire. Two methods split the loop deliberately: tool-deciding turns run
//! non-streamed ([`LlmClient::complete`]) for clean `tool_calls` parsing, and the
//! final answer is streamed ([`LlmClient::complete_streaming`]) so the UI sees it
//! arrive live. A mock (unit tests) and the real reqwest client both implement it.

use crate::ai::events::EventSink;
use crate::error::CoreResult;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A chat message role. Serialises to the OpenAI-compatible lowercase strings
/// (`system` / `user` / `assistant` / `tool`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One tool call the model requested. `arguments` is the raw JSON string exactly as
/// the model emitted it — parsed at dispatch time, so a malformed argument blob is
/// the model's problem to recover from (a tool error message), not a hard failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// A single chat message. Shaped for the OpenAI-compatible protocol: an assistant
/// turn may carry `tool_calls`; a tool result carries `tool_call_id` + `name`.
/// Empty/absent fields are skipped on serialisation to keep request bodies clean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl LlmMessage {
    /// The system prompt turn.
    pub fn system(content: impl Into<String>) -> Self {
        Self::text(Role::System, content)
    }

    /// A user turn.
    pub fn user(content: impl Into<String>) -> Self {
        Self::text(Role::User, content)
    }

    /// An assistant turn that only issues tool calls (no prose content) — the
    /// protocol-required record that precedes the matching tool-result messages.
    pub fn assistant_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: Role::Assistant,
            content: None,
            tool_calls,
            tool_call_id: None,
            name: None,
        }
    }

    /// The result of one tool call, keyed back to its call `id` so the model can
    /// match it to the request.
    pub fn tool_result(
        tool_call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            role: Role::Tool,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            name: Some(name.into()),
        }
    }

    fn text(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            name: None,
        }
    }
}

/// The model's response to a non-streamed [`LlmClient::complete`] turn: prose
/// `content` and/or the `tool_calls` it wants dispatched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
}

/// A chat-completion request: which model, the conversation so far, and the tool
/// schemas the model may call (`serde_json::Value`, built by [`crate::ai::tools`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<serde_json::Value>,
}

/// The transport the orchestrator drives. `Send + Sync` so the host can call it
/// from its worker pool and the orchestrator's future stays `Send`.
#[async_trait]
pub trait LlmClient: Send + Sync {
    /// A tool-deciding turn: return the model's [`Completion`] (content and/or tool
    /// calls). Not streamed, so `tool_calls` parse cleanly.
    async fn complete(&self, req: &LlmRequest) -> CoreResult<Completion>;

    /// Stream the final answer: push each chunk as a [`ChatEvent::Answer`] via
    /// `sink` and return the full assembled text (the orchestrator scans it for the
    /// evidence ids the model cited).
    ///
    /// **Conformance contract:** the returned `String` MUST equal the concatenation
    /// of the `Answer` deltas streamed to `sink`. The orchestrator verifies citations
    /// against the *returned* text, so a client whose return value diverges from what
    /// it streamed could surface a citation for text the user never saw — a silent
    /// fidelity break. (The shell's reqwest client gets a test asserting this holds.)
    ///
    /// [`ChatEvent::Answer`]: crate::ai::events::ChatEvent::Answer
    async fn complete_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> CoreResult<String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructors_set_the_right_roles() {
        assert_eq!(LlmMessage::system("s").role, Role::System);
        assert_eq!(LlmMessage::user("u").role, Role::User);
        assert_eq!(
            LlmMessage::tool_result("call_1", "search_notes", "{}").role,
            Role::Tool
        );
        let calls = vec![ToolCall {
            id: "c1".into(),
            name: "search_notes".into(),
            arguments: "{}".into(),
        }];
        let msg = LlmMessage::assistant_tool_calls(calls);
        assert_eq!(msg.role, Role::Assistant);
        assert!(msg.content.is_none());
        assert_eq!(msg.tool_calls.len(), 1);
    }

    #[test]
    fn role_serialises_lowercase() {
        assert_eq!(serde_json::to_value(Role::Assistant).unwrap(), "assistant");
        assert_eq!(serde_json::to_value(Role::Tool).unwrap(), "tool");
    }

    #[test]
    fn empty_fields_are_skipped_on_serialisation() {
        let v = serde_json::to_value(LlmMessage::user("hi")).unwrap();
        assert_eq!(v["role"], "user");
        assert_eq!(v["content"], "hi");
        // A plain user turn carries no tool_calls / tool_call_id / name.
        assert!(v.get("toolCalls").is_none());
        assert!(v.get("toolCallId").is_none());
        assert!(v.get("name").is_none());
    }

    #[test]
    fn tool_result_carries_call_id_and_name() {
        let v = serde_json::to_value(LlmMessage::tool_result("c1", "search_notes", "{}")).unwrap();
        assert_eq!(v["toolCallId"], "c1");
        assert_eq!(v["name"], "search_notes");
        assert_eq!(v["content"], "{}");
    }

    #[test]
    fn completion_defaults_tool_calls_when_absent() {
        let c: Completion = serde_json::from_str(r#"{"content":"hi"}"#).unwrap();
        assert!(c.tool_calls.is_empty());
        assert_eq!(c.content.as_deref(), Some("hi"));
    }
}
