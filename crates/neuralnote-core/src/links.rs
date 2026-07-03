//! The note link graph — wikilinks + relative markdown links, Obsidian-style.
//!
//! One walk over the note set builds a node per markdown note (orphans
//! included), the resolution indices, and each note's deduplicated raw link
//! targets — extracted from the BODY only (frontmatter stripped, code blocks
//! and spans masked) and dropped-body-immediately so memory stays
//! O(distinct targets), never O(vault text). Targets are then resolved against
//! the full note set and edges deduped on the unordered pair. Unresolved
//! targets are skipped silently — no ghost nodes.

use crate::error::CoreResult;
use crate::model::{GraphLink, GraphNode, LinkGraph};
use crate::note::title_and_body;
use crate::tree::{markdown_files, read_tree};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// A raw link target as written in a note, before resolution — wiki and
/// markdown targets resolve by different rules, so the kind is kept.
#[derive(Clone, PartialEq, Eq, Hash)]
enum RawTarget {
    Wiki(String),
    /// Already normalised to a vault-relative path candidate.
    Md(String),
}

/// Build the vault's link graph: a node per markdown note, an edge per resolved,
/// deduplicated wikilink or relative markdown link.
pub fn read_link_graph(root: &Path) -> CoreResult<LinkGraph> {
    let tree = read_tree(root)?;
    let files = markdown_files(&tree);

    let mut nodes: Vec<GraphNode> = Vec::new();
    // Per note: its deduped raw targets (order preserved → deterministic edges).
    let mut note_targets: Vec<(String, Vec<RawTarget>)> = Vec::new();
    // Lowercased stem AND filename → rel_paths, for `[[target]]` ± `.md`.
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    // Lowercased rel_path → rel_paths, for markdown-link resolution. A Vec —
    // never last-write-wins — because a case-sensitive filesystem can hold
    // `Target.md` AND `target.md` (see `resolve_rel`).
    let mut by_rel: HashMap<String, Vec<String>> = HashMap::new();
    let mut skipped_files: u32 = 0;

    for node in &files {
        // Lossy read (a Latin-1 note must not error the graph); an unreadable
        // note keeps its node — orphan-style, links skipped — and the failure
        // is logged AND counted, never silent.
        let raw = match std::fs::read(&node.path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                log::warn!(
                    "link graph: could not read {} ({e}); node kept, its links skipped",
                    node.path
                );
                skipped_files = skipped_files.saturating_add(1);
                String::new()
            }
        };
        let stem = Path::new(&node.name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| node.name.clone());
        let (title, body) = title_and_body(&raw, &stem);
        nodes.push(GraphNode {
            id: node.rel_path.clone(),
            title,
            cluster: cluster_of(&node.rel_path).to_string(),
        });
        by_name
            .entry(stem.to_lowercase())
            .or_default()
            .push(node.rel_path.clone());
        by_name
            .entry(node.name.to_lowercase())
            .or_default()
            .push(node.rel_path.clone());
        by_rel
            .entry(node.rel_path.to_lowercase())
            .or_default()
            .push(node.rel_path.clone());
        note_targets.push((
            node.rel_path.clone(),
            extract_targets(&node.rel_path, &body),
        ));
        // `raw`/`body` drop here — only the deduped targets are retained.
    }
    let all_rels: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();

    let mut links: Vec<GraphLink> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (source, targets) in &note_targets {
        for raw_target in targets {
            let resolved = match raw_target {
                RawTarget::Wiki(t) => resolve_wikilink(t, &by_name, &all_rels),
                RawTarget::Md(rel) => resolve_md_rel(rel, &by_rel),
            };
            let Some(target) = resolved else { continue };
            if target == *source {
                continue; // self-link
            }
            let key = if *source < target {
                (source.clone(), target.clone())
            } else {
                (target.clone(), source.clone())
            };
            if !seen.insert(key) {
                continue; // A→B and B→A are one edge
            }
            let bridge = cluster_of(source) != cluster_of(&target);
            links.push(GraphLink {
                source: source.clone(),
                target,
                bridge,
            });
        }
    }

    Ok(LinkGraph {
        nodes,
        links,
        skipped_files,
    })
}

