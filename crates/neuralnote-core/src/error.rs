//! Typed, serialisable errors. Every failure crosses the Tauri boundary as a
//! tagged JSON object `{ kind, message }`, so the UI can react to the *kind*
//! (e.g. show a "name already taken" inline message) rather than parsing prose.
//!
//! Hand-rolled (no `thiserror`) to keep the dependency surface minimal.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum CoreError {
    /// Target path does not exist.
    NotFound(String),
    /// A create/rename/move would clobber an existing entry.
    AlreadyExists(String),
    /// The path escapes the open vault root — refused. This is the security spine.
    OutsideVault(String),
    /// An empty, reserved, or separator-bearing name was supplied.
    InvalidName(String),
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
            CoreError::Conflict(m) => write!(f, "conflict: {m}"),
            CoreError::Io(m) => write!(f, "io error: {m}"),
            CoreError::Frontmatter(m) => write!(f, "frontmatter error: {m}"),
            CoreError::Llm(m) => write!(f, "llm error: {m}"),
            CoreError::LocalAi(m) => write!(f, "local AI error: {m}"),
        }
    }
}

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
    fn local_ai_serializes_kind_and_displays() {
        let error = CoreError::LocalAi("x".into());
        let value = serde_json::to_value(&error).unwrap();

        assert_eq!(value["kind"], "localAi");
        assert!(!error.to_string().is_empty());
    }
}
