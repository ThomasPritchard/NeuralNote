//! Rust-core acceptance for the lazy file-tree DISPLAY primitive
//! `neuralnote_core::tree::list_dir` (issue #40, phase 1). Fixtures 1-5 from
//! `specs/lazy-file-tree.md`.
//!
//! The load-bearing test here is the **coherence guard** (fixture 5): a file
//! omitted from a truncated `list_dir` payload is still found by `search_vault`
//! and still carries a node in `read_link_graph`. That proves the moat — full
//! cited recall — is uncapped, and the per-directory cap is a DISPLAY concern
//! only.

use std::fs;
use std::path::PathBuf;

use neuralnote_core::error::CoreError;
use neuralnote_core::model::EntryKind;
use neuralnote_core::tree::list_dir;

/// The per-directory display cap, mirrored from `tree.rs` so the width fixtures
/// are self-describing. Kept in sync by the tests themselves failing if it drifts.
const DIR_LISTING_CAP: usize = 5_000;

fn canon(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().canonicalize().unwrap()
}

/// A vault whose `Wide/` folder holds `DIR_LISTING_CAP + 1` markdown files named
/// `note-00001.md`..`note-05001.md`. The last one (which sorts past the cap and
/// is therefore omitted by `list_dir`) carries a unique `marker` so the
/// coherence guard can prove search/graph still reach it.
fn wide_vault(marker: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let wide = dir.path().join("Wide");
    fs::create_dir(&wide).unwrap();
    for i in 1..=(DIR_LISTING_CAP + 1) {
        let body = if i == DIR_LISTING_CAP + 1 {
            format!("# note {i}\n\n{marker}\n")
        } else {
            format!("# note {i}\n")
        };
        fs::write(wide.join(format!("note-{i:05}.md")), body).unwrap();
    }
    dir
}

// Fixture 1 — a folder wider than the cap returns exactly CAP entries in sort
// order, with the overflow reported as an explicit truncation count.
#[test]
fn wide_folder_returns_first_cap_entries_in_order_with_truncation_count() {
    let v = wide_vault("unused");
    let listing = list_dir(&canon(&v), &canon(&v).join("Wide")).unwrap();

    assert_eq!(listing.entries.len(), DIR_LISTING_CAP);
    // One entry beyond the cap, and sort order is preserved: the kept slice is
    // note-00001..note-05000, so the single omitted entry is the largest-sorting
    // name, note-05001.md.
    assert_eq!(listing.truncated, Some(1));
    assert_eq!(listing.entries.first().unwrap().name, "note-00001.md");
    assert_eq!(listing.entries.last().unwrap().name, "note-05000.md");
}

// Fixture 2 — one level only. A deep folder yields just its immediate children;
// a subfolder child is returned unloaded (`children: None`), folders before files.
#[test]
fn lists_only_immediate_children_and_leaves_subfolders_unloaded() {
    let v = tempfile::tempdir().unwrap();
    let top = v.path().join("Top");
    fs::create_dir_all(top.join("Sub")).unwrap();
    fs::write(top.join("Sub/deep.md"), "buried").unwrap(); // must NOT appear
    fs::write(top.join("Zeta.md"), "z").unwrap();
    fs::write(top.join("alpha.md"), "a").unwrap();

    let listing = list_dir(&canon(&v), &canon(&v).join("Top")).unwrap();

    let names: Vec<&str> = listing.entries.iter().map(|n| n.name.as_str()).collect();
    // Folder first, then files case-insensitively; the recursion never happened.
    assert_eq!(names, vec!["Sub", "alpha.md", "Zeta.md"]);

    let sub = &listing.entries[0];
    assert_eq!(sub.kind, EntryKind::Folder);
    assert!(
        sub.children.is_none(),
        "subfolder must be unloaded, not scanned"
    );
    assert!(!listing.entries.iter().any(|n| n.name == "deep.md"));
}

// Fixture 3 — an unreadable directory surfaces as CoreError::Io, never a panic
// and never a silent empty listing.
#[cfg(unix)]
#[test]
fn unreadable_directory_reports_io_error() {
    use std::os::unix::fs::PermissionsExt;

    let v = tempfile::tempdir().unwrap();
    let locked = v.path().join("Locked");
    fs::create_dir(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let result = list_dir(&canon(&v), &canon(&v).join("Locked"));

    // Restore perms first so the TempDir can be cleaned up regardless of assert.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(result, Err(CoreError::Io(_))), "got {result:?}");
}

// Fixture 4 — symlinks and dotfiles are skipped, exactly as the full scan does,
// so escapes/loops are impossible and hidden sidecars stay invisible.
#[cfg(unix)]
#[test]
fn skips_symlinks_and_hidden_entries() {
    let v = tempfile::tempdir().unwrap();
    let d = v.path().join("Dir");
    fs::create_dir(&d).unwrap();
    fs::write(d.join("real.md"), "r").unwrap();
    fs::write(d.join(".hidden.md"), "h").unwrap();
    std::os::unix::fs::symlink(d.join("real.md"), d.join("link.md")).unwrap();

    let listing = list_dir(&canon(&v), &canon(&v).join("Dir")).unwrap();

    let names: Vec<&str> = listing.entries.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, vec!["real.md"]);
    assert_eq!(listing.truncated, None);
}

// Fixture 5 — THE COHERENCE GUARD. In a vault with a truncated wide folder, the
// file omitted from the lazy listing is still found by search and still carries
// a node in the link graph. Proves the moat (full cited recall) is never capped.
#[test]
fn truncated_file_stays_searchable_and_in_the_link_graph() {
    let marker = "zqxcoherencemarker";
    let v = wide_vault(marker);
    let root = canon(&v);
    let omitted_rel = format!("Wide/note-{:05}.md", DIR_LISTING_CAP + 1);

    // It really is omitted from the DISPLAY listing.
    let listing = list_dir(&root, &root.join("Wide")).unwrap();
    assert_eq!(listing.truncated, Some(1));
    assert!(
        !listing.entries.iter().any(|n| n.rel_path == omitted_rel),
        "the omitted file must not be in the lazy listing"
    );

    // Search (full scan) still finds it by its unique marker.
    let hits = neuralnote_core::search::search_vault(&root, marker).unwrap();
    assert!(
        hits.hits.iter().any(|h| h.rel_path == omitted_rel),
        "search must reach a file hidden behind the display cap"
    );

    // The link graph (full scan) still has a node for it — it is citable.
    let graph = neuralnote_core::links::read_link_graph(&root).unwrap();
    assert!(
        graph.nodes.iter().any(|n| n.id == omitted_rel),
        "the link graph must cover a file hidden behind the display cap"
    );
}
