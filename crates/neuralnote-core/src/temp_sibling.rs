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
                Err(error) => Some(Err(open_failure(action, &error))),
            }
        })
        .unwrap_or_else(|| {
            // Every one of these names is one only this process could predict, and
            // all of them were refused EEXIST — the signature of the squatting this
            // module exists to refuse, not of ordinary contention. Leave a trace an
            // operator can find; the caller still gets the same explicit error.
            log::warn!(
                "temp_sibling: all {MAX_TEMP_ATTEMPTS} temp names for {file_name} were taken in {}",
                parent.display()
            );
            Err(CoreError::Io(format!(
                "{action}: no unique temporary file was available"
            )))
        })
}

/// The calling site's `{action}` wording, carried on the *kind* of failure that
/// actually occurred.
///
/// The variant is load-bearing past the message: `ai::tools::settle_vault_error`
/// buckets `NotFound` as a rejection the model can recover from and `Io` as a
/// failure that reads to the user as NeuralNote breaking. A parent directory
/// removed between a write's path check and this open is the first of those, so
/// flattening every kind to `Io` would report a recoverable race as a product
/// fault. `AlreadyExists` never arrives here — the retry arm above consumes it.
fn open_failure(action: &str, error: &std::io::Error) -> CoreError {
    let message = format!("{action}: {error}");
    match error.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound(message),
        _ => CoreError::Io(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A parent directory that is gone stays a `NotFound`, not a generic `Io`.
    ///
    /// The variant, not the message, is what [`crate::ai::tools`] reads:
    /// `settle_vault_error` buckets `NotFound` as a rejection the model can route
    /// around and `Io` as a failure the user sees as NeuralNote breaking. An AI
    /// write into a folder deleted inside `write_note`'s check-then-open window is
    /// the first, so it must not be reported as the second.
    #[test]
    fn a_missing_parent_directory_stays_a_not_found() {
        let root = tempfile::tempdir().unwrap();
        let removed = root.path().join("deleted-mid-save");
        let sequence = AtomicU64::new(0);

        let error = create_temp_sibling(&removed, "Note.md", &sequence, "could not save the note")
            .expect_err("a temp sibling was created inside a directory that does not exist");

        assert!(
            matches!(error, CoreError::NotFound(_)),
            "the vanished directory was reported as a product fault: {error:?}"
        );
        assert!(
            error.to_string().contains("could not save the note"),
            "the caller's wording was dropped: {error}"
        );
    }

    /// Exhaustion is the opposite call: nothing is missing, this process simply
    /// cannot get a name it owns. That stays an `Io` failure, so pinning the
    /// variant above cannot be satisfied by making every open failure a
    /// `NotFound`.
    #[test]
    fn exhausting_every_temp_name_stays_an_io_failure() {
        let parent = tempfile::tempdir().unwrap();
        let sequence = AtomicU64::new(0);
        // Occupy the band through the module's own name builder rather than a
        // hand-copied format string, then rewind the counter so the run below
        // walks the very names these calls just took. Each `expect` is the real
        // guard: a builder that stopped honouring `sequence` fails here rather
        // than leaving the run below to pass against a half-filled band.
        for _ in 0..MAX_TEMP_ATTEMPTS {
            create_temp_sibling(parent.path(), "Note.md", &sequence, "fixture")
                .expect("the fixture could not occupy a temp name");
        }
        sequence.store(0, Ordering::Relaxed);

        let error = create_temp_sibling(
            parent.path(),
            "Note.md",
            &sequence,
            "could not save the note",
        )
        .expect_err("a free temp name was found inside the occupied band");

        assert!(
            matches!(error, CoreError::Io(_)),
            "exhaustion is a local write failure, not a missing path: {error:?}"
        );
        assert!(
            error
                .to_string()
                .contains("no unique temporary file was available"),
            "exhaustion must name itself, got {error}"
        );
    }
}
