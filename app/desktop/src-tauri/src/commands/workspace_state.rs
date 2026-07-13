//! Thin IPC wrappers for vault-owned note-tab restoration state.

use neuralnote_core::workspace_state::{
    load_workspace_state as load_state, reset_workspace_state as reset_state,
    save_workspace_state as save_state, WorkspaceState, WorkspaceStateLoad,
};
use neuralnote_core::CoreError;

use crate::{root_of, SharedState};

#[tauri::command]
pub(crate) fn load_workspace_state(state: SharedState) -> Result<WorkspaceStateLoad, CoreError> {
    load_state(&root_of(&state)?)
}

#[tauri::command]
pub(crate) fn save_workspace_state(
    app_state: SharedState,
    state: WorkspaceState,
) -> Result<(), CoreError> {
    save_state(&root_of(&app_state)?, &state)
}

#[tauri::command]
pub(crate) fn reset_workspace_state(state: SharedState) -> Result<WorkspaceStateLoad, CoreError> {
    reset_state(&root_of(&state)?)
}
