//! Vault-confined storage for the durable per-vault skill-routing profile.

use neuralnote_core::capture::{CaptureError, VaultProfileIo, MAX_VAULT_PROFILE_BYTES};
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use super::note_writer::StableDirectory;
#[cfg(unix)]
use std::ffi::{CStr, CString};
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::mem::MaybeUninit;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};

const STATE_DIRECTORY: &str = ".neuralnote";
const PROFILE_FILE: &str = "profile.json";
#[cfg(unix)]
const MAX_TEMP_ATTEMPTS: usize = 32;
#[cfg(unix)]
static PROFILE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Profile I/O bound to one canonical vault and one live chat lifecycle.
pub(crate) struct RunVaultProfileIo {
    canonical_root: std::path::PathBuf,
    close_signal: Arc<crate::ai::ChatRunCloseSignal>,
}

impl RunVaultProfileIo {
    pub(crate) fn new(
        root: &Path,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> Result<Self, CaptureError> {
        let canonical_root = root
            .canonicalize()
            .map_err(|error| profile_error(format!("could not resolve the open vault: {error}")))?;
        if !canonical_root.is_dir() {
            return Err(profile_error("the open vault is not a directory"));
        }
        Ok(Self {
            canonical_root,
            close_signal,
        })
    }

    fn ensure_active(&self) -> Result<(), CaptureError> {
        if self.close_signal.is_closed() {
            Err(CaptureError::Cancelled(
                "chat run ended before vault profile I/O completed".into(),
            ))
        } else {
            Ok(())
        }
    }

    #[cfg(unix)]
    fn open_root(&self) -> Result<StableDirectory, CaptureError> {
        self.ensure_active()?;
        StableDirectory::open_confined(&self.canonical_root, &self.canonical_root).map_err(
            |error| profile_error(format!("could not open the vault profile root: {error}")),
        )
    }

    #[cfg(unix)]
    fn state_directory(&self, create: bool) -> Result<Option<StableDirectory>, CaptureError> {
        let root = self.open_root()?;
        let directory = if create {
            Some(
                root.open_or_create_child_directory(STATE_DIRECTORY)
                    .map_err(|error| {
                        profile_error(format!(
                            "could not open the vault profile directory: {error}"
                        ))
                    })?,
            )
        } else {
            root.open_child_directory(STATE_DIRECTORY)
                .map_err(|error| {
                    profile_error(format!(
                        "could not open the vault profile directory: {error}"
                    ))
                })?
        };
        self.ensure_active()?;
        Ok(directory)
    }
}

impl VaultProfileIo for RunVaultProfileIo {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError> {
        self.ensure_active()?;
        #[cfg(unix)]
        {
            let Some(directory) = self.state_directory(false)? else {
                return Ok(None);
            };
            let bytes = read_profile(directory.raw_fd())?;
            self.ensure_active()?;
            Ok(bytes)
        }
        #[cfg(not(unix))]
        {
            Err(profile_error(
                "vault profile I/O is unavailable on this platform",
            ))
        }
    }

