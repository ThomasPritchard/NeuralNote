//! Cross-process advisory lock for one stable requirement `.part` path.

use neuralnote_core::{CoreError, CoreResult};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// Retained lock-file handle protecting the stable `.part` name across app
/// processes. The file stays on disk; a crash releases the kernel lock when its
/// descriptor closes, so later retries can safely reuse it.
pub(super) struct AdvisoryInstallLock {
    file: File,
    path: PathBuf,
}

impl AdvisoryInstallLock {
    pub(super) fn acquire(directory: &Path, name: &str) -> CoreResult<Self> {
        let path = directory.join(format!("{name}.lock"));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&path).map_err(|error| {
            CoreError::Io(format!(
                "could not open requirement install lock '{}': {error}",
                path.display()
            ))
        })?;
        lock_file_nonblocking(&file, &path)?;
        Ok(Self { file, path })
    }
}

impl Drop for AdvisoryInstallLock {
    fn drop(&mut self) {
        if let Err(error) = unlock_file(&self.file) {
            log::warn!(
                "could not release requirement install lock '{}': {error}",
                self.path.display()
            );
        }
    }
}

#[cfg(unix)]
fn lock_file_nonblocking(file: &File, path: &Path) -> CoreResult<()> {
    use std::os::fd::AsRawFd;

    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Err(CoreError::Conflict(format!(
                "another process is already installing requirement '{}'",
                path.display()
            )));
        }
        return Err(CoreError::Io(format!(
            "could not lock requirement install file '{}': {error}",
            path.display()
        )));
    }
}

#[cfg(not(unix))]
fn lock_file_nonblocking(_file: &File, _path: &Path) -> CoreResult<()> {
    Ok(())
}

#[cfg(unix)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) -> std::io::Result<()> {
    Ok(())
}
