//! Crash-recovery for the undo / cancelled-write quarantine window.
//!
//! Undo and cancelled-write cleanup temporarily rename a note leaf to a hidden
//! quarantine name, verify it, then either delete it or restore its original
//! name. If the process is killed inside that narrow window, neither branch runs
//! and the bytes are stranded under the temp name. To make that recoverable, the
//! quarantine records a mapping *before* the rename (so a crash always leaves a
//! discoverable record) and clears it ONLY once the leaf is provably resolved —
//! restored to its original name or the quarantine deleted. [`reconcile_quarantine_recovery`]
//! runs the stranded mappings when a vault opens: it restores an interrupted undo,
//! discards an interrupted cancelled-write, preserves a proven-foreign replacement,
//! and surfaces every conflict it cannot resolve.
//!
//! The record is cleared by [`QuarantineGuard`] on drop, but ONLY once the leaf
//! is provably resolved — restored to its original name or the quarantine
//! deleted. Any path that returns while the leaf is still under the quarantine
//! name first calls [`QuarantineGuard::retain`], so the record outlives the drop
//! and reconcile-on-open can still recover the note. A record therefore survives
//! process death (SIGKILL) in the quarantine window *and* any live outcome that
//! could not resolve the leaf; only a resolved leaf clears it.
//!
//! Durability: [`record_quarantine`] flushes the record's directory tree to stable
//! storage before it returns, so the record is durable before the caller renames
//! the note leaf. On Apple platforms plain `fsync` does NOT flush the drive's
//! write cache, so the record file and its directories are flushed with
//! `F_FULLFSYNC` there (and `fsync` elsewhere) — see [`sync_to_stable_storage`].
//! That makes the guarantee hold under power loss, not merely a crash/SIGKILL: any
//! leaf that was durably renamed to its quarantine name always has a durable record
//! to recover it from. (The leaf rename itself is not force-synced; if it did not
//! reach disk the leaf is simply still at its original name, with nothing stranded
//! to recover.)

use super::note_writer::{QuarantineLeafState, RestoreLeafOutcome, StableDirectory};
use neuralnote_core::{paths, CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::io::Write;
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Vault-relative home for recovery records. Lives under the existing hidden
/// `.neuralnote` state directory, which the tree scanner and watcher already
/// ignore, so records never surface as notes.
const RECOVERY_DIR: &str = ".neuralnote/undo-recovery";

/// What a stranded quarantine should become when it is reconciled. The action is
/// decided at record time from the pre-operation state, not guessed on recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum QuarantineIntent {
    /// An interrupted Undo: the note existed before the operation, so restoring
    /// its original name is the non-destructive pre-undo state.
    RestoreOriginal,
    /// An interrupted cancelled-write cleanup: the run created the leaf and then
    /// aborted, so the pre-operation state is "no file" and the bytes are discarded.
    DiscardQuarantine,
    /// A cancelled-write cleanup that PROVED the quarantined bytes are a foreign
    /// concurrent replacement (a real user file, not this run's output) yet could
    /// not restore them to the original name. The bytes must be preserved, never
    /// discarded: reconcile restores them to the original name if it is free, and
    /// otherwise surfaces a conflict. It never deletes them. This intent only ever
    /// arises by converting a [`DiscardQuarantine`](Self::DiscardQuarantine) record
    /// once the discard would have destroyed proven-foreign bytes.
    PreserveReplacement,
}

/// On-disk recovery record. Written atomically before the quarantine rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuarantineMapping {
    /// Vault-relative parent directory of the note (`""` means the vault root).
    parent_rel: String,
    /// The note's real filename.
    original_leaf: String,
    /// The hidden name the note was renamed to.
    quarantine_leaf: String,
    intent: QuarantineIntent,
}

/// Clears its recovery record on drop — but ONLY while armed. A caller that
/// returns with the leaf still quarantined must [`QuarantineGuard::retain`] first
/// so the record outlives the drop and reconcile-on-open can recover the note.
/// Armed, it clears the record on any drop (normal return, error, or unwind);
/// SIGKILL skips the drop, which is what leaves the record for reconcile.
#[must_use = "hold the guard across the quarantine window so the record is not cleared while the note is still quarantined"]
pub(crate) struct QuarantineGuard {
    mapping_path: Option<PathBuf>,
}

impl QuarantineGuard {
    fn armed(mapping_path: PathBuf) -> Self {
        Self {
            mapping_path: Some(mapping_path),
        }
    }

    /// Disarm the guard: keep the recovery record on disk when the guard drops.
    /// The caller MUST call this on every path that returns while the leaf is
    /// still under its quarantine name, so the stranded note stays recoverable.
    pub(crate) fn retain(&mut self) {
        self.mapping_path = None;
    }

