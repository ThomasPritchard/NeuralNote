//! Path safety — the security spine. Every command that touches a path runs it
//! through [`ensure_within`] first, so nothing can read, write, or delete outside
//! the open vault, even via `..` segments or symlinks.

use crate::error::{CoreError, CoreResult};
use std::path::{Path, PathBuf};

/// Resolve `target` to a real absolute path and prove it lives inside `root`.
///
/// - Existing targets are `canonicalize`d (resolves `..` and follows symlinks),
///   then checked against the canonical root.
/// - Non-existent targets (e.g. a file about to be created) have their *parent*
///   canonicalised and containment-checked, then the leaf name is rejoined.
///
/// Returns the resolved path on success, or [`CoreError::OutsideVault`].
pub fn ensure_within(root: &Path, target: &Path) -> CoreResult<PathBuf> {
    let root_c = root
        .canonicalize()
        .map_err(|e| CoreError::Io(format!("vault root unreadable: {e}")))?;

    let resolved = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Target doesn't exist yet: validate via its parent.
            let parent = target
                .parent()
                .ok_or_else(|| CoreError::OutsideVault(target.display().to_string()))?;
            let parent_c = parent
                .canonicalize()
                .map_err(|_| CoreError::NotFound(parent.display().to_string()))?;
            let name = target
                .file_name()
                .ok_or_else(|| CoreError::InvalidName(target.display().to_string()))?;
            parent_c.join(name)
        }
    };

    if resolved == root_c || resolved.starts_with(&root_c) {
        Ok(resolved)
    } else {
        Err(CoreError::OutsideVault(target.display().to_string()))
    }
}

/// Reject names that are empty, navigational, separator-bearing, or contain
/// control characters — anything that could break out of the intended folder.
pub fn validate_name(name: &str) -> CoreResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidName("name cannot be empty".into()));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CoreError::InvalidName(format!("'{name}' is not allowed")));
    }
    // A leading dot would make the entry hidden (the tree filters dotfiles, as
    // Obsidian does), so it would silently vanish from the sidebar with no way to
    // reopen it. Refuse it loudly instead of hiding the user's content.
    if trimmed.starts_with('.') {
        return Err(CoreError::InvalidName(
            "name cannot start with a dot (it would be hidden from the vault)".into(),
        ));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(CoreError::InvalidName(
            "name cannot contain path separators".into(),
        ));
    }
    if name.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(CoreError::InvalidName(
            "name contains invalid characters".into(),
        ));
    }
    Ok(())
}

/// The `rel_path` (vault-relative, `/`-joined) for a resolved absolute path.
/// Falls back to the file name if `abs` is somehow not under `root`.
pub fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .ok()
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            abs.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}
