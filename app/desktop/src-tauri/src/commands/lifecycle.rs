//! Application-lifecycle commands exposed to the renderer.

use tauri::AppHandle;

/// Complete a quit that has already passed the frontend's unsaved-edit guard.
/// `AppHandle::exit` is intentionally the only programmatic exit path: Tauri
/// does not apply `ExitRequestApi::prevent_exit` to it, so it cannot loop back
/// into the native user-quit guard.
#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) {
    app.exit(0);
}
