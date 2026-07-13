mod support;

use neuralnote_core::ai::{
    note_content_hash, write_note_policy, NoteKind, NotePathState, NoteWriteBackend,
    NoteWriteParent, OpenedNoteParent, UnavailableNoteWriter, UndoCheck, WriteBudget, WriteOutcome,
    WriteSession, WRITES_PER_WORK_ITEM,
};
use neuralnote_core::{CoreError, CoreResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use support::FsBackend;

struct FailingBackend;

struct FailingParent;

struct RacingExistingBackend;

struct StoredParentBackend;

struct RacingCollisionBackend {
    collided_state: NotePathState,
}

struct RacingLiteratureBackend;

struct OutsideCanonicalParentBackend {
    canonical_root: PathBuf,
    outside: PathBuf,
}

struct ParentCanonicalizeErrorBackend {
    root: PathBuf,
    canonical_root: PathBuf,
}

struct OutsideOpenedParentBackend {
    outside: PathBuf,
}

struct RacingExistingParent {
    collided: AtomicBool,
}

struct RacingCollisionParent {
    collided: AtomicBool,
    collided_state: NotePathState,
}

struct RacingLiteratureParent {
    collided: AtomicBool,
}

impl NoteWriteBackend for FailingBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Ok(OpenedNoteParent::new(
            _canonical_parent.to_path_buf(),
            Box::new(FailingParent),
        ))
    }
}

impl NoteWriteParent for FailingParent {
    fn probe(&self, _leaf: &str) -> CoreResult<NotePathState> {
        Ok(NotePathState::Missing)
    }

    fn create_new_all_or_nothing(&self, _leaf: &str, _content: &str) -> CoreResult<()> {
        Err(CoreError::Io("disk failed".into()))
    }
}

impl NoteWriteBackend for RacingExistingBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Ok(OpenedNoteParent::new(
            _canonical_parent.to_path_buf(),
            Box::new(RacingExistingParent {
                collided: AtomicBool::new(false),
            }),
        ))
    }
}

impl NoteWriteParent for RacingExistingParent {
    fn probe(&self, _leaf: &str) -> CoreResult<NotePathState> {
        if self.collided.load(Ordering::SeqCst) {
            Ok(NotePathState::RegularFile {
                actual_name: "concept.md".into(),
            })
        } else {
            Ok(NotePathState::Missing)
        }
    }

    fn create_new_all_or_nothing(&self, leaf: &str, _content: &str) -> CoreResult<()> {
        self.collided.store(true, Ordering::SeqCst);
        Err(CoreError::AlreadyExists(leaf.into()))
    }
}

impl NoteWriteBackend for RacingCollisionBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Ok(OpenedNoteParent::new(
            canonical_parent.to_path_buf(),
            Box::new(RacingCollisionParent {
                collided: AtomicBool::new(false),
                collided_state: self.collided_state.clone(),
            }),
        ))
    }
}

impl NoteWriteParent for RacingCollisionParent {
    fn probe(&self, _leaf: &str) -> CoreResult<NotePathState> {
        if self.collided.load(Ordering::SeqCst) {
            Ok(self.collided_state.clone())
        } else {
            Ok(NotePathState::Missing)
        }
    }

    fn create_new_all_or_nothing(&self, leaf: &str, _content: &str) -> CoreResult<()> {
        self.collided.store(true, Ordering::SeqCst);
        Err(CoreError::AlreadyExists(leaf.into()))
    }
}

impl NoteWriteBackend for RacingLiteratureBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Ok(OpenedNoteParent::new(
            canonical_parent.to_path_buf(),
            Box::new(RacingLiteratureParent {
                collided: AtomicBool::new(false),
            }),
        ))
    }
}

impl NoteWriteParent for RacingLiteratureParent {
    fn probe(&self, _leaf: &str) -> CoreResult<NotePathState> {
        Ok(NotePathState::Missing)
    }

    fn create_new_all_or_nothing(&self, leaf: &str, _content: &str) -> CoreResult<()> {
        if self.collided.swap(true, Ordering::SeqCst) {
            Ok(())
        } else {
            Err(CoreError::AlreadyExists(leaf.into()))
        }
    }
}

