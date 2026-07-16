//! Typed, serialisable errors. Every failure crosses the Tauri boundary as a
//! tagged JSON object `{ kind, message }`, so the UI can react to the *kind*
//! (e.g. show a "name already taken" inline message) rather than parsing prose.
//!
//! Hand-rolled (no `thiserror`) to keep the dependency surface minimal.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
#[ts(export)]
pub enum CoreError {
    /// Target path does not exist.
    NotFound(String),
    /// A create/rename/move would clobber an existing entry.
    AlreadyExists(String),
    /// The path escapes the open vault root — refused. This is the security spine.
    OutsideVault(String),
    /// An empty, reserved, or separator-bearing name was supplied.
    InvalidName(String),
    /// Untrusted note or patch content failed validation and was not written.
    InvalidContent(String),
    /// The file changed on disk since it was read — saving would clobber an
    /// external edit. The UI offers reload-or-overwrite (optimistic concurrency).
    Conflict(String),
    /// Underlying filesystem error.
    Io(String),
    /// Frontmatter parse failure (surfaced, never swallowed).
    Frontmatter(String),
    /// An LLM transport/protocol failure (network, HTTP status, bad response) from
    /// the AI chat loop. Surfaced to the user as a `ChatEvent::Error`, never silent.
    Llm(String),
    /// Local-AI failures render distinctly from hosted LLM/provider failures.
    LocalAi(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::NotFound(m) => write!(f, "not found: {m}"),
            CoreError::AlreadyExists(m) => write!(f, "already exists: {m}"),
            CoreError::OutsideVault(m) => write!(f, "outside vault: {m}"),
            CoreError::InvalidName(m) => write!(f, "invalid name: {m}"),
            CoreError::InvalidContent(m) => write!(f, "invalid content: {m}"),
            CoreError::Conflict(m) => write!(f, "conflict: {m}"),
            CoreError::Io(m) => write!(f, "io error: {m}"),
            CoreError::Frontmatter(m) => write!(f, "frontmatter error: {m}"),
            CoreError::Llm(m) => write!(f, "llm error: {m}"),
            CoreError::LocalAi(m) => write!(f, "local AI error: {m}"),
        }
    }
}

impl CoreError {
    /// Whether this failure is worth one bounded retry of an *idempotent* operation.
    ///
    /// Retryability is a property of the error, so a newly-added transient variant can't
    /// silently fall through a call site that forgot it: the retry decision lives here,
    /// in one place, and every caller consults it rather than re-matching on error shape.
    ///
    /// Only a transport-layer LLM failure ([`CoreError::Llm`] / [`CoreError::LocalAi`])
    /// can be transient — a rate-limit, a server 5xx, or a dropped/failed connection.
    /// Everything else is permanent: auth, a bad request, an unparseable body, a domain
    /// error, or the [`CoreError::Conflict`] that a user-stop surfaces as (so a cancelled
    /// run is never retried). Retrying any of those would only repeat the same failure.
    ///
    /// Classification is by message because `CoreError` carries no structured HTTP status
    /// (it crosses the Tauri boundary as `{kind, message}`). This couples to the host
    /// transport's wording (`app/desktop/src-tauri/src/ai.rs`): HTTP failures format as
    /// `"<provider> returned <status> ..."`, a pre-response send failure as
    /// `"request to <provider> failed: ..."`.
    pub fn is_retryable(&self) -> bool {
        let message = match self {
            CoreError::Llm(m) | CoreError::LocalAi(m) => m.as_str(),
            _ => return false,
        };
        match http_status_in(message) {
            Some(status) => is_transient_status(status),
            // No HTTP status was received — the connection failed, dropped, or timed out
            // before a response. That is exactly the retryable transient class.
            None => is_dropped_connection(message),
        }
    }
}

/// 408 Request Timeout and 425 Too Early are retryable per RFC 9110; 429 is rate-limit;
/// every 5xx is a server-side transient. All other 4xx are the caller's fault (permanent).
fn is_transient_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500..=599)
}

/// The HTTP status the transport embedded as `"... returned <status> ..."`, if any.
fn http_status_in(message: &str) -> Option<u16> {
    let after = message.split("returned ").nth(1)?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    let status = digits.parse::<u16>().ok()?;
    (100..=599).contains(&status).then_some(status)
}

/// A pre-response transport failure — no HTTP status because the connection failed,
/// dropped, or timed out. The retryable transient class.
fn is_dropped_connection(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    (lower.contains("request to") && lower.contains("failed"))
        || TRANSPORT_DROP_SIGNALS
            .iter()
            .any(|signal| lower.contains(signal))
}

const TRANSPORT_DROP_SIGNALS: &[&str] = &[
    "error sending request",
    "connection closed",
    "closed before",
    "connection reset",
    "broken pipe",
    "timed out",
    "timeout",
];

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => CoreError::NotFound(e.to_string()),
            std::io::ErrorKind::AlreadyExists => CoreError::AlreadyExists(e.to_string()),
            _ => CoreError::Io(e.to_string()),
        }
    }
}

impl From<trash::Error> for CoreError {
    fn from(e: trash::Error) -> Self {
        CoreError::Io(format!("could not move to trash: {e}"))
    }
}

pub type CoreResult<T> = Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_retryable_flags_only_transient_transport_failures() {
        for message in [
            "openrouter returned 429 Too Many Requests: slow down",
            "openrouter returned 500 Internal Server Error",
            "openrouter returned 503 Service Unavailable",
            "openrouter returned 408 Request Timeout",
            "request to openrouter failed: error sending request for url (x): connection closed before message completed",
            "request to ollama failed: operation timed out",
        ] {
            assert!(
                CoreError::Llm(message.into()).is_retryable(),
                "{message} should be retryable"
            );
        }
        for message in [
            "openrouter returned 400 Bad Request: bad model",
            "openrouter returned 401 Unauthorized",
            "openrouter returned 403 Forbidden",
            "openrouter returned 404 Not Found",
            "could not parse openrouter response: expected value at line 1",
        ] {
            assert!(
                !CoreError::Llm(message.into()).is_retryable(),
                "{message} should NOT be retryable"
            );
        }
        // A user-stop surfaces as Conflict, and domain errors are never transport
        // faults — neither is ever retried.
        assert!(!CoreError::Conflict("chat run stopped by the user".into()).is_retryable());
        assert!(!CoreError::InvalidName("x".into()).is_retryable());
    }

    #[test]
    fn local_ai_serializes_kind_and_displays() {
        let error = CoreError::LocalAi("x".into());
        let value = serde_json::to_value(&error).unwrap();

        assert_eq!(value["kind"], "localAi");
        assert!(!error.to_string().is_empty());
    }
}
