use neuralnote_core::ai::{NotePathState, NoteWriteBackend, NoteWriteParent, OpenedNoteParent};
use neuralnote_core::{CoreError, CoreResult};
use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static UNDO_QUARANTINE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default)]
pub(crate) struct FsNoteWriteBackend;

impl NoteWriteBackend for FsNoteWriteBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        path.canonicalize().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => CoreError::NotFound(path.display().to_string()),
            _ => CoreError::Io(format!(
                "could not canonicalize '{}': {error}",
                path.display()
            )),
        })
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        let parent = StableDirectory::open_confined(canonical_root, canonical_parent)?;
        Ok(OpenedNoteParent::new(
            parent.canonical_path.clone(),
            Box::new(parent),
        ))
    }
}

/// Per-chat writer that shares the invocation's retained lifecycle signal. The
/// filesystem implementation remains the same descriptor-confined backend, but
/// every capability operation fails closed once its vault or event channel ends.
pub(crate) struct RunNoteWriteBackend {
    close_signal: Arc<crate::ai::ChatRunCloseSignal>,
}

impl RunNoteWriteBackend {
    pub(crate) fn new(close_signal: Arc<crate::ai::ChatRunCloseSignal>) -> Self {
        Self { close_signal }
    }

    fn ensure_active(&self) -> CoreResult<()> {
        ensure_run_active(&self.close_signal)
    }
}

impl NoteWriteBackend for RunNoteWriteBackend {
    fn canonicalize(&self, path: &Path) -> CoreResult<PathBuf> {
        self.ensure_active()?;
        FsNoteWriteBackend.canonicalize(path)
    }

    fn open_parent(
        &self,
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<OpenedNoteParent> {
        self.ensure_active()?;
        let parent = StableDirectory::open_confined_for_run(
            canonical_root,
            canonical_parent,
            Arc::clone(&self.close_signal),
        )?;
        parent.ensure_active()?;
        Ok(OpenedNoteParent::new(
            parent.canonical_path.clone(),
            Box::new(parent),
        ))
    }
}

fn ensure_run_active(signal: &crate::ai::ChatRunCloseSignal) -> CoreResult<()> {
    if signal.is_closed() {
        Err(CoreError::Conflict(
            "chat run ended before the note write completed".into(),
        ))
    } else {
        Ok(())
    }
}

/// No-follow read result used by shell Undo before consulting the core ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReadLeaf {
    Missing,
    Regular(String),
    Other,
}

/// Result of the second, immediately-pre-delete hash/identity check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CheckedUnlink {
    Deleted,
    DeletedUnverified(String),
    Missing,
    Edited,
    Recreated,
    RetryReleased(String),
    Other,
}

struct LeafSnapshot {
    content: String,
    stat: libc::stat,
    // Keep the inode alive for the whole decision. On Linux an unlinked inode can
    // otherwise be recycled immediately, allowing a replacement to appear to
    // have the same dev/inode identity as the file we originally inspected.
    _file: File,
}

enum SnapshotLeaf {
    Missing,
    Regular(LeafSnapshot),
    Other,
}

/// An opened parent-directory capability. Every later leaf lookup and mutation is
/// relative to `fd`; the original path is never reopened, so replacing it with a
/// symlink after this point cannot redirect a write.
pub(crate) struct StableDirectory {
    fd: OwnedFd,
    pub(crate) canonical_path: PathBuf,
    close_signal: Option<Arc<crate::ai::ChatRunCloseSignal>>,
}

impl StableDirectory {
    /// Open `canonical_parent`, then ask the kernel which directory the descriptor
    /// actually denotes and re-check that post-open identity against the canonical
    /// vault root. This closes the canonicalise/open TOCTOU window.
    pub(crate) fn open_confined(
        canonical_root: &Path,
        canonical_parent: &Path,
    ) -> CoreResult<Self> {
        Self::open_confined_with_signal(canonical_root, canonical_parent, None)
    }

    pub(crate) fn open_confined_for_run(
        canonical_root: &Path,
        canonical_parent: &Path,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> CoreResult<Self> {
        Self::open_confined_with_signal(canonical_root, canonical_parent, Some(close_signal))
    }

    fn open_confined_with_signal(
        canonical_root: &Path,
        canonical_parent: &Path,
        close_signal: Option<Arc<crate::ai::ChatRunCloseSignal>>,
    ) -> CoreResult<Self> {
        let fd = open_directory(canonical_parent)?;
        let canonical_path = verify_opened_directory(canonical_root, &fd)?;
        Ok(Self {
            fd,
            canonical_path,
            close_signal,
        })
    }

    fn ensure_active(&self) -> CoreResult<()> {
        match &self.close_signal {
            Some(signal) => ensure_run_active(signal),
            None => Ok(()),
        }
    }

    fn fail_created_leaf(
        &self,
        leaf: &str,
        leaf_c: &CStr,
        file: File,
        primary: CoreError,
    ) -> CoreResult<()> {
        let quarantine = match self.quarantine_leaf(leaf_c, leaf) {
            Ok(Some(quarantine)) => quarantine,
            Ok(None) => return Err(primary),
            Err(error) => {
                return Err(CoreError::Io(format!(
                    "{primary}; additionally could not isolate the created note \
                     leaf for cleanup: {error}"
                )))
            }
        };
        // Keep the created descriptor alive until after the renamed path is
        // identified. If the original name was unlinked concurrently, the live FD
        // prevents its inode from being recycled into a replacement that could
        // otherwise impersonate our file by dev/inode alone.
        let created = match fstat_fd(file.as_raw_fd()) {
            Ok(stat) => stat,
            Err(error) => {
                if let Err(restore_error) = self.restore_quarantined_leaf(&quarantine, leaf_c, leaf)
                {
                    return Err(CoreError::Io(format!(
                        "{primary}; could not identify the created note leaf after \
                         quarantine: {error}; {restore_error}"
                    )));
                }
                return Err(CoreError::Io(format!(
                    "{primary}; additionally could not identify the created note \
                     leaf after quarantine: {error}"
                )));
            }
        };
        let quarantine_c = leaf_cstring(&quarantine)?;
        let quarantined = match statat_nofollow(self.fd.as_raw_fd(), &quarantine_c) {
            Ok(stat) => stat,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                return Err(CoreError::Io(format!(
                    "{primary}; cleanup recovery leaf '{quarantine}' disappeared"
                )))
            }
            Err(error) => {
                if let Err(restore_error) = self.restore_quarantined_leaf(&quarantine, leaf_c, leaf)
                {
                    return Err(CoreError::Io(format!(
                        "{primary}; could not verify cleanup recovery leaf \
                         '{quarantine}': {error}; {restore_error}"
                    )));
                }
                return Err(CoreError::Io(format!(
                    "{primary}; could not inspect cleanup recovery leaf \
                     '{quarantine}': {error}"
                )));
            }
        };
        if !same_file_identity(&created, &quarantined) {
            if let Err(error) = self.restore_quarantined_leaf(&quarantine, leaf_c, leaf) {
                return Err(CoreError::Io(format!("{primary}; {error}")));
            }
            return Err(primary);
        }

        unlinkat(self.fd.as_raw_fd(), &quarantine_c).map_err(|error| {
            CoreError::Io(format!(
                "{primary}; additionally could not remove cleanup recovery leaf \
                 '{quarantine}': {error}"
            ))
        })?;
        Err(primary)
    }