    fn save(&self, bytes: &[u8]) -> Result<(), CaptureError> {
        self.ensure_active()?;
        if bytes.len() > MAX_VAULT_PROFILE_BYTES {
            return Err(profile_error("vault profile exceeds the byte limit"));
        }
        #[cfg(unix)]
        {
            let directory = self
                .state_directory(true)?
                .expect("create=true always returns a directory");
            replace_profile(directory.raw_fd(), bytes, || self.ensure_active())?;
            self.ensure_active()
        }
        #[cfg(not(unix))]
        {
            let _ = bytes;
            Err(profile_error(
                "vault profile I/O is unavailable on this platform",
            ))
        }
    }
}

#[cfg(unix)]
fn read_profile(directory_fd: RawFd) -> Result<Option<Vec<u8>>, CaptureError> {
    let leaf = CString::new(PROFILE_FILE).expect("profile filename contains no NUL");
    let raw = unsafe {
        // SAFETY: `directory_fd` is live for this call and `leaf` is one
        // NUL-terminated component. O_NOFOLLOW refuses a final symlink.
        libc::openat(
            directory_fd,
            leaf.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ENOENT) => Ok(None),
            Some(libc::ELOOP) => Err(profile_error("refused symlink vault profile")),
            _ => Err(profile_error(format!(
                "could not open the vault profile: {error}"
            ))),
        };
    }
    let mut file = unsafe {
        // SAFETY: openat returned a fresh descriptor owned by this scope.
        File::from_raw_fd(raw)
    };
    let stat = fstat(file.as_raw_fd())?;
    if !is_regular_file(&stat) {
        return Err(profile_error("vault profile is not a regular file"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_VAULT_PROFILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| profile_error(format!("could not read the vault profile: {error}")))?;
    if bytes.len() > MAX_VAULT_PROFILE_BYTES {
        return Err(profile_error("vault profile exceeds the byte limit"));
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn replace_profile(
    directory_fd: RawFd,
    bytes: &[u8],
    ensure_active: impl Fn() -> Result<(), CaptureError>,
) -> Result<(), CaptureError> {
    let destination = CString::new(PROFILE_FILE).expect("profile filename contains no NUL");
    reject_non_regular_destination(directory_fd, &destination)?;
    let (temp_name, mut temp_file) = create_profile_temp(directory_fd)?;
    let write_result = temp_file
        .write_all(bytes)
        .and_then(|()| temp_file.sync_all())
        .map_err(|error| profile_error(format!("could not write the vault profile: {error}")))
        .and_then(|()| ensure_active());
    drop(temp_file);
    if let Err(error) = write_result {
        unlink_temp(directory_fd, &temp_name);
        return Err(error);
    }
    if let Err(error) = reject_non_regular_destination(directory_fd, &destination) {
        unlink_temp(directory_fd, &temp_name);
        return Err(error);
    }
    let result = unsafe {
        // SAFETY: both names are single NUL-terminated components in the same
        // live directory capability. renameat atomically replaces a regular
        // destination and never follows a destination symlink.
        libc::renameat(
            directory_fd,
            temp_name.as_ptr(),
            directory_fd,
            destination.as_ptr(),
        )
    };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        unlink_temp(directory_fd, &temp_name);
        return Err(profile_error(format!(
            "could not replace the vault profile: {error}"
        )));
    }
    let synced = unsafe {
        // SAFETY: `directory_fd` remains a live directory descriptor.
        libc::fsync(directory_fd)
    };
    if synced < 0 {
        return Err(profile_error(format!(
            "vault profile was replaced but its directory could not be synced: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn create_profile_temp(directory_fd: RawFd) -> Result<(CString, File), CaptureError> {
    for _ in 0..MAX_TEMP_ATTEMPTS {
        let sequence = PROFILE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!(
            ".profile.json.{}.{sequence}.nn-tmp",
            std::process::id()
        ))
        .expect("generated profile temp filename contains no NUL");
        let raw = unsafe {
            // SAFETY: `directory_fd` is live, the generated name is one
            // NUL-terminated component, and O_EXCL prevents link traversal or
            // clobbering a pre-existing entry.
            libc::openat(
                directory_fd,
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600 as libc::c_uint,
            )
        };
        if raw >= 0 {
            let file = unsafe {
                // SAFETY: openat returned a fresh descriptor owned by this scope.
                File::from_raw_fd(raw)
            };
            return Ok((name, file));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(profile_error(format!(
                "could not create a vault profile temporary file: {error}"
            )));
        }
    }
    Err(profile_error(
        "could not allocate a unique vault profile temporary file",
    ))
}

#[cfg(unix)]
fn reject_non_regular_destination(directory_fd: RawFd, leaf: &CStr) -> Result<(), CaptureError> {
    match statat_nofollow(directory_fd, leaf) {
        Ok(stat) if is_regular_file(&stat) => Ok(()),
        Ok(stat) if is_symlink(&stat) => Err(profile_error("refused symlink vault profile")),
        Ok(_) => Err(profile_error("vault profile is not a regular file")),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        Err(error) => Err(profile_error(format!(
            "could not inspect the vault profile: {error}"
        ))),
    }
}

#[cfg(unix)]
fn fstat(fd: RawFd) -> Result<libc::stat, CaptureError> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        // SAFETY: `fd` is live and `stat` points to writable uninitialised storage.
        libc::fstat(fd, stat.as_mut_ptr())
    };
    if result < 0 {
        Err(profile_error(format!(
            "could not inspect the opened vault profile: {}",
            std::io::Error::last_os_error()
        )))
    } else {
        Ok(unsafe {
            // SAFETY: fstat returned success and initialized the structure.
            stat.assume_init()
        })
    }
}

#[cfg(unix)]
fn statat_nofollow(directory_fd: RawFd, leaf: &CStr) -> std::io::Result<libc::stat> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        // SAFETY: `directory_fd` is live, `leaf` is NUL terminated, and the
        // output points to writable uninitialised storage.
        libc::fstatat(
            directory_fd,
            leaf.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe {
            // SAFETY: fstatat returned success and initialized the structure.
            stat.assume_init()
        })
    }
}

#[cfg(unix)]
fn unlink_temp(directory_fd: RawFd, leaf: &CStr) {
    let result = unsafe {
        // SAFETY: the directory descriptor is live and `leaf` is one
        // NUL-terminated component. unlinkat removes the entry, never its target.
        libc::unlinkat(directory_fd, leaf.as_ptr(), 0)
    };
    if result < 0 {
        log::warn!(
            "could not remove a vault profile temporary file: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(unix)]
fn is_regular_file(stat: &libc::stat) -> bool {
    stat.st_mode & libc::S_IFMT == libc::S_IFREG
}

#[cfg(unix)]
fn is_symlink(stat: &libc::stat) -> bool {
    stat.st_mode & libc::S_IFMT == libc::S_IFLNK
}

fn profile_error(detail: impl Into<String>) -> CaptureError {
    CaptureError::ProfileInvalid(detail.into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use neuralnote_core::capture::{VaultProfileIo, MAX_VAULT_PROFILE_BYTES};
    use std::fs;
    use std::sync::Arc;

    fn profile_io(
        vault: &tempfile::TempDir,
    ) -> (RunVaultProfileIo, Arc<crate::ai::ChatRunCloseSignal>) {
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let io = RunVaultProfileIo::new(vault.path(), Arc::clone(&signal)).unwrap();
        (io, signal)
    }

    #[test]
    fn an_absent_profile_loads_as_none_without_creating_vault_state() {
        let vault = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);

        assert_eq!(io.load().unwrap(), None);
        assert!(!vault.path().join(".neuralnote").exists());
    }

    #[test]
    fn save_creates_and_atomically_replaces_the_profile() {
        let vault = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);

        io.save(br#"{"schemaVersion":1,"skills":{}}"#).unwrap();
        assert_eq!(
            io.load().unwrap(),
            Some(br#"{"schemaVersion":1,"skills":{}}"#.to_vec())
        );

        io.save(br#"{"schemaVersion":1,"skills":{"youtube-distil":{}}}"#)
            .unwrap();
        assert_eq!(
            io.load().unwrap(),
            Some(br#"{"schemaVersion":1,"skills":{"youtube-distil":{}}}"#.to_vec())
        );
        assert_eq!(
            fs::read_dir(vault.path().join(".neuralnote"))
                .unwrap()
                .count(),
            1,
            "a completed replace must not leave temporary files behind"
        );
    }

    #[test]
    fn oversized_profile_reads_and_writes_fail_closed() {
        let vault = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);
        let oversized = vec![b'x'; MAX_VAULT_PROFILE_BYTES + 1];

        let write_error = io.save(&oversized).unwrap_err();
        assert!(write_error.detail().contains("byte limit"));
        assert!(!vault.path().join(".neuralnote").exists());

        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        fs::write(vault.path().join(".neuralnote/profile.json"), oversized).unwrap();
        let read_error = io.load().unwrap_err();
        assert!(read_error.detail().contains("byte limit"));
    }

    #[test]
    fn exact_limit_and_non_utf8_profile_bytes_round_trip() {
        let vault = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);
        let mut bytes = vec![0xff; MAX_VAULT_PROFILE_BYTES];
        bytes[0] = 0;

        io.save(&bytes).unwrap();

        assert_eq!(io.load().unwrap(), Some(bytes));
    }

    #[test]
    fn non_directory_state_and_non_regular_profile_are_rejected() {
        let vault = tempfile::tempdir().unwrap();
        fs::write(vault.path().join(".neuralnote"), "not a directory").unwrap();
        let (io, _) = profile_io(&vault);
        assert!(io.load().unwrap_err().detail().contains("non-directory"));
        assert!(io
            .save(b"ignored")
            .unwrap_err()
            .detail()
            .contains("non-directory"));

        fs::remove_file(vault.path().join(".neuralnote")).unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        fs::create_dir(vault.path().join(".neuralnote/profile.json")).unwrap();
        assert!(io.load().unwrap_err().detail().contains("regular file"));
        assert!(io
            .save(b"ignored")
            .unwrap_err()
            .detail()
            .contains("regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_profile_is_refused_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let vault = tempfile::tempdir().unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        let path = vault.path().join(".neuralnote/profile.json");
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe {
            // SAFETY: `path` is a valid NUL-terminated pathname in the test vault.
            libc::mkfifo(path.as_ptr(), 0o600)
        };
        assert_eq!(result, 0);
        let (io, _) = profile_io(&vault);

        assert!(io.load().unwrap_err().detail().contains("regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_state_directory_is_rejected_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), vault.path().join(".neuralnote")).unwrap();
        let (io, _) = profile_io(&vault);

        let error = io.save(b"safe").unwrap_err();

        assert!(error.detail().contains("symlink"));
        assert!(!outside.path().join("profile.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_profile_is_rejected_without_reading_or_replacing_its_target() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "outside stays intact").unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        symlink(
            outside.path(),
            vault.path().join(".neuralnote/profile.json"),
        )
        .unwrap();
        let (io, _) = profile_io(&vault);

        assert!(io.load().unwrap_err().detail().contains("symlink"));
        assert!(io
            .save(b"replacement")
            .unwrap_err()
            .detail()
            .contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside.path()).unwrap(),
            "outside stays intact"
        );
    }

    #[cfg(unix)]
    #[test]
    fn predictable_temp_symlink_is_skipped_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "outside stays intact").unwrap();
        fs::create_dir(vault.path().join(".neuralnote")).unwrap();
        let sequence = PROFILE_TEMP_SEQUENCE.load(Ordering::Relaxed);
        symlink(
            outside.path(),
            vault.path().join(format!(
                ".neuralnote/.profile.json.{}.{sequence}.nn-tmp",
                std::process::id()
            )),
        )
        .unwrap();
        let (io, _) = profile_io(&vault);

        io.save(b"profile").unwrap();

        assert_eq!(io.load().unwrap(), Some(b"profile".to_vec()));
        assert_eq!(
            fs::read_to_string(outside.path()).unwrap(),
            "outside stays intact"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_before_publish_keeps_the_previous_profile() {
        let vault = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);
        io.save(b"previous").unwrap();
        let directory = io.state_directory(false).unwrap().unwrap();

        let result = replace_profile(directory.raw_fd(), b"replacement", || {
            Err(CaptureError::Cancelled("cancelled in test".into()))
        });

        assert!(matches!(result, Err(CaptureError::Cancelled(_))));
        assert_eq!(io.load().unwrap(), Some(b"previous".to_vec()));
        assert_eq!(
            fs::read_dir(vault.path().join(".neuralnote"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".nn-tmp"))
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_open_state_directory_never_follows_a_later_path_swap() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (io, _) = profile_io(&vault);
        io.save(b"previous").unwrap();
        let directory = io.state_directory(false).unwrap().unwrap();
        fs::rename(
            vault.path().join(".neuralnote"),
            vault.path().join(".neuralnote-moved"),
        )
        .unwrap();
        symlink(outside.path(), vault.path().join(".neuralnote")).unwrap();

        replace_profile(directory.raw_fd(), b"replacement", || Ok(())).unwrap();

        assert_eq!(
            fs::read(vault.path().join(".neuralnote-moved/profile.json")).unwrap(),
            b"replacement"
        );
        assert!(!outside.path().join("profile.json").exists());
    }

    #[test]
    fn a_closed_chat_run_cannot_read_or_write_profile_state() {
        let vault = tempfile::tempdir().unwrap();
        let (io, signal) = profile_io(&vault);
        signal.close();

        assert!(io.load().unwrap_err().detail().contains("chat run ended"));
        assert!(io
            .save(b"ignored")
            .unwrap_err()
            .detail()
            .contains("chat run ended"));
        assert!(!vault.path().join(".neuralnote").exists());
    }
}

#[cfg(all(test, not(unix)))]
mod non_unix_tests {
    use super::*;
    use neuralnote_core::capture::VaultProfileIo;
    use std::sync::Arc;

    #[test]
    fn profile_io_fails_closed_on_unsupported_platforms() {
        let vault = tempfile::tempdir().unwrap();
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let io = RunVaultProfileIo::new(vault.path(), signal).unwrap();

        assert!(io
            .load()
            .unwrap_err()
            .detail()
            .contains("unavailable on this platform"));
        assert!(io
            .save(b"ignored")
            .unwrap_err()
            .detail()
            .contains("unavailable on this platform"));
        assert!(!vault.path().join(STATE_DIRECTORY).exists());
    }
}
