//! Issue #210 (PA-006) — the vault SCANS must respect the same byte ceiling the
//! reader does.
//!
//! `read_note` refuses a note past `MAX_EDITABLE_NOTE_BYTES`, answering a
//! content-free doc whose `content_hash` is empty. Search, the link graph and
//! backlinks used to read the very same files with no bound at all, so an over-cap
//! note was scanned, matched, and minted a real evidence span — which the verifier
//! could then only drop, blaming a disk change that never happened. Bounding the
//! scans is the fix: the over-cap note yields no spans, and its omission is
//! COUNTED (`skipped_files`), never silent.
//!
//! These are acceptance tests over the public API only. The existing search
//! fixtures cannot fail them: every one of those notes is small, and for an in-cap
//! note a bounded read and an unbounded read are indistinguishable.

use neuralnote_core::ai::retrieval::{KeywordRetriever, RetrievalProvider};
use neuralnote_core::backlinks::read_backlinks;
use neuralnote_core::links::read_link_graph;
use neuralnote_core::note::MAX_EDITABLE_NOTE_BYTES;
use neuralnote_core::search::search_vault;
use std::fs;
use std::io::Write;
use std::path::Path;

/// Write a note that genuinely exceeds the editable cap, cheaply: a real head —
/// the text a scan would match on — followed by a sparse tail via `set_len`, so no
/// multi-megabyte buffer is allocated and no large fixture is committed. The file's
/// length, which is what both the metadata preflight and any whole-file read see,
/// really is past the cap.
fn write_oversized_note(path: &Path, head: &str) {
    let mut file = fs::File::create(path).unwrap();
    file.write_all(head.as_bytes()).unwrap();
    file.set_len(MAX_EDITABLE_NOTE_BYTES as u64 + 1).unwrap();
    drop(file);
    assert!(
        fs::metadata(path).unwrap().len() > MAX_EDITABLE_NOTE_BYTES as u64,
        "the fixture must genuinely exceed the editable cap"
    );
}

#[test]
fn search_skips_a_note_past_the_editable_byte_limit_and_counts_it() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("small.md"), "target line\n").unwrap();
    write_oversized_note(&dir.path().join("big.md"), "target line\n");

    let resp = search_vault(dir.path(), "target").unwrap();

    let rels: Vec<&str> = resp.hits.iter().map(|h| h.rel_path.as_str()).collect();
    assert_eq!(
        rels,
        ["small.md"],
        "an over-cap note must not be scanned whole"
    );
    assert_eq!(
        resp.skipped_files, 1,
        "the omitted note must be surfaced, never silent"
    );
}

#[test]
fn retrieval_mints_no_span_for_an_over_cap_note_and_reports_the_gap() {
    // The citation-fidelity half: a span here would carry a hash of content the
    // reader will never return, so the verifier could only drop it — with a false
    // "changed on disk" reason, deterministically, forever.
    let dir = tempfile::tempdir().unwrap();
    write_oversized_note(&dir.path().join("big.md"), "target line\n");

    let outcome = KeywordRetriever::new(dir.path())
        .search_notes("target", 8, None)
        .unwrap();

    assert!(
        outcome.spans.is_empty(),
        "an over-cap note must produce no evidence spans, got {:?}",
        outcome.spans
    );
    assert!(
        outcome.skipped_files >= 1,
        "the coverage footer must report the skipped note"
    );
}

#[test]
fn link_graph_keeps_the_node_but_skips_an_over_cap_note() {
    let dir = tempfile::tempdir().unwrap();
    write_oversized_note(&dir.path().join("big.md"), "[[open]]\n");
    fs::write(dir.path().join("open.md"), "").unwrap();

    let graph = read_link_graph(dir.path()).unwrap();

    assert_eq!(graph.nodes.len(), 2, "the node is kept, orphan-style");
    assert!(
        graph.links.is_empty(),
        "links from an unread note must not be invented"
    );
    assert_eq!(graph.skipped_files, 1);
}

#[test]
fn backlinks_skip_an_over_cap_source_note_and_count_it() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("target.md"), "# Rust\n").unwrap();
    write_oversized_note(&dir.path().join("big.md"), "[[target]] and Rust\n");

    let backlinks = read_backlinks(dir.path(), "target.md").unwrap();

    assert!(backlinks.linked.is_empty());
    assert!(backlinks.unlinked.is_empty());
    assert_eq!(backlinks.skipped_files, 1);
}
