//! Vault-owned note-tab restoration state.
//!
//! Only paths and the active tab are persisted. Editor drafts deliberately stay
//! in memory so this file can never become a second source of note content.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config_io::write_json_atomic;
use crate::error::{CoreError, CoreResult};
use crate::paths::ensure_within;

const STATE_FILE_NAME: &str = "workspace-state.json";
const STATE_FILE_LABEL: &str = "workspace state";
const MAX_STATE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct WorkspaceState {
    pub open_paths: Vec<String>,
    pub active_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceStateLoad {
    pub state: WorkspaceState,
    pub recovered_from_corrupt: bool,
    pub recovery_message: Option<String>,
}

impl WorkspaceStateLoad {
    fn clean(state: WorkspaceState) -> Self {
        Self {
            state,
            recovered_from_corrupt: false,
            recovery_message: None,
        }
    }

    fn recovery(message: impl Into<String>) -> Self {
        Self {
            state: WorkspaceState::default(),
            recovered_from_corrupt: true,
            recovery_message: Some(message.into()),
        }
    }
}

/// Load the ordered open paths for a vault.
///
/// Invalid user-controlled JSON is a recoverable state, not a fatal vault-open
/// failure. The original bytes remain untouched until the explicit reset call.
pub fn load_workspace_state(root: &Path) -> CoreResult<WorkspaceStateLoad> {
    let root = canonical_root(root)?;
    let path = match state_file_entry(&root) {
        Ok(path) => path,
        Err(error @ CoreError::OutsideVault(_)) => {
            return Ok(WorkspaceStateLoad::recovery(format!(
                "unsafe workspace state path at .neuralnote/{STATE_FILE_NAME}: {error}"
            )));
        }
        Err(error) => return Err(error),
    };
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceStateLoad::clean(WorkspaceState::default()));
        }
        Err(error) => return Err(read_error(&path, error)),
    };
    if metadata.is_dir() {
        return Err(CoreError::Io(format!(
            "could not read workspace state at {}: path is a directory",
            path.display()
        )));
    }

    let readable_path =
        match confined_existing_entry(&root, &path, metadata.file_type().is_symlink()) {
            Ok(path) => path,
            Err(error @ CoreError::OutsideVault(_)) => {
                return Ok(WorkspaceStateLoad::recovery(format!(
                    "unsafe workspace state path at {}: {error}",
                    path.display()
                )));
            }
            Err(error) => {
                return Ok(WorkspaceStateLoad::recovery(format!(
                    "could not resolve workspace state at {}: {error}",
                    path.display()
                )));
            }
        };
    let metadata =
        std::fs::metadata(&readable_path).map_err(|error| read_error(&readable_path, error))?;
    if !metadata.is_file() {
        return Ok(WorkspaceStateLoad::recovery(format!(
            "could not parse workspace state at {}: path is not a regular file",
            readable_path.display()
        )));
    }
    if metadata.len() > MAX_STATE_BYTES {
        return Ok(WorkspaceStateLoad::recovery(format!(
            "could not parse workspace state at {}: file exceeds the {MAX_STATE_BYTES}-byte limit",
            readable_path.display()
        )));
    }
    let file =
        std::fs::File::open(&readable_path).map_err(|error| read_error(&readable_path, error))?;
    if !file
        .metadata()
        .map_err(|error| read_error(&readable_path, error))?
        .is_file()
    {
        return Ok(WorkspaceStateLoad::recovery(format!(
            "could not parse workspace state at {}: path is not a regular file",
            readable_path.display()
        )));
    }
    let mut raw = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|error| read_error(&readable_path, error))?;
    if raw.len() as u64 > MAX_STATE_BYTES {
        return Ok(WorkspaceStateLoad::recovery(format!(
            "could not parse workspace state at {}: file exceeds the {MAX_STATE_BYTES}-byte limit",
            readable_path.display()
        )));
    }
    let state = match serde_json::from_slice::<WorkspaceState>(&raw) {
        Ok(state) => state,
        Err(error) => {
            return Ok(WorkspaceStateLoad::recovery(format!(
                "could not parse workspace state at {}: {error}",
                readable_path.display()
            )));
        }
    };
    if let Err(error) = validate_workspace_state(&root, &state) {
        return Ok(WorkspaceStateLoad::recovery(format!(
            "unsafe workspace state at {}: {error}",
            readable_path.display()
        )));
    }

    Ok(WorkspaceStateLoad::clean(state))
}

/// Persist a validated workspace state atomically.
///
/// A malformed existing file acts as a recovery latch: normal autosaves cannot
/// silently replace it. Only [`reset_workspace_state`] clears that condition.
pub fn save_workspace_state(root: &Path, state: &WorkspaceState) -> CoreResult<()> {
    let root = canonical_root(root)?;
    validate_workspace_state(&root, state)?;
    validate_serialized_size(state)?;
    let loaded = load_workspace_state(&root)?;
    if loaded.recovered_from_corrupt {
        return Err(CoreError::Io(format!(
            "workspace state must be reset before it can be saved: {}",
            loaded
                .recovery_message
                .unwrap_or_else(|| "the existing file is invalid".into())
        )));
    }
    let path = state_file_for_write(&root)?;
    write_json_atomic(&path, state, STATE_FILE_LABEL)
}

