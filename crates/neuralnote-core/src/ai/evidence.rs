//! The durable evidence contract, and the per-run registry that hands the model
//! stable ids to cite.
//!
//! A later `VectorRetriever` (embedding-RAG) returns the *same* [`EvidenceSpan`]
//! shape, so it slots in without reshaping the chat layer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A span of a note the model may cite.
///
/// `id` is a short, stable handle (`"e1"`, `"e2"`, …) assigned by
/// [`EvidenceRegistry`] for the current chat run — the model cites that id, never
/// a freeform path (which it could fabricate). `content_hash` is the owning note's
/// [`crate::model::NoteDoc::content_hash`] captured when the span was read, so the
/// verifier can prove the note is unchanged before a citation is surfaced. `text`
/// is a verbatim substring of the note's raw content, so the verifier's
/// `raw.contains(text)` check is meaningful.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSpan {
    pub id: String,
    pub rel_path: String,
    pub content_hash: String,
    /// 1-based, inclusive line range in the note's raw text.
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

/// Per-run registry mapping citable ids to their spans.
///
/// Retrieval produces spans with a placeholder `id`; [`register`](Self::register)
/// assigns the next sequential id and dedupes on `(rel_path, line-range)` so the
/// same evidence found by two different searches collapses to one id — keeping the
/// model's citations stable across a run. It is the single source of truth the
/// verifier consults when the model cites an id.
#[derive(Debug, Default)]
pub struct EvidenceRegistry {
    spans: Vec<EvidenceSpan>,
    by_range: HashMap<(String, u32, u32), usize>,
}

impl EvidenceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `span` and return the id the model should cite. The incoming
    /// `span.id` is ignored (it is a placeholder); the registry owns id assignment
    /// so ids stay globally unique across every search in the run. Identical spans
    /// (same note + line range) collapse to their existing id.
    ///
    /// TODO(span-widen): dedup keys on the line range only, so re-reading the same
    /// range with a larger `max_bytes` reuses the first (narrower) span rather than
    /// widening it. This is a context-quality limitation only — the stored `text`
    /// stays a verbatim substring, so the moat (citation fidelity) is intact.
    /// Deferred; revisit if thin read-back context proves to hurt answer quality.
    pub fn register(&mut self, mut span: EvidenceSpan) -> String {
        let key = (span.rel_path.clone(), span.start_line, span.end_line);
        if let Some(&idx) = self.by_range.get(&key) {
            return self.spans[idx].id.clone();
        }
        let id = format!("e{}", self.spans.len() + 1);
        span.id = id.clone();
        self.by_range.insert(key, self.spans.len());
        self.spans.push(span);
        id
    }

    /// The span registered under `id`, if any. `None` means the model cited an id
    /// that was never handed out — a fabricated citation the caller must drop.
    pub fn get(&self, id: &str) -> Option<&EvidenceSpan> {
        self.spans.iter().find(|s| s.id == id)
    }

    /// How many distinct spans have been registered (the orchestrator's `max_spans`
    /// guard reads this).
    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(rel: &str, start: u32, end: u32, text: &str) -> EvidenceSpan {
        EvidenceSpan {
            id: String::new(),
            rel_path: rel.into(),
            content_hash: "h".into(),
            start_line: start,
            end_line: end,
            text: text.into(),
        }
    }

    #[test]
    fn assigns_sequential_ids() {
        let mut reg = EvidenceRegistry::new();
        assert!(reg.is_empty());
        assert_eq!(reg.register(span("a.md", 1, 1, "x")), "e1");
        assert!(!reg.is_empty());
        assert_eq!(reg.register(span("a.md", 2, 2, "y")), "e2");
        assert_eq!(reg.register(span("b.md", 1, 1, "z")), "e3");
        assert_eq!(reg.len(), 3);
    }

    #[test]
    fn dedupes_identical_range_to_one_id() {
        let mut reg = EvidenceRegistry::new();
        let first = reg.register(span("a.md", 3, 3, "line three"));
        let again = reg.register(span("a.md", 3, 3, "line three"));
        assert_eq!(first, again);
        assert_eq!(reg.len(), 1, "the same evidence must not double-register");
    }

    #[test]
    fn get_returns_registered_span_and_none_for_unknown() {
        let mut reg = EvidenceRegistry::new();
        let id = reg.register(span("a.md", 1, 1, "hello"));
        assert_eq!(reg.get(&id).unwrap().text, "hello");
        assert!(reg.get("e999").is_none());
    }

    #[test]
    fn evidence_span_serialises_camel_case() {
        let v = serde_json::to_value(span("a.md", 1, 2, "t")).unwrap();
        assert!(v.get("relPath").is_some());
        assert!(v.get("contentHash").is_some());
        assert!(v.get("startLine").is_some());
        assert!(v.get("endLine").is_some());
    }
}
