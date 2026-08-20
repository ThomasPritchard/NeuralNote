//! Unit coverage for the note write path's temp sibling, and for the body-line
//! geometry every citation is measured against.
//!
//! The temp-sibling guards live *in* the crate on purpose. `TMP_SEQ` is private
//! to `note.rs`, so a test outside it can only guess which name a save will try —
//! the two standalone binaries this file replaces guessed sequence 0, which held
//! only while each contained exactly one save, a condition nothing but a comment
//! enforced. Read live, the counter needs no such promise, and these guards can
//! share the lib test binary with its other `write_note` call sites, one of which
//! saves from eight threads at once.

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use super::*;
use crate::temp_sibling::MAX_TEMP_ATTEMPTS;

/// The temp sibling [`create_temp_sibling`] builds for `file_name` at `sequence`.
/// Mirrors its format string — the single thing these tests know about the name,
/// and the reason they sit beside the code that owns it.
fn temp_sibling(parent: &Path, file_name: &str, sequence: u64) -> PathBuf {
    parent.join(format!(
        ".{file_name}.{}.{sequence}.nn-tmp",
        std::process::id()
    ))
}

/// How many consecutive temp names the guards below occupy, starting at whatever
/// the live counter reads.
///
/// A save walks [`MAX_TEMP_ATTEMPTS`] names from wherever `TMP_SEQ` stands when it
/// runs, and other threads in this binary move that counter while the band is
/// being planted. Eight windows wide, the band absorbs seven windows of that
/// interference — 224 competing saves landing inside the microseconds it takes to
/// plant it — and the save's whole window still falls on squatted names.
///
/// Exceeding even that is not a false pass: the save would find a free name and
/// SUCCEED, which is exactly what both guards assert against. Drift can turn
/// these tests red; it cannot make them pass while proving nothing.
const SQUATTED_BAND: u64 = MAX_TEMP_ATTEMPTS as u64 * 8;

/// Every temp name a save of `file_name` in `parent` can reach, lowest first.
fn temp_name_band(parent: &Path, file_name: &str) -> Vec<PathBuf> {
    let first = TMP_SEQ.load(Ordering::Relaxed);
    (first..first + SQUATTED_BAND)
        .map(|sequence| temp_sibling(parent, file_name, sequence))
        .collect()
}

/// A symlink squatting the temp sibling a save renames into place must never be
/// opened *through*. The plain `std::fs::write` this path used followed such a
/// link and truncated whatever it pointed at, outside the vault entirely (issue
/// #193).
///
/// Exhaustion is this test's WITNESS, not merely its outcome. A save gives up
/// only once every one of its [`MAX_TEMP_ATTEMPTS`] names is taken, and every
/// name it can reach here is one of these symlinks — so arriving at that error
/// proves at least that many links were offered to `create_new` and refused.
/// Follow one instead and the save succeeds, having clobbered `outside`; let the
/// counter run past the band and the save succeeds too. Both fail below rather
/// than passing quietly.
#[cfg(unix)]
#[test]
fn a_symlink_squatting_the_temp_sibling_is_never_written_through() {
    use std::os::unix::fs::symlink;

    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), "outside stays intact").unwrap();
    let note = vault.path().join("Note.md");
    std::fs::write(&note, "original").unwrap();

    let band = temp_name_band(vault.path(), "Note.md");
    for name in &band {
        symlink(outside.path(), name).unwrap();
    }

    let result = write_note(vault.path(), &note, "saved content", None);

    assert_eq!(
        std::fs::read_to_string(outside.path()).unwrap(),
        "outside stays intact",
        "the save was written THROUGH a symlink squatting its temp sibling"
    );
    let error = result.expect_err(
        "the save found a free temp name, so it was never offered a squatting \
         symlink and this guard proved nothing",
    );
    assert!(
        error
            .to_string()
            .contains("no unique temporary file was available"),
        "unexpected error: {error}"
    );
    assert!(
        std::fs::symlink_metadata(&band[0]).is_ok_and(|meta| meta.file_type().is_symlink()),
        "the squatting symlink was consumed rather than skipped"
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original");
}