    /// Create a single leaf exclusively and run the complete write operation. If
    /// writing, syncing, or the owning chat lifecycle fails, atomically quarantine
    /// and identity-check the created leaf before removing it. That avoids both a
    /// partial file and deleting an editor's concurrent replacement.
    fn create_with<F>(&self, leaf: &str, write: F) -> CoreResult<()>
    where
        F: FnOnce(&mut File) -> std::io::Result<()>,
    {
        self.ensure_active()?;
        let leaf_c = leaf_cstring(leaf)?;
        let raw = unsafe {
            // SAFETY: `self.fd` is a live directory descriptor, `leaf_c` is a
            // NUL-terminated single component, and O_CREAT supplies the required
            // mode argument. OwnedFd below assumes ownership only on success.
            libc::openat(
                self.fd.as_raw_fd(),
                leaf_c.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o666 as libc::c_uint,
            )
        };
        if raw < 0 {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::EEXIST) {
                Err(CoreError::AlreadyExists(leaf.to_string()))
            } else {
                Err(CoreError::Io(format!(
                    "could not create note leaf '{leaf}': {error}"
                )))
            };
        }
        let fd = unsafe {
            // SAFETY: `openat` returned a fresh, owned descriptor.
            OwnedFd::from_raw_fd(raw)
        };
        let mut file = File::from(fd);

        if let Err(error) = self.ensure_active() {
            return self.fail_created_leaf(leaf, &leaf_c, file, error);
        }

        if let Err(write_error) = write(&mut file) {
            return self.fail_created_leaf(
                leaf,
                &leaf_c,
                file,
                CoreError::Io(format!(
                    "could not completely write note leaf '{leaf}': {write_error}"
                )),
            );
        }
        if let Err(error) = self.ensure_active() {
            return self.fail_created_leaf(leaf, &leaf_c, file, error);
        }

