//! Directional backlinks and unlinked title mentions for one target note.
//!
//! This is deliberately additive to the undirected galaxy graph: it reuses the
//! same masked-body link extractor and Obsidian-style resolver, but keeps
//! per-occurrence line evidence for the reader panel. Code fences and inline
//! spans are masked before both link and plain-text mention scans. A source note
//! can contribute multiple unlinked mentions when the target title appears more
//! than once.

use crate::error::{CoreError, CoreResult};
use crate::links::{self, LinkResolutionIndex};
use crate::model::{Backlink, Backlinks, TreeNode, UnlinkedMention};
use crate::note::title_and_body;
use crate::search;
use crate::tree::{markdown_files, read_tree};
use std::path::Path;

struct NoteText {
    title: String,
    body: String,
}

/// Read directional linked mentions and unlinked plain-title mentions for
/// `target_rel`, a vault-relative markdown path.
pub fn read_backlinks(root: &Path, target_rel: &str) -> CoreResult<Backlinks> {
    let tree = read_tree(root)?;
    let files = markdown_files(&tree);
    let Some(target_node) = files.iter().copied().find(|n| n.rel_path == target_rel) else {
        return Err(CoreError::NotFound(target_rel.to_string()));
    };

    let resolver = LinkResolutionIndex::from_files(&files);
    let mut skipped_files = 0u32;
    let target_title = target_title(target_node, &mut skipped_files);
    let mut linked = Vec::new();
    let mut unlinked = Vec::new();

    for node in files {
        if node.rel_path == target_rel {
            continue;
        }
        scan_source(
            node,
            target_rel,
            &target_title,
            &resolver,
            &mut linked,
            &mut unlinked,
            &mut skipped_files,
        );
    }

    sort_linked(&mut linked);
    sort_unlinked(&mut unlinked);
    Ok(Backlinks {
        linked,
        unlinked,
        skipped_files,
    })
}

fn scan_source(
    node: &TreeNode,
    target_rel: &str,
    target_title: &str,
    resolver: &LinkResolutionIndex,
    linked: &mut Vec<Backlink>,
    unlinked: &mut Vec<UnlinkedMention>,
    skipped_files: &mut u32,
) {
    let Some(note) = read_note_text(node, skipped_files) else {
        return;
    };
    let linked_before = linked.len();
    for occ in links::extract_link_occurrences(&node.rel_path, &note.body) {
        if resolver.resolve(&occ.target).as_deref() == Some(target_rel) {
            linked.push(Backlink {
                source_rel: node.rel_path.clone(),
                source_title: note.title.clone(),
                snippet: occ.snippet,
                line: occ.line,
            });
        }
    }
    if linked.len() == linked_before {
        add_unlinked_mention(node, &note, target_title, unlinked);
    }
}

fn add_unlinked_mention(
    node: &TreeNode,
    note: &NoteText,
    target_title: &str,
    unlinked: &mut Vec<UnlinkedMention>,
) {
    for (line, snippet) in find_title_mentions(&note.body, target_title) {
        unlinked.push(UnlinkedMention {
            source_rel: node.rel_path.clone(),
            source_title: note.title.clone(),
            snippet,
            line,
        });
    }
}

fn read_note_text(node: &TreeNode, skipped_files: &mut u32) -> Option<NoteText> {
    let raw = match std::fs::read(&node.path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => {
            log::warn!("backlinks: skipping unreadable file {}: {e}", node.path);
            *skipped_files = skipped_files.saturating_add(1);
            return None;
        }
    };
    let (title, body) = title_and_body(&raw, &links::stem_of(&node.name));
    Some(NoteText { title, body })
}

fn target_title(node: &TreeNode, skipped_files: &mut u32) -> String {
    match read_note_text(node, skipped_files) {
        Some(note) => note.title,
        None => links::stem_of(&node.name),
    }
}

fn find_title_mentions(body: &str, title: &str) -> Vec<(u32, String)> {
    let folded_title = search::fold(title.trim());
    if folded_title.is_empty() {
        return Vec::new();
    }
    let masked = links::mask_code(body);
    let mut mentions = Vec::new();
    for (idx, (line, masked_line)) in body.lines().zip(masked.lines()).enumerate() {
        let line_no = u32::try_from(idx + 1).unwrap_or(u32::MAX);
        for (start, end) in title_matches_in_line(masked_line, &folded_title) {
            mentions.push((line_no, search::clip_line_around(line, (start, end))));
        }
    }
    mentions
}

fn title_matches_in_line(line: &str, folded_title: &[char]) -> Vec<(usize, usize)> {
    let fl = search::fold_line(line);
    let mut matches = Vec::new();
    let mut i = 0usize;
    while i + folded_title.len() <= fl.folded.len() {
        let end = i + folded_title.len();
        if fl.folded[i..end] == *folded_title && has_word_boundaries(&fl.folded, i, end) {
            matches.push((fl.fold_origin[i], fl.fold_origin[end - 1] + 1));
            i = end;
        } else {
            i += 1;
        }
    }
    matches
}

fn has_word_boundaries(folded: &[char], start: usize, end: usize) -> bool {
    let left = start == 0 || !word_join(folded[start - 1], folded[start]);
    let right = end == folded.len() || !word_join(folded[end - 1], folded[end]);
    left && right
}

fn word_join(left: char, right: char) -> bool {
    is_word_char(left) && is_word_char(right)
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn sort_linked(linked: &mut [Backlink]) {
    linked.sort_by(|a, b| {
        a.source_rel
            .cmp(&b.source_rel)
            .then_with(|| a.line.cmp(&b.line))
    });
}

fn sort_unlinked(unlinked: &mut [UnlinkedMention]) {
    unlinked.sort_by(|a, b| {
        a.source_rel
            .cmp(&b.source_rel)
            .then_with(|| a.line.cmp(&b.line))
    });
}
