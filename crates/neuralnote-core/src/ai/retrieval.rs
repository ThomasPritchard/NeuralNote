//! Retrieval — turning the user's notes into citable [`EvidenceSpan`]s.
//!
//! [`KeywordRetriever`] is the first (and, in this slice, only) implementation,
//! backed by the existing [`crate::search::search_vault`] plus bounded
//! [`crate::note::read_note`] line reads. A later embedding-RAG `VectorRetriever`
//! implements the same [`RetrievalProvider`] trait and returns the same span
//! shape, so the chat layer never changes.

use crate::ai::evidence::EvidenceSpan;
use crate::error::CoreResult;
use crate::model::{FileHit, TreeNode};
use crate::note::{content_hash, read_note};
use crate::search::search_vault_with_content;
use crate::tree::{markdown_files, read_tree};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default byte cap for a single evidence span's `text` (keeps tool results and the
/// model's context bounded). Callers may lower it per read.
const DEFAULT_SPAN_MAX_BYTES: usize = 2000;

/// Cap on the notes returned — and READ — by one `list_notes` call. Bounds both the
/// per-note disk reads and the size of the tool-result payload the model ingests, so
/// a large migrated vault can't drive a full-vault read plus a multi-thousand-entry
/// JSON blob into the context on a single listing (PA-002).
const MAX_LIST_NOTES: usize = 200;

/// Lightweight note metadata for the model's `list_notes` tool — never content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub title: String,
    pub rel_path: String,
}

/// A vault folder for the model's `list_folders` tool: its vault-relative path and
/// how many markdown notes live under it (recursively). Lets the model discover the
/// vault's shape before scoping a search or listing to one folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMeta {
    pub rel_path: String,
    pub note_count: u32,
}

/// The result of listing notes: the metadata plus the coverage signals that keep
/// discovery honest. `skipped` says how many in-scope notes could not be read;
/// `truncated`/`total` say the listing was capped (mirroring `search_notes`), so the
/// model is never misled into thinking it saw the whole vault when it saw only the
/// first [`MAX_LIST_NOTES`].
#[derive(Debug, Clone, Default)]
pub struct ListOutcome {
    pub notes: Vec<NoteMeta>,
    /// In-scope notes that could not be read (each also logged), so the model never
    /// assumes a note is absent when it was merely unreadable.
    pub skipped: u32,
    /// The cap clipped the listing — more in-scope notes exist than were returned.
    pub truncated: bool,
    /// Total in-scope notes discovered (the honest denominator), including any past
    /// the cap that were counted but not read.
    pub total: u32,
}

/// The result of a retrieval search: the evidence spans plus the coverage signals
/// the orchestrator carries into the footer, so partial coverage is never hidden.
#[derive(Debug, Clone, Default)]
pub struct SearchOutcome {
    pub spans: Vec<EvidenceSpan>,
    /// The vault-wide search hit its OWN global caps (200 total / 50 per file) — a
    /// genuine coverage gap: more matching lines exist than any single search can
    /// surface. This is what the user-facing "partial coverage" footer reports.
    pub truncated: bool,
    /// This call's `max_results` cap clipped the returned spans. Routine — the agent
    /// issues many searches — so it is NOT a coverage gap and must NOT drive the
    /// footer; it only tells the model "there were more, refine if you need to".
    pub capped: bool,
    /// Markdown files that could not be read and were skipped.
    pub skipped_files: u32,
}

/// The retrieval seam. Sync (it is file I/O), `Send + Sync` so the orchestrator's
/// future stays `Send`. Spans come back with a placeholder `id`; the orchestrator's
/// [`crate::ai::evidence::EvidenceRegistry`] assigns the real citable id.
pub trait RetrievalProvider: Send + Sync {
    /// Every markdown note's title + rel_path (metadata only), plus a count of notes
    /// that could not be read (discovery honesty). `folder`, when `Some`, scopes the
    /// listing to notes under that folder and its subfolders.
    fn list_notes(&self, folder: Option<&str>) -> CoreResult<ListOutcome>;

    /// Every folder in the vault (rel_path + recursive note count), so the model can
    /// discover the vault's structure before scoping a later call to one folder.
    fn list_folders(&self) -> CoreResult<Vec<FolderMeta>>;

    /// Search the vault, returning at most `max_results` evidence spans. `folder`,
    /// when `Some`, scopes the search to notes under that folder and its subfolders.
    fn search_notes(
        &self,
        query: &str,
        max_results: usize,
        folder: Option<&str>,
    ) -> CoreResult<SearchOutcome>;