    /// Convert the retained record to a non-destructive `intent` and keep it on
    /// disk. Used when cleanup PROVES the quarantined bytes are a foreign
    /// replacement it could not restore: leaving the original `DiscardQuarantine`
    /// record would let reconcile blind-delete bytes proven to be a real user
    /// file. The record's intent is rewritten atomically and durably, then the
    /// guard disarms so the (now non-destructive) record outlives the drop.
    ///
    /// If the rewrite fails the guard stays armed, so its drop clears the record
    /// and the bytes survive as an untracked orphan under the hidden name — a
    /// preserved (never deleted), if silent, fallback rather than a destructive
    /// discard.
    pub(crate) fn preserve_as(&mut self, intent: QuarantineIntent) -> CoreResult<()> {
        let Some(path) = self.mapping_path.as_deref() else {
            return Ok(());
        };
        rewrite_record_intent(path, intent)?;
        self.mapping_path = None;
        Ok(())
    }
}

impl Drop for QuarantineGuard {
    fn drop(&mut self) {
        let Some(path) = self.mapping_path.take() else {
            return;
        };
        // A failed delete is self-healing: reconcile treats a record whose
        // quarantine is gone as stale and clears it on the next vault open.
        remove_record_file(&path);
    }
}

/// Remove a recovery record file, tolerating an already-absent record and logging
/// any other failure. Shared by the guard drop and the reconcile clear paths so
/// both treat a missing record and a failed delete identically.
fn remove_record_file(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "could not clear undo-recovery record {}: {error}",
                path.display()
            );
        }
    }
}

/// A successful quarantine: the hidden leaf name plus the guard that clears its
/// recovery record when the caller finishes handling it.
#[must_use = "hold the handle's guard across the quarantine window so the record is not cleared while the note is still quarantined"]
pub(crate) struct QuarantineHandle {
    pub(crate) quarantine: String,
    /// The quarantine name as a validated `CString`, computed once when the leaf
    /// was quarantined. Threaded through so later delete/restore steps never have
    /// to recompute it with a fallible call inside the retain-sensitive window.
    pub(crate) quarantine_c: CString,
    pub(crate) guard: QuarantineGuard,
}

/// Persist a recovery record durably before the quarantine rename. `sequence_id`
/// uniquely names the record and matches the quarantine leaf's own sequence; it
/// must be unique per process *instance* (not a reused pid), because the commit
/// refuses to overwrite an existing record and a collision would otherwise strand
/// an earlier instance's note.
pub(crate) fn record_quarantine(
    canonical_root: &Path,
    parent_rel: &str,
    original_leaf: &str,
    quarantine_leaf: &str,
    sequence_id: &str,
    intent: QuarantineIntent,
) -> CoreResult<QuarantineGuard> {
    // A record must round-trip to a real note name on recovery. Reject an
    // original leaf the restore path could not safely act on, rather than writing
    // a record that would later be refused or, worse, mis-target another entry.
    paths::validate_name(original_leaf)?;

    let dir = canonical_root.join(RECOVERY_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| {
        CoreError::Io(format!(
            "could not create undo-recovery directory {}: {error}",
            dir.display()
        ))
    })?;
    // Make the recovery directory tree durable so the record we are about to
    // write is anchored on stable storage before the caller renames the leaf.
    fsync_dir_chain(canonical_root, &dir)?;

    let mapping = QuarantineMapping {
        parent_rel: parent_rel.to_string(),
        original_leaf: original_leaf.to_string(),
        quarantine_leaf: quarantine_leaf.to_string(),
        intent,
    };
    let mut bytes = serde_json::to_vec(&mapping).map_err(|error| {
        CoreError::Io(format!("could not serialize undo-recovery record: {error}"))
    })?;
    bytes.push(b'\n');

    let final_name = format!("{sequence_id}.json");
    let temp_name = format!(".{sequence_id}.json.tmp");
    write_record_atomically(&dir, &temp_name, &final_name, &bytes)?;
    Ok(QuarantineGuard::armed(dir.join(final_name)))
}

/// Write-to-temp, flush contents to stable storage, no-replace rename, flush the
/// directory. The rename makes the complete record appear atomically, so a crash
/// mid-write never yields a half-written mapping; `NOREPLACE` guarantees a
/// colliding record id is surfaced as an error instead of silently clobbering an
/// earlier instance's stranded record; the trailing directory flush makes the
/// committed dirent durable before this returns (and therefore before the caller's
/// leaf rename).
fn write_record_atomically(
    dir: &Path,
    temp_name: &str,
    final_name: &str,
    bytes: &[u8],
) -> CoreResult<()> {
    stage_record_temp(dir, temp_name, bytes)?;
    let temp_path = dir.join(temp_name);
    let dir_handle = open_dir(dir)?;
    match rustix::fs::renameat_with(
        &dir_handle,
        temp_name,
        &dir_handle,
        final_name,
        rustix::fs::RenameFlags::NOREPLACE,
    ) {
        Ok(()) => {}
        Err(rustix::io::Errno::EXIST) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(CoreError::Io(format!(
                "undo-recovery record '{final_name}' already exists; refusing to overwrite it"
            )));
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(CoreError::Io(format!(
                "could not commit undo-recovery record: {error}"
            )));
        }
    }
    sync_dir_to_stable_storage(&dir_handle).map_err(|error| {
        CoreError::Io(format!(
            "could not flush undo-recovery directory after commit: {error}"
        ))
    })
}

