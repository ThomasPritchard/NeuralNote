//! NeuralNote core — the client-agnostic vault domain.
//!
//! Open/create vaults, scan the file tree, read/write markdown notes (with
//! frontmatter), and do file/folder CRUD — all vault-scoped and safe. No
//! dependency on Tauri or any UI, so other clients can reuse this verbatim.

pub mod entries;
pub mod error;
pub mod model;
pub mod note;
pub mod paths;
pub mod recents;
pub mod tree;
pub mod vault;

pub use error::{CoreError, CoreResult};
pub use model::{EntryKind, NoteDoc, RecentVault, TreeNode, Vault};

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
}