    /// Read a bounded line range of one note as an evidence span. `rel_path` is
    /// vault-relative; path safety is enforced by [`read_note`].
    fn read_note_span(
        &self,
        rel_path: &str,
        start_line: u32,
        end_line: u32,
        max_bytes: usize,
    ) -> CoreResult<EvidenceSpan>;
}

/// Keyword retrieval over the existing vault search. Holds the vault root.
pub struct KeywordRetriever {
    root: PathBuf,
}

impl KeywordRetriever {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        // Canonicalize up front so `read_note`'s vault-relative path computation
        // matches the tree scan's (both then strip the same canonical prefix —
        // otherwise a symlinked root like macOS's `/var`→`/private/var` yields a
        // bare filename for nested notes). Fall back to the given path if the root
        // is unreadable; later reads then fail loudly rather than here.
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        Self { root }
    }

    /// Build single-line evidence spans for each content hit, REUSING the raw text
    /// `search_vault` already loaded (`content_by_path`, keyed by [`FileHit::path`])
    /// rather than re-reading each hit — so a matched file is read once per search,
    /// not twice (PA-007). Returns `(spans, cap_clipped, skipped_readback)`: whether
    /// `max_results` clipped the spans, and how many hits had no retained content (a
    /// delete/permission race between the scan and now, or a hit from outside the
    /// search path) — skipped loudly, never silently dropped from the coverage count.
    ///
    /// The reused text is byte-identical to what `read_note` would load, so the
    /// `content_hash` computed here matches the one the citation verifier recomputes.
    fn collect_spans(
        &self,
        hits: &[FileHit],
        content_by_path: &HashMap<String, String>,
        max_results: usize,
    ) -> (Vec<EvidenceSpan>, bool, u32) {
        let mut spans = Vec::new();
        let mut cap_clipped = false;
        let mut skipped_readback = 0u32;

        'files: for hit in hits {
            if hit.matches.is_empty() {
                continue; // a name-only hit has no line to quote
            }
            // Reuse the content the search already read — no second disk read. A hit
            // whose content wasn't retained is a genuine skip (counted, logged), the
            // same honesty the old read-back-failure branch gave.
            let Some(raw) = content_by_path.get(&hit.path) else {
                log::warn!(
                    "search_notes: no retained content for hit {}; skipping",
                    hit.path
                );
                skipped_readback = skipped_readback.saturating_add(1);
                continue;
            };
            let hash = content_hash(raw);
            let lines: Vec<&str> = raw.split_inclusive('\n').collect();
            for m in &hit.matches {
                if spans.len() >= max_results {
                    cap_clipped = true; // the model's own result cap clipped evidence
                    break 'files;
                }
                let (start, end, text) =
                    slice_lines(&lines, m.line, m.line, DEFAULT_SPAN_MAX_BYTES);
                spans.push(EvidenceSpan {
                    id: String::new(),
                    rel_path: hit.rel_path.clone(),
                    content_hash: hash.clone(),
                    start_line: start,
                    end_line: end,
                    text,
                });
            }
        }

        (spans, cap_clipped, skipped_readback)
    }
}

impl RetrievalProvider for KeywordRetriever {
    fn list_notes(&self, folder: Option<&str>) -> CoreResult<ListOutcome> {
        let tree = read_tree(&self.root)?;
        let mut notes = Vec::new();
        let mut skipped = 0u32;
        let mut total = 0u32;
        let mut read_count = 0usize;
        let mut truncated = false;
        for node in markdown_files(&tree) {
            if !in_scope(&node.rel_path, folder) {
                continue; // outside the requested folder
            }
            // Count every in-scope note (cheap, in-memory) for the honest `total`,
            // but READ at most MAX_LIST_NOTES of them — bounding disk I/O and the
            // payload the model ingests (PA-002). Past the cap we keep counting and
            // flag `truncated`, never silently claiming the listing was complete.
            total = total.saturating_add(1);
            if read_count >= MAX_LIST_NOTES {
                truncated = true;
                continue;
            }
            read_count += 1;
            // read_note yields the canonical title (frontmatter → H1 → stem). One
            // unreadable note must not sink the whole listing — skip it loudly AND
            // count it, so the model knows the listing is partial.
            match read_note(&self.root, Path::new(&node.path)) {
                Ok(doc) => notes.push(NoteMeta {
                    title: doc.title,
                    rel_path: node.rel_path.clone(),
                }),
                Err(e) => {
                    log::warn!("list_notes: skipping unreadable note {}: {e}", node.path);
                    skipped = skipped.saturating_add(1);
                }
            }
        }
        Ok(ListOutcome {
            notes,
            skipped,
            truncated,
            total,
        })
    }