/// Atomically and durably rewrite an existing record's `intent` in place, keeping
/// its filename. Unlike [`write_record_atomically`] the destination already
/// exists, so the rename REPLACES it. Used only by [`QuarantineGuard::preserve_as`]
/// to convert a discard record into a non-destructive one once cleanup proved the
/// quarantined bytes are a foreign replacement that must never be deleted.
fn rewrite_record_intent(record_path: &Path, intent: QuarantineIntent) -> CoreResult<()> {
    let dir = record_path.parent().ok_or_else(|| {
        CoreError::Io(format!(
            "undo-recovery record '{}' has no parent directory",
            record_path.display()
        ))
    })?;
    let final_name = record_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            CoreError::Io(format!(
                "undo-recovery record '{}' has no valid file name",
                record_path.display()
            ))
        })?;

    let mut mapping = read_mapping(record_path).map_err(CoreError::Io)?;
    mapping.intent = intent;
    let mut bytes = serde_json::to_vec(&mapping).map_err(|error| {
        CoreError::Io(format!("could not serialize undo-recovery record: {error}"))
    })?;
    bytes.push(b'\n');

    let temp_name = format!(".{final_name}.rewrite.tmp");
    let temp_path = dir.join(&temp_name);
    stage_record_temp(dir, &temp_name, &bytes)?;
    let dir_handle = open_dir(dir)?;
    if let Err(error) = rustix::fs::renameat(&dir_handle, &temp_name, &dir_handle, final_name) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(CoreError::Io(format!(
            "could not rewrite undo-recovery record: {error}"
        )));
    }
    sync_dir_to_stable_storage(&dir_handle).map_err(|error| {
        CoreError::Io(format!(
            "could not flush undo-recovery directory after rewrite: {error}"
        ))
    })
}

/// Write `bytes` to a fresh temp file in `dir` and flush its contents to stable
/// storage, leaving it staged for an atomic rename. Any prior temp of the same
/// name (a torn earlier attempt) is cleared first so the create cannot fail EEXIST.
fn stage_record_temp(dir: &Path, temp_name: &str, bytes: &[u8]) -> CoreResult<()> {
    let temp_path = dir.join(temp_name);
    let _ = std::fs::remove_file(&temp_path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| CoreError::Io(format!("could not write undo-recovery record: {error}")))?;
    if let Err(error) = file
        .write_all(bytes)
        .and_then(|()| sync_to_stable_storage(&file))
    {
        drop(file);
        let _ = std::fs::remove_file(&temp_path);
        return Err(CoreError::Io(format!(
            "could not write undo-recovery record: {error}"
        )));
    }
    Ok(())
}

/// Flush a file or directory handle to genuinely stable storage. On Apple
/// platforms plain `fsync` (what [`std::fs::File::sync_all`] issues) does NOT flush
/// the drive's write cache, so a power loss can lose an already-`fsync`'d write;
/// `F_FULLFSYNC` forces the platter/flash flush and is what makes the module's
/// "a durably-renamed leaf always has a durable record" guarantee hold under power
/// loss rather than merely a crash. Filesystems that reject `F_FULLFSYNC` (e.g.
/// some network mounts) fall back to a best-effort `fsync`. Everywhere else this is
/// exactly `sync_all`. It runs only on the cold quarantine-record write path.
#[cfg(target_vendor = "apple")]
fn sync_to_stable_storage(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe {
        // SAFETY: `file` owns a live descriptor for the duration of the call and
        // F_FULLFSYNC takes no pointer argument.
        libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC)
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENOTSUP) | Some(libc::EINVAL) => file.sync_all(),
        _ => Err(error),
    }
}

#[cfg(not(target_vendor = "apple"))]
fn sync_to_stable_storage(file: &std::fs::File) -> std::io::Result<()> {
    file.sync_all()
}

fn sync_dir_to_stable_storage(dir: &std::fs::File) -> std::io::Result<()> {
    sync_to_stable_storage(dir)
}

/// Open a directory as a file handle for directory-relative renames and fsync.
/// On Unix a directory opened read-only can be fsynced to flush its dirents.
fn open_dir(dir: &Path) -> CoreResult<std::fs::File> {
    std::fs::File::open(dir).map_err(|error| {
        CoreError::Io(format!(
            "could not open recovery directory {} for sync: {error}",
            dir.display()
        ))
    })
}

/// Flush every directory from `leaf_dir` up to and including `canonical_root` to
/// stable storage, so a freshly created recovery directory (and the record it will
/// hold) is durably linked into its parents before any note leaf is renamed.
fn fsync_dir_chain(canonical_root: &Path, leaf_dir: &Path) -> CoreResult<()> {
    let mut current = Some(leaf_dir);
    while let Some(dir) = current {
        sync_dir_to_stable_storage(&open_dir(dir)?).map_err(|error| {
            CoreError::Io(format!(
                "could not flush recovery directory {}: {error}",
                dir.display()
            ))
        })?;
        if dir == canonical_root {
            break;
        }
        current = dir
            .parent()
            .filter(|parent| parent.starts_with(canonical_root));
    }
    Ok(())
}

