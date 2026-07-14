use std::fs;

use neuralnote_core::error::CoreError;
use neuralnote_core::note::{read_rich_note, write_rich_note};
use neuralnote_core::rich_edit::{RichEditDisposition, RichEditPatch};

fn vault_with_note(content: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
    let vault = tempfile::tempdir().expect("temp vault");
    let note = vault.path().join("note.md");
    fs::write(&note, content).expect("seed note");
    (vault, note)
}

#[test]
fn rich_note_io_preserves_unselected_bytes_and_returns_fresh_note_doc() {
    let original = b"\xef\xbb\xbf---\n# preserved comment\ntitle: Demo\n---\n# Heading\n\nFirst.  \n\nSecond.\n";
    let (vault, note) = vault_with_note(original);
    let document = read_rich_note(vault.path(), &note).expect("rich preflight");

    assert!(matches!(document.disposition, RichEditDisposition::Rich));
    assert_eq!(
        document.frontmatter_prefix.as_bytes(),
        b"\xef\xbb\xbf---\n# preserved comment\ntitle: Demo\n---\n"
    );
    let second = document.blocks.last().expect("second paragraph");
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![second.id.clone()],
        replacement_markdown: "Changed.\n".into(),
    };

    let saved = write_rich_note(vault.path(), &note, &patch).expect("guarded save");

    assert_eq!(
        fs::read(&note).expect("saved bytes"),
        b"\xef\xbb\xbf---\n# preserved comment\ntitle: Demo\n---\n# Heading\n\nFirst.  \n\nChanged.\n"
    );
    assert_eq!(saved.raw.as_bytes(), fs::read(&note).unwrap());
    assert!(!saved.content_hash.is_empty());
}

#[test]
fn rich_note_io_maps_stale_revisions_to_conflict_without_writing() {
    let original = b"First.\n\nSecond.\n";
    let (vault, note) = vault_with_note(original);
    let document = read_rich_note(vault.path(), &note).unwrap();
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec![document.blocks[0].id.clone()],
        replacement_markdown: "Changed.\n\n".into(),
    };
    fs::write(&note, b"External change.\n").unwrap();

    let error = write_rich_note(vault.path(), &note, &patch).unwrap_err();

    assert!(matches!(error, CoreError::Conflict(_)));
    assert_eq!(fs::read(&note).unwrap(), b"External change.\n");
}

#[test]
fn rich_note_io_rejects_non_utf8_and_outside_vault_paths() {
    let (vault, note) = vault_with_note(&[0xff, 0xfe, b'\n']);
    let non_utf8 = read_rich_note(vault.path(), &note).unwrap_err();
    assert!(matches!(non_utf8, CoreError::InvalidContent(_)));

    let outside = tempfile::NamedTempFile::new().unwrap();
    let escaped = read_rich_note(vault.path(), outside.path()).unwrap_err();
    assert!(matches!(escaped, CoreError::OutsideVault(_)));
}

#[test]
fn invalid_rich_patch_is_a_typed_content_error_and_does_not_write() {
    let original = b"First.\n\nSecond.\n";
    let (vault, note) = vault_with_note(original);
    let document = read_rich_note(vault.path(), &note).unwrap();
    let patch = RichEditPatch {
        expected_revision: document.revision,
        changed_block_ids: vec!["forged".into()],
        replacement_markdown: "Changed.\n".into(),
    };

    let error = write_rich_note(vault.path(), &note, &patch).unwrap_err();

    assert!(matches!(error, CoreError::InvalidContent(_)));
    assert_eq!(fs::read(&note).unwrap(), original);
}
