//! Bounded, vault-scoped, content-safe Undo for files created by one skill run.

#[cfg(unix)]
use super::note_writer::{CheckedUnlink, ReadLeaf, StableDirectory};
use neuralnote_core::ai::UndoLedger;
#[cfg(unix)]
use neuralnote_core::ai::{note_content_hash, UndoCheck};
use neuralnote_core::{CoreError, CoreResult};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use ts_rs::TS;

const MAX_UNDO_RUNS: usize = 8;
#[cfg(test)]
static CHAT_RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Per-file Undo outcome. Every non-deletion carries a user-facing reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) enum UndoFileStatus {
    Deleted,
    SkippedEdited,
    SkippedMissing,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct UndoFileResult {
    pub(crate) rel_path: String,
    pub(crate) status: UndoFileStatus,
    pub(crate) message: Option<String>,
}

impl UndoFileResult {
    fn new(rel_path: impl Into<String>, status: UndoFileStatus, message: Option<String>) -> Self {
        Self {
            rel_path: rel_path.into(),
            status,
            message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct UndoReport {
    pub(crate) files: Vec<UndoFileResult>,
}

pub(crate) struct StoredUndoRun {
    pub(crate) canonical_root: PathBuf,
    pub(crate) ledger: UndoLedger,
}

/// The last few non-empty run ledgers. Eight bounds memory and limits the lifetime
/// of delete authority while still covering the report cards a chat pane can
/// realistically keep visible.
#[derive(Default)]
pub(crate) struct UndoRunStore {
    runs: HashMap<String, StoredUndoRun>,
    order: VecDeque<String>,
}

impl UndoRunStore {
    pub(crate) fn insert(&mut self, run_id: String, canonical_root: PathBuf, ledger: UndoLedger) {
        if ledger.entries().is_empty() {
            return;
        }
        if self.runs.remove(&run_id).is_some() {
            self.order.retain(|stored| stored != &run_id);
        }
        while self.runs.len() >= MAX_UNDO_RUNS {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.runs.remove(&oldest);
        }
        self.order.push_back(run_id.clone());
        self.runs.insert(
            run_id,
            StoredUndoRun {
                canonical_root,
                ledger,
            },
        );
    }

    pub(crate) fn root_for(&self, run_id: &str) -> CoreResult<PathBuf> {
        self.runs
            .get(run_id)
            .map(|run| run.canonical_root.clone())
            .ok_or_else(|| unavailable_undo(run_id))
    }

    pub(crate) fn take_for_root(
        &mut self,
        run_id: &str,
        canonical_root: &Path,
    ) -> CoreResult<StoredUndoRun> {
        let stored_root = self.root_for(run_id)?;
        if stored_root != canonical_root {
            return Err(CoreError::Conflict(format!(
                "skill run '{run_id}' belongs to a different vault"
            )));
        }
        self.order.retain(|stored| stored != run_id);
        self.runs
            .remove(run_id)
            .ok_or_else(|| unavailable_undo(run_id))
    }

    /// Restore a run reserved by `take_for_root` after retryable filesystem failure.
    pub(crate) fn restore(&mut self, run_id: String, stored: StoredUndoRun) {
        self.insert(run_id, stored.canonical_root, stored.ledger);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.runs.len()
    }

    #[cfg(test)]
    fn contains(&self, run_id: &str) -> bool {
        self.runs.contains_key(run_id)
    }
}

fn unavailable_undo(run_id: &str) -> CoreError {
    CoreError::NotFound(format!(
        "no undo available for skill run '{run_id}': it may already have been used, expired (only the last {MAX_UNDO_RUNS} runs are undoable), or never existed"
    ))
}

#[cfg(test)]
pub(crate) fn next_chat_run_id() -> String {
    let sequence = CHAT_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("chat-run-{}-{sequence}", std::process::id())
}

/// Apply one ledger as a best-effort report. Each entry is validated independently,
/// so an edited or missing note never hides successful deletions of its unchanged
/// siblings; the command decides whether the report is terminal or retryable.
#[cfg(unix)]
pub(crate) fn undo_ledger(root: &Path, ledger: &UndoLedger) -> UndoReport {
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            return UndoReport {
                files: ledger
                    .entries()
                    .iter()
                    .map(|entry| {
                        UndoFileResult::new(
                            &entry.rel_path,
                            UndoFileStatus::Failed,
                            Some(format!("vault root is unavailable: {error}")),
                        )
                    })
                    .collect(),
            }
        }
    };
    UndoReport {
        files: ledger
            .entries()
            .iter()
            .map(|entry| undo_entry(&canonical_root, ledger, &entry.rel_path))
            .collect(),
    }
}

/// Windows does not yet have the descriptor-confined filesystem capability used
/// by Undo. Preserve every file and report the unavailable boundary explicitly.
#[cfg(not(unix))]
pub(crate) fn undo_ledger(_root: &Path, ledger: &UndoLedger) -> UndoReport {
    UndoReport {
        files: ledger
            .entries()
            .iter()
            .map(|entry| {
                failed(
                    &entry.rel_path,
                    "secure skill Undo is not supported on this platform".into(),
                )
            })
            .collect(),
    }
}

#[cfg(unix)]
fn undo_entry(canonical_root: &Path, ledger: &UndoLedger, rel_path: &str) -> UndoFileResult {
    let (parent_rel, leaf) = match validate_undo_rel_path(rel_path) {
        Ok(parts) => parts,
        Err(error) => return failed(rel_path, error.to_string()),
    };
    let parent = canonical_root.join(parent_rel);
    let canonical_parent = match parent.canonicalize() {
        Ok(parent) => parent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return missing(rel_path, "file or parent directory is missing")
        }
        Err(error) => {
            return failed(
                rel_path,
                format!(
                    "could not resolve undo parent '{}': {error}",
                    parent.display()
                ),
            )
        }
    };
    if canonical_parent != canonical_root && !canonical_parent.starts_with(canonical_root) {
        return failed(
            rel_path,
            format!(
                "undo parent '{}' resolves outside the vault",
                canonical_parent.display()
            ),
        );
    }
    let parent = match StableDirectory::open_confined(canonical_root, &canonical_parent) {
        Ok(parent) => parent,
        Err(error) => return failed(rel_path, error.to_string()),
    };
    let content = match parent.read_leaf(&leaf) {
        Ok(ReadLeaf::Missing) => return missing(rel_path, "file is missing"),
        Ok(ReadLeaf::Other) => return edited(rel_path, "path is no longer a regular file"),
        Ok(ReadLeaf::Regular(content)) => content,
        Err(error) => return failed(rel_path, error.to_string()),
    };
    let current_hash = note_content_hash(&content);
    // TODO(undo-dup-paths): duplicate rel_path entries in UndoLedger consult only the first hash.
    match ledger.check_hash(rel_path, &current_hash) {
        UndoCheck::RefusedHashMismatch { .. } => {
            return edited(rel_path, "file changed after the skill wrote it")
        }
        UndoCheck::NotRecorded => {
            return failed(rel_path, "path is not recorded in this undo ledger".into())
        }
        UndoCheck::Allowed => {}
    }
    match parent.unlink_if_hash(&leaf, &current_hash) {
        Ok(result) => undo_unlink_result(rel_path, result),
        Err(error) => failed(rel_path, error.to_string()),
    }
}

#[cfg(unix)]
fn undo_unlink_result(rel_path: &str, result: CheckedUnlink) -> UndoFileResult {
    match result {
        CheckedUnlink::Deleted => UndoFileResult::new(rel_path, UndoFileStatus::Deleted, None),
        CheckedUnlink::DeletedUnverified(message) => {
            UndoFileResult::new(rel_path, UndoFileStatus::Deleted, Some(message))
        }
        CheckedUnlink::Missing => missing(rel_path, "file disappeared before deletion"),
        CheckedUnlink::Edited => edited(rel_path, "file changed before deletion"),
        CheckedUnlink::Recreated => edited(
            rel_path,
            "a different file now exists at this path; the note this run wrote was removed",
        ),
        CheckedUnlink::RetryReleased(message) => {
            UndoFileResult::new(rel_path, UndoFileStatus::SkippedEdited, Some(message))
        }
        CheckedUnlink::Other => edited(
            rel_path,
            "path stopped being a regular file before deletion",
        ),
    }
}

// TODO(vault-rel-path): unify validate_note_path (write_policy.rs) and validate_undo_rel_path (skills/undo.rs) behind a core VaultRelPath newtype.
#[cfg(unix)]
fn validate_undo_rel_path(rel_path: &str) -> CoreResult<(PathBuf, String)> {
    if rel_path.trim().is_empty()
        || rel_path.starts_with(['/', '\\'])
        || rel_path.contains('\\')
        || has_windows_drive_prefix(rel_path)
    {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }
    let components = rel_path.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(CoreError::OutsideVault(rel_path.to_string()));
    }
    for component in &components {
        neuralnote_core::paths::validate_name(component)?;
    }
    let leaf = components
        .last()
        .expect("validated non-empty undo path has a leaf")
        .to_string();
    if !leaf
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md"))
    {
        return Err(CoreError::InvalidName(
            "undo ledger path must end in .md".into(),
        ));
    }
    let parent = components[..components.len() - 1].iter().collect();
    Ok((parent, leaf))
}

