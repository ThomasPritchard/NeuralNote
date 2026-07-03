//! The note link graph — wikilinks + relative markdown links, Obsidian-style.
//!
//! Two passes over the note set: first build a node per markdown note (orphans
//! included) plus the resolution indices, then extract links from each note's
//! BODY (frontmatter stripped, code blocks/spans masked), resolve them against
//! the full note set, and dedupe edges on the unordered pair. Unresolved targets
//! are skipped silently — no ghost nodes.

use crate::error::CoreResult;
use crate::model::{GraphLink, GraphNode, LinkGraph};
use crate::note::title_and_body;
use crate::tree::{markdown_files, read_tree};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Build the vault's link graph: a node per markdown note, an edge per resolved,
/// deduplicated wikilink or relative markdown link.
pub fn read_link_graph(root: &Path) -> CoreResult<LinkGraph> {
    let tree = read_tree(root)?;
    let files = markdown_files(&tree);

    let mut nodes: Vec<GraphNode> = Vec::new();
    // (rel_path, body) per note, link extraction input.
    let mut bodies: Vec<(String, String)> = Vec::new();
    // Lowercased stem AND filename → rel_paths, for `[[target]]` ± `.md`.
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    // Lowercased rel_path → rel_path, for markdown-link resolution.
    let mut by_rel: HashMap<String, String> = HashMap::new();

    for node in &files {
        // Lossy read (a Latin-1 note must not error the graph); an unreadable
        // note keeps its node — orphan-style, links skipped — and is logged.
        let raw = match std::fs::read(&node.path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                log::warn!(
                    "link graph: could not read {} ({e}); node kept, its links skipped",
                    node.path
                );
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
        by_rel.insert(node.rel_path.to_lowercase(), node.rel_path.clone());
        bodies.push((node.rel_path.clone(), body));
    }
    let all_rels: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();

    let mut links: Vec<GraphLink> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (source, body) in &bodies {
        let masked = mask_code(body);
        let mut resolved: Vec<String> = Vec::new();
        for target in extract_wikilinks(&masked) {
            resolved.extend(resolve_wikilink(&target, &by_name, &all_rels));
        }
        for target in extract_md_links(&masked) {
            resolved.extend(
                normalize_md_target(source, &target)
                    .and_then(|rel| by_rel.get(&rel.to_lowercase()).cloned()),
            );
        }
        for target in resolved {
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

    Ok(LinkGraph { nodes, links })
}

/// First path segment of a rel_path; `""` for root-level notes.
fn cluster_of(rel: &str) -> &str {
    match rel.find('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

/// Blank out fenced code blocks (``` fences; an unclosed fence masks to the end)
/// and inline code spans, space-for-space, so links inside them are ignored —
/// Obsidian behavior. Newlines are kept so nothing else shifts lines.
fn mask_code(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    for line in body.split_inclusive('\n') {
        let is_fence = line.trim_start().starts_with("```");
        if is_fence || in_fence {
            for ch in line.chars() {
                out.push(if ch == '\n' || ch == '\r' { ch } else { ' ' });
            }
        } else {
            mask_inline_spans(line, &mut out);
        }
        if is_fence {
            in_fence = !in_fence;
        }
    }
    out
}

/// Copy `line` into `out`, blanking backtick code spans (a run of N backticks
/// closes with the next run of exactly N — the CommonMark rule). An unmatched
/// opener is copied literally.
fn mask_inline_spans(line: &str, out: &mut String) {
    let chars: Vec<char> = line.chars().collect();
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
                out.extend(std::iter::repeat_n(' ', span_end - i));
                i = span_end;
            }
            None => {
                out.extend(std::iter::repeat_n('`', open_len));
                i += open_len;
            }
        }
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

/// Raw wikilink targets in `text`: `[[t]]`, `[[t|alias]]`, `[[t#heading]]`,
/// `[[t#heading|alias]]`; embeds (`![[t]]`) are caught by the same scan. The
/// target is the part before the first `#` or `|`, trimmed.
fn extract_wikilinks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let target = after[..end].split(['#', '|']).next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &after[end + 2..];
    }
    out
}

/// Raw `[text](target)` markdown-link targets in `text`. `[[wikilinks]]` are
/// skipped here (the wikilink scan owns them); image links (`![…](…)`) count.
fn extract_md_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        if let Some(stripped) = after_open.strip_prefix('[') {
            rest = stripped;
            continue;
        }
        let Some(close) = after_open.find(']') else {
            break;
        };
        let after_close = &after_open[close + 1..];
        let Some(paren) = after_close.strip_prefix('(') else {
            rest = after_close;
            continue;
        };
        let Some(t_end) = paren.find(')') else { break };
        out.push(paren[..t_end].to_string());
        rest = &paren[t_end + 1..];
    }
    out
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