        Ok(())
    }

    /// Read one regular leaf through this already-confined directory descriptor.
    /// Final symlinks and non-files are reported without being followed.
    pub(crate) fn read_leaf(&self, leaf: &str) -> CoreResult<ReadLeaf> {
        Ok(match self.read_leaf_snapshot(leaf)? {
            SnapshotLeaf::Missing => ReadLeaf::Missing,
            SnapshotLeaf::Regular(snapshot) => ReadLeaf::Regular(snapshot.content),
            SnapshotLeaf::Other => ReadLeaf::Other,
        })
    }

    /// Re-open and re-hash, then atomically move the leaf to a private recovery
    /// name before deciding whether to unlink it. A normal editor may replace the
    /// original path at any instant; quarantining means that replacement is either
    /// preserved at the original name or restored after a detected mismatch.
    pub(crate) fn unlink_if_hash(
        &self,
        leaf: &str,
        expected_hash: &str,
    ) -> CoreResult<CheckedUnlink> {
        self.unlink_if_hash_after_check(leaf, expected_hash, || {})
    }

    fn unlink_if_hash_after_check<F>(
        &self,
        leaf: &str,
        expected_hash: &str,
        after_identity_check: F,
    ) -> CoreResult<CheckedUnlink>
    where
        F: FnOnce(),
    {
        self.unlink_if_hash_with_hooks(leaf, expected_hash, after_identity_check, |_| {})
    }

    fn unlink_if_hash_with_hooks<F, G>(
        &self,
        leaf: &str,
        expected_hash: &str,
        after_identity_check: F,
        after_quarantine: G,
    ) -> CoreResult<CheckedUnlink>
    where
        F: FnOnce(),
        G: FnOnce(&str),
    {
        self.unlink_if_hash_with_ops(
            leaf,
            expected_hash,
            after_identity_check,
            after_quarantine,
            unlinkat,
            statat_nofollow,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn unlink_if_hash_with_ops<F, G, D, S>(
        &self,
        leaf: &str,
        expected_hash: &str,
        after_identity_check: F,
        after_quarantine: G,
        delete_quarantine: D,
        stat_original: S,
    ) -> CoreResult<CheckedUnlink>
    where
        F: FnOnce(),
        G: FnOnce(&str),
        D: FnOnce(RawFd, &CStr) -> std::io::Result<()>,
        S: FnOnce(RawFd, &CStr) -> std::io::Result<libc::stat>,
    {
        let snapshot = match self.read_leaf_snapshot(leaf)? {
            SnapshotLeaf::Missing => return Ok(CheckedUnlink::Missing),
            SnapshotLeaf::Other => return Ok(CheckedUnlink::Other),
            SnapshotLeaf::Regular(snapshot) => snapshot,
        };
        if neuralnote_core::ai::note_content_hash(&snapshot.content) != expected_hash {
            return Ok(CheckedUnlink::Edited);
        }

        let leaf_c = leaf_cstring(leaf)?;
        if let Some(outcome) = self.recheck_original_unchanged(leaf, &leaf_c, &snapshot.stat)? {
            return Ok(outcome);
        }

        after_identity_check();
        let Some(quarantine) = self.quarantine_leaf(&leaf_c, leaf)? else {
            return Ok(CheckedUnlink::Missing);
        };
        after_quarantine(&quarantine);
        let quarantined = match self.read_leaf_snapshot(&quarantine) {
            Err(error) => {
                let context =
                    format!("could not verify quarantined undo leaf '{quarantine}': {error}");
                return self.restore_for_retry_or_finish(
                    &quarantine,
                    &leaf_c,
                    leaf,
                    &snapshot,
                    Err(CoreError::Io(format!(
                        "{context}; the original path was restored for retry"
                    ))),
                    context,
                );
            }
            Ok(SnapshotLeaf::Regular(snapshot)) => snapshot,
            Ok(SnapshotLeaf::Missing) => {
                return Ok(CheckedUnlink::DeletedUnverified(
                    "the quarantined note disappeared before verification; the original path was not reauthorized"
                        .into(),
                ))
            }
            Ok(SnapshotLeaf::Other) => {
                return self.restore_for_retry_or_finish(
                    &quarantine,
                    &leaf_c,
                    leaf,
                    &snapshot,
                    Ok(CheckedUnlink::RetryReleased(format!(
                        "undo recovery leaf '{quarantine}' is no longer a regular file; retry authority was released"
                    ))),
                    format!("undo recovery leaf '{quarantine}' is no longer a regular file"),
                );
            }
        };
        let content_unchanged =
            neuralnote_core::ai::note_content_hash(&quarantined.content) == expected_hash;
        let identity_unchanged = same_file_identity(&snapshot.stat, &quarantined.stat);
        if !content_unchanged || !identity_unchanged {
            let outcome = if identity_unchanged {
                CheckedUnlink::Edited
            } else {
                CheckedUnlink::Recreated
            };
            return self.restore_for_retry_or_finish(
                &quarantine,
                &leaf_c,
                leaf,
                &snapshot,
                Ok(outcome),
                format!("undo recovery leaf '{quarantine}' changed before deletion"),
            );
        }

        let quarantine_c = leaf_cstring(&quarantine)?;
        if let Err(error) = delete_quarantine(self.fd.as_raw_fd(), &quarantine_c) {
            let primary =
                format!("could not delete verified undo recovery leaf '{quarantine}': {error}");
            return self.restore_for_retry_or_finish(
                &quarantine,
                &leaf_c,
                leaf,
                &snapshot,
                Err(CoreError::Io(format!(
                    "{primary}; the original path was restored for retry"
                ))),
                primary,
            );
        }
        match stat_original(self.fd.as_raw_fd(), &leaf_c) {
            Ok(_) => Ok(CheckedUnlink::Recreated),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(CheckedUnlink::Deleted),
            Err(error) => Ok(CheckedUnlink::DeletedUnverified(format!(
                "the note this run wrote was deleted, but the original path could not be re-checked: {error}"
            ))),
        }
    }

    fn recheck_original_unchanged(
        &self,
        leaf: &str,
        leaf_c: &CStr,
        original: &libc::stat,
    ) -> CoreResult<Option<CheckedUnlink>> {
        let current = match statat_nofollow(self.fd.as_raw_fd(), leaf_c) {
            Ok(stat) => stat,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                return Ok(Some(CheckedUnlink::Missing))
            }
            Err(error) => {
                return Err(CoreError::Io(format!(
                    "could not re-check undo leaf '{leaf}': {error}"
                )))
            }
        };
        if !is_regular_file(&current) {
            return Ok(Some(CheckedUnlink::Other));
        }
        if !same_file_version(original, &current) {
            return Ok(Some(if same_file_identity(original, &current) {
                CheckedUnlink::Edited
            } else {
                CheckedUnlink::Recreated
            }));
        }
        Ok(None)
    }

    fn restore_for_retry_or_finish(
        &self,
        quarantine: &str,
        original: &CStr,
        display_leaf: &str,
        expected: &LeafSnapshot,
        restored: CoreResult<CheckedUnlink>,
        context: String,
    ) -> CoreResult<CheckedUnlink> {
        match self.restore_quarantined_leaf(quarantine, original, display_leaf) {
            Ok(()) => match restored {
                Ok(outcome) => Ok(outcome),
                Err(retry_error) => match self.read_leaf_snapshot(display_leaf) {
                    Ok(SnapshotLeaf::Regular(current))
                        if same_file_identity(&expected.stat, &current.stat)
                            && neuralnote_core::ai::note_content_hash(&current.content)
                                == neuralnote_core::ai::note_content_hash(&expected.content) =>
                    {
                        Err(retry_error)
                    }
                    Ok(_) => Ok(CheckedUnlink::RetryReleased(format!(
                        "{context}; the restored path no longer matches the quarantined note, so retry authority was released"
                    ))),
                    Err(error) => Ok(CheckedUnlink::RetryReleased(format!(
                        "{context}; the restored path could not be verified, so retry authority was released: {error}"
                    ))),
                },
            },
            Err(restore_error) => Ok(CheckedUnlink::RetryReleased(format!(
                "{context}; the note remains preserved as '{quarantine}' and retry authority was released because its original path could not be restored: {restore_error}"
            ))),
        }
    }

    fn quarantine_leaf(&self, leaf: &CStr, display_leaf: &str) -> CoreResult<Option<String>> {
        // TODO(undo-quarantine-recovery): persist the original/recovery-name
        // mapping and reconcile it when a vault opens if Undo or canceled-write
        // cleanup must survive an OS-level process kill in this synchronous
        // rename/recheck window. Normal errors restore or explicitly name the
        // preserved file, but SIGKILL cannot run either branch and may leave the
        // bytes under this hidden name.
        for _ in 0..16 {
            let sequence = UNDO_QUARANTINE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let quarantine = format!(".neuralnote-undo-{}-{sequence}.tmp", std::process::id());
            let quarantine_c = leaf_cstring(&quarantine)?;
            match rustix::fs::renameat_with(
                &self.fd,
                leaf,
                &self.fd,
                &quarantine_c,
                rustix::fs::RenameFlags::NOREPLACE,
            ) {
                Ok(()) => return Ok(Some(quarantine)),
                Err(rustix::io::Errno::NOENT) => return Ok(None),
                Err(rustix::io::Errno::EXIST) => continue,
                Err(error) => {
                    return Err(CoreError::Io(format!(
                        "could not quarantine note leaf '{display_leaf}': {error}"
                    )))
                }
            }
        }
        Err(CoreError::Conflict(format!(
            "could not allocate a private recovery name for note leaf '{display_leaf}'"
        )))
    }

    fn restore_quarantined_leaf(
        &self,
        quarantine: &str,
        original: &CStr,
        display_leaf: &str,
    ) -> CoreResult<()> {
        let quarantine_c = leaf_cstring(quarantine)?;
        match rustix::fs::renameat_with(
            &self.fd,
            &quarantine_c,
            &self.fd,
            original,
            rustix::fs::RenameFlags::NOREPLACE,
        ) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::EXIST) => Err(CoreError::Conflict(format!(
                "preserved changed note leaf '{display_leaf}' as '{quarantine}' because the original path was recreated"
            ))),
            Err(error) => Err(CoreError::Io(format!(
                "preserved changed note leaf '{display_leaf}' as '{quarantine}', but could not restore its original name: {error}"
            ))),
        }
    }

    fn read_leaf_snapshot(&self, leaf: &str) -> CoreResult<SnapshotLeaf> {
        let leaf_c = leaf_cstring(leaf)?;
        let raw = unsafe {
            // SAFETY: the directory FD is live and `leaf_c` is one NUL-terminated
            // component. O_NOFOLLOW refuses a final symlink.
            libc::openat(
                self.fd.as_raw_fd(),
                leaf_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENOENT) => Ok(SnapshotLeaf::Missing),
                Some(libc::ELOOP) => Ok(SnapshotLeaf::Other),
                _ => Err(CoreError::Io(format!(
                    "could not open undo leaf '{leaf}': {error}"
                ))),
            };
        }
        let fd = unsafe {
            // SAFETY: openat returned a fresh descriptor owned by this scope.
            OwnedFd::from_raw_fd(raw)
        };
        let initial = fstat_fd(fd.as_raw_fd()).map_err(|error| {
            CoreError::Io(format!("could not inspect undo leaf '{leaf}': {error}"))
        })?;
        if !is_regular_file(&initial) {
            return Ok(SnapshotLeaf::Other);
        }
        let mut file = File::from(fd);
        let mut content = String::new();
        file.read_to_string(&mut content).map_err(|error| {
            CoreError::Io(format!("could not read undo leaf '{leaf}': {error}"))
        })?;
        let stat = fstat_fd(file.as_raw_fd()).map_err(|error| {
            CoreError::Io(format!("could not re-check undo leaf '{leaf}': {error}"))
        })?;
        Ok(SnapshotLeaf::Regular(LeafSnapshot {
            content,
            stat,
            _file: file,
        }))
    }
}