    fn list_folders(&self) -> CoreResult<Vec<FolderMeta>> {
        let tree = read_tree(&self.root)?;
        let mut folders = Vec::new();
        collect_folders(&tree, &mut folders);
        Ok(folders)
    }

    fn search_notes(
        &self,
        query: &str,
        max_results: usize,
        folder: Option<&str>,
    ) -> CoreResult<SearchOutcome> {
        // TODO(search-per-run-cache): each of the 3–8 searches per chat turn still
        // re-scans the whole vault from disk here; a run-scoped path→content cache
        // across searches within one run_chat is the remaining win, but it needs
        // state threaded through RetrievalProvider — deferred (PA-007). This call
        // eliminates only the *double*-read of each hit (search + a second read_note).
        let (resp, content_by_path) = search_vault_with_content(&self.root, query)?;
        // Scope to the folder BEFORE the result cap, so a folder's own matches are
        // never lost to whole-vault hits that merely ranked ahead of them.
        let hits: Vec<FileHit> = resp
            .hits
            .into_iter()
            .filter(|h| in_scope(&h.rel_path, folder))
            .collect();
        let (spans, cap_clipped, skipped_readback) =
            self.collect_spans(&hits, &content_by_path, max_results);
        Ok(SearchOutcome {
            spans,
            // GENUINE coverage gap only — the vault search's own global cap. A routine
            // per-call `max_results` clip is `capped`, not `truncated` (see the field
            // docs), so it can't make the footer cry "partial coverage" on every query.
            truncated: resp.truncated,
            capped: cap_clipped,
            // A hit whose note fails the read-back (a delete/permission race between
            // the search scan and this read) is a genuine skip too — count it, so the
            // footer never claims a note was covered when it silently vanished.
            skipped_files: resp.skipped_files.saturating_add(skipped_readback),
        })
    }

    fn read_note_span(
        &self,
        rel_path: &str,
        start_line: u32,
        end_line: u32,
        max_bytes: usize,
    ) -> CoreResult<EvidenceSpan> {
        // read_note runs ensure_within, so a `../` in rel_path is refused, not read.
        let doc = read_note(&self.root, &self.root.join(rel_path))?;
        let lines: Vec<&str> = doc.raw.split_inclusive('\n').collect();
        let (start, end, text) = slice_lines(&lines, start_line, end_line, max_bytes);
        Ok(EvidenceSpan {
            id: String::new(),
            rel_path: doc.rel_path,
            content_hash: doc.content_hash,
            start_line: start,
            end_line: end,
            text,
        })
    }
}

/// Slice an inclusive 1-based line range out of `lines` (as produced by
/// `split_inclusive('\n')`), returning the clamped range and the exact quoted text.
///
/// The text is a verbatim substring of the note (lines are concatenated with their
/// original endings intact), so the verifier's `raw.contains(text)` always holds
/// for an unchanged note — even for CRLF notes. It is trimmed of its trailing
/// newline and bounded to `max_bytes`; both are safe because a prefix of a
/// substring is still a substring.
fn slice_lines(
    lines: &[&str],
    start_line: u32,
    end_line: u32,
    max_bytes: usize,
) -> (u32, u32, String) {
    let n = lines.len() as u32;
    if n == 0 {
        return (1, 1, String::new()); // empty note
    }
    let start = start_line.clamp(1, n);
    let end = end_line.clamp(start, n);
    let mut text = String::new();
    for line in &lines[(start as usize - 1)..(end as usize)] {
        text.push_str(line);
    }
    let trimmed_len = text.trim_end_matches(['\r', '\n']).len();
    text.truncate(trimmed_len);
    bound_to_char_boundary(&mut text, max_bytes);
    (start, end, text)
}

/// Truncate `text` to at most `max_bytes`, backing up to the nearest char boundary
/// so we never split a multibyte scalar.
fn bound_to_char_boundary(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
}

