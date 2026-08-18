//! Running out of temp names on the note write path must fail loudly.
//!
//! Skipping a squatted temp name keeps a normal save working when something is
//! sitting on the predictable name (issue #193), but the retry is bounded — and a
//! save that cannot find a free name must say so rather than silently doing
//! nothing. Like `note_temp_symlink.rs` this is a dedicated test binary so the
//! process-lifetime sequence is still 0 when the squatting names are planted:
//! exactly ONE `write_note` call may live here.

/// Mirrors `note::MAX_TEMP_ATTEMPTS` (private). If they ever drift, the write
/// below finds a free name and succeeds, and `unwrap_err` fails this test loudly.
const MAX_TEMP_ATTEMPTS: u64 = 32;

#[test]
fn exhausting_the_temp_name_attempts_is_an_explicit_failure() {
    use neuralnote_core::note::write_note;

    let vault = tempfile::tempdir().unwrap();
    let note = vault.path().join("Note.md");
    std::fs::write(&note, "original").unwrap();

    for sequence in 0..MAX_TEMP_ATTEMPTS {
        std::fs::write(
            vault
                .path()
                .join(format!(".Note.md.{}.{sequence}.nn-tmp", std::process::id())),
            "occupied",
        )
        .unwrap();
    }

    let error = write_note(vault.path(), &note, "saved content", None).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("no unique temporary file was available"),
        "exhaustion must name itself, got {error}"
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original");
}
