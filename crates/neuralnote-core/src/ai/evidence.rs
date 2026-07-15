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
/// model's citations stable across a run. When a later read of that same range
/// brings back MORE context (same source revision), the stored text widens in place
/// while keeping its id. It is the single source of truth the verifier consults when
/// the model cites an id.
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
    /// so ids stay globally unique across every search in the run. A span matching an
    /// existing one on `(rel_path, line-range)` collapses to that existing id.
    ///
    /// When the ranges collide, the stored text WIDENS to the fuller read — but only
    /// when the source is provably the same revision (`content_hash` matches) and the
    /// incoming text is strictly longer. Both texts are then verbatim substrings of
    /// one note revision, so the longer strictly dominates and the `(text, hash)` pair
    /// the verifier trusts stays self-consistent. The id never changes; a narrower
    /// later read never shrinks the span.
    ///
    /// On a `content_hash` mismatch the note changed on disk between the two reads, so
    /// the two texts may quote different revisions. Widening is refused outright: the
    /// first span is kept intact rather than pairing one revision's text with
    /// another's hash, which would break the verbatim-substring invariant the moat
    /// rests on. A genuinely-changed note is caught later by the verifier's hash check
    /// and dropped, so retaining the original never surfaces a wrong citation.
    pub fn register(&mut self, mut span: EvidenceSpan) -> String {
        let key = (span.rel_path.clone(), span.start_line, span.end_line);
        if let Some(&idx) = self.by_range.get(&key) {
            let existing = &mut self.spans[idx];
            if existing.content_hash == span.content_hash && span.text.len() > existing.text.len() {
                existing.text = span.text;
            }
            return existing.id.clone();
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
        span_h(rel, start, end, text, "h")
    }

    fn span_h(rel: &str, start: u32, end: u32, text: &str, hash: &str) -> EvidenceSpan {
        EvidenceSpan {
            id: String::new(),
            rel_path: rel.into(),
            content_hash: hash.into(),
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
    fn later_wider_read_widens_the_stored_span_keeping_its_id() {
        // narrow-then-wide: a second read of the SAME note + line range brought back
        // more context (same source, so same content_hash). The stored text must
        // widen in place and the citable id must stay stable.
        let mut reg = EvidenceRegistry::new();
        let first = reg.register(span_h("a.md", 3, 5, "short", "h1"));
        let again = reg.register(span_h("a.md", 3, 5, "short but much longer text", "h1"));
        assert_eq!(first, again, "a widened span keeps its id");
        assert_eq!(reg.len(), 1, "widening must not double-register");
        assert_eq!(
            reg.get(&first).unwrap().text,
            "short but much longer text",
            "the stored text widens to the fuller read"
        );
    }

    #[test]
    fn later_narrower_read_never_shrinks_the_stored_span() {
        // wide-then-narrow: once a fuller span is registered, a thinner later read of
        // the same range must NOT shrink it — context is only ever added, never lost.
        let mut reg = EvidenceRegistry::new();
        let first = reg.register(span_h("a.md", 1, 2, "the full quoted paragraph", "h1"));
        let again = reg.register(span_h("a.md", 1, 2, "the full", "h1"));
        assert_eq!(first, again);
        assert_eq!(reg.len(), 1);
        assert_eq!(
            reg.get(&first).unwrap().text,
            "the full quoted paragraph",
            "a narrower later read must not shrink the stored span"
        );
    }

    #[test]
    fn changed_hash_does_not_mix_text_from_two_source_versions() {
        // changed-hash: the note changed on disk between the two reads (different
        // content_hash), so the two texts may quote different revisions. Even though
        // the later text is longer, widening is refused: the stored (text, hash) pair
        // must stay self-consistent — a verbatim substring of the revision its hash
        // names — or the verifier's contains-check becomes meaningless.
        let mut reg = EvidenceRegistry::new();
        let first = reg.register(span_h("a.md", 4, 4, "original line", "hash_v1"));
        let again = reg.register(span_h(
            "a.md",
            4,
            4,
            "rewritten line, now much longer",
            "hash_v2",
        ));
        assert_eq!(
            first, again,
            "the id stays stable across a changed-hash read"
        );
        assert_eq!(reg.len(), 1);
        let stored = reg.get(&first).unwrap();
        assert_eq!(
            stored.text, "original line",
            "text from a different source version must not overwrite the stored text"
        );
        assert_eq!(
            stored.content_hash, "hash_v1",
            "the stored text and its hash must stay a self-consistent pair"
        );
    }

    #[test]
    fn widening_preserves_char_boundaries_and_verbatim_substring() {
        // Unicode: the narrow read was byte-truncated at a char boundary; the wider
        // read carries the fuller multibyte text. Widening stores the wider text
        // wholesale (it never re-slices), so the result stays valid UTF-8 and a
        // verbatim substring of the source — the moat's invariant.
        let source = "café — naïve façade with ünïcödé";
        let narrow = &source[..source
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= 6)
            .unwrap()]; // a char-boundary prefix
        let mut reg = EvidenceRegistry::new();
        let id = reg.register(span_h("m.md", 1, 1, narrow, "h1"));
        reg.register(span_h("m.md", 1, 1, source, "h1"));
        let stored = &reg.get(&id).unwrap().text;
        assert_eq!(
            stored, source,
            "widening lands on the fuller multibyte text"
        );
        assert!(
            std::str::from_utf8(stored.as_bytes()).is_ok(),
            "the widened text is valid UTF-8 (no split code point)"
        );
        assert!(
            source.contains(stored.as_str()),
            "the widened text stays a verbatim substring of the source"
        );
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
