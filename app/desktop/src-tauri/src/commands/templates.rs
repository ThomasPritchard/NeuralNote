//! Thin IPC wrappers for NeuralNote-owned per-vault template settings.

use neuralnote_core::templates::{
    load_template_settings as load_settings, reset_template_settings as reset_settings,
    save_template_settings as save_settings, TemplateSettings, TemplateSettingsStatus,
};
use neuralnote_core::CoreError;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::{root_of, SharedState};

#[tauri::command]
pub(crate) fn load_template_settings(
    state: SharedState,
) -> Result<TemplateSettingsStatus, CoreError> {
    load_settings(&root_of(&state)?)
}

#[tauri::command]
pub(crate) fn save_template_settings(
    state: SharedState,
    settings: TemplateSettings,
) -> Result<TemplateSettingsStatus, CoreError> {
    save_settings(&root_of(&state)?, &settings)
}

#[tauri::command]
pub(crate) fn reset_template_settings(
    state: SharedState,
) -> Result<TemplateSettingsStatus, CoreError> {
    reset_settings(&root_of(&state)?)
}

#[tauri::command]
pub(crate) async fn pick_template_folder(
    app: AppHandle,
    state: SharedState<'_>,
) -> Result<Option<String>, CoreError> {
    let root = root_of(&state)?;
    let picked = app
        .dialog()
        .file()
        .set_directory(&root)
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok());
    let Some(picked) = picked else {
        return Ok(None);
    };
    let picked = neuralnote_core::paths::ensure_within(&root, &picked)?;
    if picked == root || !picked.is_dir() {
        return Err(CoreError::InvalidName(
            "template folder must be a directory inside the open vault".into(),
        ));
    }
    Ok(Some(neuralnote_core::paths::rel_path(&root, &picked)))
}