/// First path segment of a rel_path; `""` for root-level notes.
fn cluster_of(rel: &str) -> &str {
    match rel.find('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

/// Extract a note's deduplicated raw link targets from its body. Dedupe happens
/// DURING extraction (insertion-ordered), so a note repeating one target a
/// million times retains O(distinct targets), never O(occurrences).
fn extract_targets(source_rel: &str, body: &str) -> Vec<RawTarget> {
    let masked = mask_code(body);
    let mut seen: HashSet<RawTarget> = HashSet::new();
    let mut out: Vec<RawTarget> = Vec::new();
    let mut add = |t: RawTarget| {
        if seen.insert(t.clone()) {
            out.push(t);
        }
    };
    extract_wikilinks(&masked, |t| add(RawTarget::Wiki(t.to_string())));
    extract_md_links(&masked, |t| {
        if let Some(rel) = normalize_md_target(source_rel, t) {
            add(RawTarget::Md(rel));
        }
    });
    out
}

/// Blank out fenced code blocks and inline code spans, space-for-space
/// (newlines kept), so links inside them are ignored — Obsidian behavior.
fn mask_code(body: &str) -> String {
    mask_inline_spans(&mask_fences(body))
}

/// Mask fenced code blocks: a fence opens with ≥3 backticks or tildes and
/// closes only on a run of the SAME character at least as long (CommonMark) —
/// a 3-backtick line inside a 4-backtick fence is content, not a closer. An
/// unclosed fence masks to the end of the body.
fn mask_fences(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut open: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let marker = fence_marker(line);
        let masked = match (open, marker) {
            (None, Some(m)) => {
                open = Some(m);
                true
            }
            (None, None) => false,
            (Some((ch, len)), m) => {
                if m.is_some_and(|(c2, l2)| c2 == ch && l2 >= len) {
                    open = None;
                }
                true // opener, interior, and closer lines all mask
            }
        };
        if masked {
            blank_keeping_newlines(line, &mut out);
        } else {
            out.push_str(line);
        }
    }
    out
}

/// The leading code-fence run of a line (``` or ~~~, length ≥ 3), if any.
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let len = trimmed.chars().take_while(|&c| c == first).count();
    (len >= 3).then_some((first, len))
}

/// Blank inline code spans over the WHOLE body — CommonMark spans may cross
/// newlines. A run of N backticks closes on the next run of exactly N; an
/// unmatched opener is copied literally.
fn mask_inline_spans(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let open_len = backtick_run_len(&chars, i);
        match find_closing_run(&chars, i + open_len, open_len) {
            Some(close_start) => {
                let span_end = close_start + open_len;
                for &c in &chars[i..span_end] {
                    out.push(if c == '\n' || c == '\r' { c } else { ' ' });
                }
                i = span_end;
            }
            None => {
                out.extend(std::iter::repeat_n('`', open_len));
                i += open_len;
            }
        }
    }
    out
}

/// Push `line` as spaces, preserving newline chars so lines never shift.
fn blank_keeping_newlines(line: &str, out: &mut String) {
    for c in line.chars() {
        out.push(if c == '\n' || c == '\r' { c } else { ' ' });
    }
}

fn backtick_run_len(chars: &[char], from: usize) -> usize {
    chars[from..].iter().take_while(|&&c| c == '`').count()
}

/// The start of the next backtick run of exactly `n`, if any.
fn find_closing_run(chars: &[char], from: usize, n: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == '`' {
            let len = backtick_run_len(chars, i);
            if len == n {
                return Some(i);
            }
            i += len;
        } else {
            i += 1;
        }
    }
    None
}

/// Emit raw wikilink targets in `text`: `[[t]]`, `[[t|alias]]`, `[[t#heading]]`,
/// `[[t#heading|alias]]`; embeds (`![[t]]`) are caught by the same scan. The
/// target is the part before the first `#` or `|`, trimmed.
fn extract_wikilinks(text: &str, mut emit: impl FnMut(&str)) {
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { return };
        let target = after[..end].split(['#', '|']).next().unwrap_or("").trim();
        if !target.is_empty() {
            emit(target);
        }
        rest = &after[end + 2..];
    }
}

