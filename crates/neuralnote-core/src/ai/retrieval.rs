//! Retrieval — turning the user's notes into citable [`EvidenceSpan`]s.
//!
//! [`KeywordRetriever`] is the first (and, in this slice, only) implementation,
//! backed by the existing [`crate::search::search_vault`] plus bounded
//! [`crate::note::read_note`] line reads. A later embedding-RAG `VectorRetriever`
//! implements the same [`RetrievalProvider`] trait and returns the same span
//! shape, so the chat layer never changes.

use crate::ai::evidence::EvidenceSpan;
use crate::error::CoreResult;
use crate::model::{FileHit, NoteDoc, SearchResponse, TreeNode};
use crate::note::{content_hash, read_note};
use crate::search::search_vault_with_content;
use crate::tree::{markdown_files, read_tree};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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

/// The raw result of a whole-vault search: the response plus the content of every
/// hit file (keyed by absolute path), exactly as [`search_vault_with_content`]
/// returns it. Folder scoping and the per-call result cap are applied to this
/// AFTER it is cached, so the same cached raw data yields correctly-scoped,
/// correctly-capped outcomes for any `(folder, max_results)` a later call passes.
type SearchData = (SearchResponse, HashMap<String, String>);

/// The disk-facing reads retrieval performs, behind a seam so a run-scoped cache
/// can memoize them (and tests can count the calls that actually reach disk).
/// Every method returns the EXACT value its underlying free function returns
/// today — the cache changes *how often* a read happens, never *what* it yields.
trait VaultReader: Send + Sync {
    fn read_tree(&self, root: &Path) -> CoreResult<Vec<TreeNode>>;
    fn read_note(&self, root: &Path, path: &Path) -> CoreResult<NoteDoc>;
    /// `injected` is the run's accumulated content pool (issue #67): content earlier
    /// searches in this run already loaded, so this scan can reuse a note it covers
    /// instead of re-reading it from disk. Empty means a pure-disk scan.
    fn search(
        &self,
        root: &Path,
        query: &str,
        injected: &HashMap<String, Arc<str>>,
    ) -> CoreResult<SearchData>;
}

/// The production reader: each call goes straight to disk via the existing free
/// functions, so an uncached retriever behaves byte-for-byte as before.
struct DiskVaultReader;

impl VaultReader for DiskVaultReader {
    fn read_tree(&self, root: &Path) -> CoreResult<Vec<TreeNode>> {
        read_tree(root)
    }

    fn read_note(&self, root: &Path, path: &Path) -> CoreResult<NoteDoc> {
        read_note(root, path)
    }

    fn search(
        &self,
        root: &Path,
        query: &str,
        injected: &HashMap<String, Arc<str>>,
    ) -> CoreResult<SearchData> {
        search_vault_with_content(root, query, injected)
    }
}

/// Memoized reads for ONE chat run. Keyed by the exact input each read takes, so a
/// hit returns the identical value the first read produced. Only SUCCESSES are
/// stored (an `Err` is propagated and re-attempted next time) — the cache never
/// turns a transient read failure into a sticky stale hit. Every entry is an `Arc`
/// so a hit is a cheap pointer clone, not a copy of a note's full text.
#[derive(Default)]
struct RunCache {
    tree: Option<Arc<Vec<TreeNode>>>,
    notes: HashMap<PathBuf, Arc<NoteDoc>>,
    searches: HashMap<String, Arc<SearchData>>,
    /// Decoded note text, keyed by absolute path, accumulated across every search in
    /// the run so a LATER query can reuse a note an earlier query already loaded
    /// without a second disk read (issue #67). Each value is an `Arc<str>` so a
    /// snapshot of the pool is cheap pointer clones, never a copy of any note's text.
    content_pool: HashMap<String, Arc<str>>,
}

/// Keyword retrieval over the existing vault search. Holds the vault root, the
/// disk reader, and a run-scoped read cache. The cache lives exactly as long as
/// this retriever: the shell builds a fresh [`KeywordRetriever`] per `run_chat`
/// (see `commands/ai.rs`), so a new run starts with an empty cache and re-reads
/// disk — while repeated reads *within* one run are served from memory.
pub struct KeywordRetriever {
    root: PathBuf,
    reader: Arc<dyn VaultReader>,
    /// Run-scoped read memo. `Mutex` gives the interior mutability the `&self`
    /// [`RetrievalProvider`] methods need; critical sections do no I/O (the disk
    /// read happens with the lock released), so they stay tiny and can't deadlock.
    cache: Mutex<RunCache>,
}

