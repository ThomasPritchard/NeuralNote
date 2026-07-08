//! Full-text vault search — an on-demand scan per query, no index (the AI
//! phase's embeddings supersede ranking later).
//!
//! Matching is case-insensitive via a per-line fold map: each original char's
//! `to_lowercase()` output is recorded together with the char it came from, and
//! matches found in the folded text are mapped back through that record. The
//! original line is never indexed with offsets derived from a lowercased copy —
//! folding can change length (`İ` → `i` + combining dot), so such offsets drift
//! and byte-slicing with them panics. Every slice boundary below comes from
//! `char_indices`, making boundary panics impossible by construction.

use crate::error::CoreResult;
use crate::model::{FileHit, SearchMatch, SearchResponse, TreeNode};
use crate::note::title_and_body;
use crate::tree::{markdown_files, read_tree};
use std::path::Path;

/// Total content matches returned per search (the UI shows a truncation banner).
pub const MAX_TOTAL_MATCHES: usize = 200;
/// Content matches returned per file.
pub const MAX_MATCHES_PER_FILE: usize = 50;
/// Snippet window size in Unicode scalars (chars).
pub const SNIPPET_MAX_CHARS: usize = 200;
/// Longest query actually searched, in chars — longer input is trimmed
/// server-side (never an error) so a pasted blob can't drive unbounded work.
pub const MAX_QUERY_CHARS: usize = 256;

/// Case-insensitively search every markdown note under `root` for `query`.
///
/// The raw file text is searched, frontmatter included (Obsidian behavior).
/// Name/title hits rank before content-only hits, each group in tree-walk
/// order. Queries longer than [`MAX_QUERY_CHARS`] are truncated to it.
pub fn search_vault(root: &Path, query: &str) -> CoreResult<SearchResponse> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            truncated: false,
            skipped_files: 0,
        });
    }
    let capped: String = trimmed.chars().take(MAX_QUERY_CHARS).collect();
    let folded_query = fold(&capped);
    let tree = read_tree(root)?;

    let mut name_hits: Vec<FileHit> = Vec::new();
    let mut content_hits: Vec<FileHit> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    let mut skipped_files: u32 = 0;

    for node in markdown_files(&tree) {
        // Lossy read: a Latin-1 note must not error the whole search; an
        // unreadable file is skipped loudly (logged AND counted), never fatal.
        let raw = match std::fs::read(&node.path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                log::warn!("search: skipping unreadable file {}: {e}", node.path);
                skipped_files = skipped_files.saturating_add(1);
                continue;
            }
        };
        let budget = MAX_MATCHES_PER_FILE.min(MAX_TOTAL_MATCHES - total);
        let (hit, clipped) = build_file_hit(node, &raw, &folded_query, budget, truncated);
        truncated |= clipped;
        let Some(hit) = hit else { continue };
        total += hit.matches.len();
        if hit.name_match {
            name_hits.push(hit);
        } else {
            content_hits.push(hit);
        }
    }

    name_hits.append(&mut content_hits);
    Ok(SearchResponse {
        hits: name_hits,
        truncated,
        skipped_files,
    })
}

/// The per-file hit-building step: the name/title check (which runs for every
/// file — a name hit costs no match budget) plus the budgeted content scan.
/// When the budget is spent AND truncation is already known, the scan is
/// skipped; otherwise a zero-budget scan still runs so a clipped match can
/// raise the truncation flag. Returns the file's hit (`None` when nothing
/// matched) and whether the scan was clipped.
fn build_file_hit(
    node: &TreeNode,
    raw: &str,
    folded_query: &[char],
    budget: usize,
    truncation_known: bool,
) -> (Option<FileHit>, bool) {
    let stem = Path::new(&node.name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| node.name.clone());
    let (title, _body) = title_and_body(raw, &stem);
    let name_match = contains_folded(&stem, folded_query) || contains_folded(&title, folded_query);

    let (matches, clipped) = if budget == 0 && truncation_known {
        (Vec::new(), false) // budget gone and truncation already known — skip
    } else {
        scan_content(raw, folded_query, budget)
    };

    if !name_match && matches.is_empty() {
        return (None, clipped);
    }
    let hit = FileHit {
        path: node.path.clone(),
        rel_path: node.rel_path.clone(),
        title,
        name_match,
        matches,
    };
    (Some(hit), clipped)
}

/// Scan `raw`'s lines for matches, keeping at most `budget` of them. The bool is
/// true iff at least one further matching line existed beyond the budget — the
/// exact "did a cap clip anything" signal for the `truncated` flag.
fn scan_content(raw: &str, folded_query: &[char], budget: usize) -> (Vec<SearchMatch>, bool) {
    let mut out = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let line_no = u32::try_from(idx + 1).unwrap_or(u32::MAX);
        let Some(m) = match_line(line, line_no, folded_query) else {
            continue;
        };
        if out.len() >= budget {
            return (out, true);
        }
        out.push(m);
    }
    (out, false)
}

/// Case-fold one char: `to_lowercase` plus Greek final-sigma normalisation
/// (ς → σ), so word-final sigma matches regardless of position. Deliberately
/// NO other multi-char equivalences (ß→ss, etc.) — hand-rolled Unicode tables
/// are a known bug farm here; the ß limitation is documented in the spec.
fn fold_char(ch: char) -> impl Iterator<Item = char> {
    ch.to_lowercase().map(|c| if c == 'ς' { 'σ' } else { c })
}

/// Case-fold a string the same way lines are folded (per-char [`fold_char`]).
pub(crate) fn fold(s: &str) -> Vec<char> {
    s.chars().flat_map(fold_char).collect()
}

