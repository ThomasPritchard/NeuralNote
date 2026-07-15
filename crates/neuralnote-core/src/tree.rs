//! Vault file-tree scanning.

use crate::error::CoreResult;
use crate::model::{DirListing, EntryKind, TreeNode};
use crate::paths::rel_path;
use std::path::Path;

/// Guard against pathological nesting (and stack overflow) on a recursive scan.
/// Far deeper than any real vault; folders beyond this depth show as empty.
const MAX_DEPTH: usize = 48;

/// Build the vault tree rooted at `root`. Hidden entries (dotfiles, and our own
/// `.neuralnote` sidecar) are skipped, as are symlinks (avoids escape + loops).
/// Within each folder, children are sorted folders-first then files, each group
/// case-insensitive by name.
pub fn read_tree(root: &Path) -> CoreResult<Vec<TreeNode>> {
    let canon = root
        .canonicalize()
        .map_err(|e| crate::error::CoreError::Io(format!("vault root unreadable: {e}")))?;
    scan_dir(&canon, &canon, 0)
}

fn scan_dir(root: &Path, dir: &Path, depth: usize) -> CoreResult<Vec<TreeNode>> {
    let mut nodes: Vec<TreeNode> = Vec::new();

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue; // don't follow symlinks — prevents escapes and cycles
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let path = entry.path();

        if file_type.is_dir() {
            let children = if depth + 1 < MAX_DEPTH {
                scan_dir(root, &path, depth + 1)?
            } else {
                Vec::new()
            };
            nodes.push(TreeNode {
                kind: EntryKind::Folder,
                name,
                path: path.to_string_lossy().into_owned(),
                rel_path: rel_path(root, &path),
                ext: None,
                children: Some(children),
            });
        } else if file_type.is_file() {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
            nodes.push(TreeNode {
                kind: EntryKind::File,
                name,
                path: path.to_string_lossy().into_owned(),
                rel_path: rel_path(root, &path),
                ext,
                children: None,
            });
        }
    }

    nodes.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Folder, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Folder) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

/// Per-directory breadth cap for the DISPLAY path only. A single folder with
/// more than this many visible entries returns the first CAP (sorted) plus a
/// truncation count. Search / graph / retrieval are uncapped — a truncated file
/// is still fully indexed and citable.
const DIR_LISTING_CAP: usize = 5_000;

/// One directory's immediate children, non-recursively — the lazy file-tree
/// DISPLAY primitive. Applies the SAME hidden-skip ([`is_hidden`]) and
/// symlink-skip (`file_type.is_symlink()`) protections as [`scan_dir`], and the
/// SAME folders-first, case-insensitive sort. Folders in the result carry
/// `children: None` (unloaded — a later expand fetches them). No recursion, so
/// `MAX_DEPTH` is irrelevant here.
///
/// Over [`DIR_LISTING_CAP`] visible entries: returns the first CAP (in sort
/// order) with `truncated = Some(remaining)`; otherwise `truncated = None`. An
/// unreadable directory surfaces as [`crate::error::CoreError::Io`] — never a
/// panic, never a silent empty listing.
pub fn list_dir(root: &Path, dir: &Path) -> CoreResult<DirListing> {
    let root_c = root
        .canonicalize()
        .map_err(|e| crate::error::CoreError::Io(format!("vault root unreadable: {e}")))?;

    let mut nodes: Vec<TreeNode> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue; // don't follow symlinks — prevents escapes and cycles
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let path = entry.path();

        if file_type.is_dir() {
            nodes.push(TreeNode {
                kind: EntryKind::Folder,
                name,
                path: path.to_string_lossy().into_owned(),
                rel_path: rel_path(&root_c, &path),
                ext: None,
                children: None, // unloaded — one level only, no recursion
            });
        } else if file_type.is_file() {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
            nodes.push(TreeNode {
                kind: EntryKind::File,
                name,
                path: path.to_string_lossy().into_owned(),
                rel_path: rel_path(&root_c, &path),
                ext,
                children: None,
            });
        }
    }

    sort_tree_nodes(&mut nodes);

    let truncated = if nodes.len() > DIR_LISTING_CAP {
        let omitted = (nodes.len() - DIR_LISTING_CAP) as u32;
        nodes.truncate(DIR_LISTING_CAP);
        Some(omitted)
    } else {
        None
    };

    Ok(DirListing {
        entries: nodes,
        truncated,
    })
}

/// Folders-first, then case-insensitive by name — the [`read_tree`] ordering,
/// reused by [`list_dir`] so both paths present a folder's children identically.
fn sort_tree_nodes(nodes: &mut [TreeNode]) {
    nodes.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Folder, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Folder) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}

