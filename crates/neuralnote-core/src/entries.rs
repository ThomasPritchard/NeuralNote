//! File and folder operations: create, rename, delete (to trash), move.
//! Every operation is vault-scoped and refuses to clobber an existing entry.

use crate::error::{CoreError, CoreResult};
use crate::model::TreeNode;
use crate::paths::{ensure_descendant, ensure_within, validate_name};
use crate::tree::node_for;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static CASE_RENAME_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const MAX_CASE_RENAME_ATTEMPTS: usize = 32;

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

/// Reserve a private hidden directory for the two-step case-only rename. Creation
/// is exclusive, so a stale path or concurrent rename is never reused as staging.
fn reserve_case_rename_stage(parent: &Path, final_name: &str) -> CoreResult<(PathBuf, PathBuf)> {
    for attempt in 0..MAX_CASE_RENAME_ATTEMPTS {
        let stage_name = if attempt == 0 {
            format!(".{final_name}.{}.nn-caserename", std::process::id())
        } else {
            let sequence = CASE_RENAME_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            format!(
                ".{final_name}.{}.{sequence}.nn-caserename",
                std::process::id()
            )
        };
        let stage_dir = parent.join(stage_name);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&stage_dir) {
            Ok(()) => {
                #[cfg(unix)]
                if let Err(error) =
                    std::fs::set_permissions(&stage_dir, std::fs::Permissions::from_mode(0o700))
                {
                    remove_case_rename_stage(&stage_dir);
                    return Err(error.into());
                }
                return Ok((stage_dir.clone(), stage_dir.join("entry")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(CoreError::Io(
        "could not rename entry: no unique staging directory was available".into(),
    ))
}

/// Remove an empty staging directory without making a committed rename look like
/// a failure. Cleanup problems remain visible in the native log.
fn remove_case_rename_stage(stage_dir: &Path) {
    if let Err(error) = std::fs::remove_dir(stage_dir) {
        log::warn!(
            "entries: could not remove case-rename staging directory {}: {error}",
            stage_dir.display()
        );
    }
}

/// Move the source into its reserved staging directory, then to its final case.
/// On the second failure, restore the original path and report any stranded copy.
fn commit_case_only_rename(
    source: &Path,
    stage_dir: &Path,
    staged_entry: &Path,
    final_target: &Path,
) -> CoreResult<()> {
    if let Err(error) = std::fs::rename(source, staged_entry) {
        remove_case_rename_stage(stage_dir);
        return Err(error.into());
    }
    if let Err(error) = std::fs::rename(staged_entry, final_target) {
        return Err(restore_case_only_rename(
            staged_entry,
            source,
            stage_dir,
            error,
        ));
    }
    remove_case_rename_stage(stage_dir);
    Ok(())
}

/// Restore a staged entry after the final case-only rename failed.
fn restore_case_only_rename(
    staged_entry: &Path,
    source: &Path,
    stage_dir: &Path,
    rename_error: std::io::Error,
) -> CoreError {
    match std::fs::rename(staged_entry, source) {
        Ok(()) => {
            remove_case_rename_stage(stage_dir);
            rename_error.into()
        }
        Err(restore_error) => CoreError::Io(format!(
            "rename failed ({rename_error}) and the original name could not be restored \
             ({restore_error}); the entry is intact at {}",
            staged_entry.display()
        )),
    }
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
    // `create_new` is `O_CREAT|O_EXCL`, which POSIX requires to fail `EEXIST` on a
    // symlink — dangling or not — so the note can never be created THROUGH a link
    // planted at this name (issue #193). It is also the clobber refusal itself:
    // a separate `exists()` pre-check would only widen a check-then-create window,
    // and `exists()` follows symlinks, so it reports `false` for the dangling link
    // that is exactly the case being defended against.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CoreError::AlreadyExists(file_name));
        }
        Err(error) => return Err(error.into()),
    }
    node_for(&canon_root(root)?, &target)
}

/// Rename a file or folder in place (keeps it in the same parent).
pub fn rename_entry(root: &Path, path: &Path, new_name: &str) -> CoreResult<TreeNode> {
    validate_name(new_name)?;
    // `ensure_descendant`, not `ensure_within`: the vault root is contained in
    // itself, and renaming it moves the vault inside the user's filesystem —
    // the case-only branch below would do it *outside* the boundary entirely.
    let path = ensure_descendant(root, path)?;
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
    let response = crate::tree::node_for_destination(&canon_root(root)?, &path, &target)?;
    std::fs::rename(&path, &target)?;
    Ok(response)
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
    // Both renames below run in `parent`, which is derived from the target rather
    // than from the vault. Prove *the parent* is contained, then join onto that —
    // these are the only writes in this module no `ensure_within` stands in front
    // of, and for a vault-root target `parent` is outside the vault entirely.
    //
    // The check has to land on the parent rather than on the joined path: leaf
    // names here differ from what is on disk only by case, and `ensure_within`
    // canonicalises, which on a case-insensitive filesystem normalises the new
    // casing straight back to the old one and collapses the rename to a no-op.
    // `final_name` is separator-free (`validate_name`), so a contained parent
    // makes the join contained too.
    let parent = ensure_within(root, parent)?;
    let final_target = parent.join(final_name);
    if final_target.exists() && !is_same_entry(path, &final_target) {
        // A genuinely different file already holds that name (case-sensitive FS).
        return Err(CoreError::AlreadyExists(final_name.to_string()));
    }
    let canonical_root = canon_root(root)?;
    let response = crate::tree::node_for_destination(&canonical_root, path, &final_target)?;
    let (stage_dir, staged_entry) = reserve_case_rename_stage(&parent, final_name)?;
    commit_case_only_rename(path, &stage_dir, &staged_entry, &final_target)?;
    Ok(response)
}

/// Move a file or folder to `new_parent`, keeping its name. Refuses to move a
/// folder into its own descendant, and refuses to move the vault root at all.
pub fn move_entry(root: &Path, path: &Path, new_parent: &Path) -> CoreResult<TreeNode> {
    // `ensure_descendant` on what is being moved, `ensure_within` on where it is
    // going: the vault root is a legitimate *destination* but never a legitimate
    // thing to relocate. Containment alone admits the root (it is contained in
    // itself), and the self-move branch below only catches a root `path` by
    // coincidence — `new_parent` is already proven inside the root, so
    // `starts_with` is trivially true there. Naming the boundary here keeps the
    // refusal when that branch is narrowed (issue #194).
    let path = ensure_descendant(root, path)?;
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
    let response = crate::tree::node_for_destination(&canon_root(root)?, &path, &target)?;
    std::fs::rename(&path, &target)?;
    Ok(response)
}

/// Delete a file or folder by moving it to the OS trash — recoverable, never a
/// permanent `remove`. A wrong delete is always recoverable from the system
/// Trash.
///
/// On macOS "recoverable" means dragging the note out of the Trash, not Finder's
/// one-click "Put Back": the delete method chosen below does not record the
/// origin path. That cost is accepted deliberately — see the comment on the
/// macOS branch.
pub fn delete_entry(root: &Path, path: &Path) -> CoreResult<()> {
    // `ensure_descendant`, not `ensure_within`: the root passes containment, and
    // deleting it would move the user's entire vault to the Trash on one IPC call.
    let path = ensure_descendant(root, path)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.display().to_string()));
    }
    // Do NOT collapse this branch back to `trash::delete` (issue #159).
    //
    // `trash`'s macOS default is `DeleteMethod::Finder`, which shells out to
    // `osascript` and asks Finder to do the delete. When Finder refuses — a
    // read-only parent directory, say — `osascript` does not fail; it returns
    // when the Apple Event times out. Measured on Darwin 24.6.0: 120.1 s, during
    // which the whole app is unresponsive because this call runs synchronously
    // under the vault mutation mutex.
    //
    // `NsFileManager` uses `trashItemAtURL` and fails immediately instead:
    // 21.8 ms for the same refusal, and a successful delete still lands in
    // ~/.Trash. Two costs come with it, both accepted:
    //   - no Finder "Put Back" entry, so restoring is a drag out of the Trash;
    //   - a different `trash::Error` variant (`Unknown` rather than `Os`), which
    //     `CoreError::from` maps identically, so no caller sees the change.
    // It also removes a failure class: the Finder path needs macOS Automation
    // permission, so a user who denied that prompt had every delete fail.
    #[cfg(target_os = "macos")]
    {
        // The `use` must stay inside this block: `trash::macos` is itself gated
        // on macOS, so a top-of-file import breaks the Linux and Windows builds.
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::new();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(&path)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(&path)?;
    }
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