/// True if `rel_path` sits inside `folder` (at any depth). `None`, empty, `"."`, or a
/// bare `"/"` means the whole vault. Matching is slash-normalised and
/// case-insensitive, so the model can pass "recipes", "/Recipes/", or "Recipes" and
/// reach the same folder — forgiving on purpose, because the model won't reliably
/// reproduce the stored case. Components must match whole (so "Cook" ≠ "Cooking/…").
fn in_scope(rel_path: &str, folder: Option<&str>) -> bool {
    let folder = match folder {
        Some(f) => f.trim_matches('/'),
        None => return true,
    };
    if folder.is_empty() || folder == "." {
        return true;
    }
    let folder_parts: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    let path_parts: Vec<&str> = rel_path.split('/').collect();
    // The note must live strictly BELOW the folder (its file name remains), and every
    // folder component must match the corresponding leading path component.
    path_parts.len() > folder_parts.len()
        && folder_parts
            .iter()
            .zip(&path_parts)
            .all(|(f, p)| f.eq_ignore_ascii_case(p))
}

/// Collect every folder in the tree (nested included) with its recursive markdown
/// note count, preserving `read_tree`'s folders-first ordering.
fn collect_folders(nodes: &[TreeNode], out: &mut Vec<FolderMeta>) {
    for node in nodes {
        if let Some(children) = &node.children {
            out.push(FolderMeta {
                rel_path: node.rel_path.clone(),
                note_count: markdown_files(children).len() as u32,
            });
            collect_folders(children, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SearchMatch;
    use std::fs;

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

    #[test]
    fn search_builds_single_line_spans_with_hash_and_position() {
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        let out = r.search_notes("components", 8, None).unwrap();
        assert_eq!(out.spans.len(), 1);
        let span = &out.spans[0];
        assert_eq!(span.rel_path, "Research/widgets.md");
        assert_eq!((span.start_line, span.end_line), (3, 3));
        assert_eq!(span.text, "Widgets are small components.");
        assert!(!span.content_hash.is_empty());
        // The span text is a verbatim substring of the note (the verifier's check).
        let doc = read_note(v.path(), &v.path().join("Research/widgets.md")).unwrap();
        assert!(doc.raw.contains(&span.text));
        assert_eq!(span.content_hash, doc.content_hash);
    }

    #[test]
    fn search_caps_at_max_results_flags_capped_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..5).map(|i| format!("target line {i}\n")).collect();
        fs::write(dir.path().join("n.md"), body).unwrap();
        let r = KeywordRetriever::new(dir.path());
        let out = r.search_notes("target", 2, None).unwrap();
        assert_eq!(out.spans.len(), 2);
        // A per-call cap is `capped` (routine), NOT `truncated` (a coverage gap) — so
        // it can't drive the user-facing "partial coverage" footer.
        assert!(out.capped, "clipping to max_results must flag `capped`");
        assert!(
            !out.truncated,
            "a routine per-search cap is not a vault-coverage gap"
        );
    }

    #[test]
    fn search_flags_truncated_when_the_vault_search_hits_its_own_cap() {
        // >50 matching lines in one file trips search_vault's own per-file cap
        // (MAX_MATCHES_PER_FILE) — a GENUINE coverage gap, so `truncated` is set even
        // though the per-call span cap also clips.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..60).map(|i| format!("target line {i}\n")).collect();
        fs::write(dir.path().join("big.md"), body).unwrap();
        let r = KeywordRetriever::new(dir.path());
        let out = r.search_notes("target", 20, None).unwrap();
        assert!(
            out.truncated,
            "the vault search's own per-file cap is a real coverage gap"
        );
    }

    #[test]
    fn list_notes_returns_titles_and_rel_paths() {
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        let out = r.list_notes(None).unwrap();
        assert_eq!(out.notes.len(), 1);
        assert_eq!(out.skipped, 0);
        assert_eq!(out.total, 1); // one note, no cap hit
        assert!(!out.truncated);
        assert_eq!(out.notes[0].rel_path, "Research/widgets.md");
        assert_eq!(out.notes[0].title, "Widgets"); // first H1
    }

    #[test]
    fn list_notes_caps_at_max_and_flags_truncated_with_total() {
        // A vault larger than the cap must return at most MAX_LIST_NOTES entries
        // (bounding disk reads + payload), flag `truncated`, and report the true
        // `total` as the honest denominator (PA-002).
        let dir = tempfile::tempdir().unwrap();
        let over = MAX_LIST_NOTES + 5;
        for i in 0..over {
            fs::write(dir.path().join(format!("note_{i:04}.md")), "# n\n").unwrap();
        }
        let r = KeywordRetriever::new(dir.path());
        let out = r.list_notes(None).unwrap();
        assert_eq!(out.notes.len(), MAX_LIST_NOTES, "listing is capped to K");
        assert!(out.truncated, "the cap clipped the listing");
        assert_eq!(out.total, over as u32, "total is the honest denominator");
    }

    #[test]
    fn search_read_back_failure_is_counted_as_skipped() {
        // A hit with NO retained content (a delete/permission race between the scan
        // and now, modelled by an empty content map) must be counted in skipped_files,
        // not silently dropped. Since collect_spans reuses already-loaded content
        // (PA-007), "couldn't read it back" now means "not in the content map".
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        let ghost = FileHit {
            path: v
                .path()
                .join("Research/ghost.md")
                .to_string_lossy()
                .into_owned(),
            rel_path: "Research/ghost.md".into(),
            title: "ghost".into(),
            name_match: false,
            matches: vec![SearchMatch {
                line: 1,
                snippet: "x".into(),
                ranges: vec![(0, 1)],
            }],
        };
        let empty = HashMap::new();
        let (spans, _clipped, skipped) = r.collect_spans(&[ghost], &empty, 8);
        assert!(spans.is_empty());
        assert_eq!(
            skipped, 1,
            "a hit with no retained content must increment skipped_files"
        );
    }

    #[test]
    fn collect_spans_reuses_provided_content_without_re_reading() {
        // PA-007: collect_spans builds spans from the content search_vault already
        // loaded and NEVER touches disk. The hit points at a path that does not
        // exist — a re-read (the old double-read) would fail and skip; instead it
        // uses the provided content and produces a span whose content_hash matches
        // content_hash of that exact content (the verifier's invariant).
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        let content = "line one\nquotable target line\n".to_string();
        let hit = FileHit {
            path: "/nonexistent/ghost.md".into(),
            rel_path: "ghost.md".into(),
            title: "ghost".into(),
            name_match: false,
            matches: vec![SearchMatch {
                line: 2,
                snippet: "target".into(),
                ranges: vec![(0, 6)],
            }],
        };
        let mut map = HashMap::new();
        map.insert("/nonexistent/ghost.md".to_string(), content.clone());
        let (spans, clipped, skipped) = r.collect_spans(&[hit], &map, 8);
        assert_eq!(skipped, 0, "content was provided, nothing to skip");
        assert!(!clipped);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].text, "quotable target line");
        assert_eq!(spans[0].content_hash, crate::note::content_hash(&content));
    }

    #[test]
    #[cfg(unix)]
    fn list_notes_counts_unreadable_notes_as_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("open.md"), "readable\n").unwrap();
        fs::write(dir.path().join("locked.md"), "secret\n").unwrap();
        fs::set_permissions(
            dir.path().join("locked.md"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let r = KeywordRetriever::new(dir.path());
        let out = r.list_notes(None).unwrap();
        assert_eq!(out.notes.len(), 1); // only the readable note is listed
        assert_eq!(out.skipped, 1); // the unreadable one is counted, not hidden
    }

    #[test]
    fn read_note_span_returns_bounded_range() {
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        let span = r.read_note_span("Research/widgets.md", 1, 2, 2000).unwrap();
        assert_eq!((span.start_line, span.end_line), (1, 2));
        // Lines 1-2 are the H1 then a blank line; trailing newlines are trimmed.
        assert_eq!(span.text, "# Widgets");
    }

    #[test]
    fn read_note_span_clamps_out_of_range_lines() {
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        // The note has 4 lines; asking for 100..200 clamps to the last line.
        let span = r
            .read_note_span("Research/widgets.md", 100, 200, 2000)
            .unwrap();
        assert_eq!((span.start_line, span.end_line), (4, 4));
        assert_eq!(span.text, "They snap together.");
    }

    #[test]
    fn read_note_span_bounds_bytes_on_char_boundary() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("m.md"), "ünïcödé wîdé lïné").unwrap();
        let r = KeywordRetriever::new(dir.path());
        let span = r.read_note_span("m.md", 1, 1, 5).unwrap();
        assert!(span.text.len() <= 5);
        // Truncation landed on a char boundary (valid UTF-8) — no panic, no �-split.
        assert!(std::str::from_utf8(span.text.as_bytes()).is_ok());
    }

    #[test]
    fn read_note_span_refuses_path_escape() {
        let v = vault();
        let r = KeywordRetriever::new(v.path());
        assert!(r.read_note_span("../../etc/passwd", 1, 1, 100).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn search_counts_skipped_unreadable_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("locked.md"), "target here\n").unwrap();
        fs::write(dir.path().join("open.md"), "target here\n").unwrap();
        fs::set_permissions(
            dir.path().join("locked.md"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let r = KeywordRetriever::new(dir.path());
        let out = r.search_notes("target", 8, None).unwrap();
        assert_eq!(out.skipped_files, 1);
    }

    /// Two top-level folders (one with a subfolder). "boil" spans Cooking + Work
    /// (cross-folder); "tender" spans only the two Cooking notes — so scoping is
    /// testable both ways.
    fn multi_folder_vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Cooking/Baking")).unwrap();
        fs::create_dir(dir.path().join("Work")).unwrap();
        fs::write(
            dir.path().join("Cooking/pasta.md"),
            "# Pasta\n\nBoil the noodles until tender.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("Cooking/Baking/bread.md"),
            "# Bread\n\nKnead the dough until tender.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("Work/report.md"),
            "# Report\n\nBoil the ocean quarterly.\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn search_scopes_to_a_folder() {
        let v = multi_folder_vault();
        let r = KeywordRetriever::new(v.path());
        // "boil" matches Cooking/pasta.md and Work/report.md; scoping to Cooking
        // returns only the Cooking hit.
        let scoped = r.search_notes("boil", 8, Some("Cooking")).unwrap();
        assert_eq!(scoped.spans.len(), 1);
        assert_eq!(scoped.spans[0].rel_path, "Cooking/pasta.md");
        // Whole-vault (no scope) sees both.
        let all = r.search_notes("boil", 8, None).unwrap();
        assert_eq!(all.spans.len(), 2);
    }

    #[test]
    fn search_folder_scope_includes_subfolders_case_insensitively() {
        let v = multi_folder_vault();
        let r = KeywordRetriever::new(v.path());
        // Lowercase "cooking" must still reach Cooking/ AND its Baking/ subfolder.
        let out = r.search_notes("tender", 8, Some("cooking")).unwrap();
        let paths: Vec<String> = out.spans.iter().map(|s| s.rel_path.clone()).collect();
        assert_eq!(out.spans.len(), 2);
        assert!(paths.contains(&"Cooking/pasta.md".to_string()));
        assert!(paths.contains(&"Cooking/Baking/bread.md".to_string()));
        assert!(!paths.iter().any(|p| p.starts_with("Work/")));
    }

    #[test]
    fn list_notes_scopes_to_a_folder() {
        let v = multi_folder_vault();
        let r = KeywordRetriever::new(v.path());
        let out = r.list_notes(Some("Cooking")).unwrap();
        let paths: Vec<String> = out.notes.iter().map(|n| n.rel_path.clone()).collect();
        assert_eq!(paths.len(), 2); // pasta + Baking/bread — not Work/report
        assert!(paths.iter().all(|p| p.starts_with("Cooking/")));
    }

    #[test]
    fn list_folders_reports_paths_and_recursive_counts() {
        let v = multi_folder_vault();
        let r = KeywordRetriever::new(v.path());
        let folders = r.list_folders().unwrap();
        let by_path: std::collections::HashMap<&str, u32> = folders
            .iter()
            .map(|f| (f.rel_path.as_str(), f.note_count))
            .collect();
        // Cooking counts recursively (pasta + Baking/bread); Baking = 1; Work = 1.
        assert_eq!(by_path.get("Cooking"), Some(&2));
        assert_eq!(by_path.get("Cooking/Baking"), Some(&1));
        assert_eq!(by_path.get("Work"), Some(&1));
    }

    #[test]
    fn in_scope_matches_folders_forgivingly() {
        assert!(in_scope("Cooking/pasta.md", Some("Cooking")));
        assert!(in_scope("Cooking/Baking/bread.md", Some("cooking"))); // case-insensitive, nested
        assert!(in_scope("Cooking/pasta.md", Some("/Cooking/"))); // slash-normalised
        assert!(in_scope("Work/report.md", None)); // whole vault
        assert!(in_scope("Work/report.md", Some(""))); // empty == whole vault
        assert!(!in_scope("Work/report.md", Some("Cooking")));
        // A path equal to the folder name isn't "inside" it, and a partial component
        // ("Cook") must not match "Cooking/…".
        assert!(!in_scope("Cooking", Some("Cooking")));
        assert!(!in_scope("Cooking/pasta.md", Some("Cook")));
    }
}