/// Hidden = starts with `.` (covers `.obsidian`, `.git`, `.neuralnote`, etc.).
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Build a single [`TreeNode`] for `path` (folders include their scanned
/// children). Used by entry operations to return the node they just produced.
/// `root` must be the canonical vault root; `path` an absolute path within it.
pub fn node_for(root: &Path, path: &Path) -> CoreResult<TreeNode> {
    let meta = std::fs::symlink_metadata(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if meta.is_dir() {
        Ok(TreeNode {
            kind: EntryKind::Folder,
            name,
            path: path.to_string_lossy().into_owned(),
            rel_path: rel_path(root, path),
            ext: None,
            children: Some(scan_dir(root, path, 0)?),
        })
    } else {
        Ok(TreeNode {
            kind: EntryKind::File,
            name,
            path: path.to_string_lossy().into_owned(),
            rel_path: rel_path(root, path),
            ext: path.extension().map(|e| e.to_string_lossy().to_lowercase()),
            children: None,
        })
    }
}

/// The file extensions the reader renders natively as Markdown, lowercased.
///
/// This is the SINGLE source of truth for the markdown-extension vocabulary. The
/// `#[cfg(test)]` generator below mirrors it into
/// `app/desktop/src/lib/bindings/markdownExtensions.ts`, which the TS client
/// (`app/desktop/src/workspace/fileMeta.ts`) consumes directly — so the tree,
/// reader, and client classification cannot silently diverge (the drift check in
/// `scripts/rust-quality-gate.sh` fails the build if the mirror goes stale).
pub const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];

/// True when `ext` is one of [`MARKDOWN_EXTENSIONS`]. The comparison is exact, so
/// `ext` MUST already be lowercased — every caller in this module builds it via
/// `to_lowercase()`, and the TS mirror lowercases identically, keeping the two
/// sides case-insensitive in lock-step.
pub fn is_markdown_ext(ext: Option<&str>) -> bool {
    ext.is_some_and(|e| MARKDOWN_EXTENSIONS.contains(&e))
}

/// Flatten every markdown file out of a scanned tree, in tree-walk order
/// (deterministic: folders-first, case-insensitive by name — the [`read_tree`]
/// sort). Consumers that start from `read_tree` + this helper inherit the scan
/// rules (hidden-dotdir skip, symlink skip, depth cap) by construction.
pub fn markdown_files(nodes: &[TreeNode]) -> Vec<&TreeNode> {
    let mut out = Vec::new();
    collect_markdown(nodes, &mut out);
    out
}

fn collect_markdown<'a>(nodes: &'a [TreeNode], out: &mut Vec<&'a TreeNode>) {
    for node in nodes {
        match &node.children {
            Some(children) => collect_markdown(children, out),
            None => {
                if is_markdown_ext(node.ext.as_deref()) {
                    out.push(node);
                }
            }
        }
    }
}

#[cfg(test)]
mod markdown_extension_tests {
    use super::*;

    /// The predicate accepts exactly the shared set — nothing more, nothing less.
    /// A change to [`MARKDOWN_EXTENSIONS`] that this predicate stops honouring
    /// (or vice versa) fails here, on the Rust side of the contract.
    #[test]
    fn is_markdown_ext_accepts_exactly_the_shared_set() {
        for ext in MARKDOWN_EXTENSIONS {
            assert!(is_markdown_ext(Some(ext)), "expected {ext} to be markdown");
        }
        for other in ["txt", "png", "pdf", "MD", "markdownx", ""] {
            assert!(
                !is_markdown_ext(Some(other)),
                "{other} must not be markdown"
            );
        }
        assert!(!is_markdown_ext(None));
    }

    /// Mirror [`MARKDOWN_EXTENSIONS`] into the frontend bindings dir as a runtime
    /// TS array, so `fileMeta.ts` consumes the SAME list the Rust core does. Named
    /// with `export` so it runs under `cargo test --workspace export` alongside the
    /// ts-rs type exports and the event-name generator; the drift check then fails
    /// the build if the committed mirror is stale — never a silent Rust↔TS split.
    ///
    /// Deterministic: a fixed template with the constant values interpolated, so a
    /// clean checkout + `cargo test` yields zero diff and a changed constant yields
    /// exactly one. Targets the same `../src/lib/bindings` dir as `event_names.rs`,
    /// resolved from this crate's manifest so it is independent of the test cwd.
    #[test]
    fn export_markdown_extension_bindings() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../app/desktop/src/lib/bindings");
        std::fs::create_dir_all(&dir).expect("create bindings dir");

        let items = MARKDOWN_EXTENSIONS
            .iter()
            .map(|e| format!("\"{e}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let contents = format!(
            "// This file was generated from the Rust `MARKDOWN_EXTENSIONS` constant \
             by `cargo test`\n// (crates/neuralnote-core/src/tree.rs). Do not edit \
             this file manually.\n\n\
             /** File extensions the reader renders natively as Markdown, lowercased.\n \
             *  The Rust core is the single source of truth; both sides consume this\n \
             *  list so the tree, reader, and client classification cannot diverge. */\n\
             export const MARKDOWN_EXTENSIONS = [{items}] as const;\n"
        );

        std::fs::write(dir.join("markdownExtensions.ts"), contents)
            .expect("write markdownExtensions.ts");
    }
}
