//! Error-path and edge-case coverage for the vault entry operations
//! (`create_folder` / `create_note` / `rename_entry` / `move_entry` /
//! `delete_entry`). This file targets the refusal branches that keep the vault
//! safe: clobber refusal, missing targets, folder-into-descendant moves, and the
//! trash-backed delete. The successful-delete path reaches the real OS Trash, so
//! it is `#[ignore]`d at the bottom of this file rather than covered here.

use std::fs;
use std::path::Path;
use std::time::Instant;

use neuralnote_core::entries::{
    create_folder, create_note, delete_entry, move_entry, rename_entry,
};

fn vault() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn create_refuses_to_clobber_an_existing_folder_or_note() {
    let vault = vault();
    create_folder(vault.path(), vault.path(), "Projects").unwrap();
    create_note(vault.path(), vault.path(), "Ideas").unwrap();

    assert!(create_folder(vault.path(), vault.path(), "Projects").is_err());
    assert!(create_note(vault.path(), vault.path(), "Ideas").is_err());
}

#[test]
fn create_note_appends_the_markdown_extension_only_when_missing() {
    let vault = vault();

    let bare = create_note(vault.path(), vault.path(), "Journal").unwrap();
    let kept = create_note(vault.path(), vault.path(), "Notes.markdown").unwrap();

    assert_eq!(bare.name, "Journal.md");
    assert_eq!(kept.name, "Notes.markdown");
}

#[test]
fn renaming_a_missing_entry_reports_not_found() {
    let vault = vault();

    let error = rename_entry(vault.path(), &vault.path().join("ghost.md"), "real.md").unwrap_err();

    assert!(error.to_string().contains("not found"));
}

#[test]
fn renaming_a_folder_does_not_graft_on_a_markdown_extension() {
    let vault = vault();
    create_folder(vault.path(), vault.path(), "Docs").unwrap();

    let node = rename_entry(vault.path(), &vault.path().join("Docs"), "Papers").unwrap();

    assert_eq!(node.name, "Papers");
    assert!(vault.path().join("Papers").is_dir());
}

#[test]
fn renaming_a_non_markdown_file_preserves_its_own_extension() {
    let vault = vault();
    fs::write(vault.path().join("diagram.png"), b"binary").unwrap();

    let node = rename_entry(vault.path(), &vault.path().join("diagram.png"), "chart").unwrap();

    // A `.png` must never be re-labelled `.md`, and no extension is invented.
    assert_eq!(node.name, "chart");
}

#[test]
fn renaming_a_note_to_its_own_name_is_a_no_op() {
    let vault = vault();
    create_note(vault.path(), vault.path(), "Keep.md").unwrap();

    let node = rename_entry(vault.path(), &vault.path().join("Keep.md"), "Keep").unwrap();

    assert_eq!(node.name, "Keep.md");
    assert!(vault.path().join("Keep.md").is_file());
}

#[test]
fn renaming_onto_an_existing_sibling_is_refused() {
    let vault = vault();
    create_note(vault.path(), vault.path(), "First.md").unwrap();
    create_note(vault.path(), vault.path(), "Second.md").unwrap();

    let error = rename_entry(vault.path(), &vault.path().join("First.md"), "Second").unwrap_err();

    assert!(error.to_string().contains("already exists"));
}

#[test]
fn moving_a_missing_entry_reports_not_found() {
    let vault = vault();
    create_folder(vault.path(), vault.path(), "Dest").unwrap();

    let error = move_entry(
        vault.path(),
        &vault.path().join("ghost.md"),
        &vault.path().join("Dest"),
    )
    .unwrap_err();

    assert!(error.to_string().contains("not found"));
}

#[test]
fn moving_into_a_non_directory_target_reports_not_found() {
    let vault = vault();
    create_note(vault.path(), vault.path(), "Note.md").unwrap();
    create_note(vault.path(), vault.path(), "NotAFolder.md").unwrap();

    let error = move_entry(
        vault.path(),
        &vault.path().join("Note.md"),
        &vault.path().join("NotAFolder.md"),
    )
    .unwrap_err();

    assert!(error.to_string().contains("not found"));
}

