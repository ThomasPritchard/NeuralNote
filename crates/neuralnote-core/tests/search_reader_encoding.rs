//! Issue #33 — the reader and search MUST decode a non-UTF-8 note identically, so
//! search can never miss text the reader shows (a citation-fidelity hole). These
//! acceptance tests pin the shared decode policy through the public API: a unique
//! ascii token is placed on the SAME line as the non-UTF-8 bytes, so the search
//! snippet for that line must byte-match the line the reader presents — proving the
//! searchable string equals the reader's string across the lossy region itself.
//!
//! Covers the four required cases: Latin-1, malformed UTF-8, a literal (valid)
//! replacement character, and a mixed vault whose unreadable file is skipped and
//! counted, never fatal.

use neuralnote_core::model::{FileHit, SearchResponse};
use neuralnote_core::note::read_note;
use neuralnote_core::search::search_vault;
use std::fs;
use std::path::{Path, PathBuf};

fn vault() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    (dir, root)
}

fn write_bytes(root: &Path, name: &str, bytes: &[u8]) {
    fs::write(root.join(name), bytes).unwrap();
}

fn hit_for<'a>(resp: &'a SearchResponse, name: &str) -> &'a FileHit {
    resp.hits
        .iter()
        .find(|h| h.path.ends_with(name))
        .unwrap_or_else(|| panic!("expected a search hit for {name}; got {:?}", resp.hits))
}

/// The load-bearing invariant: searching `token` finds `name`, and the snippet of
/// the matched line is byte-identical to the same line as the reader presents it.
/// Because `token` shares its line with the non-UTF-8 bytes, this equality holds
/// *across* the U+FFFD region — the exact place a divergent decode would drift.
fn assert_search_matches_reader(root: &Path, name: &str, token: &str) {
    let doc = read_note(root, &root.join(name)).unwrap();
    let reader_line = doc
        .raw
        .lines()
        .find(|l| l.contains(token))
        .unwrap_or_else(|| {
            panic!(
                "reader raw for {name} has no line with {token}: {:?}",
                doc.raw
            )
        });

    let resp = search_vault(root, token).unwrap();
    let hit = hit_for(&resp, name);
    let snippet = &hit.matches[0].snippet;
    assert_eq!(
        snippet, reader_line,
        "search snippet must equal the reader's line byte-for-byte for {name}"
    );
}

/// The bytes on disk are never mutated by reading — the ownership promise.
fn assert_bytes_preserved(root: &Path, name: &str, original: &[u8]) {
    let _ = read_note(root, &root.join(name)).unwrap();
    assert_eq!(
        fs::read(root.join(name)).unwrap(),
        original,
        "reading {name} must not rewrite its bytes"
    );
}

#[test]
fn latin1_note_is_searchable_exactly_as_the_reader_shows_it() {
    let (_d, root) = vault();
    // "café résumé" in Latin-1/Windows-1252: é = 0xE9. Searchable ascii on the line.
    let bytes = [
        b'c', b'a', b'f', 0xE9, b' ', b'r', 0xE9, b's', b'u', b'm', 0xE9, b' ', b'w', b'i', b'd',
        b'g', b'e', b't',
    ];
    write_bytes(&root, "latin1.md", &bytes);

    let doc = read_note(&root, &root.join("latin1.md")).unwrap();
    assert!(doc.lossy_text, "a Latin-1 note must be flagged lossy_text");
    assert!(
        doc.raw.contains('\u{FFFD}'),
        "invalid bytes render as U+FFFD"
    );

    assert_search_matches_reader(&root, "latin1.md", "widget");
    assert_bytes_preserved(&root, "latin1.md", &bytes);
}