impl AsRawFd for StableDirectory {
    fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

impl NoteWriteParent for StableDirectory {
    fn probe(&self, leaf: &str) -> CoreResult<NotePathState> {
        self.ensure_active()?;
        let leaf_c = leaf_cstring(leaf)?;
        let stat = match statat_nofollow(self.fd.as_raw_fd(), &leaf_c) {
            Ok(stat) => stat,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                return Ok(NotePathState::Missing)
            }
            Err(error) => {
                return Err(CoreError::Io(format!(
                    "could not inspect note leaf '{leaf}': {error}"
                )))
            }
        };
        if !is_regular_file(&stat) {
            return Ok(NotePathState::Other);
        }

        let state = NotePathState::RegularFile {
            actual_name: actual_regular_name(self.fd.as_raw_fd(), leaf, &stat)?,
        };
        self.ensure_active()?;
        Ok(state)
    }

    fn create_new_all_or_nothing(&self, leaf: &str, content: &str) -> CoreResult<()> {
        self.create_with(leaf, |file| {
            file.write_all(content.as_bytes())?;
            file.sync_all()
        })
    }
}

/// Open a directory without following its final component. Ancestor components may
/// still change during the syscall, which is why [`verify_opened_directory`] must
/// run on the resulting descriptor before it becomes a capability.
fn open_directory(path: &Path) -> CoreResult<OwnedFd> {
    let path_c = path_cstring(path)?;
    let raw = unsafe {
        // SAFETY: `path_c` is a valid C pathname. `open` returns a fresh descriptor
        // on success, transferred to OwnedFd immediately below.
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        let error = std::io::Error::last_os_error();
        return Err(match error.raw_os_error() {
            Some(libc::ENOENT) => CoreError::NotFound(path.display().to_string()),
            Some(libc::ELOOP) => CoreError::OutsideVault(format!(
                "refused symlink while opening note parent '{}'",
                path.display()
            )),
            _ => CoreError::Io(format!(
                "could not open note parent '{}': {error}",
                path.display()
            )),
        });
    }
    Ok(unsafe {
        // SAFETY: `open` returned a fresh, owned descriptor.
        OwnedFd::from_raw_fd(raw)
    })
}

