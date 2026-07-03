//! NeuralNote core — the client-agnostic vault domain.
//!
//! Open/create vaults, scan the file tree, read/write markdown notes (with
//! frontmatter), and do file/folder CRUD — all vault-scoped and safe. No
//! dependency on Tauri or any UI, so other clients can reuse this verbatim.

pub mod entries;
pub mod error;
pub mod links;
pub mod model;
pub mod note;
pub mod paths;
pub mod recents;
pub mod search;
pub mod tree;
pub mod vault;

pub use error::{CoreError, CoreResult};
pub use model::{
    EntryKind, FileHit, GraphLink, GraphNode, LinkGraph, NoteDoc, RecentVault, SearchMatch,
    SearchResponse, TreeNode, Vault,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Research")).unwrap();
        fs::write(dir.path().join("Research/note.md"), "# Hello\n\nbody").unwrap();
        fs::write(dir.path().join(".hidden.md"), "secret").unwrap();
        dir
    }

    #[test]
    fn rejects_path_escape_via_dotdot() {
        let v = vault();
        let escape = v.path().join("Research/../../etc/passwd");
        assert!(matches!(
            paths::ensure_within(v.path(), &escape),
            Err(CoreError::OutsideVault(_)) | Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn allows_path_inside_vault() {
        let v = vault();
        let inside = v.path().join("Research/note.md");
        assert!(paths::ensure_within(v.path(), &inside).is_ok());
    }

    #[test]
    fn validate_name_rejects_separators_and_navigation() {
        assert!(paths::validate_name("a/b").is_err());
        assert!(paths::validate_name("..").is_err());
        assert!(paths::validate_name("  ").is_err());
        assert!(paths::validate_name(".todo").is_err()); // leading dot → would be hidden
        assert!(paths::validate_name("ok name").is_ok());
    }

    #[test]
    fn tree_hides_dotfiles_and_sorts_folders_first() {
        let v = vault();
        let nodes = tree::read_tree(v.path()).unwrap();
        assert!(nodes.iter().all(|n| !n.name.starts_with('.')));
        assert_eq!(nodes.first().map(|n| n.kind), Some(EntryKind::Folder));
    }

    #[test]
    fn reads_frontmatter_and_body() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(
            &f,
            "---\ntitle: My Note\ntags: [a, b]\n---\n# Heading\n\ntext",
        )
        .unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert_eq!(doc.title, "My Note");
        assert!(doc.frontmatter_error.is_none());
        assert!(doc.body.contains("# Heading"));
        assert!(!doc.body.contains("title: My Note"));
    }

    #[test]
    fn unterminated_frontmatter_surfaces_error_keeps_content() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "---\ntitle: oops\nno closing fence").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.frontmatter_error.is_some());
        assert!(doc.raw.contains("no closing fence"));
    }

    #[test]
    fn crash_safe_write_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "old").unwrap();
        let before = note::read_note(dir.path(), &f).unwrap();
        let saved =
            note::write_note(dir.path(), &f, "new content", Some(before.content_hash)).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content");
        // write_note returns the fresh doc — no separate re-read needed.
        assert_eq!(saved.raw, "new content");
    }

    #[test]
    fn write_detects_external_change_via_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "v1").unwrap();
        let opened = note::read_note(dir.path(), &f).unwrap();
        // An external process changes the file after we opened it.
        fs::write(&f, "external edit").unwrap();
        let err = note::write_note(dir.path(), &f, "v2", Some(opened.content_hash));
        assert!(matches!(err, Err(CoreError::Conflict(_))));
        // External content is intact — the conflicting save did not clobber it.
        assert_eq!(fs::read_to_string(&f).unwrap(), "external edit");
        // Forcing (None) overwrites regardless.
        assert!(note::write_note(dir.path(), &f, "forced", None).is_ok());
    }

    #[test]
    fn create_note_appends_md_and_refuses_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let node = entries::create_note(dir.path(), dir.path(), "ideas").unwrap();
        assert_eq!(node.name, "ideas.md");
        assert!(entries::create_note(dir.path(), dir.path(), "ideas").is_err());
    }

    #[test]
    fn cannot_move_folder_into_itself() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("a");
        fs::create_dir(&parent).unwrap();
        let child = parent.join("b");
        fs::create_dir(&child).unwrap();
        assert!(entries::move_entry(dir.path(), &parent, &child).is_err());
    }

    #[test]
    fn read_note_flags_non_utf8_as_binary() {
        // PA-003: a binary attachment must not dead-end as a read error.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("image.png");
        fs::write(&f, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0xff, 0xfe]).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.binary);
        assert!(doc.body.is_empty() && doc.raw.is_empty());
    }

    #[test]
    fn non_utf8_markdown_note_is_shown_lossily_not_hidden() {
        // Round-5 silent-failure finding: a `.md` note with a Windows-1252/Latin-1
        // byte (ubiquitous in migrated vaults) must be SHOWN (lossy-decoded), not
        // silently hidden as a contentless "binary". The degradation is flagged.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("accented.md");
        // "café" with a Latin-1 0xE9 (invalid UTF-8), then a body line.
        fs::write(&f, [b'c', b'a', b'f', 0xE9, b'\n', b'b', b'o', b'd', b'y']).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(!doc.binary, "a text note must not be hidden as binary");
        assert!(
            doc.lossy_text,
            "non-UTF-8 decode must be flagged — never silent"
        );
        assert!(doc.raw.contains("caf")); // content shown; the bad byte became U+FFFD
        assert!(doc.body.contains("body"));
    }

    #[test]
    fn lossy_note_can_be_saved_not_just_read() {
        // Round-6 regression: a non-UTF-8 note is editable, so saving must WORK. The
        // write-path conflict check must read the file the same (lossy) way the
        // reader did, or the content-hash compare errors and every save fails.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("accented.md");
        fs::write(&f, [b'c', b'a', b'f', 0xE9]).unwrap(); // non-UTF-8 (Latin-1 "café")
        let opened = note::read_note(dir.path(), &f).unwrap();
        assert!(opened.lossy_text);
        // Saving with the hash from the lossy read must succeed — not Io/Conflict.
        let saved =
            note::write_note(dir.path(), &f, "café fixed", Some(opened.content_hash)).unwrap();
        assert_eq!(saved.raw, "café fixed");
        assert!(!saved.lossy_text); // the re-saved content is now clean UTF-8
    }

    #[test]
    fn reads_utf8_note_as_non_binary() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "plain text").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(!doc.binary);
        assert_eq!(doc.raw, "plain text");
    }

    #[test]
    fn case_only_rename_is_allowed() {
        // PA-017: recapitalising a name must not be refused as a collision.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Notes.md"), "x").unwrap();
        let node =
            entries::rename_entry(dir.path(), &dir.path().join("Notes.md"), "notes.md").unwrap();
        assert_eq!(node.name, "notes.md");
    }

    #[test]
    fn case_only_rename_handles_non_ascii() {
        // Round-9: a case-only rename differing in a NON-ASCII letter
        // (`café.md` → `CAFÉ.md`) must also apply, not silently no-op — the
        // detection is Unicode-aware (`to_lowercase`), not ASCII-only.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("café.md"), "x").unwrap();
        let node =
            entries::rename_entry(dir.path(), &dir.path().join("café.md"), "CAFÉ.md").unwrap();
        assert_eq!(node.name, "CAFÉ.md");
    }

    #[test]
    fn concurrent_writes_same_note_leave_no_temp() {
        // PA-016: unique temp names so parallel writers can't collide or leak.
        use std::thread;
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "init").unwrap();
        let root = dir.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let (root, f) = (root.clone(), f.clone());
                thread::spawn(move || note::write_note(&root, &f, &format!("content {i}"), None))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        let leftovers = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".nn-tmp"))
            .count();
        assert_eq!(leftovers, 0, "leaked temp files");
        assert!(fs::read_to_string(&f).unwrap().starts_with("content "));
    }

    #[test]
    fn create_and_open_vault_roundtrip() {
        let parent = tempfile::tempdir().unwrap();
        let v = vault::create_vault(parent.path(), "My Vault").unwrap();
        assert_eq!(v.name, "My Vault");
        assert!(Path::new(&v.path).is_dir());
        // Re-creating the same name is refused.
        assert!(matches!(
            vault::create_vault(parent.path(), "My Vault"),
            Err(CoreError::AlreadyExists(_))
        ));
        // Opening the created folder yields the same vault.
        let opened = vault::open_vault(Path::new(&v.path)).unwrap();
        assert_eq!(opened.path, v.path);
        assert_eq!(opened.name, "My Vault");
    }

    #[test]
    fn open_vault_rejects_missing_and_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            vault::open_vault(&dir.path().join("nope")),
            Err(CoreError::NotFound(_))
        ));
        let f = dir.path().join("a.md");
        fs::write(&f, "x").unwrap();
        assert!(matches!(
            vault::open_vault(&f),
            Err(CoreError::InvalidName(_))
        ));
    }

    #[test]
    fn recents_record_list_roundtrip_and_cap() {
        let cfg = tempfile::tempdir().unwrap();
        for i in 0..15 {
            let vault_dir = cfg.path().join(format!("v{i}"));
            fs::create_dir(&vault_dir).unwrap();
            recents::record_recent_vault(
                cfg.path(),
                &Vault {
                    name: format!("v{i}"),
                    path: vault_dir.to_string_lossy().into_owned(),
                },
            )
            .unwrap();
        }
        let list = recents::list_recent_vaults(cfg.path()).unwrap();
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(list.len(), 12); // capped at MAX
        assert!(names.contains(&"v14")); // newest kept
        assert!(!names.contains(&"v0")); // oldest dropped
                                         // A corrupt recents file is tolerated as empty, never an error.
        fs::write(cfg.path().join("recent-vaults.json"), "{ not json").unwrap();
        assert_eq!(recents::list_recent_vaults(cfg.path()).unwrap().len(), 0);
    }

    #[test]
    fn create_folder_move_and_rename_succeed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = entries::create_folder(dir.path(), dir.path(), "Docs").unwrap();
        assert_eq!(folder.name, "Docs");
        assert_eq!(folder.kind, EntryKind::Folder);
        assert!(entries::create_folder(dir.path(), dir.path(), "Docs").is_err()); // dup
        let note = entries::create_note(dir.path(), dir.path(), "n").unwrap();
        let moved = entries::move_entry(dir.path(), Path::new(&note.path), Path::new(&folder.path))
            .unwrap();
        assert_eq!(moved.name, "n.md");
        assert!(Path::new(&moved.path).is_file());
        let renamed = entries::rename_entry(dir.path(), Path::new(&moved.path), "renamed").unwrap();
        assert_eq!(renamed.name, "renamed.md");
        assert!(entries::rename_entry(dir.path(), Path::new(&renamed.path), "a/b").is_err());
    }

    #[test]
    fn core_error_displays_all_variants_and_from_io() {
        for e in [
            CoreError::NotFound("a".into()),
            CoreError::AlreadyExists("a".into()),
            CoreError::OutsideVault("a".into()),
            CoreError::InvalidName("a".into()),
            CoreError::Conflict("a".into()),
            CoreError::Io("a".into()),
            CoreError::Frontmatter("a".into()),
        ] {
            assert!(!e.to_string().is_empty());
        }
        let dup = std::io::Error::new(std::io::ErrorKind::AlreadyExists, "dup");
        assert!(matches!(CoreError::from(dup), CoreError::AlreadyExists(_)));
        let other = std::io::Error::other("boom");
        assert!(matches!(CoreError::from(other), CoreError::Io(_)));
    }

    /// Build a "billion laughs" alias bomb: `levels` anchors, each a `fan`-wide list
    /// of aliases to the previous one, so a naive parser expands it to `fan^levels`
    /// nodes. Bounded sizes here reject *fast* (the parser aborts at its repetition
    /// limit) — they never actually expand, so there is no OOM risk in the suite.
    fn alias_bomb(levels: usize, fan: usize) -> String {
        let xs = vec!["x"; fan].join(",");
        let mut s = format!("a0: &a0 [{xs}]\n");
        for i in 1..levels {
            let refs = vec![format!("*a{}", i - 1); fan].join(",");
            s.push_str(&format!("a{i}: &a{i} [{refs}]\n"));
        }
        s.push_str(&format!("top: *a{}\n", levels - 1));
        s
    }

    #[test]
    fn serde_yaml_dependency_rejects_alias_bombs() {
        // CANARY for why there is no hand-rolled anchor guard: serde_yaml_ng (via
        // unsafe-libyaml) already rejects alias bombs with a "repetition limit",
        // exactly (it is the same tokenizer that would expand them) — so we rely on
        // it rather than re-implementing detection (which we tried, and which was
        // bypassed twice by YAML grammar edge cases). If a dependency bump ever
        // drops this protection, this test fails and the decision must be revisited.
        for (levels, fan) in [(5usize, 10usize), (9, 10)] {
            let r: Result<serde_json::Value, _> = serde_yaml_ng::from_str(&alias_bomb(levels, fan));
            assert!(
                r.is_err(),
                "bomb {levels}x{fan} was NOT rejected by the parser"
            );
        }
        // The exact bytes that bypassed the old hand-rolled guard (a mid-scalar `'`
        // in `it's` hid every anchor from the byte-scanner) — the parser is immune.
        let bypass = "defs: [it's, &a [x,x,x,x,x,x,x,x,x,x], &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a], &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b], &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c], &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d], *e]\n";
        let r: Result<serde_json::Value, _> = serde_yaml_ng::from_str(bypass);
        assert!(
            r.is_err(),
            "round-4 bypass bomb was NOT rejected by the parser"
        );
        // A benign single alias must still parse — it's a repetition budget, not a ban.
        let benign: Result<serde_json::Value, _> =
            serde_yaml_ng::from_str("base: &b {a: 1}\nuse: *b\n");
        assert!(benign.is_ok(), "the parser wrongly rejected a benign alias");
    }

    #[test]
    fn frontmatter_rejects_alias_bomb_and_preserves_body() {
        // Integration: an alias bomb in a note's frontmatter surfaces as a
        // frontmatter_error (no parsed frontmatter) while the body is kept intact —
        // a failure is never silent and never loses the user's content.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("bomb.md");
        let bomb = format!("---\n{}---\nbody text\n", alias_bomb(6, 10));
        fs::write(&f, bomb).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.frontmatter.is_none());
        assert!(doc.frontmatter_error.is_some());
        assert!(doc.body.contains("body text")); // content is preserved
    }

    #[test]
    fn frontmatter_accepts_scalars_resembling_anchors() {
        // Legit frontmatter often contains `&`/`*` in ordinary values — in quoted
        // strings, comments, escaped strings, hyphenated/glob scalars, block
        // scalars, and Obsidian's `aliases:` list. None of these are anchors, so
        // all must parse cleanly (protecting the free Obsidian-migration path).
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("ok.md");
        let fm = "---\n\
            title: R&D and 2 * 3\n\
            aliases: [foo, bar]\n\
            summary: \"Pros, *cons*, and R&D\"\n\
            quoted: 'a, *b*, c'\n\
            status: active  # next: &m and *a\n\
            escaped: \"say \\\"hi\\\" then *wave* & grin\"\n\
            glob: a-*b\n\
            desc: |\n  \
            *starts with a star* and a & b\n  \
            second line\n\
            ---\nbody\n";
        fs::write(&f, fm).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(
            doc.frontmatter_error.is_none(),
            "false rejection of legit frontmatter: {:?}",
            doc.frontmatter_error
        );
        assert_eq!(doc.title, "R&D and 2 * 3");
    }

    #[test]
    fn frontmatter_too_large_is_refused_not_parsed() {
        // Over the 4 KiB cap → treated as malformed (the size/quadratic-amplification
        // bound) so a pathological file can't tie up the parser; body still preserved.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("big.md");
        let huge = "x".repeat((4 << 10) + 16); // just over the 4 KiB cap
        fs::write(&f, format!("---\nk: {huge}\n---\nbody")).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.frontmatter.is_none());
        assert!(doc
            .frontmatter_error
            .as_deref()
            .unwrap()
            .contains("too large"));
        assert!(doc.body.contains("body"));
    }

    #[test]
    fn frontmatter_just_under_the_cap_still_parses() {
        // Boundary: a large-but-legitimate frontmatter just under 4 KiB parses fine
        // (the cap is generous for real notes; only pathological blocks are refused).
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("ok-big.md");
        let val = "x".repeat((4 << 10) - 64); // comfortably under the cap
        fs::write(&f, format!("---\ntitle: Big\nk: {val}\n---\nbody")).unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(
            doc.frontmatter_error.is_none(),
            "{:?}",
            doc.frontmatter_error
        );
        assert_eq!(doc.title, "Big");
    }

    #[test]
    fn frontmatter_after_utf8_bom_is_still_parsed() {
        // Round-7: a leading UTF-8 BOM (common in Windows-edited notes) must not hide
        // the `---` fence — frontmatter parses, and the body excludes the fence block.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("bom.md");
        fs::write(&f, "\u{feff}---\ntitle: Bommed\n---\nbody here").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(
            doc.frontmatter_error.is_none(),
            "{:?}",
            doc.frontmatter_error
        );
        assert_eq!(doc.title, "Bommed");
        assert!(doc.body.contains("body here"));
        assert!(!doc.body.contains("title:")); // the fence block was extracted
    }

    #[test]
    fn frontmatter_must_be_a_mapping_not_a_list_or_scalar() {
        // A top-level YAML list/scalar isn't a key/value properties set — surface it
        // rather than silently dropping the frontmatter.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("list.md");
        fs::write(&f, "---\n- one\n- two\n---\nbody").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.frontmatter.is_none());
        assert!(doc
            .frontmatter_error
            .as_deref()
            .unwrap()
            .contains("key: value"));
    }

    #[test]
    fn malformed_yaml_frontmatter_surfaces_error_keeps_body() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("bad.md");
        fs::write(&f, "---\nkey: [unclosed\n---\nbody text").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        assert!(doc.frontmatter.is_none());
        assert!(doc
            .frontmatter_error
            .as_deref()
            .unwrap()
            .contains("invalid YAML"));
        assert!(doc.body.contains("body text"));
    }

    /* ─────────────────────────────  search  ─────────────────────────────── */

    /// Slice a snippet by chars, exactly how the frontend consumes ranges
    /// (`Array.from`) — an assertion through this proves ranges are Unicode-scalar
    /// offsets, never bytes or UTF-16 units.
    fn slice_chars(s: &str, range: (u32, u32)) -> String {
        s.chars()
            .skip(range.0 as usize)
            .take((range.1 - range.0) as usize)
            .collect()
    }

    #[test]
    fn search_empty_or_whitespace_query_returns_nothing() {
        let v = vault();
        for q in ["", "   ", "\t \n"] {
            let r = search::search_vault(v.path(), q).unwrap();
            assert!(r.hits.is_empty(), "query {q:?} must return no hits");
            assert!(!r.truncated);
        }
    }

    #[test]
    fn search_is_ascii_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "Hello World\n").unwrap();
        let r = search::search_vault(dir.path(), "hello WORLD").unwrap();
        assert_eq!(r.hits.len(), 1);
        let m = &r.hits[0].matches[0];
        assert_eq!(m.line, 1);
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "Hello World");
    }

    #[test]
    fn search_matches_across_unicode_case_folds() {
        // 'İ' lowercases to TWO scalars ("i" + combining dot above), so the folded
        // text is longer than the original — the match must still map back to the
        // original char range.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "her İstanbul notes\n").unwrap();
        let r = search::search_vault(dir.path(), "İSTANBUL").unwrap();
        assert_eq!(r.hits.len(), 1);
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (4, 12));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "İstanbul");
    }

    #[test]
    fn search_offsets_survive_fold_expansion_before_match() {
        // Two 'İ' BEFORE the match shift folded indices by +2 relative to original
        // char indices. Indexing the original with folded offsets (the classic
        // lowercased-copy bug) would highlight the wrong slice here.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "İİ Istanbul trip\n").unwrap();
        let r = search::search_vault(dir.path(), "istanbul").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (3, 11));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "Istanbul");
    }

    #[test]
    fn search_matches_cjk() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "この日本語ノートです\n").unwrap();
        let r = search::search_vault(dir.path(), "日本語").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (2, 5));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "日本語");
    }

    #[test]
    fn search_ranges_are_scalar_offsets_with_emoji_before_match() {
        // "🎉🎉 " is 3 scalars but 9 bytes / 5 UTF-16 units — the range must count
        // scalars for the frontend's Array.from slicing to land on the match.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "🎉🎉 launch day\n").unwrap();
        let r = search::search_vault(dir.path(), "launch").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (3, 9));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "launch");
    }

    #[test]
    fn search_handles_combining_marks() {
        // Decomposed "café" (e + U+0301): each scalar counts separately, and a
        // combining mark inside the query folds stably.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("n.md"), "cafe\u{301} menu\n").unwrap();
        let r = search::search_vault(dir.path(), "menu").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (6, 10));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "menu");
        let r = search::search_vault(dir.path(), "CAFE\u{301}").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.ranges[0], (0, 5));
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "cafe\u{301}");
    }

    #[test]
    fn search_clips_long_lines_on_char_boundaries() {
        // 250 multibyte chars, the match, then 100 more: the 200-char window slices
        // mid-run on both sides — byte-offset slicing would panic here (the canary).
        let dir = tempfile::tempdir().unwrap();
        let line = format!("{}needle{}", "あ".repeat(250), "い".repeat(100));
        fs::write(dir.path().join("n.md"), &line).unwrap();
        let r = search::search_vault(dir.path(), "needle").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.snippet.chars().count(), search::SNIPPET_MAX_CHARS);
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "needle");
    }

    #[test]
    fn search_clip_window_clamps_at_line_end() {
        // Match at the very end of a long line: the window clamps to the line end
        // and the match range stays fully inside the snippet.
        let dir = tempfile::tempdir().unwrap();
        let line = format!("{}needle", "あ".repeat(300));
        fs::write(dir.path().join("n.md"), &line).unwrap();
        let r = search::search_vault(dir.path(), "needle").unwrap();
        let m = &r.hits[0].matches[0];
        assert_eq!(m.snippet.chars().count(), search::SNIPPET_MAX_CHARS);
        assert_eq!(m.ranges[0].1 as usize, search::SNIPPET_MAX_CHARS);
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "needle");
    }

    #[test]
    fn search_caps_matches_per_file_and_flags_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..60).map(|i| format!("target line {i}\n")).collect();
        fs::write(dir.path().join("n.md"), body).unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        assert_eq!(r.hits[0].matches.len(), search::MAX_MATCHES_PER_FILE);
        assert!(r.truncated);
        // Exactly at the cap → nothing was clipped, so no truncation flag.
        let dir2 = tempfile::tempdir().unwrap();
        let body: String = (0..50).map(|i| format!("target line {i}\n")).collect();
        fs::write(dir2.path().join("n.md"), body).unwrap();
        let r = search::search_vault(dir2.path(), "target").unwrap();
        assert_eq!(r.hits[0].matches.len(), search::MAX_MATCHES_PER_FILE);
        assert!(!r.truncated);
    }

    #[test]
    fn search_caps_total_matches_across_files() {
        // 5 files × 45 matching lines = 225 candidates: under the per-file cap, but
        // the 200 total budget clips the last file mid-way.
        let dir = tempfile::tempdir().unwrap();
        for f in 0..5 {
            let body: String = (0..45).map(|i| format!("target line {i}\n")).collect();
            fs::write(dir.path().join(format!("f{f}.md")), body).unwrap();
        }
        // Name/title checks still run after the content budget is exhausted: this
        // file walks last (after the budget is gone) yet must surface as a name hit.
        fs::write(dir.path().join("target-notes.md"), "no matches here\n").unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        let total: usize = r.hits.iter().map(|h| h.matches.len()).sum();
        assert_eq!(total, search::MAX_TOTAL_MATCHES);
        assert!(r.truncated);
        assert_eq!(r.hits[0].rel_path, "target-notes.md");
        assert!(r.hits[0].name_match);
        assert!(r.hits[0].matches.is_empty());
    }

    #[test]
    fn search_ranks_name_matches_before_content_matches() {
        // "aaa.md" (content-only) walks before "zz-alpha.md" (name match), but name
        // matches rank first; within each group, tree-walk order holds.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("aaa.md"), "alpha in body\n").unwrap();
        fs::write(dir.path().join("zz-alpha.md"), "nothing here\n").unwrap();
        let r = search::search_vault(dir.path(), "alpha").unwrap();
        let rels: Vec<&str> = r.hits.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(rels, ["zz-alpha.md", "aaa.md"]);
        assert!(r.hits[0].name_match);
        assert!(r.hits[0].matches.is_empty()); // name-only hit carries no matches
        assert!(!r.hits[1].name_match);
        assert_eq!(r.hits[1].matches.len(), 1);
    }

    #[test]
    fn search_title_match_counts_as_name_match() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("misc.md"),
            "---\ntitle: Alpha Ideas\n---\nnothing else\n",
        )
        .unwrap();
        let r = search::search_vault(dir.path(), "alpha").unwrap();
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].name_match);
        assert_eq!(r.hits[0].title, "Alpha Ideas");
        // The raw text is searched frontmatter-included, so the `title:` line
        // itself is also an honest content match alongside the name flag.
        assert_eq!(r.hits[0].matches.len(), 1);
        assert_eq!(r.hits[0].matches[0].line, 2);
    }

    #[test]
    fn search_only_scans_markdown_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), "target text\n").unwrap();
        fs::write(dir.path().join("img.png"), b"target\xff\xfe").unwrap();
        fs::write(dir.path().join("doc.md"), "target text\n").unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        let rels: Vec<&str> = r.hits.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(rels, ["doc.md"]);
    }

    #[test]
    fn search_skips_hidden_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".obsidian")).unwrap();
        fs::write(dir.path().join(".obsidian/config.md"), "target\n").unwrap();
        fs::write(dir.path().join("real.md"), "target\n").unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        let rels: Vec<&str> = r.hits.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(rels, ["real.md"]);
    }

    #[test]
    fn search_includes_frontmatter_text() {
        // Raw text is searched, frontmatter included (Obsidian behavior); line
        // numbers are 1-based over the raw file.
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("n.md"),
            "---\ntags: [projectx]\n---\nbody\n",
        )
        .unwrap();
        let r = search::search_vault(dir.path(), "projectx").unwrap();
        assert_eq!(r.hits[0].matches[0].line, 2);
    }

    #[test]
    fn search_reads_non_utf8_notes_lossily() {
        // A Latin-1 note must not error the whole search — it is decoded lossily,
        // like the reader does.
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("latin1.md"), b"caf\xE9 target line\n").unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        assert_eq!(r.hits.len(), 1);
        let m = &r.hits[0].matches[0];
        assert_eq!(slice_chars(&m.snippet, m.ranges[0]), "target");
    }

    #[test]
    #[cfg(unix)]
    fn search_skips_unreadable_files_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("locked.md"), "target\n").unwrap();
        fs::write(dir.path().join("open.md"), "target\n").unwrap();
        fs::set_permissions(
            dir.path().join("locked.md"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let r = search::search_vault(dir.path(), "target").unwrap();
        let rels: Vec<&str> = r.hits.iter().map(|h| h.rel_path.as_str()).collect();
        assert_eq!(rels, ["open.md"]);
    }

    /* ──────────────────────────────  links  ────────────────────────────── */

    /// The edge between two notes regardless of direction (edges are deduped on
    /// the unordered pair, so direction is an implementation detail).
    fn edge<'a>(g: &'a LinkGraph, a: &str, b: &str) -> Option<&'a GraphLink> {
        g.links
            .iter()
            .find(|l| (l.source == a && l.target == b) || (l.source == b && l.target == a))
    }

    #[test]
    fn graph_extracts_all_wikilink_forms_and_embeds() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("a.md"),
            "[[b]] then [[b|alias]] then [[b#head]] then [[b#head|alias]] and ![[c]]\n",
        )
        .unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("c.md"), "").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 2); // the four b-forms dedupe; the embed counts
        assert!(edge(&g, "a.md", "b.md").is_some());
        assert!(edge(&g, "a.md", "c.md").is_some());
    }

    #[test]
    fn graph_resolves_path_qualified_wikilinks_by_suffix() {
        // [[projects/note]] resolves by case-insensitive rel-path suffix, and the
        // suffix must be segment-aligned: neither other/note.md nor
        // xprojects/note.md may match.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("deep/projects")).unwrap();
        fs::create_dir(dir.path().join("other")).unwrap();
        fs::create_dir(dir.path().join("xprojects")).unwrap();
        fs::write(dir.path().join("deep/projects/note.md"), "").unwrap();
        fs::write(dir.path().join("other/note.md"), "").unwrap();
        fs::write(dir.path().join("xprojects/note.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "[[Projects/Note]]\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 1);
        assert!(edge(&g, "a.md", "deep/projects/note.md").is_some());
    }

    #[test]
    fn graph_resolves_relative_markdown_links() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("root.md"), "").unwrap();
        fs::write(dir.path().join("a/two.md"), "").unwrap();
        fs::write(dir.path().join("a/my note.md"), "").unwrap();
        fs::write(
            dir.path().join("a/one.md"),
            "[t](./two.md#section) and [r](../root.md) and [s](my%20note.md)\n\
             [h](https://example.com/x.md) [m](mailto:a@b.md) [abs](/etc/notes.md)\n\
             [esc](../../outside.md)\n",
        )
        .unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 3);
        assert!(edge(&g, "a/one.md", "a/two.md").is_some()); // ./ + #fragment stripped
        assert!(edge(&g, "a/one.md", "root.md").is_some()); // ../
        assert!(edge(&g, "a/one.md", "a/my note.md").is_some()); // %20 decoded
        assert_eq!(g.nodes.len(), 4); // scheme/absolute/escaping targets: no ghosts
    }

    #[test]
    fn graph_ignores_links_in_code_blocks_and_spans() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("c.md"), "").unwrap();
        fs::write(
            dir.path().join("a.md"),
            "```\n[[b]]\n```\ninline `[[b]]` span\n[[c]]\n",
        )
        .unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 1);
        assert!(edge(&g, "a.md", "c.md").is_some());
    }

    #[test]
    fn graph_unclosed_fence_masks_to_end_of_note() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("c.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "[[b]]\n```\n[[c]] never closed\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 1); // only the pre-fence link survives
        assert!(edge(&g, "a.md", "b.md").is_some());
    }

    #[test]
    fn graph_wikilinks_resolve_case_insensitively_with_or_without_md() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Target.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "[[tArGeT]]\n").unwrap();
        fs::write(dir.path().join("b.md"), "[[TARGET.MD]]\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert!(edge(&g, "a.md", "Target.md").is_some());
        assert!(edge(&g, "b.md", "Target.md").is_some());
    }

    #[test]
    fn graph_ambiguous_wikilink_prefers_shortest_then_lexicographic() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("x")).unwrap();
        fs::create_dir(dir.path().join("y")).unwrap();
        fs::write(dir.path().join("x/dup.md"), "").unwrap();
        fs::write(dir.path().join("y/dup.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "[[dup]]\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        // Equal-length candidates → lexicographic pins x/dup.md (the tiebreak).
        assert!(edge(&g, "a.md", "x/dup.md").is_some());
        assert!(edge(&g, "a.md", "y/dup.md").is_none());
        // A shorter root-level candidate beats both.
        fs::write(dir.path().join("dup.md"), "").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert!(edge(&g, "a.md", "dup.md").is_some());
        assert!(edge(&g, "a.md", "x/dup.md").is_none());
    }

    #[test]
    fn graph_skips_unresolved_and_self_links() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "[[ghost]] and [[a]]\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.nodes.len(), 1); // no ghost node for the unresolved target
        assert!(g.links.is_empty()); // the self-link is dropped
    }

    #[test]
    fn graph_dedupes_edges_on_the_unordered_pair() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "[[b]] and again [[b]]\n").unwrap();
        fs::write(dir.path().join("b.md"), "[[a]]\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.links.len(), 1); // A→B twice + B→A = one edge
    }

    #[test]
    fn graph_includes_orphans_with_cluster_and_title() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Research")).unwrap();
        fs::write(dir.path().join("Research/deep.md"), "# Deep Dive\ntext\n").unwrap();
        fs::write(dir.path().join("solo.md"), "no links at all\n").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert!(g.links.is_empty());
        let deep = g.nodes.iter().find(|n| n.id == "Research/deep.md").unwrap();
        assert_eq!(deep.cluster, "Research");
        assert_eq!(deep.title, "Deep Dive"); // H1 title — same rule as the reader
        let solo = g.nodes.iter().find(|n| n.id == "solo.md").unwrap();
        assert_eq!(solo.cluster, ""); // root-level notes get the "" cluster
        assert_eq!(solo.title, "solo");
    }

    #[test]
    fn graph_bridge_flags_cross_cluster_links_only() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("A")).unwrap();
        fs::create_dir(dir.path().join("B")).unwrap();
        fs::write(dir.path().join("A/one.md"), "[[two]] [[three]]\n").unwrap();
        fs::write(dir.path().join("A/two.md"), "").unwrap();
        fs::write(dir.path().join("B/three.md"), "").unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert!(!edge(&g, "A/one.md", "A/two.md").unwrap().bridge);
        assert!(edge(&g, "A/one.md", "B/three.md").unwrap().bridge);
    }

    #[test]
    fn graph_of_empty_vault_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert!(g.nodes.is_empty());
        assert!(g.links.is_empty());
    }

    #[test]
    fn graph_title_agrees_with_read_note() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("n.md");
        fs::write(&f, "---\ntitle: Frontmatter Wins\n---\n# H1 Loses\n").unwrap();
        let doc = note::read_note(dir.path(), &f).unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.nodes[0].title, doc.title);
    }

    #[test]
    #[cfg(unix)]
    fn graph_keeps_node_for_unreadable_note() {
        // An unreadable note must not fail the whole graph — it stays a node
        // (titled by stem, links skipped) and the failure is logged, not silent.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("locked.md"), "[[open]]\n").unwrap();
        fs::write(dir.path().join("open.md"), "").unwrap();
        fs::set_permissions(
            dir.path().join("locked.md"),
            fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let g = links::read_link_graph(dir.path()).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert!(g.links.is_empty());
        let locked = g.nodes.iter().find(|n| n.id == "locked.md").unwrap();
        assert_eq!(locked.title, "locked");
    }
}
