//! Citation verification — the moat's discipline, held even in the keyword slice.
//!
//! Before any citation is surfaced, its span is re-read from disk and proven
//! current: the note's content hash must be unchanged since the span was captured,
//! the quoted text must still occur verbatim, AND the line range must describe
//! exactly the text quoted. Any doubt drops the citation — *a wrong citation is
//! worse than no answer* (spec §6). No crypto dependency: the same
//! [`crate::model::NoteDoc::content_hash`] the vault already computes is reused.

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

    /// Prove `span` is safe to surface. Returns `Ok(())` when the note is unchanged,
    /// still contains the quoted text, and is claimed over exactly the lines that text
    /// covers; otherwise `Err(reason)` — a human-readable reason to show in a
    /// [`crate::ai::events::ChatEvent::CitationDropped`] event.
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
        // The range must describe exactly the text carried. Neither check below can
        // see an over-claim — a prefix of a substring is still a substring, and the
        // hash covers the note, not the range — so a producer that shortened its quote
        // (a byte budget, a trimmed blank tail) without shortening its range would
        // otherwise attribute the answer to lines it never quoted. `text` is non-empty
        // here, so it covers at least its own start line.
        let expected_end = span
            .start_line
            .saturating_add(lines_carried(&span.text).saturating_sub(1));
        if span.end_line != expected_end {
            return Err(format!(
                "the cited span claims lines {}–{} but its quoted text covers {}–{expected_end}",
                span.start_line, span.end_line, span.start_line
            ));
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

/// How many of the note's lines `text` actually carries, counted the way the note
/// was split in the first place (`split_inclusive('\n')`): a `\n` ends its own line,
/// so a trailing newline opens no new one, and a final unterminated fragment still
/// counts as the line it came from. Empty text carries no line at all.
///
/// This is the single definition of the range/quote contract: producers derive their
/// end line from it (`ai::retrieval::slice_lines`) and [`CitationVerifier::verify`]
/// re-checks it, so the two can never drift apart.
pub(crate) fn lines_carried(text: &str) -> u32 {
    u32::try_from(text.split_inclusive('\n').count()).unwrap_or(u32::MAX)
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
    fn drops_a_span_whose_range_claims_more_lines_than_its_quote() {
        // The PA-003 shape: a quote shortened by a byte budget kept its untruncated
        // end line. The hash still matches and the quote is still verbatim — a prefix
        // of a substring is still a substring — so the range check is the only thing
        // between this citation and a claim over lines it never carried.
        let v = vault_with("target line here\nsecond line\nthird line\n");
        let doc = read_note(v.path(), &v.path().join("n.md")).unwrap();
        let over_claiming = EvidenceSpan {
            id: "e1".into(),
            rel_path: "n.md".into(),
            content_hash: doc.content_hash,
            start_line: 1,
            end_line: 3,
            text: "target line here\nsecond".into(),
        };
        let err = CitationVerifier::new(v.path())
            .verify(&over_claiming)
            .unwrap_err();
        assert!(err.contains("claims lines 1–3"), "{err}");
        assert!(err.contains("covers 1–2"), "{err}");
    }

    #[test]
    fn drops_a_span_whose_range_ends_before_it_starts() {
        // The check is an equality, not "no wider than": an inverted range describes
        // no text at all and must not slip through on a single-line quote.
        let v = vault_with("target line here\nsecond line\n");
        let doc = read_note(v.path(), &v.path().join("n.md")).unwrap();
        let inverted = EvidenceSpan {
            id: "e1".into(),
            rel_path: "n.md".into(),
            content_hash: doc.content_hash,
            start_line: 2,
            end_line: 1,
            text: "second line".into(),
        };
        let err = CitationVerifier::new(v.path())
            .verify(&inverted)
            .unwrap_err();
        assert!(err.contains("claims lines 2–1"), "{err}");
    }

    #[test]
    fn passes_a_multi_line_citation_whose_range_matches_its_quote() {
        // The range check must not cost a legitimate multi-line citation: a whole
        // span, read within its budget, still verifies.
        let v = vault_with("alpha\nbravo\ncharlie\n");
        let span = KeywordRetriever::new(v.path())
            .read_note_span("n.md", 1, 3, 2000)
            .unwrap();
        assert_eq!((span.start_line, span.end_line), (1, 3));
        assert_eq!(span.text, "alpha\nbravo\ncharlie");
        assert!(CitationVerifier::new(v.path()).verify(&span).is_ok());
    }

    #[test]
    fn drops_when_the_note_was_deleted() {
        let v = vault_with("target line here\n");
        let span = captured_span(v.path());
        fs::remove_file(v.path().join("n.md")).unwrap();
        assert!(CitationVerifier::new(v.path()).verify(&span).is_err());
    }
}
