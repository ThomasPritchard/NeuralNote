//! Desktop implementations of the core skill I/O seams.

mod elicitation;
#[cfg(unix)]
mod note_writer;
#[cfg(not(unix))]
mod note_writer_unsupported;
#[cfg(unix)]
mod quarantine_recovery;
mod undo;

use neuralnote_core::{ai::UndoLedger, CoreError};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub(crate) use elicitation::{
    CancelChatRunOutcome, PendingElicitations, RunElicitationGuard, ShellUserPrompt,
};
#[cfg(all(unix, test))]
pub(crate) use note_writer::FsNoteWriteBackend;
#[cfg(unix)]
pub(crate) use note_writer::RunNoteWriteBackend;
#[cfg(not(unix))]
pub(crate) use note_writer_unsupported::RunNoteWriteBackend;
#[cfg(unix)]
pub(crate) use quarantine_recovery::{reconcile_quarantine_recovery, QuarantineRecoveryReport};
pub(crate) use undo::{undo_ledger, UndoReport, UndoRunStore};

/// Non-Unix stub of the crash-recovery seam. The undo / cancelled-write quarantine
/// window only exists on the descriptor-confined Unix note-writer, so on other
/// platforms there is nothing to reconcile: recovery is a no-op returning an empty
/// report, keeping `open_vault`'s call site portable (the payload type is generated
/// from the Unix definition, so the frontend contract is identical either way).
#[cfg(not(unix))]
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuarantineRecoveryReport {
    pub(crate) entries: Vec<serde_json::Value>,
}

#[cfg(not(unix))]
pub(crate) fn reconcile_quarantine_recovery(
    _canonical_root: &std::path::Path,
) -> QuarantineRecoveryReport {
    QuarantineRecoveryReport::default()
}

pub(crate) fn retain_chat_undo_ledger(
    state: &Mutex<crate::AppState>,
    run_id: String,
    canonical_root: PathBuf,
    ledger: Option<UndoLedger>,
) {
    if let Some(ledger) = ledger.filter(|ledger| !ledger.entries().is_empty()) {
        lock_app_state(state)
            .skill_undo_runs
            .insert(run_id, canonical_root, ledger);
    }
}

/// Resolve a live structured prompt owned by `turn_id`. Validation is performed
/// against the parked server-side option set; invalid choices leave the prompt
/// live for a retry. The turn id scopes the answer to its own run so a reused
/// model-authored elicitation id in a sibling run is never resolved by mistake.
#[tauri::command]
pub(crate) fn answer_elicitation(
    state: crate::SharedState<'_>,
    turn_id: String,
    id: String,
    choices: Vec<String>,
) -> Result<(), neuralnote_core::CoreError> {
    let pending = {
        let state = crate::lock_state(&state);
        std::sync::Arc::clone(&state.pending_elicitations)
    };
    pending.answer(&turn_id, &id, choices)
}

/// Consume one run ledger once every file reaches a terminal result. A vault
/// mismatch is checked before the entry is removed, and a transient file failure
/// restores the reserved run so the user can retry it.
#[tauri::command]
pub(crate) fn undo_skill_run(
    state: crate::SharedState<'_>,
    run_id: String,
) -> Result<UndoReport, CoreError> {
    undo_skill_run_inner(state.inner(), &run_id)
}

struct PreparedUndoRun {
    current_root: PathBuf,
    canonical_current: PathBuf,
}

fn lock_app_state(state: &Mutex<crate::AppState>) -> MutexGuard<'_, crate::AppState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prepare_undo_run(
    state: &Mutex<crate::AppState>,
    run_id: &str,
) -> Result<PreparedUndoRun, CoreError> {
    let stored_root = lock_app_state(state).skill_undo_runs.root_for(run_id)?;
    let current_root = lock_app_state(state)
        .session
        .as_ref()
        .map(|session| session.root.clone())
        .ok_or_else(|| CoreError::Io("no vault is open".into()))?;
    let canonical_current = current_root.canonicalize().map_err(|error| {
        CoreError::Io(format!(
            "could not resolve the current vault for Undo: {error}"
        ))
    })?;
    if canonical_current != stored_root {
        return Err(CoreError::Conflict(format!(
            "skill run '{run_id}' belongs to a different vault"
        )));
    }

    Ok(PreparedUndoRun {
        current_root,
        canonical_current,
    })
}

