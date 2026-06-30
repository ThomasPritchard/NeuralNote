//! File and folder operations: create, rename, delete (to trash), move.
//! Every operation is vault-scoped and refuses to clobber an existing entry.

use crate::error::{CoreError, CoreResult};
use crate::model::TreeNode;
use crate::paths::{ensure_within, validate_name};
use crate::tree::node_for;
use std::path::{Path, PathBuf};

/// Canonical vault root (used as the base for `rel_path` in returned nodes).
fn canon_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))
}

/// Whether two existing paths resolve to the same on-disk entry. On a
/// case-insensitive filesystem (macOS APFS, default NTFS) `Todo.md` and `todo.md`
/// are one file, so a case-only rename must be allowed rather than refused as a
/// collision (PA-017).
fn is_same_entry(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(ca), Ok(cb)) if ca == cb)
}

/// Create an empty folder `name` inside `parent`.
pub fn create_folder(root: &Path, parent: &Path, name: &str) -> CoreResult<TreeNode> {
    validate_name(name)?;
    let parent = ensure_within(root, parent)?;
    let target = ensure_within(root, &parent.join(name.trim()))?;
    if target.exists() {
        return Err(CoreError::AlreadyExists(name.to_string()));
    }
    std::fs::create_dir(&target)?;
    node_for(&canon_root(root)?, &target)
}

/// Create an empty markdown note `name` inside `parent`. A `.md` extension is
/// added if the name has none.
pub fn create_note(root: &Path, parent: &Path, name: &str) -> CoreResult<TreeNode> {
    validate_name(name)?;
    let parent = ensure_within(root, parent)?;
    let file_name = ensure_md_extension(name.trim());
    let target = ensure_within(root, &parent.join(&file_name))?;
    if target.exists() {
        return Err(CoreError::AlreadyExists(file_name));
    }
    std::fs::write(&target, "")?;
    node_for(&canon_root(root)?, &target)
}

/// Rename a file or folder in place (keeps it in the same parent).
pub fn rename_entry(root: &Path, path: &Path, new_name: &str) -> CoreResult<TreeNode> {
    validate_name(new_name)?;
    let path = ensure_within(root, path)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::OutsideVault(path.display().to_string()))?;

    let current_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Preserve a markdown extension only on files that already had one — never
    // re-label a .png or .json as .md.
    let had_md = path
        .extension()
        .map(|e| crate::tree::is_markdown_ext(Some(&e.to_string_lossy().to_lowercase())))
        .unwrap_or(false);
    let final_name = if path.is_file() && had_md {
        ensure_md_extension(new_name.trim())
    } else {
        new_name.trim().to_string()
    };

    // Case-only rename of the same entry (`Todo.md` → `todo.md`): on a
    // case-insensitive FS `ensure_within` canonicalises the target back to the
    // current case (collapsing it to a no-op) and a direct rename is itself a
    // no-op, so the new case never lands. Detect it from the literal names and
    // delegate to the two-step temp rename (PA-017). Use a Unicode-aware lowercase
    // compare (not `eq_ignore_ascii_case`) so `café.md` → `CAFÉ.md` is caught too,
    // rather than silently no-opping.
    if final_name != current_name && final_name.to_lowercase() == current_name.to_lowercase() {
        return apply_case_only_rename(root, &path, parent, &final_name);
    }

    let target = ensure_within(root, &parent.join(&final_name))?;
    if target == path {
        return node_for(&canon_root(root)?, &path); // exact no-op rename
    }
    if target.exists() {
        return Err(CoreError::AlreadyExists(final_name));
    }
    std::fs::rename(&path, &target)?;
    node_for(&canon_root(root)?, &target)
}

/// Apply a case-only rename (`Todo.md` → `todo.md`) via a two-step rename through
/// a hidden temp name, so the new case actually lands on a case-insensitive
/// filesystem (where a direct same-name rename is a no-op). Extracted from
/// `rename_entry` to keep that function's branching within complexity limits.
fn apply_case_only_rename(
    root: &Path,
    path: &Path,
    parent: &Path,
    final_name: &str,
) -> CoreResult<TreeNode> {
    let final_target = parent.join(final_name);
    if final_target.exists() && !is_same_entry(path, &final_target) {
        // A genuinely different file already holds that name (case-sensitive FS).
        return Err(CoreError::AlreadyExists(final_name.to_string()));
    }
    let tmp = parent.join(format!(
        ".{final_name}.{}.nn-caserename",
        std::process::id()
    ));
    std::fs::rename(path, &tmp)?;
    if let Err(e) = std::fs::rename(&tmp, &final_target) {
        // Restore the original name. If that ALSO fails the entry is stranded
        // under a hidden temp — never leave that silent: name its location so
        // the user/logs can recover it rather than seeing it vanish.
        return match std::fs::rename(&tmp, path) {
            Ok(()) => Err(e.into()),
            Err(restore_err) => Err(CoreError::Io(format!(
                "rename failed ({e}) and the original name could not be restored \
                 ({restore_err}); the file is intact at {}",
                tmp.display()
            ))),
        };
    }
    node_for(&canon_root(root)?, &final_target)
}

/// Move a file or folder to `new_parent`, keeping its name. Refuses to move a
/// folder into its own descendant.
pub fn move_entry(root: &Path, path: &Path, new_parent: &Path) -> CoreResult<TreeNode> {
    let path = ensure_within(root, path)?;
    let new_parent = ensure_within(root, new_parent)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    if !new_parent.is_dir() {
        return Err(CoreError::NotFound(new_parent.display().to_string()));
    }
    // Block moving a folder into itself or a descendant.
    if new_parent == path || new_parent.starts_with(&path) {
        return Err(CoreError::InvalidName(
            "cannot move a folder into itself".into(),
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| CoreError::InvalidName(path.display().to_string()))?;
    let target = ensure_within(root, &new_parent.join(name))?;
    if target == path {
        return node_for(&canon_root(root)?, &path); // already there
    }
    if target.exists() {
        return Err(CoreError::AlreadyExists(
            name.to_string_lossy().into_owned(),
        ));
    }
    std::fs::rename(&path, &target)?;
    node_for(&canon_root(root)?, &target)
}

/// Delete a file or folder by moving it to the OS trash — recoverable, never a
/// permanent `remove`. A wrong delete should always be undoable.
pub fn delete_entry(root: &Path, path: &Path) -> CoreResult<()> {
    let path = ensure_within(root, path)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    trash::delete(&path)?;
    Ok(())
}

/// Ensure a note file name ends in a markdown extension (defaults to `.md`).
fn ensure_md_extension(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx") {
        name.to_string()
    } else {
        format!("{name}.md")
    }
}