#[cfg(test)]
mod case_rename_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn reserved_case_rename_stage_has_mode_0700() {
        let parent = tempfile::tempdir().unwrap();
        let (stage_dir, staged_entry) =
            reserve_case_rename_stage(parent.path(), "renamed.md").unwrap();

        assert_eq!(
            std::fs::metadata(&stage_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!staged_entry.exists());
        std::fs::remove_dir(stage_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_move_into_the_stage_keeps_the_original_and_cleans_the_directory() {
        let probe = tempfile::NamedTempFile::new().unwrap();
        std::fs::set_permissions(probe.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(probe.path()).is_ok() {
            return;
        }

        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("original.md");
        let final_target = parent.path().join("renamed.md");
        let stage_dir = parent.path().join(".stage");
        let staged_entry = stage_dir.join("entry");
        std::fs::write(&source, "source contents").unwrap();
        std::fs::create_dir(&stage_dir).unwrap();
        std::fs::set_permissions(&stage_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let error = commit_case_only_rename(&source, &stage_dir, &staged_entry, &final_target)
            .expect_err("the read-only staging directory must reject the first rename");

        assert!(matches!(error, CoreError::Io(_) | CoreError::NotFound(_)));
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "source contents");
        assert!(!stage_dir.exists());
        assert!(!final_target.exists());
    }

    #[test]
    fn a_failed_final_rename_restores_the_original_and_cleans_the_stage() {
        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("original.md");
        let final_target = parent.path().join("missing-parent").join("blocked");
        let stage_dir = parent.path().join(".stage");
        let staged_entry = stage_dir.join("entry");
        std::fs::create_dir(&stage_dir).unwrap();
        std::fs::write(&source, "source contents").unwrap();

        let error = commit_case_only_rename(&source, &stage_dir, &staged_entry, &final_target)
            .expect_err("the final rename has no destination parent");

        assert!(matches!(error, CoreError::NotFound(_)));
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "source contents");
        assert!(!stage_dir.exists());
        assert!(!final_target.exists());
    }

    #[test]
    fn a_failed_restore_reports_where_the_staged_entry_remains() {
        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("original");
        let stage_dir = parent.path().join(".stage");
        let staged_entry = stage_dir.join("entry");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&stage_dir).unwrap();
        std::fs::write(&staged_entry, "recoverable source").unwrap();

        let error = restore_case_only_rename(
            &staged_entry,
            &source,
            &stage_dir,
            std::io::Error::other("simulated final rename failure"),
        );

        assert!(
            error
                .to_string()
                .contains(&staged_entry.to_string_lossy().to_string()),
            "the recovery path was omitted: {error}"
        );
        assert_eq!(
            std::fs::read_to_string(&staged_entry).unwrap(),
            "recoverable source"
        );
    }
}