/// Running out of temp names must fail loudly. Skipping a squatted name keeps a
/// normal save working when something sits on the predictable one (issue #193),
/// but the retry is bounded — and a save that cannot find a free name has to say
/// so rather than silently doing nothing.
///
/// Non-vacuous for the same reason as the symlink guard above: had the counter
/// moved past the band, a free name would exist and this save would have
/// succeeded.
#[test]
fn exhausting_the_temp_name_attempts_is_an_explicit_failure() {
    let vault = tempfile::tempdir().unwrap();
    let note = vault.path().join("Note.md");
    std::fs::write(&note, "original").unwrap();

    let band = temp_name_band(vault.path(), "Note.md");
    for name in &band {
        std::fs::write(name, "occupied").unwrap();
    }

    let error = write_note(vault.path(), &note, "saved content", None)
        .expect_err("the save found a free temp name outside the squatted band");

    assert!(
        error
            .to_string()
            .contains("no unique temporary file was available"),
        "exhaustion must name itself, got {error}"
    );
    assert_eq!(std::fs::read_to_string(&note).unwrap(), "original");
}

/// The offset [`body_line_offset`] reports for `raw`, measured against the body
/// the real parser extracts from it — never a body assembled by hand, which would
/// only pin this test's idea of the parse.
fn offset_of(raw: &str) -> usize {
    body_line_offset(raw, &parse_frontmatter(raw).body)
}

#[test]
fn a_note_without_frontmatter_starts_its_body_on_the_first_file_line() {
    assert_eq!(offset_of("# Title\n\nbody\n"), 0);
}

#[test]
fn a_frontmatter_block_offsets_the_body_by_the_lines_it_occupies() {
    assert_eq!(offset_of("---\ntitle: x\n---\nbody line\n"), 3);
    assert_eq!(offset_of("---\ntitle: x\n...\nbody line\n"), 3);
}

/// An unterminated block keeps the WHOLE file as the body so no content is ever
/// lost, which puts the body's first line back on the file's first line. The
/// offset must be 0, not the 3 an "it opened with `---`" reading would give.
#[test]
fn an_unterminated_frontmatter_block_has_no_offset() {
    assert_eq!(offset_of("---\ntitle: x\nbody line\n"), 0);
}

/// A UTF-8 byte-order mark is three bytes and no line. `parse_frontmatter` skips
/// it to find the opening fence but leaves it in `raw`, so the byte distance to
/// the body carries it while the line count does not.
#[test]
fn a_byte_order_mark_before_the_frontmatter_does_not_shift_the_offset() {
    assert_eq!(offset_of("\u{feff}---\ntitle: x\n---\n"), 3);
    assert_eq!(offset_of("\u{feff}---\ntitle: x\n---\nbody line\n"), 3);
}

/// CRLF makes every skipped line one byte longer than LF does. The offset counts
/// lines, so both spellings of the same frontmatter give the same answer.
#[test]
fn crlf_line_endings_offset_by_lines_not_bytes() {
    assert_eq!(offset_of("---\r\na: 1\r\n---\r\n"), 3);
    assert_eq!(offset_of("---\r\na: 1\r\n---\r\nbody line\r\n"), 3);
}

/// The contract the numbers above exist to serve, and the reason both search and
/// backlinks route their line numbers through this one function: a body-relative
/// line plus the offset is the line the user sees in the file. A citation that
/// points at the wrong line is worse than no citation at all.
#[test]
fn adding_the_offset_to_a_body_line_lands_on_that_line_in_the_file() {
    for raw in [
        "---\ntitle: x\ntags: [a]\n---\n# Heading\n\nthe cited line\n",
        "---\r\ntitle: x\r\ntags: [a]\r\n---\r\n# Heading\r\n\r\nthe cited line\r\n",
        "\u{feff}---\ntitle: x\ntags: [a]\n---\n# Heading\n\nthe cited line\n",
        "---\ntitle: x\n# Heading\n\nthe cited line\n",
        "# Heading\n\nthe cited line\n",
    ] {
        let body = parse_frontmatter(raw).body;
        let in_body = body
            .lines()
            .position(|line| line == "the cited line")
            .unwrap();

        let in_file = body_line_offset(raw, &body) + in_body;

        assert_eq!(
            raw.lines().nth(in_file),
            Some("the cited line"),
            "cited file line {in_file} of {raw:?}"
        );
    }
}
