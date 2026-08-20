//! The hidden temp sibling every atomic file write in the core renames into place.
//!
//! Each write path builds a *predictable* name — a dot prefix that keeps it out of
//! the tree scan, this process's id, and a counter — so anything able to drop a
//! file in the target directory can plant a symlink there first. `create_new` is
//! `O_CREAT|O_EXCL`, which POSIX requires to fail `EEXIST` on a symlink, dangling
//! or not, rather than follow it: the content being written can never truncate
//! whatever the link points at (issues #193, #213). A taken name is skipped rather
//! than failing the write, bounded by [`MAX_TEMP_ATTEMPTS`] so exhaustion is
//! explicit rather than endless.
//!
//! One control, one implementation. What legitimately differs between call sites
//! stays with them: their own counter, so one site's contention never advances
//! another's; their own error wording; whether they `sync_all` the handle before
//! renaming (`config_io` does, the note save path deliberately does not, to keep
//! its performance profile); and what they do with a failed write or rename.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{CoreError, CoreResult};

/// How many temp names one write will try before giving up. Bounded so a squatted
/// name is skipped rather than failing the write, and so a directory full of
/// squatting names ends in an explicit error rather than an unbounded loop.
pub(crate) const MAX_TEMP_ATTEMPTS: usize = 32;

/// Create and open `parent`/`.{file_name}.{pid}.{n}.nn-tmp`, refusing to follow a
/// symlink squatting the name.
///
/// `sequence` is the calling site's own name counter. `action` is what that site
/// was doing, so a failure reads `"{action}: {detail}"` in the site's own words.
///
/// The returned handle is a brand-new, empty, writable file the caller owns; it is
/// the caller's job to write it, and to remove it if the write or the rename fails.
pub(crate) fn create_temp_sibling(
    parent: &Path,
    file_name: &str,
    sequence: &AtomicU64,
    action: &str,
) -> CoreResult<(PathBuf, std::fs::File)> {
    (0..MAX_TEMP_ATTEMPTS)
        .find_map(|_| {
            let seq = sequence.fetch_add(1, Ordering::Relaxed);
            let temp = parent.join(format!(".{file_name}.{}.{seq}.nn-tmp", std::process::id()));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
            {
                Ok(file) => Some(Ok((temp, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(CoreError::Io(format!("{action}: {error}")))),
            }
        })
        .unwrap_or_else(|| {
            Err(CoreError::Io(format!(
                "{action}: no unique temporary file was available"
            )))
        })
}
