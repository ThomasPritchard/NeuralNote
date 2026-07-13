//! Thin IPC wrappers for global app preferences.

use neuralnote_core::preferences::{
    load_app_preferences as load_preferences, save_app_preferences as save_preferences,
    AppPreferences, AppPreferencesLoad,
};
use neuralnote_core::CoreError;
use tauri::AppHandle;

use crate::config_dir;

#[tauri::command]
pub(crate) fn load_app_preferences(app: AppHandle) -> Result<AppPreferencesLoad, CoreError> {
    load_preferences(&config_dir(&app)?)
}

#[tauri::command]
pub(crate) fn save_app_preferences(
    app: AppHandle,
    preferences: AppPreferences,
) -> Result<(), CoreError> {
    save_preferences(&config_dir(&app)?, &preferences)
}