/// Resolve the path of the object represented by `fd` *after* opening it and prove
/// that identity remains within `canonical_root`. Never fall back to the caller's
/// pre-open path: doing so would recreate the race this check exists to close.
fn verify_opened_directory(canonical_root: &Path, fd: &OwnedFd) -> CoreResult<PathBuf> {
    let opened_path = opened_fd_path(fd)?;
    if opened_path != canonical_root && !opened_path.starts_with(canonical_root) {
        return Err(CoreError::OutsideVault(format!(
            "opened note parent '{}' is outside vault '{}'",
            opened_path.display(),
            canonical_root.display()
        )));
    }
    Ok(opened_path)
}

#[cfg(target_os = "macos")]
fn opened_fd_path(fd: &OwnedFd) -> CoreResult<PathBuf> {
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
    let result = unsafe {
        // SAFETY: macOS F_GETPATH requires a writable MAXPATHLEN-sized buffer;
        // `buffer` has that size and `fd` remains live for the call.
        libc::fcntl(
            fd.as_raw_fd(),
            libc::F_GETPATH,
            buffer.as_mut_ptr().cast::<libc::c_char>(),
        )
    };
    if result < 0 {
        return Err(CoreError::Io(format!(
            "could not resolve opened note-parent identity: {}",
            std::io::Error::last_os_error()
        )));
    }
    let terminator = buffer
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| CoreError::Io("opened note-parent path was not NUL terminated".into()))?;
    Ok(PathBuf::from(OsStr::from_bytes(&buffer[..terminator])))
}

#[cfg(not(target_os = "macos"))]
fn opened_fd_path(fd: &OwnedFd) -> CoreResult<PathBuf> {
    let proc_path = PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()));
    let opened = std::fs::read_link(&proc_path).map_err(|error| {
        CoreError::Io(format!(
            "could not resolve opened note-parent identity through '{}': {error}",
            proc_path.display()
        ))
    })?;
    if opened.as_os_str().as_bytes().ends_with(b" (deleted)") {
        return Err(CoreError::Io(format!(
            "opened note parent '{}' was deleted before identity verification",
            opened.display()
        )));
    }
    Ok(opened)
}

fn path_cstring(path: &Path) -> CoreResult<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        CoreError::InvalidName(format!("path '{}' contains a NUL byte", path.display()))
    })
}

/// Enforce the trait's leaf-only contract at the syscall boundary. Core owns the
/// richer note-path policy; this narrow check exists so an accidental future caller
/// cannot turn an `openat` leaf into `../` traversal.
fn leaf_cstring(leaf: &str) -> CoreResult<CString> {
    let mut components = Path::new(leaf).components();
    let is_single_leaf = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(name)), None) if name == OsStr::new(leaf)
    );
    if !is_single_leaf {
        return Err(CoreError::InvalidName(format!(
            "'{leaf}' is not a single note filename"
        )));
    }
    CString::new(leaf.as_bytes())
        .map_err(|_| CoreError::InvalidName("note filename contains a NUL byte".into()))
}

fn statat_nofollow(dir_fd: RawFd, leaf: &CStr) -> std::io::Result<libc::stat> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        // SAFETY: `dir_fd` is live, `leaf` is NUL terminated, and `stat` points to
        // enough writable storage. AT_SYMLINK_NOFOLLOW preserves final-leaf safety.
        libc::fstatat(
            dir_fd,
            leaf.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe {
            // SAFETY: successful fstatat initialized the entire stat structure.
            stat.assume_init()
        })
    }
}

fn fstat_fd(fd: RawFd) -> std::io::Result<libc::stat> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        // SAFETY: `fd` is live and `stat` has space for one result.
        libc::fstat(fd, stat.as_mut_ptr())
    };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe {
            // SAFETY: successful fstat initialized the result.
            stat.assume_init()
        })
    }
}

fn same_file_version(before: &libc::stat, current: &libc::stat) -> bool {
    same_file_identity(before, current)
        && before.st_size == current.st_size
        && same_file_times(before, current)
}

fn same_file_identity(before: &libc::stat, current: &libc::stat) -> bool {
    before.st_dev == current.st_dev && before.st_ino == current.st_ino
}