fn take_prepared_undo_run(
    state: &Mutex<crate::AppState>,
    run_id: &str,
    prepared: &PreparedUndoRun,
) -> Result<undo::StoredUndoRun, CoreError> {
    let mut app_state = lock_app_state(state);
    let session_unchanged = app_state
        .session
        .as_ref()
        .is_some_and(|session| session.root == prepared.current_root);
    if !session_unchanged {
        return Err(CoreError::Conflict(
            "the open vault changed while Undo was being prepared".into(),
        ));
    }
    app_state
        .skill_undo_runs
        .take_for_root(run_id, &prepared.canonical_current)
}

fn undo_skill_run_inner(
    state: &Mutex<crate::AppState>,
    run_id: &str,
) -> Result<UndoReport, CoreError> {
    undo_skill_run_inner_with(state, run_id, undo_ledger)
}

fn undo_skill_run_inner_with(
    state: &Mutex<crate::AppState>,
    run_id: &str,
    apply_undo: impl FnOnce(&std::path::Path, &UndoLedger) -> UndoReport,
) -> Result<UndoReport, CoreError> {
    let prepared = prepare_undo_run(state, run_id)?;
    let mut stored = take_prepared_undo_run(state, run_id, &prepared)?;
    let report = apply_undo(&stored.canonical_root, &stored.ledger);
    if report
        .files
        .iter()
        .any(|file| file.status == undo::UndoFileStatus::Failed)
    {
        // Taking before I/O reserves the authority against concurrent callers. Put
        // back only entries whose I/O failed; terminal paths must not regain delete
        // authority if a byte-identical replacement appears before the retry.
        debug_assert_eq!(
            report.files.len(),
            stored.ledger.entries().len(),
            "apply_undo must report every ledger entry"
        );
        stored.ledger.retain_entries(|entry| {
            report.files.iter().any(|file| {
                file.rel_path == entry.rel_path && file.status == undo::UndoFileStatus::Failed
            })
        });
        lock_app_state(state)
            .skill_undo_runs
            .restore(run_id.to_string(), stored);
    }
    Ok(report)
}

#[cfg(all(test, unix))]
mod tests {
    use super::undo::{UndoFileResult, UndoFileStatus};
    use super::*;
    use async_trait::async_trait;
    use neuralnote_core::ai::{
        run_chat, write_note_policy, ChatEvent, Completion, EventSink, Guards, HardwareSpec,
        KeywordRetriever, LlmClient, LlmRequest, NoUserPrompt, NoteKind, SkillEnvironment,
        SkillRegistry, SkillServices, ToolCall, UndoLedger, WriteSession, FIXTURE_SKILL_ID,
    };
    use neuralnote_core::{CoreError, CoreResult};
    use std::collections::{BTreeSet, VecDeque};
    use std::fs;
    use std::path::Path;
    use std::sync::Mutex;

    fn app_state_for(root: &Path) -> Mutex<crate::AppState> {
        Mutex::new(crate::AppState {
            session: Some(crate::VaultSession {
                root: root.to_path_buf(),
                _watcher: None,
            }),
            ..crate::AppState::default()
        })
    }

    fn lock(state: &Mutex<crate::AppState>) -> std::sync::MutexGuard<'_, crate::AppState> {
        state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn ledger_with_note(root: &Path, rel_path: &str, content: &str) -> UndoLedger {
        let mut writes = WriteSession::new(1).unwrap();
        write_note_policy(
            root,
            rel_path,
            content,
            NoteKind::Literature,
            0,
            &FsNoteWriteBackend,
            &mut writes,
        )
        .unwrap();
        writes.into_ledger()
    }

    fn retain_run(state: &Mutex<crate::AppState>, run_id: &str, root: &Path, ledger: UndoLedger) {
        lock(state).skill_undo_runs.insert(
            run_id.to_string(),
            root.canonicalize().unwrap(),
            ledger,
        );
    }