#[test]
fn moving_an_entry_into_its_current_parent_is_a_no_op() {
    let vault = vault();
    create_note(vault.path(), vault.path(), "Stay.md").unwrap();

    let node = move_entry(vault.path(), &vault.path().join("Stay.md"), vault.path()).unwrap();

    assert_eq!(node.name, "Stay.md");
    assert!(vault.path().join("Stay.md").is_file());
}

#[test]
fn moving_onto_an_existing_entry_in_the_target_is_refused() {
    let vault = vault();
    create_folder(vault.path(), vault.path(), "Dest").unwrap();
    create_note(vault.path(), vault.path(), "Clash.md").unwrap();
    create_note(vault.path(), &vault.path().join("Dest"), "Clash.md").unwrap();

    let error = move_entry(
        vault.path(),
        &vault.path().join("Clash.md"),
        &vault.path().join("Dest"),
    )
    .unwrap_err();

    assert!(error.to_string().contains("already exists"));
}

#[test]
fn moving_a_folder_into_its_own_descendant_is_refused() {
    let vault = vault();
    create_folder(vault.path(), vault.path(), "Parent").unwrap();
    create_folder(vault.path(), &vault.path().join("Parent"), "Child").unwrap();

    let error = move_entry(
        vault.path(),
        &vault.path().join("Parent"),
        &vault.path().join("Parent/Child"),
    )
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("cannot move a folder into itself"));
}

/// Whether the temp filesystem distinguishes `A` from `a` in file names. macOS
/// APFS and default Windows NTFS are case-insensitive, so the case-collision
/// branch below cannot exist there and the test is skipped.
fn filesystem_is_case_sensitive(dir: &Path) -> bool {
    let lower = dir.join("case-probe");
    fs::write(&lower, "x").unwrap();
    let distinct = !dir.join("CASE-PROBE").exists();
    fs::remove_file(&lower).unwrap();
    distinct
}

#[test]
fn a_case_only_rename_onto_a_distinct_existing_file_is_refused() {
    let vault = vault();
    if !filesystem_is_case_sensitive(vault.path()) {
        return; // On a case-insensitive FS the two names are one file.
    }
    // Two genuinely different files whose names differ only in case. Renaming one
    // onto the other's name must be refused, not silently clobber it.
    fs::write(vault.path().join("Todo.md"), "todo").unwrap();
    fs::write(vault.path().join("TODO.md"), "other").unwrap();

    let error = rename_entry(vault.path(), &vault.path().join("Todo.md"), "TODO.md").unwrap_err();

    assert!(error.to_string().contains("already exists"));
    assert_eq!(
        fs::read_to_string(vault.path().join("TODO.md")).unwrap(),
        "other"
    );
}

#[test]
fn a_case_only_rename_lands_the_new_casing() {
    let vault = vault();
    fs::write(vault.path().join("Todo.md"), "todo").unwrap();

    let node = rename_entry(vault.path(), &vault.path().join("Todo.md"), "todo.md").unwrap();

    assert_eq!(node.name, "todo.md");
    assert_eq!(
        fs::read_to_string(vault.path().join("todo.md")).unwrap(),
        "todo"
    );
}

/// The filesystem root is the one path with no parent to rename within. It is
/// only reachable when the vault root *is* `/`, but a caller that opened one must
/// get a refusal rather than an unwrap on the missing parent.
#[cfg(unix)]
#[test]
fn renaming_the_vault_root_itself_is_refused() {
    let root = Path::new("/");

    let error = rename_entry(root, root, "renamed-root").unwrap_err();

    assert!(
        error.to_string().contains("outside vault"),
        "unexpected error: {error}"
    );
}

#[test]
fn deleting_a_missing_entry_reports_not_found() {
    let vault = vault();

    let error = delete_entry(vault.path(), &vault.path().join("ghost.md")).unwrap_err();

    assert!(error.to_string().contains("not found"));
}

/// True when the filesystem enforces the restrictive permission bits the delete
/// test below relies on (running as root bypasses them).
#[cfg(unix)]
fn permission_restrictions_apply() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let file = tempfile::NamedTempFile::new().unwrap();
    fs::set_permissions(file.path(), fs::Permissions::from_mode(0o000)).unwrap();
    fs::read(file.path()).is_err()
}

