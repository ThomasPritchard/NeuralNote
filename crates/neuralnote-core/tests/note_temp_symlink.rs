//! The note write path must never write *through* a symlink squatting the temp
//! sibling it renames into place (issue #193).
//!
//! `write_note` builds that temp name from the process id and a process-lifetime
//! counter that starts at zero, so the FIRST `write_note` call in a process uses
//! sequence 0 and its temp name is exactly predictable from outside the crate.
//! That predictability is the vulnerability, and it is also what makes this test
//! possible — but only while the sequence really is 0.
//!
//! Which is why this is a dedicated test binary: it must contain exactly ONE call
//! to `write_note`, directly or indirectly. Add a second and the counter moves on,
//! the planted symlink is never reached, and the test goes quietly green while
//! crossing nothing. (`crates/neuralnote-core/src/config_io.rs` solves the same
//! problem for its own temp file by reading the counter from inside the crate.)

#[cfg(unix)]
#[test]
fn a_symlink_squatting_the_temp_sibling_is_skipped_without_being_written_through() {
    use neuralnote_core::note::write_note;
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), "outside stays intact").unwrap();

    let note = vault.path().join("Note.md");
    std::fs::write(&note, "original").unwrap();

    // Sequence 0: this is the first (and only) write_note call in this binary.
    let temp = vault
        .path()
        .join(format!(".Note.md.{}.0.nn-tmp", std::process::id()));
    symlink(outside.path(), &temp).unwrap();

    let doc = write_note(vault.path(), &note, "saved content", None).unwrap();

    assert_eq!(
        std::fs::read_to_string(outside.path()).unwrap(),
        "outside stays intact",
        "the note content was written through the squatting symlink"
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "saved content");
    assert_eq!(doc.raw, "saved content");
}