impl NoteWriteBackend for OutsideCanonicalParentBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        if path.ends_with("Inside") {
            Ok(self.outside.clone())
        } else {
            Ok(self.canonical_root.clone())
        }
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Err(CoreError::Io(
            "outside canonical parent should be rejected before opening".into(),
        ))
    }
}

impl NoteWriteBackend for ParentCanonicalizeErrorBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        if path == self.root {
            Ok(self.canonical_root.clone())
        } else {
            Err(CoreError::OutsideVault("backend refused parent".into()))
        }
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Err(CoreError::Io(
            "parent canonicalize error should be returned before opening".into(),
        ))
    }
}

impl NoteWriteBackend for OutsideOpenedParentBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        _canonical_root: &Path,
        _canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        Ok(OpenedNoteParent::new(
            self.outside.clone(),
            Box::new(FailingParent),
        ))
    }
}

impl NoteWriteBackend for StoredParentBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        let requested_name = path.file_name().map(|name| name.to_string_lossy());
        if requested_name.as_deref() == Some("atomic") {
            let stored = path.with_file_name("Atomic");
            return stored.canonicalize().map_err(CoreError::from);
        }
        path.canonicalize().map_err(CoreError::from)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        FsBackend.open_parent(canonical_root, canonical_parent)
    }
}

fn session(items: usize) -> WriteSession {
    WriteSession::new(items).unwrap()
}

fn write(
    root: &Path,
    rel_path: &str,
    content: &str,
    kind: NoteKind,
    work_item: usize,
    session: &mut WriteSession,
) -> CoreResult<WriteOutcome> {
    write_note_policy(
        root, rel_path, content, kind, work_item, &FsBackend, session,
    )
}

