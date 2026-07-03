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
use crate::model::{FileHit, SearchMatch, SearchResponse};
use crate::note::title_and_body;
use crate::tree::{markdown_files, read_tree};
use std::path::Path;

/// Total content matches returned per search (the UI shows a truncation banner).
pub const MAX_TOTAL_MATCHES: usize = 200;
/// Content matches returned per file.
pub const MAX_MATCHES_PER_FILE: usize = 50;
/// Snippet window size in Unicode scalars (chars).
pub const SNIPPET_MAX_CHARS: usize = 200;

/// Case-insensitively search every markdown note under `root` for `query`.
///
/// The raw file text is searched, frontmatter included (Obsidian behavior).
/// Name/title hits rank before content-only hits, each group in tree-walk order.
pub fn search_vault(root: &Path, query: &str) -> CoreResult<SearchResponse> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let folded_query = fold(trimmed);
    let tree = read_tree(root)?;

    let mut name_hits: Vec<FileHit> = Vec::new();
    let mut content_hits: Vec<FileHit> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for node in markdown_files(&tree) {
        // Lossy read: a Latin-1 note must not error the whole search; an
        // unreadable file is skipped loudly, never fatal.
        let raw = match std::fs::read(&node.path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                log::warn!("search: skipping unreadable file {}: {e}", node.path);
                continue;
            }
        };
        let stem = Path::new(&node.name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| node.name.clone());
        let (title, _body) = title_and_body(&raw, &stem);
        // Name/title checks run for every file, even after the content budget is
        // exhausted — a name hit costs no match budget.
        let name_match =
            contains_folded(&stem, &folded_query) || contains_folded(&title, &folded_query);

        let budget = MAX_MATCHES_PER_FILE.min(MAX_TOTAL_MATCHES - total);
        let (matches, clipped) = if budget == 0 && truncated {
            (Vec::new(), false) // budget gone and truncation already known — skip
        } else {
            scan_content(&raw, &folded_query, budget)
        };
        truncated |= clipped;
        total += matches.len();

        if name_match || !matches.is_empty() {
            let hit = FileHit {
                path: node.path.clone(),
                rel_path: node.rel_path.clone(),
                title,
                name_match,
                matches,
            };
            if name_match {
                name_hits.push(hit);
            } else {
                content_hits.push(hit);
            }
        }
    }

    name_hits.append(&mut content_hits);
    Ok(SearchResponse {
        hits: name_hits,
        truncated,
    })
}

/// Scan `raw`'s lines for matches, keeping at most `budget` of them. The bool is
/// true iff at least one further matching line existed beyond the budget — the
/// exact "did a cap clip anything" signal for the `truncated` flag.
fn scan_content(raw: &str, folded_query: &[char], budget: usize) -> (Vec<SearchMatch>, bool) {
    let mut out = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let Some(m) = match_line(line, idx as u32 + 1, folded_query) else {
            continue;
        };
        if out.len() >= budget {
            return (out, true);
        }
        out.push(m);
    }
    (out, false)
}

/// Case-fold a string the same way lines are folded (per-char `to_lowercase`).
fn fold(s: &str) -> Vec<char> {
    s.chars().flat_map(char::to_lowercase).collect()
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
struct FoldedLine {
    /// Each original char's `to_lowercase()` output, concatenated.
    folded: Vec<char>,
    /// The original CHAR index each folded char came from (pushed once per
    /// emitted folded char, so expansion like `İ` → 2 chars stays mapped).
    fold_origin: Vec<usize>,
    /// Byte offset of each original char, plus a final `line.len()` sentinel —
    /// `line[char_starts[a]..char_starts[b]]` is boundary-safe for any a ≤ b.
    char_starts: Vec<usize>,
}

fn fold_line(line: &str) -> FoldedLine {
    let mut folded = Vec::new();
    let mut fold_origin = Vec::new();
    let mut char_starts = Vec::new();
    for (char_idx, (byte_idx, ch)) in line.char_indices().enumerate() {
        char_starts.push(byte_idx);
        for lc in ch.to_lowercase() {
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

/// All non-overlapping occurrences of `query` in `folded`, as folded-index ranges.
fn occurrences(folded: &[char], query: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + query.len() <= folded.len() {
        if folded[i..i + query.len()] == *query {
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
    let occs = occurrences(&fl.folded, folded_query);
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
/// [`SNIPPET_MAX_CHARS`]-wide window centered on the first match (clamped to the
/// line), with ranges rebased to the window and out-of-window ranges dropped.
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
    let (a, b) = occs[0];
    let start = ((a + b) / 2)
        .saturating_sub(SNIPPET_MAX_CHARS / 2)
        .min(n_chars - SNIPPET_MAX_CHARS);
    let end = start + SNIPPET_MAX_CHARS;
    let snippet = line[fl.char_starts[start]..fl.char_starts[end]].to_string();
    let ranges = occs
        .iter()
        .filter(|&&(x, y)| x >= start && y <= end)
        .map(|&(x, y)| ((x - start) as u32, (y - start) as u32))
        .collect();
    (snippet, ranges)
}
