//! Host-owned vault profile I/O: `<vault>/.neuralnote/profile.json`.

use neuralnote_core::capture::{CaptureError, VaultProfileIo, MAX_VAULT_PROFILE_BYTES};
use neuralnote_core::paths::ensure_within;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const PROFILE_FILE_NAME: &str = "profile.json";
const PROFILE_LABEL: &str = "vault profile";

/// Reads and writes the vault routing profile through the host filesystem.
pub(crate) struct FsVaultProfileIo {
    root: PathBuf,
}

impl FsVaultProfileIo {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl VaultProfileIo for FsVaultProfileIo {
    fn load(&self) -> Result<Option<Vec<u8>>, CaptureError> {
        let path = profile_path_for_read(&self.root)?;
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(&path, "read", error)),
        };
        if metadata.is_dir() {
            return Err(profile_error(format!(
                "{PROFILE_LABEL} path is a directory: {}",
                path.display()
            )));
        }
        if metadata.len() > MAX_VAULT_PROFILE_BYTES as u64 {
            return Err(profile_error(format!(
                "{PROFILE_LABEL} exceeds the byte limit"
            )));
        }
        let bytes = std::fs::read(&path).map_err(|error| io_error(&path, "read", error))?;
        if bytes.len() > MAX_VAULT_PROFILE_BYTES {
            return Err(profile_error(format!(
                "{PROFILE_LABEL} exceeds the byte limit"
            )));
        }
        Ok(Some(bytes))
    }

    fn save(&self, bytes: &[u8]) -> Result<(), CaptureError> {
        if bytes.len() > MAX_VAULT_PROFILE_BYTES {
            return Err(profile_error(format!(
                "{PROFILE_LABEL} exceeds the byte limit"
            )));
        }
        let path = profile_path_for_write(&self.root)?;
        write_bytes_atomic(&path, bytes)
    }
}

fn profile_path_for_read(root: &Path) -> Result<PathBuf, CaptureError> {
    let state_dir = root.join(".neuralnote");
    match std::fs::symlink_metadata(&state_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(state_dir.join(PROFILE_FILE_NAME));
        }
        Err(error) => {
            return Err(io_error(&state_dir, "inspect", error));
        }
        Ok(_) => {}
    }
    let state_dir = ensure_within(root, &state_dir).map_err(confine_error)?;
    if !state_dir.is_dir() {
        return Err(profile_error(format!(
            "vault profile directory is not a directory: {}",
            state_dir.display()
        )));
    }
    Ok(state_dir.join(PROFILE_FILE_NAME))
}

fn profile_path_for_write(root: &Path) -> Result<PathBuf, CaptureError> {
    let state_dir = root.join(".neuralnote");
    if !state_dir.exists() {
        std::fs::create_dir(&state_dir).map_err(|error| io_error(&state_dir, "create", error))?;
    }
    let state_dir = ensure_within(root, &state_dir).map_err(confine_error)?;
    if !state_dir.is_dir() {
        return Err(profile_error(format!(
            "vault profile directory is not a directory: {}",
            state_dir.display()
        )));
    }
    Ok(state_dir.join(PROFILE_FILE_NAME))
}

static PROFILE_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), CaptureError> {
    let parent = path.parent().ok_or_else(|| {
        profile_error(format!(
            "{PROFILE_LABEL} path has no parent: {}",
            path.display()
        ))
    })?;
    let (temp, mut file) = (0..32)
        .find_map(|_| {
            let sequence = PROFILE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let temp = parent.join(format!(
                ".{PROFILE_FILE_NAME}.{}.{sequence}.nn-tmp",
                std::process::id()
            ));
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
            {
                Ok(file) => Some(Ok((temp, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(io_error(&temp, "write", error))),
            }
        })
        .unwrap_or_else(|| {
            Err(profile_error(format!(
                "could not write {PROFILE_LABEL}: no unique temporary file was available"
            )))
        })?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(io_error(&temp, "write", error));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(io_error(path, "replace", error));
    }
    Ok(())
}

fn profile_error(detail: impl Into<String>) -> CaptureError {
    CaptureError::ProfileInvalid(detail.into())
}

fn io_error(path: &Path, verb: &str, error: std::io::Error) -> CaptureError {
    profile_error(format!(
        "could not {verb} {PROFILE_LABEL} at {}: {error}",
        path.display()
    ))
}

fn confine_error(error: neuralnote_core::CoreError) -> CaptureError {
    profile_error(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_profile_loads_as_none_not_unavailable() {
        let vault = tempfile::tempdir().unwrap();
        let io = FsVaultProfileIo::new(vault.path().to_path_buf());
        assert_eq!(io.load().expect("a missing profile is not an error"), None);
        assert!(neuralnote_core::capture::UnavailableVaultProfileIo
            .load()
            .is_err());
    }

    #[test]
    fn save_then_load_round_trips_the_bytes() {
        let vault = tempfile::tempdir().unwrap();
        let io = FsVaultProfileIo::new(vault.path().to_path_buf());
        let bytes = br#"{"schemaVersion":1,"skills":{}}"#;
        io.save(bytes).expect("save must write inside the vault");
        assert_eq!(io.load().expect("load after save"), Some(bytes.to_vec()));
        assert!(vault
            .path()
            .join(".neuralnote")
            .join("profile.json")
            .is_file());
    }

    #[test]
    fn an_oversized_save_is_refused_before_write() {
        let vault = tempfile::tempdir().unwrap();
        let io = FsVaultProfileIo::new(vault.path().to_path_buf());
        let too_big = vec![b'x'; MAX_VAULT_PROFILE_BYTES + 1];
        assert!(matches!(
            io.save(&too_big),
            Err(CaptureError::ProfileInvalid(message)) if message.contains("byte limit")
        ));
        assert!(!vault
            .path()
            .join(".neuralnote")
            .join("profile.json")
            .exists());
    }
}