#[test]
fn literature_and_transcript_collisions_suffix_from_two_upward() {
    for kind in [NoteKind::Literature, NoteKind::Transcript] {
        let vault = tempfile::tempdir().unwrap();
        fs::write(vault.path().join("Name.md"), "old").unwrap();
        fs::write(vault.path().join("Name 2.md"), "older").unwrap();
        let mut run = session(1);

        let outcome = write(vault.path(), "Name.md", "new", kind, 0, &mut run).unwrap();

        assert!(matches!(
            outcome,
            WriteOutcome::Created { ref rel_path, written_kind, .. }
                if rel_path == "Name 3.md" && written_kind == kind
        ));
        assert_eq!(
            fs::read_to_string(vault.path().join("Name.md")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(vault.path().join("Name 3.md")).unwrap(),
            "new"
        );
        assert_eq!(run.ledger().entries().len(), 1);
    }
}

#[test]
fn atomic_collision_returns_existing_without_write_budget_or_ledger_entry() {
    let vault = tempfile::tempdir().unwrap();
    fs::write(vault.path().join("Concept.md"), "user-owned").unwrap();
    let mut run = session(1);

    let outcome = write(
        vault.path(),
        "Concept.md",
        "replacement",
        NoteKind::Atomic,
        0,
        &mut run,
    )
    .unwrap();

    assert_eq!(
        outcome,
        WriteOutcome::Existing {
            rel_path: "Concept.md".into()
        }
    );
    assert_eq!(
        fs::read_to_string(vault.path().join("Concept.md")).unwrap(),
        "user-owned"
    );
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn atomic_create_race_reprobes_and_returns_the_stored_existing_path() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);

    let outcome = write_note_policy(
        vault.path(),
        "Concept.md",
        "replacement",
        NoteKind::Atomic,
        0,
        &RacingExistingBackend,
        &mut run,
    )
    .unwrap();

    assert_eq!(
        outcome,
        WriteOutcome::Existing {
            rel_path: "concept.md".into()
        }
    );
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn atomic_create_race_rejects_a_collision_that_disappears_before_reprobe() {
    let vault = tempfile::tempdir().unwrap();
    let backend = RacingCollisionBackend {
        collided_state: NotePathState::Missing,
    };
    let mut run = session(1);

    let error = write_note_policy(
        vault.path(),
        "Concept.md",
        "replacement",
        NoteKind::Atomic,
        0,
        &backend,
        &mut run,
    )
    .unwrap_err();

    match error {
        CoreError::Conflict(message) => assert!(
            message.contains(
                "atomic note collision at 'Concept.md' disappeared before it could be inspected"
            ),
            "unexpected conflict: {message}"
        ),
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn atomic_create_race_rejects_a_collision_that_is_not_a_regular_file() {
    let vault = tempfile::tempdir().unwrap();
    let backend = RacingCollisionBackend {
        collided_state: NotePathState::Other,
    };
    let mut run = session(1);

    let error = write_note_policy(
        vault.path(),
        "Concept.md",
        "replacement",
        NoteKind::Atomic,
        0,
        &backend,
        &mut run,
    )
    .unwrap_err();

    match error {
        CoreError::Conflict(message) => assert!(
            message.contains("atomic note collision at 'Concept.md' is not a regular file"),
            "unexpected conflict: {message}"
        ),
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn literature_create_race_retries_with_a_suffixed_name() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);

    let outcome = write_note_policy(
        vault.path(),
        "Name.md",
        "content",
        NoteKind::Literature,
        0,
        &RacingLiteratureBackend,
        &mut run,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        WriteOutcome::Created {
            rel_path,
            written_kind: NoteKind::Literature,
            ..
        } if rel_path == "Name 2.md"
    ));
    assert_eq!(run.budget().total_writes(), 1);
    assert_eq!(run.ledger().entries()[0].rel_path, "Name 2.md");
}

#[test]
fn atomic_collision_returns_the_filesystems_stored_case_and_normalisation() {
    for (stored, requested) in [
        ("Concept.md", "concept.md"),
        ("Caf\u{e9}.md", "Cafe\u{301}.md"),
    ] {
        let vault = tempfile::tempdir().unwrap();
        fs::write(vault.path().join(stored), "existing").unwrap();
        if !vault.path().join(requested).try_exists().unwrap() {
            // This filesystem treats the pair as distinct, so there is no
            // collision whose stored spelling needs resolving.
            continue;
        }
        let mut run = session(1);

        let outcome = write(
            vault.path(),
            requested,
            "replacement",
            NoteKind::Atomic,
            0,
            &mut run,
        )
        .unwrap();

        assert_eq!(
            outcome,
            WriteOutcome::Existing {
                rel_path: stored.into()
            }
        );
        assert!(run.ledger().entries().is_empty());
    }
}

#[test]
fn valid_nested_path_is_created_inside_existing_parent() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Literature")).unwrap();
    let mut run = session(1);

    let outcome = write(
        vault.path(),
        "Literature/Alpha β.md",
        "content",
        NoteKind::Literature,
        0,
        &mut run,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        WriteOutcome::Created { rel_path, .. } if rel_path == "Literature/Alpha β.md"
    ));
}

#[test]
fn created_and_ledger_paths_use_the_filesystems_stored_parent_spelling() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Atomic")).unwrap();
    let mut run = session(1);

    let outcome = write_note_policy(
        vault.path(),
        "atomic/New.md",
        "content",
        NoteKind::Literature,
        0,
        &StoredParentBackend,
        &mut run,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        WriteOutcome::Created { rel_path, .. } if rel_path == "Atomic/New.md"
    ));
    assert_eq!(run.ledger().entries()[0].rel_path, "Atomic/New.md");
    assert!(vault.path().join("Atomic/New.md").exists());
}