/// One reconciled recovery outcome. Every variant is surfaced to the user; stale
/// records that recovered nothing produce no entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) enum QuarantineRecoveryStatus {
    /// An interrupted undo was rolled back: the note is back at its original name.
    Recovered,
    /// An interrupted cancelled write was discarded, as it would have been live.
    RemovedInterruptedWrite,
    /// The note could not be restored because its original path is occupied; it
    /// stays preserved under the hidden name for the user to resolve.
    Conflict,
    /// The record could not be acted on safely and is left untouched for review.
    Retained,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct QuarantineRecoveryEntry {
    pub(crate) rel_path: String,
    pub(crate) status: QuarantineRecoveryStatus,
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct QuarantineRecoveryReport {
    pub(crate) entries: Vec<QuarantineRecoveryEntry>,
}

/// Reconcile every stranded quarantine mapping for `canonical_root`. Best-effort
/// and independent per record: one unreadable or escaping record never blocks the
/// others. Called once when a vault opens (`commands/vault.rs::open_vault`); the
/// returned report is surfaced to the webview as a `QUARANTINE_RECOVERY` event.
pub(crate) fn reconcile_quarantine_recovery(canonical_root: &Path) -> QuarantineRecoveryReport {
    let dir = canonical_root.join(RECOVERY_DIR);
    let mut report = QuarantineRecoveryReport::default();
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return report,
        Err(error) => {
            report.entries.push(QuarantineRecoveryEntry {
                rel_path: RECOVERY_DIR.to_string(),
                status: QuarantineRecoveryStatus::Retained,
                message: Some(format!("could not read undo-recovery directory: {error}")),
            });
            return report;
        }
    };

    for dirent in read_dir {
        let dirent = match dirent {
            Ok(dirent) => dirent,
            // A per-entry read error must not be swallowed: a record whose dirent
            // errors would otherwise be silently skipped and its note left
            // stranded. Surface it so the user can act on it.
            Err(error) => {
                report.entries.push(retained(
                    RECOVERY_DIR,
                    format!("could not read an undo-recovery directory entry: {error}"),
                ));
                continue;
            }
        };
        let path = dirent.path();
        match classify_record_candidate(&path) {
            RecordCandidate::NotARecord => continue,
            // A momentarily unreadable record (EACCES/EIO) must not be mistaken for
            // "not a record" and skipped; surface it for review.
            RecordCandidate::Unreadable(message) => report.entries.push(retained(
                &record_display(&path),
                format!("could not stat a candidate undo-recovery record: {message}"),
            )),
            RecordCandidate::Record => {
                if let Some(entry) = reconcile_one(canonical_root, &path) {
                    report.entries.push(entry);
                }
            }
        }
    }
    report
}

/// The private quarantine-name shape this module produces
/// (`.neuralnote-undo-<sequence>.tmp`). Reconciliation refuses any other leaf.
fn is_quarantine_name(name: &str) -> bool {
    name.starts_with(".neuralnote-undo-") && name.ends_with(".tmp")
}

/// A candidate for a recovery record, distinguishing "not one of ours" from a
/// stat error that must be surfaced rather than silently skipped.
enum RecordCandidate {
    Record,
    NotARecord,
    Unreadable(String),
}

/// Whether `path`'s file name matches the shape this module writes
/// (`<id>.json`, not a hidden temp). A pure name check with no filesystem access.
fn has_record_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !name.starts_with('.') && name.ends_with(".json"))
}

fn classify_record_candidate(path: &Path) -> RecordCandidate {
    if !has_record_name(path) {
        return RecordCandidate::NotARecord;
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => RecordCandidate::Record,
        Ok(_) => RecordCandidate::NotARecord,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RecordCandidate::NotARecord,
        Err(error) => RecordCandidate::Unreadable(error.to_string()),
    }
}

/// Reconcile a single record. Returns `Some(entry)` for a user-visible outcome,
/// `None` when nothing was recovered (a stale record, cleared silently).
fn reconcile_one(canonical_root: &Path, record_path: &Path) -> Option<QuarantineRecoveryEntry> {
    let mapping = match read_mapping(record_path) {
        Ok(mapping) => mapping,
        Err(message) => {
            return Some(retained(
                &record_display(record_path),
                format!("unreadable undo-recovery record: {message}"),
            ))
        }
    };
    let display = mapping_display(&mapping);

    // Only ever act on the private quarantine names this code produces. A record
    // that points at any other leaf (a forged or corrupt record) is refused, so
    // reconciliation can never restore over or delete a real note by name.
    if !is_quarantine_name(&mapping.quarantine_leaf) {
        return Some(retained(
            &display,
            format!(
                "recovery record names an unexpected leaf '{}'; it was left untouched",
                mapping.quarantine_leaf
            ),
        ));
    }

    // The original leaf is the name we would restore the note to. A forged or
    // corrupt record naming a traversal, a separator, or a hidden name must never
    // be acted on — validate it before it can steer a rename.
    if let Err(error) = paths::validate_name(&mapping.original_leaf) {
        return Some(retained(
            &display,
            format!(
                "recovery record names an unsafe original leaf '{}': {error}; it was left untouched",
                mapping.original_leaf
            ),
        ));
    }

    let parent = match open_recovery_parent(canonical_root, &mapping.parent_rel) {
        Ok(RecoveryParent::Open(parent)) => parent,
        Ok(RecoveryParent::Vanished) => {
            // The parent directory is gone, so the quarantined leaf is gone with
            // it. Nothing to recover; drop the stale record.
            clear_record(record_path);
            return None;
        }
        Err(message) => return Some(retained(&display, message)),
    };

    match parent.quarantine_leaf_state(&mapping.quarantine_leaf) {
        Ok(QuarantineLeafState::Missing) => {
            clear_record(record_path);
            None
        }
        Ok(QuarantineLeafState::NonRegular) => Some(retained(
            &display,
            format!(
                "recovery leaf '{}' is no longer a regular file; it was left untouched",
                mapping.quarantine_leaf
            ),
        )),
        Ok(QuarantineLeafState::Regular) => {
            Some(resolve_quarantine(&parent, &mapping, &display, record_path))
        }
        Err(error) => Some(retained(
            &display,
            format!("could not inspect recovery leaf: {error}"),
        )),
    }
}