/// Atomically replace any malformed state with the empty default and clear the
/// recovery latch. A symlink entry is replaced, never followed for writing.
pub fn reset_workspace_state(root: &Path) -> CoreResult<WorkspaceStateLoad> {
    let root = canonical_root(root)?;
    let path = state_file_for_write(&root)?;
    let state = WorkspaceState::default();
    write_json_atomic(&path, &state, STATE_FILE_LABEL)?;
    Ok(WorkspaceStateLoad::clean(state))
}

fn validate_workspace_state(root: &Path, state: &WorkspaceState) -> CoreResult<()> {
    let mut unique = HashSet::with_capacity(state.open_paths.len());
    for raw in &state.open_paths {
        let normalized = validate_relative_path(raw)?;
        if !unique.insert(normalized.clone()) {
            return Err(CoreError::InvalidName(format!(
                "workspace state contains duplicate path '{normalized}'"
            )));
        }
        validate_candidate_confinement(root, &normalized)?;
    }

    if let Some(active) = &state.active_path {
        let active = validate_relative_path(active)?;
        if !unique.contains(&active) {
            return Err(CoreError::InvalidName(
                "workspace state activePath must be one of openPaths".into(),
            ));
        }
    }
    Ok(())
}

fn validate_relative_path(raw: &str) -> CoreResult<String> {
    if raw.is_empty() || raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err(CoreError::InvalidName(
            "workspace paths must be non-empty vault-relative paths without control characters"
                .into(),
        ));
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(CoreError::OutsideVault(raw.into()));
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(CoreError::OutsideVault(raw.into()));
            }
        }
    }
    let normalized = parts.join("/");
    if normalized.is_empty() || normalized != raw {
        return Err(CoreError::InvalidName(format!(
            "workspace path is not normalized: '{raw}'"
        )));
    }
    Ok(normalized)
}

fn validate_candidate_confinement(root: &Path, relative: &str) -> CoreResult<()> {
    let candidate = root.join(relative);
    match ensure_within(root, &candidate) {
        Ok(_) => Ok(()),
        Err(CoreError::NotFound(_)) => {
            // Stale paths are valid restoration records. Resolve the nearest
            // existing ancestor so a missing descendant of an escaping symlink
            // is still refused while an ordinary moved note remains loadable.
            let ancestor = candidate
                .ancestors()
                .skip(1)
                .find(|ancestor| ancestor.exists())
                .ok_or_else(|| CoreError::NotFound(relative.into()))?;
            ensure_within(root, ancestor).map(|_| ())
        }
        Err(error) => Err(error),
    }
}

fn validate_serialized_size(state: &WorkspaceState) -> CoreResult<()> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| CoreError::Io(format!("could not serialize workspace state: {error}")))?;
    if bytes.len() as u64 + 1 > MAX_STATE_BYTES {
        return Err(CoreError::InvalidName(format!(
            "workspace state cannot exceed {MAX_STATE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn canonical_root(root: &Path) -> CoreResult<PathBuf> {
    root.canonicalize()
        .map_err(|error| CoreError::Io(format!("vault root unreadable: {error}")))
}

fn state_file_entry(root: &Path) -> CoreResult<PathBuf> {
    let state_dir = root.join(".neuralnote");
    match std::fs::symlink_metadata(&state_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(state_dir.join(STATE_FILE_NAME));
        }
        Err(error) => {
            return Err(CoreError::Io(format!(
                "could not inspect workspace state directory {}: {error}",
                state_dir.display()
            )));
        }
        Ok(_) => {}
    }
    let state_dir = ensure_within(root, &state_dir)?;
    if !state_dir.is_dir() {
        return Err(CoreError::Io(format!(
            "workspace state directory is not a directory: {}",
            state_dir.display()
        )));
    }
    Ok(state_dir.join(STATE_FILE_NAME))
}

fn state_file_for_write(root: &Path) -> CoreResult<PathBuf> {
    let state_dir = root.join(".neuralnote");
    if !state_dir.exists() {
        std::fs::create_dir(&state_dir).map_err(|error| {
            CoreError::Io(format!(
                "could not create workspace state directory {}: {error}",
                state_dir.display()
            ))
        })?;
    }
    let state_dir = ensure_within(root, &state_dir)?;
    if !state_dir.is_dir() {
        return Err(CoreError::Io(format!(
            "workspace state directory is not a directory: {}",
            state_dir.display()
        )));
    }
    Ok(state_dir.join(STATE_FILE_NAME))
}

fn confined_existing_entry(root: &Path, path: &Path, is_symlink: bool) -> CoreResult<PathBuf> {
    if is_symlink {
        let resolved = path.canonicalize().map_err(|error| {
            CoreError::Io(format!(
                "could not resolve workspace state symlink {}: {error}",
                path.display()
            ))
        })?;
        ensure_within(root, &resolved)
    } else {
        ensure_within(root, path)
    }
}

fn read_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Io(format!(
        "could not read workspace state at {}: {error}",
        path.display()
    ))
}