#[test]
fn traversal_absolute_and_weird_paths_are_rejected() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Folder")).unwrap();

    for path in [
        "../escape.md",
        "Folder/../../escape.md",
        "/tmp/absolute.md",
        "C:/Windows/absolute.md",
        "\\\\server\\share\\note.md",
        "",
        ".",
        "./Name.md",
        "Folder//Name.md",
        "Folder/",
        "Folder\\Name.md",
        ".hidden/Name.md",
        "bad:name.md",
        "question?.md",
        "quote\".md",
        "CON.md",
        "nul.txt.md",
        "COM1.md",
        "COM¹.md",
        "LPT².log.md",
        " NUL.md",
        "CON .md",
        "Folder./Name.md",
        "Folder /Name.md",
        "Name.txt",
        "bad\0name.md",
    ] {
        let mut run = session(1);
        let error = write(
            vault.path(),
            path,
            "content",
            NoteKind::Literature,
            0,
            &mut run,
        )
        .unwrap_err();
        assert!(
            matches!(
                error,
                CoreError::OutsideVault(_) | CoreError::InvalidName(_)
            ),
            "{path:?} produced {error:?}"
        );
        assert!(run.ledger().entries().is_empty());
    }
}

#[test]
fn atomic_collision_with_a_directory_is_rejected_as_not_a_note() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Concept.md")).unwrap();
    let mut run = session(1);

    assert!(write(
        vault.path(),
        "Concept.md",
        "replacement",
        NoteKind::Atomic,
        0,
        &mut run,
    )
    .is_err());
    assert!(run.ledger().entries().is_empty());
}

#[cfg(unix)]
struct SwappingBackend {
    vault: PathBuf,
    outside: PathBuf,
    swapped: AtomicBool,
}

#[cfg(unix)]
struct InVaultSwappingBackend {
    vault: PathBuf,
    swapped: AtomicBool,
}

#[cfg(unix)]
impl NoteWriteBackend for SwappingBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        let canonical = path.canonicalize().map_err(CoreError::from)?;
        if path == self.vault.join("Swap") && !self.swapped.swap(true, Ordering::SeqCst) {
            fs::rename(path, self.vault.join("Swap original")).unwrap();
            std::os::unix::fs::symlink(&self.outside, path).unwrap();
        }
        Ok(canonical)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        FsBackend.open_parent(canonical_root, canonical_parent)
    }
}

#[cfg(unix)]
impl NoteWriteBackend for InVaultSwappingBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        let canonical = path.canonicalize().map_err(CoreError::from)?;
        if path == self.vault.join("Foo") && !self.swapped.swap(true, Ordering::SeqCst) {
            fs::rename(path, self.vault.join("Foo original")).unwrap();
            std::os::unix::fs::symlink(self.vault.join("Bar"), path).unwrap();
        }
        Ok(canonical)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        FsBackend.open_parent(canonical_root, canonical_parent)
    }
}

#[cfg(unix)]
#[test]
fn parent_swap_between_validation_and_create_cannot_escape_the_vault() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Swap")).unwrap();
    let backend = SwappingBackend {
        vault: vault.path().to_path_buf(),
        outside: outside.path().to_path_buf(),
        swapped: AtomicBool::new(false),
    };
    let mut run = session(1);

    let result = write_note_policy(
        vault.path(),
        "Swap/Owned.md",
        "content",
        NoteKind::Literature,
        0,
        &backend,
        &mut run,
    );

    assert!(matches!(result, Err(CoreError::OutsideVault(_))));
    assert!(!outside.path().join("Owned.md").exists());
    assert!(run.ledger().entries().is_empty());
}

#[cfg(unix)]
#[test]
fn in_vault_parent_swap_reports_and_records_the_directory_actually_opened() {
    let vault = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Foo")).unwrap();
    fs::create_dir(vault.path().join("Bar")).unwrap();
    let backend = InVaultSwappingBackend {
        vault: vault.path().to_path_buf(),
        swapped: AtomicBool::new(false),
    };
    let mut run = session(1);

    let outcome = write_note_policy(
        vault.path(),
        "Foo/New.md",
        "content",
        NoteKind::Literature,
        0,
        &backend,
        &mut run,
    )
    .unwrap();

    assert!(matches!(
        outcome,
        WriteOutcome::Created { rel_path, .. } if rel_path == "Bar/New.md"
    ));
    assert_eq!(run.ledger().entries()[0].rel_path, "Bar/New.md");
    assert!(vault.path().join("Bar/New.md").exists());
}