#[cfg(target_vendor = "apple")]
fn same_file_times(before: &libc::stat, current: &libc::stat) -> bool {
    before.st_mtime == current.st_mtime
        && before.st_mtime_nsec == current.st_mtime_nsec
        && before.st_ctime == current.st_ctime
        && before.st_ctime_nsec == current.st_ctime_nsec
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn same_file_times(before: &libc::stat, current: &libc::stat) -> bool {
    before.st_mtime == current.st_mtime
        && before.st_mtime_nsec == current.st_mtime_nsec
        && before.st_ctime == current.st_ctime
        && before.st_ctime_nsec == current.st_ctime_nsec
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
fn same_file_times(_before: &libc::stat, _current: &libc::stat) -> bool {
    true
}

fn is_regular_file(stat: &libc::stat) -> bool {
    stat.st_mode & libc::S_IFMT == libc::S_IFREG
}

/// Recover the stored casing/normalisation from the opened directory rather than
/// lowercasing or normalising in Rust (which would guess at the filesystem's real
/// equivalence grammar). On a case-insensitive filesystem, `fstatat(requested)`
/// identifies the object and readdir supplies its actual stored bytes.
fn actual_regular_name(dir_fd: RawFd, requested: &str, target: &libc::stat) -> CoreResult<String> {
    let dot = CString::new(".").expect("dot contains no NUL");
    let stream_fd = openat_directory(dir_fd, &dot)?;
    let raw_stream_fd = stream_fd.into_raw_fd();
    let raw_stream = unsafe {
        // SAFETY: fdopendir takes ownership of the fresh directory descriptor.
        libc::fdopendir(raw_stream_fd)
    };
    if raw_stream.is_null() {
        let error = std::io::Error::last_os_error();
        let _ = unsafe {
            // SAFETY: fdopendir failed, so ownership of the descriptor was not
            // transferred to a DIR stream and it must be closed here.
            libc::close(raw_stream_fd)
        };
        return Err(CoreError::Io(format!(
            "could not enumerate opened note parent: {error}"
        )));
    }
    let stream = DirectoryStream(raw_stream);
    let mut matching_names = Vec::new();

    loop {
        clear_errno();
        let entry = unsafe {
            // SAFETY: `stream.0` remains a valid DIR pointer for this loop and each
            // returned entry is copied before the next readdir call.
            libc::readdir(stream.0)
        };
        if entry.is_null() {
            if let Some(error) = readdir_error() {
                return Err(CoreError::Io(format!(
                    "could not enumerate opened note parent: {error}"
                )));
            }
            break;
        }
        let name = unsafe {
            // SAFETY: POSIX dirent::d_name is NUL terminated for a successful
            // readdir result and remains valid until the next readdir call.
            CStr::from_ptr((*entry).d_name.as_ptr())
        };
        match classify_directory_entry(dir_fd, requested, target, name)? {
            DirectoryEntryClassification::Skip => continue,
            DirectoryEntryClassification::ExactMatch => return Ok(requested.to_string()),
            DirectoryEntryClassification::Alias(stored) => matching_names.push(stored),
        }
    }
    drop(stream);

    match matching_names.as_slice() {
        [stored] => Ok(stored.clone()),
        [] => Err(CoreError::Conflict(format!(
            "regular note leaf '{requested}' disappeared while resolving its stored name"
        ))),
        _ => Err(CoreError::Conflict(format!(
            "regular note leaf '{requested}' has ambiguous hard-link aliases"
        ))),
    }
}

enum DirectoryEntryClassification {
    Skip,
    ExactMatch,
    Alias(String),
}

fn classify_directory_entry(
    dir_fd: RawFd,
    requested: &str,
    target: &libc::stat,
    name: &CStr,
) -> CoreResult<DirectoryEntryClassification> {
    if matches!(name.to_bytes(), b"." | b"..") {
        return Ok(DirectoryEntryClassification::Skip);
    }
    let entry_stat = match statat_nofollow(dir_fd, name) {
        Ok(stat) => stat,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            return Err(CoreError::Conflict(
                "note parent changed while resolving stored filename".into(),
            ))
        }
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not inspect a stored note filename: {error}"
            )))
        }
    };
    if entry_stat.st_dev != target.st_dev || entry_stat.st_ino != target.st_ino {
        return Ok(DirectoryEntryClassification::Skip);
    }
    if name.to_bytes() == requested.as_bytes() {
        return Ok(DirectoryEntryClassification::ExactMatch);
    }
    let stored = std::str::from_utf8(name.to_bytes()).map_err(|_| {
        CoreError::InvalidName(
            "colliding note filename is not valid UTF-8 and cannot be reported safely".into(),
        )
    })?;
    Ok(DirectoryEntryClassification::Alias(stored.to_string()))
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        let result = unsafe {
            // SAFETY: this wrapper uniquely owns the DIR pointer returned by
            // fdopendir and closes it exactly once.
            libc::closedir(self.0)
        };
        if result < 0 {
            log::warn!(
                "could not close note-parent directory stream: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

fn openat_directory(dir_fd: RawFd, leaf: &CStr) -> CoreResult<OwnedFd> {
    let raw = unsafe {
        // SAFETY: `dir_fd` is live and `leaf` is NUL terminated. No create mode is
        // needed because these flags cannot create an entry.
        libc::openat(
            dir_fd,
            leaf.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        return Err(CoreError::Io(format!(
            "could not duplicate opened note parent for enumeration: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(unsafe {
        // SAFETY: openat returned a fresh, owned descriptor.
        OwnedFd::from_raw_fd(raw)
    })
}

fn unlinkat(dir_fd: RawFd, leaf: &CStr) -> std::io::Result<()> {
    let result = unsafe {
        // SAFETY: `dir_fd` is live and `leaf` is a NUL-terminated single component.
        // unlinkat removes the directory entry itself and never follows a symlink.
        libc::unlinkat(dir_fd, leaf.as_ptr(), 0)
    };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_vendor = "apple")]
fn clear_errno() {
    unsafe {
        // SAFETY: __error returns this thread's errno slot on Apple platforms.
        *libc::__error() = 0;
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn clear_errno() {
    unsafe {
        // SAFETY: __errno_location returns this thread's errno slot on Linux.
        *libc::__errno_location() = 0;
    }
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
fn clear_errno() {}

#[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
fn readdir_error() -> Option<std::io::Error> {
    let error = std::io::Error::last_os_error();
    (error.raw_os_error() != Some(0)).then_some(error)
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
fn readdir_error() -> Option<std::io::Error> {
    // The shipped macOS path and Linux CI both expose a thread-local errno setter.
    // On other Unix targets, a null readdir result is conservatively treated as EOF;
    // the rest of the descriptor confinement remains enforced.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use neuralnote_core::ai::{NotePathState, NoteWriteBackend, NoteWriteParent};
    use neuralnote_core::CoreError;
    use std::fs;
    use std::io::{self, Write};
    use std::os::unix::fs::symlink;
    use std::sync::Arc;

    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }

    #[test]
    fn canonicalize_maps_a_missing_path_to_not_found() {
        let dir = tempfile::tempdir().unwrap();

        assert!(matches!(
            FsNoteWriteBackend.canonicalize(&dir.path().join("missing")),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn closed_run_backend_refuses_to_open_a_note_parent() {
        let dir = tempfile::tempdir().unwrap();
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let backend = RunNoteWriteBackend::new(Arc::clone(&signal));
        signal.close();

        assert!(matches!(
            backend.open_parent(&canonical(dir.path()), &canonical(dir.path())),
            Err(CoreError::Conflict(message)) if message.contains("chat run ended")
        ));
    }

    #[test]
    fn cancellation_during_a_note_write_removes_the_created_leaf() {
        let dir = tempfile::tempdir().unwrap();
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let stable = StableDirectory::open_confined_for_run(
            &canonical(dir.path()),
            &canonical(dir.path()),
            Arc::clone(&signal),
        )
        .unwrap();

        let result = stable.create_with("Cancelled.md", |file| {
            file.write_all(b"must not survive")?;
            signal.close();
            Ok(())
        });

        assert!(matches!(
            result,
            Err(CoreError::Conflict(message)) if message.contains("chat run ended")
        ));
        assert!(!dir.path().join("Cancelled.md").exists());
    }

    #[test]
    fn cancellation_cleanup_never_deletes_a_concurrent_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Cancelled.md");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let stable = StableDirectory::open_confined_for_run(
            &canonical(dir.path()),
            &canonical(dir.path()),
            Arc::clone(&signal),
        )
        .unwrap();

        let result = stable.create_with("Cancelled.md", |file| {
            file.write_all(b"run output")?;
            fs::remove_file(&path)?;
            fs::write(&path, "user replacement")?;
            signal.close();
            Ok(())
        });

        assert!(matches!(result, Err(CoreError::Conflict(_))));
        assert_eq!(fs::read_to_string(path).unwrap(), "user replacement");
    }

    #[test]
    fn create_and_probe_use_the_open_directory_capability() {
        let dir = tempfile::tempdir().unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        assert_eq!(stable.probe("New.md").unwrap(), NotePathState::Missing);
        stable
            .create_new_all_or_nothing("New.md", "complete content")
            .unwrap();

        assert_eq!(
            stable.probe("New.md").unwrap(),
            NotePathState::RegularFile {
                actual_name: "New.md".into()
            }
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("New.md")).unwrap(),
            "complete content"
        );
    }

    #[test]
    fn create_collision_maps_to_already_exists_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Existing.md"), "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        assert!(matches!(
            stable.create_new_all_or_nothing("Existing.md", "replacement"),
            Err(CoreError::AlreadyExists(_))
        ));
        assert_eq!(
            fs::read_to_string(dir.path().join("Existing.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn symlink_leaf_is_other_and_is_never_followed_or_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target.md");
        fs::write(&target, "outside").unwrap();
        symlink(&target, dir.path().join("Link.md")).unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        assert_eq!(stable.probe("Link.md").unwrap(), NotePathState::Other);
        assert!(matches!(
            stable.create_new_all_or_nothing("Link.md", "replacement"),
            Err(CoreError::AlreadyExists(_))
        ));
        assert_eq!(fs::read_to_string(target).unwrap(), "outside");
    }

    #[test]
    fn probe_returns_stored_casing_when_the_filesystem_collides() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Concept.md"), "existing").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        if dir.path().join("concept.md").try_exists().unwrap() {
            assert_eq!(
                stable.probe("concept.md").unwrap(),
                NotePathState::RegularFile {
                    actual_name: "Concept.md".into()
                }
            );
        }
    }

    #[test]
    fn post_open_identity_rejects_a_directory_moved_outside_the_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let vault = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        let parent = vault.join("Parent");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir(&outside).unwrap();
        let fd = open_directory(&canonical(&parent)).unwrap();
        fs::rename(&parent, outside.join("Escaped")).unwrap();

        assert!(matches!(
            verify_opened_directory(&canonical(&vault), &fd),
            Err(CoreError::OutsideVault(_))
        ));
    }

    #[test]
    fn opened_fd_survives_later_path_swap_without_following_the_new_symlink() {
        let sandbox = tempfile::tempdir().unwrap();
        let vault = sandbox.path().join("vault");
        let outside = sandbox.path().join("outside");
        let parent = vault.join("Parent");
        let original = vault.join("Parent original");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir(&outside).unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(&vault), &canonical(&parent)).unwrap();
        fs::rename(&parent, &original).unwrap();
        symlink(&outside, &parent).unwrap();

        stable
            .create_new_all_or_nothing("Safe.md", "content")
            .unwrap();

        assert_eq!(
            fs::read_to_string(original.join("Safe.md")).unwrap(),
            "content"
        );
        assert!(!outside.join("Safe.md").exists());
    }

    #[test]
    fn a_write_error_unlinks_the_partial_leaf() {
        let dir = tempfile::tempdir().unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        let result = stable.create_with("Partial.md", |file| {
            file.write_all(b"partial")?;
            Err(io::Error::other("forced write failure"))
        });

        assert!(
            matches!(result, Err(CoreError::Io(message)) if message.contains("forced write failure"))
        );
        assert!(!dir.path().join("Partial.md").exists());
    }

    #[test]
    fn leaf_operations_reject_traversal_even_when_called_below_core_policy() {
        let dir = tempfile::tempdir().unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        assert!(matches!(
            stable.create_new_all_or_nothing("../Escape.md", "content"),
            Err(CoreError::InvalidName(_))
        ));
        assert!(!dir.path().parent().unwrap().join("Escape.md").exists());
    }

    #[test]
    fn undo_helpers_read_and_delete_only_the_expected_content() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Written.md"), "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();

        assert_eq!(
            stable.read_leaf("Written.md").unwrap(),
            ReadLeaf::Regular("original".into())
        );
        assert_eq!(
            stable
                .unlink_if_hash(
                    "Written.md",
                    &neuralnote_core::ai::note_content_hash("original")
                )
                .unwrap(),
            CheckedUnlink::Deleted
        );
        assert!(!dir.path().join("Written.md").exists());
    }

    #[test]
    fn undo_helpers_distinguish_missing_edited_and_non_regular_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target.md");
        fs::write(&target, "outside").unwrap();
        fs::write(dir.path().join("Edited.md"), "changed").unwrap();
        symlink(&target, dir.path().join("Link.md")).unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        assert_eq!(stable.read_leaf("Missing.md").unwrap(), ReadLeaf::Missing);
        assert_eq!(
            stable.unlink_if_hash("Missing.md", &expected).unwrap(),
            CheckedUnlink::Missing
        );
        assert_eq!(
            stable.unlink_if_hash("Edited.md", &expected).unwrap(),
            CheckedUnlink::Edited
        );
        assert_eq!(stable.read_leaf("Link.md").unwrap(), ReadLeaf::Other);
        assert_eq!(
            stable.unlink_if_hash("Link.md", &expected).unwrap(),
            CheckedUnlink::Other
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "outside");
        assert!(dir.path().join("Edited.md").exists());
        assert!(dir.path().join("Link.md").exists());
    }

    #[test]
    fn undo_preserves_a_replacement_made_after_the_final_identity_check() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_after_check("Written.md", &expected, || {
                fs::remove_file(&path).unwrap();
                fs::write(&path, "user edit").unwrap();
            })
            .unwrap();

        assert_eq!(result, CheckedUnlink::Recreated);
        assert_eq!(fs::read_to_string(path).unwrap(), "user edit");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".neuralnote-undo-")
        }));
    }

    #[test]
    fn undo_removes_the_old_version_but_keeps_a_save_created_after_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_hooks(
                "Written.md",
                &expected,
                || {},
                |_| {
                    fs::write(&path, "user edit").unwrap();
                },
            )
            .unwrap();

        assert_eq!(result, CheckedUnlink::Recreated);
        assert_eq!(fs::read_to_string(path).unwrap(), "user edit");
    }

    #[test]
    fn failed_quarantine_delete_restores_the_original_path_for_a_safe_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable.unlink_if_hash_with_ops(
            "Written.md",
            &expected,
            || {},
            |_| {},
            |_, _| Err(io::Error::other("forced quarantine delete failure")),
            statat_nofollow,
        );

        assert!(matches!(
            result,
            Err(CoreError::Io(message))
                if message.contains("forced quarantine delete failure")
                    && message.contains("restored for retry")
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".neuralnote-undo-")
        }));
    }

    #[test]
    fn failed_quarantine_delete_never_reauthorizes_a_recreated_original_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_ops(
                "Written.md",
                &expected,
                || {},
                |_| fs::write(&path, "replacement").unwrap(),
                |_, _| Err(io::Error::other("forced quarantine delete failure")),
                statat_nofollow,
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::RetryReleased(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "replacement");
    }

    #[test]
    fn retry_requires_the_exact_original_inode_to_be_restored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_ops(
                "Written.md",
                &expected,
                || {},
                |_| {},
                |_, quarantine| {
                    let quarantine = dir.path().join(quarantine.to_str().unwrap());
                    fs::remove_file(&quarantine).unwrap();
                    fs::write(quarantine, "original").unwrap();
                    Err(io::Error::other("forced quarantine delete failure"))
                },
                statat_nofollow,
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::RetryReleased(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn non_regular_quarantine_state_is_terminal_even_when_restored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_hooks(
                "Written.md",
                &expected,
                || {},
                |quarantine| {
                    let quarantine = dir.path().join(quarantine);
                    fs::remove_file(&quarantine).unwrap();
                    fs::create_dir(quarantine).unwrap();
                },
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::RetryReleased(_)));
        assert!(path.is_dir());
    }

    #[test]
    fn quarantined_mismatch_never_reauthorizes_a_recreated_original_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_hooks(
                "Written.md",
                &expected,
                || {},
                |quarantine| {
                    fs::write(dir.path().join(quarantine), "changed recovery").unwrap();
                    fs::write(&path, "original").unwrap();
                },
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::RetryReleased(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn vanished_quarantine_is_terminal_and_cannot_reauthorize_the_original_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_hooks(
                "Written.md",
                &expected,
                || {},
                |quarantine| {
                    fs::remove_file(dir.path().join(quarantine)).unwrap();
                    fs::write(&path, "original").unwrap();
                },
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::DeletedUnverified(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn final_stat_failure_is_terminal_after_the_owned_note_was_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Written.md");
        fs::write(&path, "original").unwrap();
        let stable =
            StableDirectory::open_confined(&canonical(dir.path()), &canonical(dir.path())).unwrap();
        let expected = neuralnote_core::ai::note_content_hash("original");

        let result = stable
            .unlink_if_hash_with_ops(
                "Written.md",
                &expected,
                || {},
                |_| {},
                unlinkat,
                |_, _| Err(io::Error::other("forced final stat failure")),
            )
            .unwrap();

        assert!(matches!(result, CheckedUnlink::DeletedUnverified(_)));
        assert!(!path.exists());
    }
}