fn resolve_quarantine(
    parent: &StableDirectory,
    mapping: &QuarantineMapping,
    display: &str,
    record_path: &Path,
) -> QuarantineRecoveryEntry {
    match mapping.intent {
        QuarantineIntent::DiscardQuarantine => match parent.remove_leaf(&mapping.quarantine_leaf) {
            Ok(()) => {
                clear_record(record_path);
                QuarantineRecoveryEntry {
                    rel_path: display.to_string(),
                    status: QuarantineRecoveryStatus::RemovedInterruptedWrite,
                    message: Some(
                        "an interrupted note write was discarded, as it would have been".into(),
                    ),
                }
            }
            Err(error) => retained(
                display,
                format!("could not remove the interrupted write: {error}"),
            ),
        },
        QuarantineIntent::RestoreOriginal => restore_or_conflict(
            parent,
            mapping,
            display,
            record_path,
            &RestoreMessages {
                restored: "an interrupted undo was rolled back and the note restored",
                conflict: format!(
                    "a file already exists at this path; the recovered note is preserved as '{}'",
                    mapping.quarantine_leaf
                ),
                restore_error: "could not restore the recovered note",
            },
        ),
        QuarantineIntent::PreserveReplacement => restore_or_conflict(
            parent,
            mapping,
            display,
            record_path,
            &RestoreMessages {
                restored: "a concurrent replacement was recovered to its original name",
                conflict: format!(
                    "a file already exists at this path; a concurrent replacement is preserved as '{}'",
                    mapping.quarantine_leaf
                ),
                restore_error: "could not restore a concurrent replacement",
            },
        ),
    }
}

/// The user-facing messages for each outcome of a restore-or-conflict recovery.
/// Every non-destructive intent shares one recovery algorithm — restore to the
/// original name if free, otherwise preserve under the hidden name and surface a
/// conflict — differing only in wording.
struct RestoreMessages {
    restored: &'static str,
    conflict: String,
    restore_error: &'static str,
}

/// Restore the quarantined leaf to its original name (no-overwrite). If the
/// destination is occupied, preserve the bytes under the hidden name and surface a
/// conflict; if the rename errors, retain the record for review. This path NEVER
/// deletes the quarantined bytes — it is the shared recovery for every
/// non-destructive intent.
fn restore_or_conflict(
    parent: &StableDirectory,
    mapping: &QuarantineMapping,
    display: &str,
    record_path: &Path,
    messages: &RestoreMessages,
) -> QuarantineRecoveryEntry {
    match parent.restore_leaf_noreplace(&mapping.quarantine_leaf, &mapping.original_leaf) {
        Ok(RestoreLeafOutcome::Restored) => {
            clear_record(record_path);
            QuarantineRecoveryEntry {
                rel_path: display.to_string(),
                status: QuarantineRecoveryStatus::Recovered,
                message: Some(messages.restored.to_string()),
            }
        }
        Ok(RestoreLeafOutcome::DestinationOccupied) => QuarantineRecoveryEntry {
            rel_path: display.to_string(),
            status: QuarantineRecoveryStatus::Conflict,
            message: Some(messages.conflict.clone()),
        },
        Err(error) => retained(display, format!("{}: {error}", messages.restore_error)),
    }
}

enum RecoveryParent {
    Open(StableDirectory),
    Vanished,
}

/// Resolve and open the note's parent directory under the same descriptor
/// confinement the live write path uses, so a symlinked or escaping parent is
/// refused rather than followed. Mirrors the undo command's parent resolution.
fn open_recovery_parent(canonical_root: &Path, parent_rel: &str) -> Result<RecoveryParent, String> {
    let parent_abs = resolve_parent_path(canonical_root, parent_rel)?;
    let canonical_parent = match parent_abs.canonicalize() {
        Ok(canonical_parent) => canonical_parent,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoveryParent::Vanished)
        }
        Err(error) => {
            return Err(format!(
                "could not resolve recovery parent '{}': {error}",
                parent_abs.display()
            ))
        }
    };
    if canonical_parent != canonical_root && !canonical_parent.starts_with(canonical_root) {
        return Err(format!(
            "recovery parent '{}' resolves outside the vault",
            canonical_parent.display()
        ));
    }
    match StableDirectory::open_confined(canonical_root, &canonical_parent) {
        Ok(parent) => Ok(RecoveryParent::Open(parent)),
        Err(CoreError::NotFound(_)) => Ok(RecoveryParent::Vanished),
        Err(error) => Err(error.to_string()),
    }
}

