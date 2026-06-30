//! Vault file-tree scanning.

use crate::error::CoreResult;
use crate::model::{EntryKind, TreeNode};
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

/// Markdown file extensions the reader renders natively.
// TODO(PA-029): this predicate (and the `.md`/`.markdown`/`.mdx` set) is mirrored
// independently in the TS client (`app/desktop/src/lib/fileMeta.ts`). They agree
// today but can silently diverge. Deferred: expose this set from the core as the
// single source of truth (e.g. a generated shared constant) when next touched.
pub fn is_markdown_ext(ext: Option<&str>) -> bool {
    matches!(ext, Some("md") | Some("markdown") | Some("mdx"))
}