/// Emit raw `[text](target)` markdown-link targets in `text`. `[[wikilinks]]`
/// are skipped here (the wikilink scan owns them); image links (`![…](…)`) count.
fn extract_md_links(text: &str, mut emit: impl FnMut(&str)) {
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        if let Some(stripped) = after_open.strip_prefix('[') {
            rest = stripped;
            continue;
        }
        let Some(close) = after_open.find(']') else {
            return;
        };
        let after_close = &after_open[close + 1..];
        let Some(paren) = after_close.strip_prefix('(') else {
            rest = after_close;
            continue;
        };
        let Some(t_end) = paren.find(')') else { return };
        emit(&paren[..t_end]);
        rest = &paren[t_end + 1..];
    }
}

/// Resolve a markdown-link target lexically against the source note's folder.
/// Returns the normalised vault-relative path, or `None` for external targets
/// (scheme or absolute), empty targets, or `..` escaping the vault root.
fn normalize_md_target(source_rel: &str, raw_target: &str) -> Option<String> {
    let target = raw_target.trim().split('#').next().unwrap_or("");
    if target.is_empty() || target.starts_with('/') || has_scheme(target) {
        return None;
    }
    let decoded = target.replace("%20", " "); // `%20` only — no general decoding
    let mut segs: Vec<&str> = source_rel.split('/').collect();
    segs.pop(); // drop the source file name, keeping its folder
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                segs.pop()?; // escaping the root → not a vault link
            }
            p => segs.push(p),
        }
    }
    Some(segs.join("/"))
}

/// Whether the target starts with an RFC 3986 scheme (`^[A-Za-z][A-Za-z0-9+.\-]*:`),
/// e.g. `https:`, `mailto:` — such links are external, never vault notes.
fn has_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        match c {
            ':' => return true,
            c if c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-') => {}
            _ => return false,
        }
    }
    false
}

/// Resolve a wikilink target to a note's rel_path. Filename targets match the
/// lowercased stem/filename index; path-qualified targets (`[[folder/note]]`)
/// match by case-insensitive, segment-aligned rel-path suffix, with or without
/// `.md`. Ambiguity → shortest rel_path, then lexicographic (Obsidian's rule).
fn resolve_wikilink(
    target: &str,
    by_name: &HashMap<String, Vec<String>>,
    all_rels: &[String],
) -> Option<String> {
    let t = target.to_lowercase();
    let candidates: Vec<&String> = if t.contains('/') {
        let wants = [t.clone(), format!("{t}.md")];
        all_rels
            .iter()
            .filter(|rel| {
                let rel = rel.to_lowercase();
                wants
                    .iter()
                    .any(|w| rel == *w || rel.ends_with(&format!("/{w}")))
            })
            .collect()
    } else {
        by_name.get(&t).into_iter().flatten().collect()
    };
    candidates
        .into_iter()
        .min_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)))
        .cloned()
}

/// Resolve a normalised rel-path candidate against the folded rel-path index,
/// case-insensitively. Exact-case match wins; otherwise the same
/// shortest-then-lexicographic tiebreak as wikilinks (a case-sensitive
/// filesystem can hold `Target.md` AND `target.md`).
pub(crate) fn resolve_rel(cand: &str, by_rel: &HashMap<String, Vec<String>>) -> Option<String> {
    let list = by_rel.get(&cand.to_lowercase())?;
    if let Some(exact) = list.iter().find(|r| r.as_str() == cand) {
        return Some(exact.clone());
    }
    list.iter()
        .min_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)))
        .cloned()
}

/// Markdown-link resolution: the candidate as written, else with `.md`
/// appended (Obsidian resolves extensionless links).
fn resolve_md_rel(cand: &str, by_rel: &HashMap<String, Vec<String>>) -> Option<String> {
    resolve_rel(cand, by_rel).or_else(|| resolve_rel(&format!("{cand}.md"), by_rel))
}