/// A delete the OS refuses must surface as an error and leave the note in place.
/// Reporting success would tell the UI to drop a note from the tree that is still
/// on disk — content lost from the user's view without being lost from the vault.
///
/// It must also refuse *promptly*. This ran on every unix except macOS until
/// #159: there `trash::delete` asked Finder over AppleScript, and a refusal
/// returned only when the Apple Event timed out — a measured 120.1 s, during
/// which the app was unresponsive. `DeleteMethod::NsFileManager` fails
/// immediately instead (21.8 ms measured on Darwin 24.6.0), so macOS runs this
/// too.
///
/// The elapsed-time bound is the half that pins #159: the error and
/// note-survives assertions were both satisfied *during* the two-minute hang, so
/// they cannot tell a fast refusal from a slow one. The bound is deliberately
/// loose — three orders of magnitude above the measured cost, an order of
/// magnitude below the Apple Event timeout — so it stays quiet on a loaded
/// shared runner while still separating the two unambiguously.
///
/// Swapping the macOS branch back to `DeleteMethod::Finder` was verified to fail
/// this test. Note it failed on the note-survives assertion rather than the
/// bound: with a read-only parent, Finder completed the delete in ~3.5 s instead
/// of refusing it, which is a second reason not to go back — #159 measured that
/// same configuration refusing after 120.1 s, so Finder's outcome here is not
/// even consistent.
#[cfg(unix)]
#[test]
fn a_delete_the_os_refuses_surfaces_an_error_and_keeps_the_note() {
    use std::os::unix::fs::PermissionsExt;

    if !permission_restrictions_apply() {
        return;
    }
    let vault = vault();
    let locked = vault.path().join("locked");
    fs::create_dir(&locked).unwrap();
    let note = locked.join("stays.md");
    fs::write(&note, "still here").unwrap();
    // Trashing has to unlink the entry from its parent. A read-only folder blocks
    // that on every unix, which is the refusal this test turns on. The unreadable
    // note additionally blocks the freedesktop copy-then-remove fallback, so on
    // Linux nothing reaches the real Trash either; macOS has no such fallback and
    // fails at the unlink.
    fs::set_permissions(&note, fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();

    let started = Instant::now();
    let result = delete_entry(vault.path(), &note);
    let elapsed = started.elapsed();

    // Best-effort cleanup, before any assertion. Unwrapping here would panic on
    // the *cleanup* and bury whichever assertion below actually failed — and the
    // note is legitimately absent in exactly the failure we most want reported.
    let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o755));
    let _ = fs::set_permissions(&note, fs::Permissions::from_mode(0o644));

    assert!(
        note.exists(),
        "the note was removed from the vault by a delete the OS should have \
         refused; a delete that cannot be completed must leave the note in place"
    );
    let error = result.expect_err("a refused delete must report an error, not success");
    assert!(
        error.to_string().contains("could not move to trash"),
        "unexpected error: {error}"
    );
    assert_eq!(fs::read_to_string(&note).unwrap(), "still here");
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "a refused delete took {elapsed:?}; it must fail fast rather than block \
         the caller on an Apple Event timeout (see #159)"
    );
}

// Opt-in: `delete_entry` moves the file to the *real* OS Trash — neither the
// Finder nor the NsFileManager path has a sandbox — so running this deposits a
// file in the developer's ~/.Trash and would pollute CI. Ignored by default; run
// explicitly with `cargo test -p neuralnote-core -- --ignored deleting_an_entry`.
#[test]
#[ignore = "moves a real file to the OS Trash; opt-in to avoid polluting ~/.Trash and CI"]
fn deleting_an_entry_removes_it_from_the_vault() {
    let vault = vault();
    let note = vault.path().join("trash-me.md");
    fs::write(&note, "goodbye").unwrap();

    delete_entry(vault.path(), &note).unwrap();

    // Delete moves to the OS trash (recoverable) rather than unlinking, but from
    // the vault's point of view the entry is gone.
    assert!(!Path::new(&note).exists());
}