#[cfg(unix)]
fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn failed(rel_path: &str, message: String) -> UndoFileResult {
    UndoFileResult::new(rel_path, UndoFileStatus::Failed, Some(message))
}

#[cfg(unix)]
fn edited(rel_path: &str, message: &str) -> UndoFileResult {
    UndoFileResult::new(
        rel_path,
        UndoFileStatus::SkippedEdited,
        Some(message.into()),
    )
}

#[cfg(unix)]
fn missing(rel_path: &str, message: &str) -> UndoFileResult {
    UndoFileResult::new(
        rel_path,
        UndoFileStatus::SkippedMissing,
        Some(message.into()),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::skills::FsNoteWriteBackend;
    use neuralnote_core::ai::{write_note_policy, NoteKind, UndoLedger, WriteSession};
    use std::fs;
    use std::os::unix::fs::symlink;

    fn ledger_with_notes(root: &Path, notes: &[(&str, &str)]) -> UndoLedger {
        let backend = FsNoteWriteBackend;
        let mut session = WriteSession::new(1).unwrap();
        for (path, content) in notes {
            if let Some(parent) = Path::new(path)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                fs::create_dir_all(root.join(parent)).unwrap();
            }
            write_note_policy(
                root,
                path,
                content,
                NoteKind::Literature,
                0,
                &backend,
                &mut session,
            )
            .unwrap();
        }
        session.into_ledger()
    }

    #[test]
    fn undo_report_serializes_the_exact_status_vocabulary() {
        let report = UndoReport {
            files: vec![
                UndoFileResult::new("a.md", UndoFileStatus::Deleted, None),
                UndoFileResult::new("b.md", UndoFileStatus::SkippedEdited, Some("edited".into())),
                UndoFileResult::new(
                    "c.md",
                    UndoFileStatus::SkippedMissing,
                    Some("missing".into()),
                ),
                UndoFileResult::new("d.md", UndoFileStatus::Failed, Some("failed".into())),
            ],
        };

        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["files"][0]["status"], "deleted");
        assert_eq!(value["files"][1]["status"], "skippedEdited");
        assert_eq!(value["files"][2]["status"], "skippedMissing");
        assert_eq!(value["files"][3]["status"], "failed");
        assert!(value["files"][0]["message"].is_null());
    }

    #[test]
    fn recreated_file_result_explains_that_the_run_owned_note_was_removed() {
        let result = undo_unlink_result("Recreated.md", CheckedUnlink::Recreated);

        assert_eq!(result.status, UndoFileStatus::SkippedEdited);
        assert_eq!(
            result.message.as_deref(),
            Some("a different file now exists at this path; the note this run wrote was removed")
        );
    }

    #[test]
    fn post_quarantine_failures_do_not_return_retryable_statuses_after_authority_is_gone() {
        let preserved = undo_unlink_result(
            "Preserved.md",
            CheckedUnlink::RetryReleased("preserved under recovery name".into()),
        );
        let deleted = undo_unlink_result(
            "Deleted.md",
            CheckedUnlink::DeletedUnverified("deleted but final check failed".into()),
        );

        assert_eq!(preserved.status, UndoFileStatus::SkippedEdited);
        assert_eq!(
            preserved.message.as_deref(),
            Some("preserved under recovery name")
        );
        assert_eq!(deleted.status, UndoFileStatus::Deleted);
        assert_eq!(
            deleted.message.as_deref(),
            Some("deleted but final check failed")
        );
    }

    #[test]
    fn undo_deletes_unchanged_files() {
        let vault = tempfile::tempdir().unwrap();
        let ledger = ledger_with_notes(vault.path(), &[("Created.md", "original")]);

        let report = undo_ledger(vault.path(), &ledger);

        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].status, UndoFileStatus::Deleted);
        assert_eq!(report.files[0].message, None);
        assert!(!vault.path().join("Created.md").exists());
    }

    #[test]
    fn undo_skips_edited_and_missing_files_with_reasons() {
        let vault = tempfile::tempdir().unwrap();
        let ledger = ledger_with_notes(
            vault.path(),
            &[("Edited.md", "original"), ("Missing.md", "original")],
        );
        fs::write(vault.path().join("Edited.md"), "user edit").unwrap();
        fs::remove_file(vault.path().join("Missing.md")).unwrap();

        let report = undo_ledger(vault.path(), &ledger);

        assert_eq!(report.files[0].status, UndoFileStatus::SkippedEdited);
        assert!(report.files[0]
            .message
            .as_deref()
            .unwrap()
            .contains("changed"));
        assert_eq!(report.files[1].status, UndoFileStatus::SkippedMissing);
        assert!(report.files[1]
            .message
            .as_deref()
            .unwrap()
            .contains("missing"));
        assert_eq!(
            fs::read_to_string(vault.path().join("Edited.md")).unwrap(),
            "user edit"
        );
    }

    #[test]
    fn undo_rejects_a_parent_symlink_swap_without_touching_the_outside_file() {
        let sandbox = tempfile::tempdir().unwrap();
        let vault = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let ledger = ledger_with_notes(&vault, &[("Folder/Created.md", "original")]);
        fs::rename(vault.join("Folder"), vault.join("Folder original")).unwrap();
        fs::write(outside.join("Created.md"), "original").unwrap();
        symlink(&outside, vault.join("Folder")).unwrap();

        let report = undo_ledger(&vault, &ledger);

        assert_eq!(report.files[0].status, UndoFileStatus::Failed);
        assert!(report.files[0]
            .message
            .as_deref()
            .unwrap()
            .contains("outside"));
        assert_eq!(
            fs::read_to_string(outside.join("Created.md")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(vault.join("Folder original/Created.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn undo_path_validation_rejects_untrusted_ledger_shapes() {
        for path in [
            "",
            "/abs.md",
            "../escape.md",
            "a/../../escape.md",
            "a\\b.md",
            "C:/x.md",
        ] {
            assert!(validate_undo_rel_path(path).is_err(), "{path:?} must fail");
        }
        assert_eq!(
            validate_undo_rel_path("Folder/Note.md").unwrap(),
            (PathBuf::from("Folder"), "Note.md".to_string())
        );
    }

    #[test]
    fn undo_store_is_bounded_vault_scoped_and_single_shot() {
        let vault = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let ledger = ledger_with_notes(vault.path(), &[("one.md", "x")]);
        let mut store = UndoRunStore::default();
        for index in 0..9 {
            store.insert(format!("run-{index}"), root.clone(), ledger.clone());
        }

        assert_eq!(store.len(), 8);
        assert!(matches!(
            store.root_for("run-0"),
            Err(CoreError::NotFound(message)) if message.contains("last 8 runs")
        ));
        assert!(matches!(
            store.take_for_root("run-8", &other.path().canonicalize().unwrap()),
            Err(CoreError::Conflict(_))
        ));
        assert!(
            store.contains("run-8"),
            "vault mismatch must preserve the run"
        );
        let taken = store.take_for_root("run-8", &root).unwrap();
        assert_eq!(taken.canonical_root, root);
        assert!(matches!(
            store.take_for_root("run-8", &taken.canonical_root),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn empty_ledgers_are_not_retained_and_run_ids_are_unique() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let mut store = UndoRunStore::default();

        store.insert("empty".into(), root, UndoLedger::default());

        assert_eq!(store.len(), 0);
        let first = next_chat_run_id();
        let second = next_chat_run_id();
        assert_ne!(first, second);
        assert!(first.starts_with("chat-run-"));
    }
}
