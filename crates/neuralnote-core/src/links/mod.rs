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
use crate::model::{GraphLink, GraphNode, LinkGraph, TreeNode};
use crate::note::title_and_body;
use crate::search;
use crate::tree::{markdown_files, read_tree};
use std::collections::{HashMap, HashSet};
use std::path::Path;

mod mask;

pub(crate) use mask::mask_code;

/// A raw link target as written in a note, before resolution — wiki and
/// markdown targets resolve by different rules, so the kind is kept.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) enum RawTarget {
    Wiki(String),
    /// Already normalised to a vault-relative path candidate.
    Md(String),
}

/// One raw link occurrence from a source body, with source-line context.
pub(crate) struct RawLinkOccurrence {
    pub(crate) target: RawTarget,
    pub(crate) line: u32,
    pub(crate) snippet: String,
}

/// The case-folded note indices used by every Obsidian-style link resolver.
pub(crate) struct LinkResolutionIndex {
    /// Lowercased stem AND filename → rel_paths, for `[[target]]` ± `.md`.
    by_name: HashMap<String, Vec<String>>,
    /// Lowercased rel_path → rel_paths, for markdown-link resolution.
    by_rel: HashMap<String, Vec<String>>,
    all_rels: Vec<String>,
}

impl LinkResolutionIndex {
    pub(crate) fn from_files(files: &[&TreeNode]) -> Self {
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_rel: HashMap<String, Vec<String>> = HashMap::new();
        let mut all_rels: Vec<String> = Vec::new();
        for node in files {
            let stem = stem_of(&node.name);
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
            all_rels.push(node.rel_path.clone());
        }
        Self {
            by_name,
            by_rel,
            all_rels,
        }
    }

    pub(crate) fn resolve(&self, raw_target: &RawTarget) -> Option<String> {
        match raw_target {
            RawTarget::Wiki(t) => resolve_wikilink(t, &self.by_name, &self.all_rels),
            RawTarget::Md(rel) => resolve_md_rel(rel, &self.by_rel),
        }
    }
}

/// Build the vault's link graph: a node per markdown note, an edge per resolved,
/// deduplicated wikilink or relative markdown link.
pub fn read_link_graph(root: &Path) -> CoreResult<LinkGraph> {
    let tree = read_tree(root)?;
    let files = markdown_files(&tree);
    let index = collect_notes(&files);
    let links = build_links(&index);
    Ok(LinkGraph {
        nodes: index.nodes,
        links,
        skipped_files: index.skipped_files,
    })
}

/// One walk's worth of per-file collection: the nodes, the resolution indices,
/// and each note's deduplicated raw targets.
struct NoteIndex {
    nodes: Vec<GraphNode>,
    /// Per note: its deduped raw targets (order preserved → deterministic edges).
    note_targets: Vec<(String, Vec<RawTarget>)>,
    resolver: LinkResolutionIndex,
    skipped_files: u32,
}

/// The per-file collection step: build every note's node, index it for
/// resolution, and extract its raw link targets.
fn collect_notes(files: &[&TreeNode]) -> NoteIndex {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut note_targets: Vec<(String, Vec<RawTarget>)> = Vec::new();
    let resolver = LinkResolutionIndex::from_files(files);
    let mut skipped_files: u32 = 0;

    for node in files {
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
        let stem = stem_of(&node.name);
        let (title, body) = title_and_body(&raw, &stem);
        nodes.push(GraphNode {
            id: node.rel_path.clone(),
            title,
            cluster: cluster_of(&node.rel_path).to_string(),
        });
        note_targets.push((
            node.rel_path.clone(),
            extract_targets(&node.rel_path, &body),
        ));
        // `raw`/`body` drop here — only the deduped targets are retained.
    }

    NoteIndex {
        nodes,
        note_targets,
        resolver,
        skipped_files,
    }
}

