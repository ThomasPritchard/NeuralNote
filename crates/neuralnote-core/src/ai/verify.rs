//! Citation verification — the moat's discipline, held even in the keyword slice.
//!
//! Before any citation is surfaced, its span is re-read from disk and proven
//! current: the note's content hash must be unchanged since the span was captured
//! AND the quoted text must still occur verbatim. Any doubt drops the citation —
//! *a wrong citation is worse than no answer* (spec §6). No crypto dependency: the
//! same [`crate::model::NoteDoc::content_hash`] the vault already computes is reused.

use crate::ai::evidence::EvidenceSpan;
use crate::note::read_note;
use std::path::PathBuf;

/// Re-verifies cited spans against the live vault.
pub struct CitationVerifier {
    root: PathBuf,
}

impl CitationVerifier {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Prove `span` is safe to surface. Returns `Ok(())` when the note is unchanged
    /// and still contains the quoted text; otherwise `Err(reason)` — a human-readable
    /// reason to show in a [`crate::ai::events::ChatEvent::CitationDropped`] event.
    ///
    /// A note that cannot be re-read (deleted, permissions) is a drop, not a hard
    /// error: one bad citation must never sink the whole answer.
    pub fn verify(&self, span: &EvidenceSpan) -> Result<(), String> {
        // An empty span is structurally uncitable — and `raw.contains("")` is always
        // true, so the quote check below would pass it vacuously. Reject it up front.
        // Empty text is reachable: a blank line, an empty note, or `max_bytes`
        // truncating a multibyte first char to zero.
        if span.text.is_empty() {
            return Err("the cited span has no quotable text".to_string());
        }
        let doc = read_note(&self.root, &self.root.join(&span.rel_path))
            .map_err(|e| format!("the cited note could not be re-read: {e}"))?;
        if doc.content_hash != span.content_hash {
            return Err("the note changed on disk since it was read".to_string());
        }
        // Belt-and-suspenders alongside the hash: guards a span whose recorded text
        // was never actually in the note (a fabricated quote paired with a real hash).
        if !doc.raw.contains(&span.text) {
            return Err("the quoted text is no longer present in the note".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::retrieval::{KeywordRetriever, RetrievalProvider};
    use std::fs;

    fn vault_with(content: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), content).unwrap();
        dir
    }

    fn captured_span(root: &std::path::Path) -> EvidenceSpan {
        // Capture a span the honest way — via the retriever — so its hash + text
        // match the note exactly at capture time.
        let r = KeywordRetriever::new(root);
        r.search_notes("target", 8, None).unwrap().spans.remove(0)
    }

    #[test]
    fn passes_an_unchanged_citation() {
        let v = vault_with("target line here\n");
        let span = captured_span(v.path());
        assert!(CitationVerifier::new(v.path()).verify(&span).is_ok());
    }

    #[test]
    fn drops_when_the_note_changed_on_disk() {
        let v = vault_with("target line here\n");
        let span = captured_span(v.path());
        // An external edit lands after the span was captured.
        fs::write(v.path().join("n.md"), "totally different content\n").unwrap();
        let err = CitationVerifier::new(v.path()).verify(&span).unwrap_err();
        assert!(err.contains("changed on disk"));
    }

    #[test]
    fn drops_when_the_quoted_text_is_absent_despite_matching_hash() {
        let v = vault_with("target line here\n");
        // Craft a span with the note's REAL current hash but a fabricated quote —
        // the hash check passes, so only the text check can catch it.
        let doc = read_note(v.path(), &v.path().join("n.md")).unwrap();
        let span = EvidenceSpan {
            id: "e1".into(),
            rel_path: "n.md".into(),
            content_hash: doc.content_hash,
            start_line: 1,
            end_line: 1,
            text: "a quote the note never contained".into(),
        };
        let err = CitationVerifier::new(v.path()).verify(&span).unwrap_err();
        assert!(err.contains("no longer present"));
    }

    #[test]
    fn drops_a_span_with_empty_quotable_text() {
        // A blank-line span (empty text) must not verify vacuously via `contains("")`.
        let v = vault_with("first\n\nthird\n");
        let doc = read_note(v.path(), &v.path().join("n.md")).unwrap();
        let blank = EvidenceSpan {
            id: "e1".into(),
            rel_path: "n.md".into(),
            content_hash: doc.content_hash,
            start_line: 2,
            end_line: 2,
            text: String::new(),
        };
        let err = CitationVerifier::new(v.path()).verify(&blank).unwrap_err();
        assert!(err.contains("no quotable text"));
    }

    #[test]
    fn drops_when_the_note_was_deleted() {
        let v = vault_with("target line here\n");
        let span = captured_span(v.path());
        fs::remove_file(v.path().join("n.md")).unwrap();
        assert!(CitationVerifier::new(v.path()).verify(&span).is_err());
    }
}