impl KeywordRetriever {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_reader(root, Arc::new(DiskVaultReader))
    }

    /// Construct with an explicit reader. The default [`DiskVaultReader`] reads from
    /// disk; tests inject a counting reader to prove within-run reads are deduped.
    fn with_reader(root: impl Into<PathBuf>, reader: Arc<dyn VaultReader>) -> Self {
        // Canonicalize up front so `read_note`'s vault-relative path computation
        // matches the tree scan's (both then strip the same canonical prefix —
        // otherwise a symlinked root like macOS's `/var`→`/private/var` yields a
        // bare filename for nested notes). Fall back to the given path if the root
        // is unreadable; later reads then fail loudly rather than here.
        let root = root.into();
        let root = root.canonicalize().unwrap_or(root);
        Self {
            root,
            reader,
            cache: Mutex::new(RunCache::default()),
        }
    }

    /// The vault tree, read once per run. Reused by `list_notes` and `list_folders`
    /// so one run walks the directory tree a single time.
    fn cached_tree(&self) -> CoreResult<Arc<Vec<TreeNode>>> {
        if let Some(tree) = self.cache.lock().unwrap().tree.clone() {
            return Ok(tree);
        }
        let tree = Arc::new(self.reader.read_tree(&self.root)?);
        self.cache.lock().unwrap().tree = Some(Arc::clone(&tree));
        Ok(tree)
    }

    /// One note's [`NoteDoc`], read once per run per path. Dedups the common
    /// search-then-read and list-then-read patterns: a note pulled in by
    /// `list_notes` and then quoted by `read_note_span` is loaded from disk once.
    fn cached_note(&self, path: &Path) -> CoreResult<Arc<NoteDoc>> {
        if let Some(doc) = self.cache.lock().unwrap().notes.get(path).cloned() {
            return Ok(doc);
        }
        let doc = Arc::new(self.reader.read_note(&self.root, path)?);
        self.cache
            .lock()
            .unwrap()
            .notes
            .insert(path.to_path_buf(), Arc::clone(&doc));
        Ok(doc)
    }

    /// One query's raw whole-vault search result, read once per run per query, so
    /// the model re-issuing a query it already ran costs no second vault rescan.
    fn cached_search(&self, query: &str) -> CoreResult<Arc<SearchData>> {
        if let Some(data) = self.cache.lock().unwrap().searches.get(query).cloned() {
            return Ok(data);
        }
        // Snapshot the run's accumulated content pool (Arc clones — no note text is
        // copied) and release the lock before the vault scan touches disk, keeping the
        // critical section I/O-free. Passing it in lets this scan reuse content an
        // earlier query already loaded, skipping a second disk read of the same note
        // (issue #67); byte-identity and the disk fallback are guaranteed inside
        // `search_vault_with_content`.
        let injected = self.cache.lock().unwrap().content_pool.clone();
        let data = Arc::new(self.reader.search(&self.root, query, &injected)?);
        let mut cache = self.cache.lock().unwrap();
        // Fold this scan's freshly-loaded content into the pool so a LATER query can
        // reuse it. `or_insert` keeps the first-loaded bytes for a path stable across
        // the run, matching the same-query cache's within-run view.
        for (path, content) in &data.1 {
            cache
                .content_pool
                .entry(path.clone())
                .or_insert_with(|| Arc::from(content.as_str()));
        }
        cache.searches.insert(query.to_string(), Arc::clone(&data));
        Ok(data)
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
        let tree = self.cached_tree()?;
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
            match self.cached_note(Path::new(&node.path)) {
                Ok(doc) => notes.push(NoteMeta {
                    title: doc.title.clone(),
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
        let tree = self.cached_tree()?;
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
        // The whole-vault scan runs once per DISTINCT query per run: a repeat of a
        // query already issued this run is served from the cache with no re-read (the
        // 3–8 searches per turn no longer each rescan when the model revisits a term).
        // Folder scoping and the result cap are applied to the cached raw result
        // below, so the same cached data yields correct outcomes for any scope/cap.
        let data = self.cached_search(query)?;
        let (resp, content_by_path) = &*data;
        // Scope to the folder BEFORE the result cap, so a folder's own matches are
        // never lost to whole-vault hits that merely ranked ahead of them.
        let hits: Vec<FileHit> = resp
            .hits
            .iter()
            .filter(|h| in_scope(&h.rel_path, folder))
            .cloned()
            .collect();
        let (spans, cap_clipped, skipped_readback) =
            self.collect_spans(&hits, content_by_path, max_results);
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
        let doc = self.cached_note(&self.root.join(rel_path))?;
        let lines: Vec<&str> = doc.raw.split_inclusive('\n').collect();
        let (start, end, text) = slice_lines(&lines, start_line, end_line, max_bytes);
        Ok(EvidenceSpan {
            id: String::new(),
            rel_path: doc.rel_path.clone(),
            content_hash: doc.content_hash.clone(),
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
        // Truncation landed on a char boundary (valid UTF-8), never inside a code point.
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

    /// A [`VaultReader`] that counts how many calls actually reach disk, wrapping
    /// the real [`DiskVaultReader`]. A cache hit skips the reader, so a count of 1
    /// for N logical reads is the dedup proof.
    struct CountingReader {
        inner: DiskVaultReader,
        note_reads: Mutex<usize>,
        search_reads: Mutex<HashMap<String, usize>>,
    }

    impl CountingReader {
        fn new() -> Self {
            Self {
                inner: DiskVaultReader,
                note_reads: Mutex::new(0),
                search_reads: Mutex::new(HashMap::new()),
            }
        }
        fn total_note_reads(&self) -> usize {
            *self.note_reads.lock().unwrap()
        }
        fn search_count(&self, query: &str) -> usize {
            self.search_reads
                .lock()
                .unwrap()
                .get(query)
                .copied()
                .unwrap_or(0)
        }
    }

    impl VaultReader for CountingReader {
        fn read_tree(&self, root: &Path) -> CoreResult<Vec<TreeNode>> {
            self.inner.read_tree(root)
        }
        fn read_note(&self, root: &Path, path: &Path) -> CoreResult<NoteDoc> {
            *self.note_reads.lock().unwrap() += 1;
            self.inner.read_note(root, path)
        }
        fn search(
            &self,
            root: &Path,
            query: &str,
            injected: &HashMap<String, Arc<str>>,
        ) -> CoreResult<SearchData> {
            *self
                .search_reads
                .lock()
                .unwrap()
                .entry(query.to_string())
                .or_default() += 1;
            self.inner.search(root, query, injected)
        }
    }

    fn counting_retriever(root: &Path) -> (Arc<CountingReader>, KeywordRetriever) {
        let reader = Arc::new(CountingReader::new());
        let shared = Arc::clone(&reader);
        let dyn_reader: Arc<dyn VaultReader> = shared;
        (reader, KeywordRetriever::with_reader(root, dyn_reader))
    }

    #[test]
    fn repeated_search_within_a_run_scans_the_vault_once() {
        let v = vault();
        let (reader, r) = counting_retriever(v.path());
        let first = r.search_notes("components", 8, None).unwrap();
        let again = r.search_notes("components", 8, None).unwrap();
        // The whole-vault scan ran once for the query; the repeat hit the cache.
        assert_eq!(reader.search_count("components"), 1);
        // And the cached repeat is byte-identical — same spans, order, hashes.
        assert_eq!(first.spans.len(), again.spans.len());
        assert_eq!(first.spans[0].text, again.spans[0].text);
        assert_eq!(first.spans[0].content_hash, again.spans[0].content_hash);
        assert_eq!(first.spans[0].rel_path, again.spans[0].rel_path);
    }

    #[test]
    #[cfg(unix)]
    fn a_later_query_reuses_content_a_prior_query_loaded_without_re_reading_disk() {
        // Issue #67: a DIFFERENT query later in the run reuses content the first query
        // already loaded, with no second disk read of that note. Proven by making the
        // file unreadable AFTER the first query pooled its content: the second query
        // still surfaces the note (so it never re-read disk) and counts no skip.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("both.md");
        fs::write(&f, "alpha and beta appear together\n").unwrap();
        let r = KeywordRetriever::new(dir.path());

        // Query A loads both.md's content into the run's content pool.
        let a = r.search_notes("alpha", 8, None).unwrap();
        assert_eq!(a.spans.len(), 1);

        // The note becomes unreadable only AFTER its content was pooled.
        fs::set_permissions(&f, fs::Permissions::from_mode(0o000)).unwrap();

        // Query B (a different term present in the same note) still finds it — it
        // reused the pooled content instead of re-reading the now-unreadable file.
        let b = r.search_notes("beta", 8, None).unwrap();
        // Restore permissions first so tempdir cleanup can't fail regardless of asserts.
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            b.spans.len(),
            1,
            "the second query reused pooled content — no disk read of the note"
        );
        assert_eq!(b.spans[0].rel_path, "both.md");
        assert_eq!(
            b.skipped_files, 0,
            "reuse means the unreadable file is never even opened, so nothing is skipped"
        );
        // The reused span is a faithful citation: its hash is the hash of that content.
        assert_eq!(
            b.spans[0].content_hash,
            crate::note::content_hash("alpha and beta appear together\n")
        );
    }

    #[test]
    fn a_stale_pooled_span_is_dropped_by_the_verifier_never_surfaced() {
        // Issue #67 END TO END — the composition the two halves (retrieval reuse and
        // the verifier's drop) are each tested for separately, but not together.
        // Query A pools a note's content; the note is then rewritten on disk so its
        // content_hash moves; query B reuses the STALE pooled bytes to build a span
        // carrying the OLD content and OLD hash. The CitationVerifier re-reads disk,
        // sees the hash has moved, and DROPS the span — a citation from stale pooled
        // bytes is never surfaced as a wrong citation (the moat, verify.rs:60-66).
        use crate::ai::verify::CitationVerifier;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("both.md");
        fs::write(&f, "alpha and beta appear together\n").unwrap();
        let r = KeywordRetriever::new(dir.path());

        // Query A loads both.md's content into the run's content pool.
        let a = r.search_notes("alpha", 8, None).unwrap();
        assert_eq!(a.spans.len(), 1);

        // The note is rewritten on disk AFTER its content was pooled — the new body
        // shares neither term, so a disk read by query B would match nothing.
        fs::write(&f, "gamma delta epsilon rewritten\n").unwrap();

        // Query B (a term present only in the STALE pooled copy) still finds it: the
        // exact-path pool hit means it reuses the pooled bytes and never reads disk.
        let b = r.search_notes("beta", 8, None).unwrap();
        assert_eq!(
            b.spans.len(),
            1,
            "query B reused the pooled (now-stale) content — no disk read"
        );
        let stale = &b.spans[0];
        // The span was built from the stale pooled bytes: its text and hash are the OLD
        // note, not the current disk content.
        assert_eq!(stale.text, "alpha and beta appear together");
        assert_eq!(
            stale.content_hash,
            crate::note::content_hash("alpha and beta appear together\n"),
            "the span carries the stale pooled content's hash"
        );

        // The moat: the verifier re-reads disk, the hash has moved, and the stale span
        // is DROPPED — never surfaced as a citation whose text matches the stale bytes.
        let verifier = CitationVerifier::new(dir.path());
        let err = verifier
            .verify(stale)
            .expect_err("a stale pooled span must be dropped, not verified");
        assert!(
            err.contains("changed on disk"),
            "the drop reason must name the on-disk change, got: {err}"
        );
    }

    #[test]
    fn repeated_note_reads_within_a_run_touch_disk_once_per_path() {
        let v = vault();
        let (reader, r) = counting_retriever(v.path());
        // Two spans from different line ranges of the SAME note — one disk read.
        let a = r.read_note_span("Research/widgets.md", 1, 2, 2000).unwrap();
        let b = r.read_note_span("Research/widgets.md", 3, 3, 2000).unwrap();
        assert_eq!(
            reader.total_note_reads(),
            1,
            "the note is read from disk once"
        );
        // Both spans still reflect the note correctly (same hash, distinct ranges).
        assert_eq!(a.content_hash, b.content_hash);
        assert_eq!((a.start_line, a.end_line), (1, 2));
        assert_eq!((b.start_line, b.end_line), (3, 3));
    }

    #[test]
    fn a_cached_search_still_scopes_and_caps_per_call() {
        // The load-bearing invariant: caching the RAW search result must not change
        // scoping or caps. One vault scan feeds a whole-vault call AND a folder-scoped
        // call AND a capped call, each returning exactly what the uncached path would.
        let v = multi_folder_vault();
        let (reader, r) = counting_retriever(v.path());
        let all = r.search_notes("boil", 8, None).unwrap();
        let scoped = r.search_notes("boil", 8, Some("Cooking")).unwrap();
        let capped = r.search_notes("boil", 1, None).unwrap();
        assert_eq!(
            reader.search_count("boil"),
            1,
            "one scan feeds all three calls"
        );
        assert_eq!(all.spans.len(), 2, "whole vault sees both hits");
        assert_eq!(
            scoped.spans.len(),
            1,
            "folder scope keeps only the Cooking hit"
        );
        assert_eq!(scoped.spans[0].rel_path, "Cooking/pasta.md");
        assert_eq!(capped.spans.len(), 1, "max_results=1 clips to one span");
        assert!(capped.capped, "the per-call cap still flags `capped`");
    }

    #[test]
    fn a_failed_read_is_not_cached_and_is_re_attempted() {
        // A read that errors must not become a sticky hit — the reader is called each
        // time, so a later legitimate read (or a fixed permission) is never masked by
        // a stale error. A path escape errors deterministically.
        let v = vault();
        let (reader, r) = counting_retriever(v.path());
        assert!(r.read_note_span("../../etc/passwd", 1, 1, 100).is_err());
        assert!(r.read_note_span("../../etc/passwd", 1, 1, 100).is_err());
        assert_eq!(
            reader.total_note_reads(),
            2,
            "an errored read is retried, never served stale from the cache"
        );
    }

    #[test]
    fn the_cache_lives_for_one_run_and_a_fresh_run_sees_disk_changes() {
        let v = vault();
        // Run 1: capture the pre-edit view, then edit the note on disk mid-run.
        let run1 = KeywordRetriever::new(v.path());
        let before = run1.search_notes("components", 8, None).unwrap();
        assert_eq!(before.spans.len(), 1);
        fs::write(
            v.path().join("Research/widgets.md"),
            "# Widgets\n\nNothing relevant remains here.\n",
        )
        .unwrap();
        // Same run: the cache holds the pre-edit view (cache lifetime == one run).
        let same_run = run1.search_notes("components", 8, None).unwrap();
        assert_eq!(
            same_run.spans.len(),
            1,
            "within one run the cached search is stable"
        );
        // A FRESH run (new retriever) re-reads disk and sees the edit — the cache is
        // never process-global. Citation fidelity is unaffected: CitationVerifier
        // reads disk directly (see verify.rs), so a stale span never surfaces.
        let run2 = KeywordRetriever::new(v.path());
        let after = run2.search_notes("components", 8, None).unwrap();
        assert_eq!(
            after.spans.len(),
            0,
            "a new run sees the current disk state"
        );
    }

    /// Representative-vault benchmark for the run-scoped cache (issue #20). Ignored
    /// by default (timing is machine-dependent and not a correctness gate); run with
    /// `cargo test -p neuralnote-core cache_benchmark -- --ignored --nocapture` to see
    /// the measured before/after. "Before" = today's behaviour, a fresh retriever per
    /// operation so every call re-reads disk; "after" = one run-scoped retriever.
    #[test]
    #[ignore = "timing benchmark, not a correctness gate — run with --ignored --nocapture"]
    fn cache_benchmark_reports_before_after() {
        use std::time::Instant;
        // A large synthetic vault: 1,000 notes across 20 folders, ~40 lines each.
        let dir = tempfile::tempdir().unwrap();
        for folder in 0..20 {
            let folder_path = dir.path().join(format!("topic_{folder:02}"));
            fs::create_dir(&folder_path).unwrap();
            for note in 0..50 {
                let body: String = (0..40)
                    .map(|line| format!("Line {line} about widgets and gadgets in note {note}.\n"))
                    .collect();
                fs::write(folder_path.join(format!("note_{note:02}.md")), body).unwrap();
            }
        }

        // A turn's worth of activity: the model searches a term, then reads spans from
        // hit notes, revisiting the term and notes a few times (the common pattern).
        let searches = 6usize;
        let reads = 12usize;

        // BEFORE: a fresh retriever per operation — every search rescans the vault and
        // every read re-opens the note (no cross-call reuse).
        let before_start = Instant::now();
        for _ in 0..searches {
            let r = KeywordRetriever::new(dir.path());
            let _ = r.search_notes("widgets", 20, None).unwrap();
        }
        for _ in 0..reads {
            let r = KeywordRetriever::new(dir.path());
            let _ = r.read_note_span("topic_00/note_00.md", 1, 5, 2000).unwrap();
        }
        let before = before_start.elapsed();

        // AFTER: one run-scoped retriever — the repeated query is scanned once and the
        // repeatedly-read note is opened once.
        let after_start = Instant::now();
        let r = KeywordRetriever::new(dir.path());
        for _ in 0..searches {
            let _ = r.search_notes("widgets", 20, None).unwrap();
        }
        for _ in 0..reads {
            let _ = r.read_note_span("topic_00/note_00.md", 1, 5, 2000).unwrap();
        }
        let after = after_start.elapsed();

        println!(
            "issue #20 cache benchmark (1000 notes, {searches} repeated searches + {reads} repeated reads):\n  before (fresh retriever per op): {before:?}\n  after  (one run-scoped cache):   {after:?}"
        );
        assert!(
            after < before,
            "the run-scoped cache must not be slower than re-reading: before={before:?} after={after:?}"
        );
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