/// The edge-building step: resolve every note's raw targets and keep one edge
/// per unordered pair, skipping self-links and unresolved targets.
fn build_links(index: &NoteIndex) -> Vec<GraphLink> {
    let mut links: Vec<GraphLink> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (source, targets) in &index.note_targets {
        for raw_target in targets {
            let Some(target) = index.resolver.resolve(raw_target) else {
                continue;
            };
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
    links
}

/// First path segment of a rel_path; `""` for root-level notes.
fn cluster_of(rel: &str) -> &str {
    match rel.find('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

pub(crate) fn stem_of(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string())
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
    emit_raw_targets(source_rel, &masked, |target, _offset| add(target));
    out
}

/// Extract every raw link occurrence from a body, preserving source-line
/// evidence for directional backlinks. Resolution happens later via
/// [`LinkResolutionIndex`] so these occurrences use the graph's exact rules.
pub(crate) fn extract_link_occurrences(source_rel: &str, body: &str) -> Vec<RawLinkOccurrence> {
    let masked = mask_code(body);
    let context = LineContext::new(body, &masked);
    let mut out = Vec::new();
    emit_raw_targets(source_rel, &masked, |target, offset| {
        out.push(context.occurrence(target, offset));
    });
    out
}

fn emit_raw_targets(source_rel: &str, masked: &str, mut emit: impl FnMut(RawTarget, usize)) {
    extract_wikilinks(masked, |target, offset| {
        emit(RawTarget::Wiki(target.to_string()), offset);
    });
    extract_md_links(masked, |target, offset| {
        if let Some(rel) = normalize_md_target(source_rel, target) {
            emit(RawTarget::Md(rel), offset);
        }
    });
}

struct LineContext<'a> {
    starts: Vec<usize>,
    masked_lines: Vec<&'a str>,
    original_lines: Vec<&'a str>,
}

impl<'a> LineContext<'a> {
    fn new(original: &'a str, masked: &'a str) -> Self {
        let (starts, masked_lines) = line_parts(masked);
        Self {
            starts,
            masked_lines,
            original_lines: original.lines().collect(),
        }
    }

    fn occurrence(&self, target: RawTarget, offset: usize) -> RawLinkOccurrence {
        let idx = self.line_index(offset);
        let line = self.original_lines.get(idx).copied().unwrap_or("");
        let col = self.char_offset(idx, offset);
        RawLinkOccurrence {
            target,
            line: u32::try_from(idx + 1).unwrap_or(u32::MAX),
            snippet: search::clip_line_around(line, (col, col.saturating_add(1))),
        }
    }

    fn line_index(&self, offset: usize) -> usize {
        match self.starts.binary_search(&offset) {
            Ok(idx) => idx,
            Err(0) => 0,
            Err(idx) => idx - 1,
        }
    }

    fn char_offset(&self, idx: usize, offset: usize) -> usize {
        let start = self.starts.get(idx).copied().unwrap_or(0);
        let line = self.masked_lines.get(idx).copied().unwrap_or("");
        let byte_len = offset.saturating_sub(start).min(line.len());
        line[..byte_len].chars().count()
    }
}

fn line_parts(text: &str) -> (Vec<usize>, Vec<&str>) {
    let mut starts = Vec::new();
    let mut lines = Vec::new();
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        starts.push(offset);
        lines.push(line.trim_end_matches(['\n', '\r']));
        offset += line.len();
    }
    if starts.is_empty() {
        starts.push(0);
        lines.push("");
    }
    (starts, lines)
}

/// Emit raw wikilink targets in `text`: `[[t]]`, `[[t|alias]]`, `[[t#heading]]`,
/// `[[t#heading|alias]]`; embeds (`![[t]]`) are caught by the same scan. The
/// target is the part before the first `#` or `|`, trimmed.
fn extract_wikilinks(text: &str, mut emit: impl FnMut(&str, usize)) {
    let mut base = 0usize;
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let open = base + start;
        let after_start = open + 2;
        let after = &text[after_start..];
        let Some(end) = after.find("]]") else { return };
        let target = after[..end].split(['#', '|']).next().unwrap_or("").trim();
        if !target.is_empty() {
            emit(target, open);
        }
        base = after_start + end + 2;
        rest = &text[base..];
    }
}

/// Emit raw `[text](target)` markdown-link targets in `text`. `[[wikilinks]]`
/// are skipped here (the wikilink scan owns them); image links (`![…](…)`) count.
fn extract_md_links(text: &str, mut emit: impl FnMut(&str, usize)) {
    let mut base = 0usize;
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let open_abs = base + open;
        let after_open_abs = open_abs + 1;
        let after_open = &text[after_open_abs..];
        if let Some(stripped) = after_open.strip_prefix('[') {
            base = after_open_abs + 1;
            rest = stripped;
            continue;
        }
        let Some(close) = after_open.find(']') else {
            return;
        };
        let after_close_abs = after_open_abs + close + 1;
        let after_close = &text[after_close_abs..];
        let Some(paren) = after_close.strip_prefix('(') else {
            base = after_close_abs;
            rest = after_close;
            continue;
        };
        let paren_abs = after_close_abs + 1;
        let Some(t_end) = paren.find(')') else { return };
        emit(&paren[..t_end], open_abs);
        base = paren_abs + t_end + 1;
        rest = &text[base..];
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
