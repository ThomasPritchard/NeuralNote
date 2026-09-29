//! Filesystem regressions for bounded, atomic note saves.

use neuralnote_core::note::{read_note, write_note, MAX_EDITABLE_NOTE_BYTES};
use neuralnote_core::CoreError;
use std::fs::{self, File};

#[cfg(unix)]
#[test]
fn saving_an_existing_private_note_preserves_its_mode() {
    use std::os::unix::fs::PermissionsExt;

    let vault = tempfile::tempdir().unwrap();
    let note = vault.path().join("private.md");
    fs::write(&note, "private draft").unwrap();
    fs::set_permissions(&note, fs::Permissions::from_mode(0o600)).unwrap();

    write_note(vault.path(), &note, "updated private draft", None).unwrap();

    let saved_mode = fs::metadata(&note).unwrap().permissions().mode() & 0o7777;
    assert_eq!(
        saved_mode, 0o600,
        "atomic replacement broadened a private note"
    );
    assert_eq!(fs::read_to_string(&note).unwrap(), "updated private draft");
}

#[test]
fn an_oversized_external_replacement_conflicts_without_disabling_explicit_overwrite() {
    let vault = tempfile::tempdir().unwrap();
    let note = vault.path().join("editable.md");
    fs::write(&note, "initial text").unwrap();
    let opened = read_note(vault.path(), &note).unwrap();

    let mut replacement = File::create(&note).unwrap();
    use std::io::Write;
    replacement
        .write_all(b"external oversized replacement")
        .unwrap();
    replacement
        .set_len(MAX_EDITABLE_NOTE_BYTES as u64 + 1)
        .unwrap();
    drop(replacement);

    let error = write_note(
        vault.path(),
        &note,
        "the retained editor draft",
        Some(opened.content_hash),
    )
    .expect_err("saving a stale draft must conflict when the disk file exceeds the cap");
    assert!(
        matches!(&error, CoreError::Conflict(message)
            if message.contains("editable") && message.contains(&MAX_EDITABLE_NOTE_BYTES.to_string())),
        "expected an explicit size-related conflict, got {error:?}"
    );
    assert_eq!(
        fs::metadata(&note).unwrap().len(),
        MAX_EDITABLE_NOTE_BYTES as u64 + 1,
        "the failed save changed the external file"
    );

    write_note(vault.path(), &note, "user chose overwrite", None)
        .expect("explicit overwrite must retain its existing behavior");
    assert_eq!(fs::read_to_string(&note).unwrap(), "user chose overwrite");
}