/// Whether `text`, case-folded, contains the folded query.
fn contains_folded(text: &str, folded_query: &[char]) -> bool {
    let folded = fold(text);
    folded
        .windows(folded_query.len())
        .any(|w| w == folded_query)
}

/// A line's fold map: the folded text plus enough bookkeeping to map any folded
/// match back to an original char range and to slice the original line safely.
pub(crate) struct FoldedLine {
    /// Each original char's `to_lowercase()` output, concatenated.
    pub(crate) folded: Vec<char>,
    /// The original CHAR index each folded char came from (pushed once per
    /// emitted folded char, so expansion like `İ` → 2 chars stays mapped).
    pub(crate) fold_origin: Vec<usize>,
    /// Byte offset of each original char, plus a final `line.len()` sentinel —
    /// `line[char_starts[a]..char_starts[b]]` is boundary-safe for any a ≤ b.
    pub(crate) char_starts: Vec<usize>,
}

pub(crate) fn fold_line(line: &str) -> FoldedLine {
    let mut folded = Vec::new();
    let mut fold_origin = Vec::new();
    let mut char_starts = Vec::new();
    for (char_idx, (byte_idx, ch)) in line.char_indices().enumerate() {
        char_starts.push(byte_idx);
        for lc in fold_char(ch) {
            folded.push(lc);
            fold_origin.push(char_idx);
        }
    }
    char_starts.push(line.len());
    FoldedLine {
        folded,
        fold_origin,
        char_starts,
    }
}

fn char_starts(line: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = line.char_indices().map(|(idx, _)| idx).collect();
    starts.push(line.len());
    starts
}

fn snippet_window(n_chars: usize, first: (usize, usize)) -> (usize, usize) {
    if n_chars <= SNIPPET_MAX_CHARS {
        return (0, n_chars);
    }
    let (a, b) = (first.0.min(n_chars), first.1.min(n_chars));
    let start = ((a + b) / 2)
        .saturating_sub(SNIPPET_MAX_CHARS / 2)
        .min(n_chars - SNIPPET_MAX_CHARS);
    (start, start + SNIPPET_MAX_CHARS)
}

pub(crate) fn clip_line_around(line: &str, first: (usize, usize)) -> String {
    let starts = char_starts(line);
    let (start, end) = snippet_window(starts.len() - 1, first);
    line[starts[start]..starts[end]].to_string()
}

/// Non-overlapping occurrences of `query` in `folded`, as folded-index ranges.
///
/// The scan is bounded by the snippet window: the first occurrence pins the
/// window, and its end can never exceed `first_end + SNIPPET_MAX_CHARS` in
/// original chars — anything starting past that is discarded by
/// [`build_snippet`] anyway, so the scan stops there structurally (a multi-MB
/// single-line note cannot amplify allocations).
fn occurrences(folded: &[char], fold_origin: &[usize], query: &[char]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut cutoff: Option<usize> = None; // original-char index; None until a match
    let mut i = 0;
    while i + query.len() <= folded.len() {
        if cutoff.is_some_and(|c| fold_origin[i] >= c) {
            break;
        }
        if folded[i..i + query.len()] == *query {
            if out.is_empty() {
                let first_end = fold_origin[i + query.len() - 1] + 1;
                cutoff = Some(first_end + SNIPPET_MAX_CHARS);
            }
            out.push((i, i + query.len()));
            i += query.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Match one line: fold it, find occurrences, map them back to original char
/// ranges, and build the (possibly clipped) snippet. One [`SearchMatch`] per
/// matching line; `line_no` is 1-based.
fn match_line(line: &str, line_no: u32, folded_query: &[char]) -> Option<SearchMatch> {
    let fl = fold_line(line);
    let occs = occurrences(&fl.folded, &fl.fold_origin, folded_query);
    if occs.is_empty() {
        return None;
    }
    // A folded match [i, j) maps to original chars [origin[i], origin[j-1] + 1).
    let orig: Vec<(usize, usize)> = occs
        .iter()
        .map(|&(i, j)| (fl.fold_origin[i], fl.fold_origin[j - 1] + 1))
        .collect();
    let (snippet, ranges) = build_snippet(line, &fl, &orig);
    Some(SearchMatch {
        line: line_no,
        snippet,
        ranges,
    })
}

/// The snippet for a matched line: the whole line when short, else a
/// [`SNIPPET_MAX_CHARS`]-wide window centered on the first match (clamped to
/// the line). Ranges are rebased to the window; a range straddling a window
/// edge is CLIPPED to its visible part, and only fully-outside ranges are
/// dropped — so the first match (which the window is centered on) always
/// yields a range, even when wider than the window itself.
fn build_snippet(
    line: &str,
    fl: &FoldedLine,
    occs: &[(usize, usize)],
) -> (String, Vec<(u32, u32)>) {
    let n_chars = fl.char_starts.len() - 1; // minus the sentinel
    if n_chars <= SNIPPET_MAX_CHARS {
        let ranges = occs.iter().map(|&(a, b)| (a as u32, b as u32)).collect();
        return (line.to_string(), ranges);
    }
    let (start, end) = snippet_window(n_chars, occs[0]);
    let snippet = line[fl.char_starts[start]..fl.char_starts[end]].to_string();
    let ranges = occs
        .iter()
        .filter_map(|&(x, y)| {
            let (cx, cy) = (x.max(start), y.min(end));
            (cx < cy).then_some(((cx - start) as u32, (cy - start) as u32))
        })
        .collect();
    (snippet, ranges)
}