#[test]
fn malformed_utf8_note_is_searchable_exactly_as_the_reader_shows_it() {
    let (_d, root) = vault();
    // 0xE2 0x82 is the truncated start of a 3-byte sequence (€ is E2 82 AC) — the
    // third byte is missing, so it is malformed mid-line.
    let bytes = [
        b'p', b'r', b'i', b'c', b'e', b' ', 0xE2, 0x82, b' ', b'g', b'a', b'd', b'g', b'e', b't',
    ];
    write_bytes(&root, "malformed.md", &bytes);

    let doc = read_note(&root, &root.join("malformed.md")).unwrap();
    assert!(
        doc.lossy_text,
        "a malformed-UTF-8 note must be flagged lossy_text"
    );

    assert_search_matches_reader(&root, "malformed.md", "gadget");
    assert_bytes_preserved(&root, "malformed.md", &bytes);
}

#[test]
fn literal_replacement_char_is_valid_utf8_not_flagged_lossy_and_is_searchable() {
    let (_d, root) = vault();
    // A note that genuinely CONTAINS U+FFFD as valid UTF-8 (EF BF BD). It is real
    // content, not decode loss — the reader must not mislabel it lossy, and search
    // must treat the replacement char as a first-class, findable character.
    let content = "note about the \u{FFFD} symbol and gizmo";
    write_bytes(&root, "replacement.md", content.as_bytes());

    let doc = read_note(&root, &root.join("replacement.md")).unwrap();
    assert!(
        !doc.lossy_text,
        "a valid-UTF-8 note is not lossy even when it contains a real U+FFFD"
    );
    assert_eq!(doc.raw, content, "valid UTF-8 is taken verbatim");

    assert_search_matches_reader(&root, "replacement.md", "gizmo");
    // The replacement character itself is searchable content, same as the reader.
    let resp = search_vault(&root, "\u{FFFD}").unwrap();
    assert!(
        resp.hits.iter().any(|h| h.path.ends_with("replacement.md")),
        "a literal U+FFFD must be findable by search"
    );
}

#[test]
fn mixed_vault_search_matches_reader_for_every_readable_note() {
    let (_d, root) = vault();
    write_bytes(&root, "valid.md", "alpha shared payload".as_bytes());
    // Latin-1 é on the shared line.
    let latin1 = [
        b'b', b'e', b't', b'a', b' ', b's', b'h', b'a', b'r', b'e', b'd', b' ', 0xE9, b' ', b'x',
    ];
    write_bytes(&root, "latin1.md", &latin1);
    // Malformed multibyte on the shared line.
    let malformed = [
        b'g', b'a', b'm', b'm', b'a', b' ', b's', b'h', b'a', b'r', b'e', b'd', b' ', 0xE2, 0x82,
    ];
    write_bytes(&root, "malformed.md", &malformed);

    let resp = search_vault(&root, "shared").unwrap();
    for name in ["valid.md", "latin1.md", "malformed.md"] {
        assert_search_matches_reader(&root, name, "shared");
    }
    assert_eq!(
        resp.skipped_files, 0,
        "no unreadable files yet, so nothing is skipped"
    );
}

#[cfg(unix)]
#[test]
fn unreadable_note_in_a_mixed_vault_is_skipped_and_counted_not_fatal() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, root) = vault();
    write_bytes(&root, "readable.md", "alpha shared payload".as_bytes());
    write_bytes(&root, "locked.md", "delta shared secret".as_bytes());
    fs::set_permissions(root.join("locked.md"), fs::Permissions::from_mode(0o000)).unwrap();

    let resp = search_vault(&root, "shared").unwrap();

    // Readable notes still match, exactly as the reader shows them.
    assert_search_matches_reader(&root, "readable.md", "shared");
    // The unreadable file is surfaced as a skip, never a fatal error, and counted.
    assert_eq!(
        resp.skipped_files, 1,
        "the locked note must be counted skipped"
    );
    assert!(
        !resp.hits.iter().any(|h| h.path.ends_with("locked.md")),
        "an unreadable note yields no hit"
    );

    // Restore perms so the tempdir can be cleaned up.
    fs::set_permissions(root.join("locked.md"), fs::Permissions::from_mode(0o644)).unwrap();
}