fn resolve_parent_path(canonical_root: &Path, parent_rel: &str) -> Result<PathBuf, String> {
    if parent_rel.is_empty() {
        return Ok(canonical_root.to_path_buf());
    }
    if parent_rel.starts_with(['/', '\\']) || parent_rel.contains('\\') {
        return Err(format!(
            "recovery parent '{parent_rel}' is not vault-relative"
        ));
    }
    let mut resolved = canonical_root.to_path_buf();
    for component in parent_rel.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(format!(
                "recovery parent '{parent_rel}' is not vault-relative"
            ));
        }
        paths::validate_name(component).map_err(|error| error.to_string())?;
        resolved.push(component);
    }
    Ok(resolved)
}

fn read_mapping(record_path: &Path) -> Result<QuarantineMapping, String> {
    let bytes = std::fs::read(record_path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn clear_record(record_path: &Path) {
    remove_record_file(record_path);
}

fn mapping_display(mapping: &QuarantineMapping) -> String {
    if mapping.parent_rel.is_empty() {
        mapping.original_leaf.clone()
    } else {
        format!("{}/{}", mapping.parent_rel, mapping.original_leaf)
    }
}

fn record_display(record_path: &Path) -> String {
    record_path
        .file_name()
        .map(|name| format!("{}/{}", RECOVERY_DIR, name.to_string_lossy()))
        .unwrap_or_else(|| RECOVERY_DIR.to_string())
}

fn retained(rel_path: &str, message: String) -> QuarantineRecoveryEntry {
    QuarantineRecoveryEntry {
        rel_path: rel_path.to_string(),
        status: QuarantineRecoveryStatus::Retained,
        message: Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }

    fn records(root: &Path) -> Vec<PathBuf> {
        match fs::read_dir(root.join(RECOVERY_DIR)) {
            Ok(read_dir) => read_dir
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| has_record_name(path))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Reproduce the exact on-disk state a process kill leaves in the quarantine
    /// window: a durable recovery record plus the note renamed to its hidden name,
    /// with the clearing guard never run.
    fn strand(
        root: &Path,
        parent_rel: &str,
        original: &str,
        intent: QuarantineIntent,
        index: u32,
    ) -> String {
        let quarantine = format!(".neuralnote-undo-test-{index}.tmp");
        let guard = record_quarantine(
            root,
            parent_rel,
            original,
            &quarantine,
            &format!("test-{index}"),
            intent,
        )
        .unwrap();
        let dir = if parent_rel.is_empty() {
            root.to_path_buf()
        } else {
            root.join(parent_rel)
        };
        fs::rename(dir.join(original), dir.join(&quarantine)).unwrap();
        std::mem::forget(guard);
        quarantine
    }

    #[test]
    fn interrupted_undo_is_restored_to_its_original_name() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Written.md"), "original").unwrap();
        let quarantine = strand(
            &root,
            "",
            "Written.md",
            QuarantineIntent::RestoreOriginal,
            1,
        );
        assert!(!root.join("Written.md").exists());
        assert!(root.join(&quarantine).exists());
        assert_eq!(records(&root).len(), 1);

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(root.join("Written.md")).unwrap(),
            "original"
        );
        assert!(!root.join(&quarantine).exists());
        assert!(records(&root).is_empty());
        assert_eq!(report.entries.len(), 1);
        assert_eq!(
            report.entries[0].status,
            QuarantineRecoveryStatus::Recovered
        );
        assert_eq!(report.entries[0].rel_path, "Written.md");
    }

    #[test]
    fn interrupted_undo_in_a_subfolder_reports_the_full_rel_path() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::create_dir(root.join("Folder")).unwrap();
        fs::write(root.join("Folder/Note.md"), "body").unwrap();
        strand(
            &root,
            "Folder",
            "Note.md",
            QuarantineIntent::RestoreOriginal,
            2,
        );

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(root.join("Folder/Note.md")).unwrap(),
            "body"
        );
        assert_eq!(
            report.entries[0].status,
            QuarantineRecoveryStatus::Recovered
        );
        assert_eq!(report.entries[0].rel_path, "Folder/Note.md");
    }

    #[test]
    fn interrupted_undo_never_overwrites_a_reoccupied_destination() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Written.md"), "original note").unwrap();
        let quarantine = strand(
            &root,
            "",
            "Written.md",
            QuarantineIntent::RestoreOriginal,
            3,
        );
        fs::write(root.join("Written.md"), "a newer file").unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(root.join("Written.md")).unwrap(),
            "a newer file"
        );
        assert_eq!(
            fs::read_to_string(root.join(&quarantine)).unwrap(),
            "original note"
        );
        assert_eq!(records(&root).len(), 1, "conflict must keep the record");
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Conflict);
        assert!(report.entries[0]
            .message
            .as_deref()
            .unwrap()
            .contains(&quarantine));
    }

    #[test]
    fn interrupted_undo_will_not_follow_a_destination_symlink() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("evil.md"), "outside stays intact").unwrap();
        let root = canonical(&root);
        fs::write(root.join("Note.md"), "original").unwrap();
        let quarantine = strand(&root, "", "Note.md", QuarantineIntent::RestoreOriginal, 4);
        fs::remove_file(root.join("Note.md")).ok();
        symlink(outside.join("evil.md"), root.join("Note.md")).unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(outside.join("evil.md")).unwrap(),
            "outside stays intact"
        );
        assert_eq!(
            fs::read_to_string(root.join(&quarantine)).unwrap(),
            "original"
        );
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Conflict);
    }

    #[test]
    fn interrupted_cancelled_write_is_discarded() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Draft.md"), "aborted run output").unwrap();
        let quarantine = strand(
            &root,
            "",
            "Draft.md",
            QuarantineIntent::DiscardQuarantine,
            5,
        );

        let report = reconcile_quarantine_recovery(&root);

        assert!(!root.join(&quarantine).exists());
        assert!(!root.join("Draft.md").exists());
        assert!(records(&root).is_empty());
        assert_eq!(report.entries.len(), 1);
        assert_eq!(
            report.entries[0].status,
            QuarantineRecoveryStatus::RemovedInterruptedWrite
        );
    }

    #[test]
    fn a_record_whose_parent_is_a_symlink_out_of_the_vault_is_refused() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("Secret.md"), "outside stays intact").unwrap();
        let root = canonical(&root);
        symlink(&outside, root.join("Folder")).unwrap();
        // A record that points its parent at the escaping symlink.
        let guard = record_quarantine(
            &root,
            "Folder",
            "Secret.md",
            ".neuralnote-undo-test-6.tmp",
            "test-6",
            QuarantineIntent::RestoreOriginal,
        )
        .unwrap();
        std::mem::forget(guard);

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(outside.join("Secret.md")).unwrap(),
            "outside stays intact"
        );
        assert_eq!(
            records(&root).len(),
            1,
            "an escaping record is retained, not cleared"
        );
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
        assert!(report.entries[0]
            .message
            .as_deref()
            .unwrap()
            .contains("outside"));
    }

    #[test]
    fn a_record_naming_a_real_note_leaf_refuses_to_touch_it() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Important.md"), "user content").unwrap();
        let dir = root.join(RECOVERY_DIR);
        fs::create_dir_all(&dir).unwrap();
        // A forged record that tries to have a real note discarded.
        fs::write(
            dir.join("forged.json"),
            r#"{"parentRel":"","originalLeaf":"Important.md","quarantineLeaf":"Important.md","intent":"discardQuarantine"}"#,
        )
        .unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(root.join("Important.md")).unwrap(),
            "user content"
        );
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
        assert!(report.entries[0]
            .message
            .as_deref()
            .unwrap()
            .contains("unexpected leaf"));
    }

    #[test]
    fn a_torn_or_foreign_record_is_retained_not_acted_on() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        let dir = root.join(RECOVERY_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("garbage.json"), "{ this is not : valid").unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert!(
            dir.join("garbage.json").exists(),
            "unreadable record is left for review"
        );
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
        assert!(report.entries[0]
            .message
            .as_deref()
            .unwrap()
            .contains("unreadable"));
    }

    #[test]
    fn a_record_missing_a_field_is_retained() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        let dir = root.join(RECOVERY_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("partial.json"),
            r#"{"parentRel":"","originalLeaf":"X.md","intent":"restoreOriginal"}"#,
        )
        .unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
    }

    #[test]
    fn a_stale_record_whose_quarantine_vanished_is_cleared_silently() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        // The note is already back at its name; the record's quarantine never existed.
        fs::write(root.join("Written.md"), "present").unwrap();
        let guard = record_quarantine(
            &root,
            "",
            "Written.md",
            ".neuralnote-undo-test-7.tmp",
            "test-7",
            QuarantineIntent::RestoreOriginal,
        )
        .unwrap();
        std::mem::forget(guard);

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(root.join("Written.md")).unwrap(),
            "present"
        );
        assert!(records(&root).is_empty(), "stale record is cleared");
        assert!(report.entries.is_empty(), "a stale record surfaces nothing");
    }

    #[test]
    fn a_quarantine_file_without_any_record_is_left_untouched() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        // A legacy orphan: bytes under a hidden name with no recovery record.
        fs::write(root.join(".neuralnote-undo-legacy.tmp"), "orphan bytes").unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert!(report.entries.is_empty());
        assert_eq!(
            fs::read_to_string(root.join(".neuralnote-undo-legacy.tmp")).unwrap(),
            "orphan bytes"
        );
    }

    #[test]
    fn a_non_regular_quarantine_is_retained_and_untouched() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Written.md"), "original").unwrap();
        let quarantine = strand(
            &root,
            "",
            "Written.md",
            QuarantineIntent::RestoreOriginal,
            8,
        );
        // The quarantine name is now something other than a regular file.
        fs::remove_file(root.join(&quarantine)).unwrap();
        fs::create_dir(root.join(&quarantine)).unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert!(root.join(&quarantine).is_dir());
        assert_eq!(records(&root).len(), 1, "record is retained");
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
    }

    #[test]
    fn a_vault_with_no_recovery_directory_reconciles_to_an_empty_report() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());

        assert!(reconcile_quarantine_recovery(&root).entries.is_empty());
    }

    #[test]
    fn record_quarantine_rejects_an_unsafe_original_leaf() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());

        assert!(matches!(
            record_quarantine(
                &root,
                "",
                "../Escape.md",
                ".neuralnote-undo-dd-1.tmp",
                "dd-1",
                QuarantineIntent::RestoreOriginal,
            ),
            Err(CoreError::InvalidName(_))
        ));
    }

    #[test]
    fn a_forged_record_with_a_traversal_original_leaf_is_refused() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("vault");
        fs::create_dir_all(&root).unwrap();
        let root = canonical(&root);
        let dir = root.join(RECOVERY_DIR);
        fs::create_dir_all(&dir).unwrap();
        // A genuine quarantine leaf, but a record whose original leaf escapes.
        let quarantine = ".neuralnote-undo-forged-1.tmp";
        fs::write(root.join(quarantine), "captured bytes").unwrap();
        fs::write(
            dir.join("forged.json"),
            format!(
                r#"{{"parentRel":"","originalLeaf":"../Escape.md","quarantineLeaf":"{quarantine}","intent":"restoreOriginal"}}"#
            ),
        )
        .unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
        assert!(report.entries[0]
            .message
            .as_deref()
            .unwrap()
            .contains("unsafe original leaf"));
        assert!(!root.parent().unwrap().join("Escape.md").exists());
        assert!(
            root.join(quarantine).exists(),
            "the captured bytes stay preserved under the hidden name"
        );
    }

    #[test]
    fn a_symlink_quarantine_leaf_is_retained_and_never_followed() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "outside stays intact").unwrap();
        let root = canonical(&root);
        fs::write(root.join("Note.md"), "original").unwrap();
        let quarantine = strand(&root, "", "Note.md", QuarantineIntent::RestoreOriginal, 20);
        // Replace the quarantined leaf with a symlink pointing outside the vault.
        fs::remove_file(root.join(&quarantine)).unwrap();
        symlink(outside.join("secret.md"), root.join(&quarantine)).unwrap();

        let report = reconcile_quarantine_recovery(&root);

        assert_eq!(
            fs::read_to_string(outside.join("secret.md")).unwrap(),
            "outside stays intact"
        );
        assert_eq!(
            records(&root).len(),
            1,
            "a non-regular quarantine leaf is retained, not acted on"
        );
        assert_eq!(report.entries[0].status, QuarantineRecoveryStatus::Retained);
    }

    #[test]
    fn a_record_is_committed_before_record_quarantine_returns() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::create_dir(root.join("Folder")).unwrap();

        let guard = record_quarantine(
            &root,
            "Folder",
            "Note.md",
            ".neuralnote-undo-cafe-1.tmp",
            "cafe-1",
            QuarantineIntent::RestoreOriginal,
        )
        .unwrap();
        std::mem::forget(guard);

        // The complete record is on disk the instant record_quarantine returns —
        // i.e. before the caller performs the note-leaf rename. That ordering is
        // what makes a durably-renamed (stranded) leaf always recoverable.
        let mapping = read_mapping(&root.join(RECOVERY_DIR).join("cafe-1.json")).unwrap();
        assert_eq!(mapping.parent_rel, "Folder");
        assert_eq!(mapping.original_leaf, "Note.md");
        assert_eq!(mapping.quarantine_leaf, ".neuralnote-undo-cafe-1.tmp");
        assert_eq!(mapping.intent, QuarantineIntent::RestoreOriginal);
    }

    #[test]
    fn committing_a_record_refuses_to_overwrite_an_existing_id() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        // A stranded record left by a prior process instance.
        let first = record_quarantine(
            &root,
            "",
            "First.md",
            ".neuralnote-undo-aaaa-1.tmp",
            "aaaa-1",
            QuarantineIntent::RestoreOriginal,
        )
        .unwrap();
        std::mem::forget(first);

        // A new instance whose id happens to collide (pid reuse + reset counter)
        // must NOT silently overwrite the earlier instance's record.
        let second = record_quarantine(
            &root,
            "",
            "Second.md",
            ".neuralnote-undo-bbbb-1.tmp",
            "aaaa-1",
            QuarantineIntent::RestoreOriginal,
        );

        assert!(
            second.is_err(),
            "a colliding record id must be refused, not silently overwritten"
        );
        let mapping = read_mapping(&root.join(RECOVERY_DIR).join("aaaa-1.json")).unwrap();
        assert_eq!(
            mapping.original_leaf, "First.md",
            "the first instance's stranded record must survive intact"
        );
    }

    #[test]
    fn reconcile_is_idempotent() {
        let vault = tempfile::tempdir().unwrap();
        let root = canonical(vault.path());
        fs::write(root.join("Written.md"), "original").unwrap();
        strand(
            &root,
            "",
            "Written.md",
            QuarantineIntent::RestoreOriginal,
            9,
        );

        let first = reconcile_quarantine_recovery(&root);
        let second = reconcile_quarantine_recovery(&root);

        assert_eq!(first.entries.len(), 1);
        assert!(second.entries.is_empty());
        assert_eq!(
            fs::read_to_string(root.join("Written.md")).unwrap(),
            "original"
        );
    }
}