#[test]
fn canonical_parent_outside_the_vault_is_rejected_by_core() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let backend = OutsideCanonicalParentBackend {
        canonical_root: vault.path().canonicalize().unwrap(),
        outside: outside.path().canonicalize().unwrap(),
    };
    let mut run = session(1);

    let error = write_note_policy(
        vault.path(),
        "Inside/Owned.md",
        "content",
        NoteKind::Literature,
        0,
        &backend,
        &mut run,
    )
    .unwrap_err();

    match error {
        CoreError::OutsideVault(path) => assert_eq!(path, "Inside/Owned.md"),
        other => panic!("expected outside-vault error, got {other:?}"),
    }
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn parent_canonicalize_outside_vault_error_is_preserved() {
    let vault = tempfile::tempdir().unwrap();
    let backend = ParentCanonicalizeErrorBackend {
        root: vault.path().to_path_buf(),
        canonical_root: vault.path().canonicalize().unwrap(),
    };
    let mut run = session(1);

    let error = write_note_policy(
        vault.path(),
        "Inside/Owned.md",
        "content",
        NoteKind::Literature,
        0,
        &backend,
        &mut run,
    )
    .unwrap_err();

    match error {
        CoreError::OutsideVault(message) => assert_eq!(message, "backend refused parent"),
        other => panic!("expected outside-vault error, got {other:?}"),
    }
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn opened_parent_outside_the_vault_is_rejected_by_core() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(vault.path().join("Inside")).unwrap();
    let backend = OutsideOpenedParentBackend {
        outside: outside.path().canonicalize().unwrap(),
    };
    let mut run = session(1);

    let error = write_note_policy(
        vault.path(),
        "Inside/Owned.md",
        "content",
        NoteKind::Literature,
        0,
        &backend,
        &mut run,
    )
    .unwrap_err();

    match error {
        CoreError::OutsideVault(path) => assert_eq!(path, "Inside/Owned.md"),
        other => panic!("expected outside-vault error, got {other:?}"),
    }
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn missing_parent_is_rejected_instead_of_created_by_core() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);

    assert!(matches!(
        write(
            vault.path(),
            "Missing/Name.md",
            "content",
            NoteKind::Literature,
            0,
            &mut run,
        ),
        Err(CoreError::NotFound(_) | CoreError::Io(_))
    ));
}

#[cfg(unix)]
#[test]
fn symlinked_parent_cannot_escape_the_vault() {
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), vault.path().join("escape")).unwrap();
    let mut run = session(1);

    assert!(matches!(
        write(
            vault.path(),
            "escape/Owned.md",
            "content",
            NoteKind::Literature,
            0,
            &mut run,
        ),
        Err(CoreError::OutsideVault(_))
    ));
    assert!(!outside.path().join("Owned.md").exists());
}

#[test]
fn write_budget_rejects_a_work_item_count_that_overflows_the_run_cap() {
    let error = WriteBudget::new(usize::MAX).unwrap_err();

    match error {
        CoreError::InvalidName(message) => assert!(
            message.contains("work item count overflows the write budget"),
            "unexpected invalid-name error: {message}"
        ),
        other => panic!("expected invalid-name error, got {other:?}"),
    }
}

#[test]
fn write_budget_reports_its_derived_total_cap() {
    let budget = WriteBudget::new(3).unwrap();

    assert_eq!(budget.total_cap(), 3 * WRITES_PER_WORK_ITEM);
}

#[test]
fn one_item_allows_eight_creates_and_names_the_cap_on_the_ninth() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);

    for index in 0..WRITES_PER_WORK_ITEM {
        write(
            vault.path(),
            &format!("Note {index}.md"),
            "content",
            NoteKind::Literature,
            0,
            &mut run,
        )
        .unwrap();
    }
    let error = write(
        vault.path(),
        "One too many.md",
        "content",
        NoteKind::Literature,
        0,
        &mut run,
    )
    .unwrap_err()
    .to_string();

    assert!(error.contains("8 writes per work item"));
    assert!(error.contains("run cap 8"));
    assert_eq!(run.budget().total_writes(), 8);
}