    #[test]
    fn failed_undo_run_is_retryable_after_the_transient_failure_clears() {
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().join("Retry.md");
        let ledger = ledger_with_note(vault.path(), "Retry.md", "original");
        let state = app_state_for(vault.path());
        retain_run(&state, "run-retry", vault.path(), ledger);

        let failed = undo_skill_run_inner_with(&state, "run-retry", |_, ledger| UndoReport {
            files: ledger
                .entries()
                .iter()
                .map(|entry| UndoFileResult {
                    rel_path: entry.rel_path.clone(),
                    status: UndoFileStatus::Failed,
                    message: Some("vault is temporarily locked".into()),
                })
                .collect(),
        })
        .unwrap();

        assert_eq!(failed.files[0].status, UndoFileStatus::Failed);
        assert!(path.exists());
        assert!(lock(&state).skill_undo_runs.root_for("run-retry").is_ok());

        let retried = undo_skill_run_inner(&state, "run-retry").unwrap();

        assert_eq!(retried.files[0].status, UndoFileStatus::Deleted);
        assert!(!path.exists());
        assert!(matches!(
            undo_skill_run_inner(&state, "run-retry"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    #[cfg_attr(
        debug_assertions,
        should_panic(expected = "apply_undo must report every ledger entry")
    )]
    fn incomplete_failed_undo_report_trips_entry_coverage_assertion() {
        let vault = tempfile::tempdir().unwrap();
        let mut writes = WriteSession::new(1).unwrap();
        for (rel_path, content) in [("First.md", "first"), ("Second.md", "second")] {
            write_note_policy(
                vault.path(),
                rel_path,
                content,
                NoteKind::Literature,
                0,
                &FsNoteWriteBackend,
                &mut writes,
            )
            .unwrap();
        }
        let state = app_state_for(vault.path());
        retain_run(
            &state,
            "run-incomplete-report",
            vault.path(),
            writes.into_ledger(),
        );

        undo_skill_run_inner_with(&state, "run-incomplete-report", |_, _| UndoReport {
            files: vec![UndoFileResult {
                rel_path: "First.md".into(),
                status: UndoFileStatus::Failed,
                message: Some("vault is temporarily locked".into()),
            }],
        })
        .unwrap();
    }

    #[test]
    fn retry_restores_only_files_whose_first_undo_failed() {
        let vault = tempfile::tempdir().unwrap();
        let first_path = vault.path().join("First.md");
        let second_path = vault.path().join("Second.md");
        let mut writes = WriteSession::new(1).unwrap();
        for (rel_path, content) in [("First.md", "first"), ("Second.md", "second")] {
            write_note_policy(
                vault.path(),
                rel_path,
                content,
                NoteKind::Literature,
                0,
                &FsNoteWriteBackend,
                &mut writes,
            )
            .unwrap();
        }
        let state = app_state_for(vault.path());
        retain_run(
            &state,
            "run-partial-retry",
            vault.path(),
            writes.into_ledger(),
        );

        let first = undo_skill_run_inner_with(&state, "run-partial-retry", |_, _| {
            fs::remove_file(&first_path).unwrap();
            UndoReport {
                files: vec![
                    UndoFileResult {
                        rel_path: "First.md".into(),
                        status: UndoFileStatus::Deleted,
                        message: None,
                    },
                    UndoFileResult {
                        rel_path: "Second.md".into(),
                        status: UndoFileStatus::Failed,
                        message: Some("vault is temporarily locked".into()),
                    },
                ],
            }
        })
        .unwrap();

        assert_eq!(first.files[0].status, UndoFileStatus::Deleted);
        assert_eq!(first.files[1].status, UndoFileStatus::Failed);
        assert!(!first_path.exists());

        // A byte-identical replacement at an already-terminal path belongs to the
        // user, not to the original run, and must not be authorised by a retry.
        fs::write(&first_path, "first").unwrap();

        let retried = undo_skill_run_inner(&state, "run-partial-retry").unwrap();

        assert_eq!(retried.files.len(), 1);
        assert_eq!(retried.files[0].rel_path, "Second.md");
        assert_eq!(retried.files[0].status, UndoFileStatus::Deleted);
        assert!(first_path.exists());
        assert!(!second_path.exists());
    }

    #[test]
    fn cross_vault_undo_is_rejected_without_consuming_the_run() {
        let vault_a = tempfile::tempdir().unwrap();
        let vault_b = tempfile::tempdir().unwrap();
        let ledger = ledger_with_note(vault_a.path(), "Owned.md", "original");
        let state = app_state_for(vault_b.path());
        retain_run(&state, "run-a", vault_a.path(), ledger);

        let result = undo_skill_run_inner(&state, "run-a");

        assert!(matches!(result, Err(CoreError::Conflict(_))));
        assert!(vault_a.path().join("Owned.md").exists());
        assert!(lock(&state).skill_undo_runs.root_for("run-a").is_ok());
    }

    #[test]
    fn vault_swap_during_undo_preparation_is_rejected_without_consuming_the_run() {
        let vault_a = tempfile::tempdir().unwrap();
        let vault_b = tempfile::tempdir().unwrap();
        let ledger = ledger_with_note(vault_a.path(), "Owned.md", "original");
        let state = app_state_for(vault_a.path());
        retain_run(&state, "run-a", vault_a.path(), ledger);
        let prepared = prepare_undo_run(&state, "run-a").unwrap();
        lock(&state).session = Some(crate::VaultSession {
            root: vault_b.path().to_path_buf(),
            _watcher: None,
        });

        let result = take_prepared_undo_run(&state, "run-a", &prepared);

        assert!(matches!(
            result,
            Err(CoreError::Conflict(message)) if message.contains("changed while Undo was being prepared")
        ));
        assert!(vault_a.path().join("Owned.md").exists());
        assert!(lock(&state).skill_undo_runs.root_for("run-a").is_ok());
    }

    struct ScriptedLlm(Mutex<VecDeque<Completion>>);

    #[async_trait]
    impl LlmClient for ScriptedLlm {
        async fn complete(&self, _request: &LlmRequest) -> CoreResult<Completion> {
            Ok(self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front()
                .expect("scripted completion"))
        }

        async fn complete_streaming(
            &self,
            _request: &LlmRequest,
            sink: &mut dyn EventSink,
        ) -> CoreResult<String> {
            sink.send(ChatEvent::Answer {
                delta: "Finished.".into(),
            });
            Ok("Finished.".into())
        }
    }

    #[derive(Default)]
    struct DiscardEvents;

    impl EventSink for DiscardEvents {
        fn send(&mut self, _event: ChatEvent) {}
    }

    #[tokio::test]
    async fn chat_skill_write_can_be_undone_and_is_consumed_exactly_once() {
        let vault = tempfile::tempdir().unwrap();
        let registry = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 16_000_000_000,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 10_000_000_000,
            },
            app_data_bin_dir: vault.path().join("bin"),
            available_binaries: BTreeSet::new(),
        };
        let services = SkillServices::new(
            &registry,
            &environment,
            &NoUserPrompt,
            &FsNoteWriteBackend,
            1,
        );
        let llm = ScriptedLlm(Mutex::new(
            vec![
                Completion {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "write".into(),
                        name: "write_note".into(),
                        arguments: r##"{"rel_path":"Fixture.md","content":"# Fixture","kind":"literature","work_item":0}"##.into(),
                    }],
                },
                Completion {
                    content: Some("ready".into()),
                    tool_calls: Vec::new(),
                },
            ]
            .into(),
        ));
        let retriever = KeywordRetriever::new(vault.path());
        let mut sink = DiscardEvents;
        let ledger = run_chat(
            "write the fixture",
            &[],
            vec![FIXTURE_SKILL_ID.into()],
            vault.path(),
            "test-model",
            &retriever,
            &llm,
            &services,
            &mut sink,
            &Guards::default(),
        )
        .await
        .unwrap();
        assert!(vault.path().join("Fixture.md").exists());
        assert_eq!(ledger.entries().len(), 1);

        let state = app_state_for(vault.path());
        retain_chat_undo_ledger(
            &state,
            "run-chat".into(),
            vault.path().canonicalize().unwrap(),
            Some(ledger),
        );
        let report = undo_skill_run_inner(&state, "run-chat").unwrap();

        assert_eq!(report.files[0].status, UndoFileStatus::Deleted);
        assert!(!vault.path().join("Fixture.md").exists());
        assert!(matches!(
            undo_skill_run_inner(&state, "run-chat"),
            Err(CoreError::NotFound(_))
        ));
    }
}