#[test]
fn three_items_enforce_each_eight_and_derive_a_twenty_four_write_run_cap() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(3);

    for item in 0..3 {
        for index in 0..WRITES_PER_WORK_ITEM {
            write(
                vault.path(),
                &format!("Item {item} Note {index}.md"),
                "content",
                NoteKind::Literature,
                item,
                &mut run,
            )
            .unwrap();
        }
    }
    let error = write(
        vault.path(),
        "Twenty fifth.md",
        "content",
        NoteKind::Literature,
        2,
        &mut run,
    )
    .unwrap_err()
    .to_string();

    assert!(error.contains("run cap 24"));
    assert_eq!(run.budget().total_writes(), 24);
}

#[test]
fn zero_items_and_out_of_range_work_item_are_rejected() {
    let vault = tempfile::tempdir().unwrap();
    let mut zero = session(0);
    assert!(write(
        vault.path(),
        "Name.md",
        "content",
        NoteKind::Literature,
        0,
        &mut zero,
    )
    .is_err());

    let mut one = session(1);
    assert!(write(
        vault.path(),
        "Name.md",
        "content",
        NoteKind::Literature,
        1,
        &mut one,
    )
    .is_err());
}

#[test]
fn write_failure_consumes_no_budget_and_records_no_undo_entry() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);

    assert!(write_note_policy(
        vault.path(),
        "Name.md",
        "content",
        NoteKind::Literature,
        0,
        &FailingBackend,
        &mut run,
    )
    .is_err());
    assert_eq!(run.budget().total_writes(), 0);
    assert!(run.ledger().entries().is_empty());
}

#[test]
fn write_session_can_expand_monotonically_for_validated_playlist_items() {
    let mut run = WriteSession::new(1).unwrap();

    run.ensure_work_items(3).unwrap();
    run.ensure_work_items(2).unwrap();

    assert_eq!(run.budget().work_item_count(), 3);
    assert_eq!(run.budget().total_cap(), 3 * WRITES_PER_WORK_ITEM);
}

#[test]
fn failed_playlist_budget_expansion_preserves_the_existing_budget() {
    let mut run = WriteSession::new(2).unwrap();

    assert!(run.ensure_work_items(usize::MAX).is_err());

    assert_eq!(run.budget().work_item_count(), 2);
    assert_eq!(run.budget().total_cap(), 2 * WRITES_PER_WORK_ITEM);
}

#[test]
fn unavailable_shell_writer_surfaces_the_deferred_integration() {
    let unavailable = UnavailableNoteWriter;
    let root_error = unavailable
        .canonicalize(Path::new("/vault"))
        .unwrap_err()
        .to_string();
    let parent_error = match unavailable.open_parent(Path::new("/vault"), Path::new("/vault")) {
        Ok(_) => panic!("unavailable writer unexpectedly opened a parent"),
        Err(error) => error.to_string(),
    };

    assert!(root_error.contains("not wired"));
    assert!(parent_error.contains("not wired"));
}

#[test]
fn undo_refuses_when_current_hash_no_longer_matches_written_content() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);
    write(
        vault.path(),
        "Name.md",
        "original",
        NoteKind::Literature,
        0,
        &mut run,
    )
    .unwrap();

    assert_eq!(
        run.ledger()
            .check_hash("Name.md", &note_content_hash("original")),
        UndoCheck::Allowed
    );
    assert!(matches!(
        run.ledger()
            .check_hash("Name.md", &note_content_hash("user edit")),
        UndoCheck::RefusedHashMismatch { .. }
    ));
    assert_eq!(
        run.ledger().check_hash("Unknown.md", "anything"),
        UndoCheck::NotRecorded
    );
}

#[test]
fn partial_undo_retains_only_entries_that_still_have_delete_authority() {
    let vault = tempfile::tempdir().unwrap();
    let mut run = session(1);
    for rel_path in ["Terminal.md", "Retry.md"] {
        write(
            vault.path(),
            rel_path,
            "content",
            NoteKind::Literature,
            0,
            &mut run,
        )
        .unwrap();
    }
    let mut ledger = run.into_ledger();

    ledger.retain_entries(|entry| entry.rel_path == "Retry.md");

    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(ledger.entries()[0].rel_path, "Retry.md");
}
