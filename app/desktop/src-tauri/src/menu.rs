//! Native application menu for the desktop shell.
//!
//! Built in Rust and (re)installed at startup and whenever a vault opens or
//! closes. Custom items emit `menu://action` to the frontend over the same
//! Rust→webview event bridge the vault watcher uses (`vault://tree-changed`);
//! the native Edit/Window items keep their predefined OS behaviour and need no
//! wiring at all (undo/copy/paste act on the focused webview element). The menu
//! is rebuilt from `AppState` rather than mutated in place, so the "Open Recent"
//! list, the enabled state of vault-only items, and the chat-panel checkmark are
//! always derived fresh and can never drift out of sync with the app.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::event_names::MENU_ACTION;
use crate::{config_dir, lock_state, AppState};

/// Recent-vault item ids are `open-recent:<absolute path>`; the path is decoded
/// back out in [`parse_menu_id`] and sent to the frontend to open.
const RECENT_PREFIX: &str = "open-recent:";
const NAVIGATION_TOGGLE_ACTION: &str = "toggle-sidebar";
const NAVIGATION_TOGGLE_LABEL: &str = "Toggle Navigation Sidebar";
const ASSISTANT_PANEL_LABEL: &str = "Neural Assistant AI Panel";

/// Every custom (non-predefined) action id, in one place so the builder and
/// [`parse_menu_id`] can't drift apart. Predefined natives (copy, quit, …) are
/// deliberately absent — the OS handles them and they never reach our handler.
const CUSTOM_ACTIONS: &[&str] = &[
    "new-note",
    "new-folder",
    "open-vault",
    "close-tab",
    "close-window",
    "close-vault",
    "save",
    "search",
    "view-files",
    "view-search",
    "toggle-graph",
    "toggle-chat",
    NAVIGATION_TOGGLE_ACTION,
    "format-bold",
    "format-italic",
    "format-h1",
    "format-h2",
    "format-h3",
    "format-link",
];

/// Payload for [`MENU_ACTION`]. `path` is set only for Open Recent; it's omitted
/// from the JSON otherwise so the frontend sees a clean `{ action }` for the
/// common case.
#[derive(Clone, Serialize)]
struct MenuActionPayload {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

impl MenuActionPayload {
    fn simple(action: &str) -> Self {
        Self {
            action: action.to_string(),
            path: None,
        }
    }
}

/// Map a clicked menu-item id to the payload emitted to the frontend. Recent
/// items carry their vault path after `open-recent:`. Pure — unit-tested without
/// a running app. Returns `None` for predefined natives and unknown ids so the
/// handler stays silent on anything it doesn't own.
fn parse_menu_id(id: &str) -> Option<MenuActionPayload> {
    if let Some(path) = id.strip_prefix(RECENT_PREFIX) {
        if path.is_empty() {
            return None;
        }
        return Some(MenuActionPayload {
            action: "open-recent".to_string(),
            path: Some(path.to_string()),
        });
    }
    CUSTOM_ACTIONS
        .contains(&id)
        .then(|| MenuActionPayload::simple(id))
}

/// `(vault_open, chat_visible, editing)` read from the shared app state — the
/// facts the menu's enabled/checked states depend on. `editing` gates the Format
/// items (which only do anything while the editor is mounted); the rest gate on
/// `vault_open`.
fn menu_state(app: &AppHandle) -> (bool, bool, bool) {
    let state = app.state::<Mutex<AppState>>();
    let guard = lock_state(&state);
    (guard.session.is_some(), guard.chat_visible, guard.editing)
}

/// Human label for a recent vault: its folder name, falling back to the full
/// path if there's no final component.
fn recent_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// The live "Open Recent" submenu, built from the on-disk recents list. An empty
/// list shows a single disabled hint rather than a dead, empty submenu.
fn recent_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let recents = config_dir(app)
        .ok()
        .and_then(|cfg| neuralnote_core::recents::list_recent_vaults(&cfg).ok())
        .unwrap_or_default();

    let builder = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        let empty =
            MenuItem::with_id(app, "recent-empty", "No recent vaults", false, None::<&str>)?;
        return builder.item(&empty).build();
    }

    // The items must outlive the `.item(&…)` borrows, so collect them first.
    let items = recents
        .iter()
        .map(|r| {
            MenuItem::with_id(
                app,
                format!("{RECENT_PREFIX}{}", r.path),
                recent_label(&r.path),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let mut builder = builder;
    for item in &items {
        builder = builder.item(item);
    }
    builder.build()
}

/// Build the whole application menu from current state. Vault-only items are
/// disabled when no vault is open; Format items are disabled unless a note is
/// being edited; the chat item reflects its stored visibility.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let (vault_open, chat_visible, editing) = menu_state(app);

    // macOS: the first submenu becomes the application menu; its items are all
    // predefined natives (About/Services/Hide/Quit) — no wiring needed.
    let app_menu = SubmenuBuilder::new(app, "NeuralNote")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About NeuralNote"),
            None,
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let new_note = MenuItem::with_id(app, "new-note", "New Note", vault_open, Some("CmdOrCtrl+N"))?;
    let new_folder = MenuItem::with_id(
        app,
        "new-folder",
        "New Folder",
        vault_open,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let open_vault =
        MenuItem::with_id(app, "open-vault", "Open Vault…", true, Some("CmdOrCtrl+O"))?;
    let recent = recent_submenu(app)?;
    let save = MenuItem::with_id(app, "save", "Save", vault_open, Some("CmdOrCtrl+S"))?;
    let close_tab = MenuItem::with_id(
        app,
        "close-tab",
        "Close Tab",
        vault_open,
        Some("CmdOrCtrl+W"),
    )?;
    let close_vault =
        MenuItem::with_id(app, "close-vault", "Close Vault", vault_open, None::<&str>)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_note)
        .item(&new_folder)
        .separator()
        .item(&open_vault)
        .item(&recent)
        .separator()
        .item(&save)
        .item(&close_tab)
        .separator()
        .item(&close_vault)
        .build()?;

    // Edit: predefined natives operate on the focused webview element (the note
    // focused note editor, so undo/redo/cut/copy/paste/select-all need zero wiring. Only
    // Find is ours.
    let find = MenuItem::with_id(
        app,
        "search",
        "Find in Vault…",
        vault_open,
        Some("CmdOrCtrl+K"),
    )?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&find)
        .build()?;

    // Format items act on the focused rich or raw note editor. They gate on
    // `editing`, not `vault_open`, to avoid enabled items that silently do
    // nothing while focus is elsewhere.
    let bold = MenuItem::with_id(app, "format-bold", "Bold", editing, Some("CmdOrCtrl+B"))?;
    let italic = MenuItem::with_id(app, "format-italic", "Italic", editing, Some("CmdOrCtrl+I"))?;
    let h1 = MenuItem::with_id(
        app,
        "format-h1",
        "Heading 1",
        editing,
        Some("CmdOrCtrl+Alt+1"),
    )?;
    let h2 = MenuItem::with_id(
        app,
        "format-h2",
        "Heading 2",
        editing,
        Some("CmdOrCtrl+Alt+2"),
    )?;
    let h3 = MenuItem::with_id(
        app,
        "format-h3",
        "Heading 3",
        editing,
        Some("CmdOrCtrl+Alt+3"),
    )?;
    let link = MenuItem::with_id(
        app,
        "format-link",
        "Insert Link",
        editing,
        Some("CmdOrCtrl+Alt+K"),
    )?;
    let format_menu = SubmenuBuilder::new(app, "Format")
        .item(&bold)
        .item(&italic)
        .separator()
        .item(&h1)
        .item(&h2)
        .item(&h3)
        .separator()
        .item(&link)
        .build()?;

    let view_files = MenuItem::with_id(
        app,
        "view-files",
        "Show Files",
        vault_open,
        Some("CmdOrCtrl+1"),
    )?;
    let view_search = MenuItem::with_id(
        app,
        "view-search",
        "Show Search",
        vault_open,
        Some("CmdOrCtrl+2"),
    )?;
    let toggle_graph = MenuItem::with_id(
        app,
        "toggle-graph",
        "Toggle Graph View",
        vault_open,
        Some("CmdOrCtrl+G"),
    )?;
    // The webview owns the chat panel's visibility now (a titlebar button competes
    // with the menu, so the menu is no longer its only toggle). This CheckMenuItem
    // no longer flips any state — it only paints its checkmark from `chat_visible`,
    // a copy the webview pushes back via `set_chat_visible`.
    let toggle_chat = CheckMenuItemBuilder::with_id("toggle-chat", ASSISTANT_PANEL_LABEL)
        .checked(chat_visible)
        .enabled(vault_open)
        .build(app)?;
    // Plain MenuItem, not a CheckMenuItem: the preferred navigation expansion lives
    // entirely in the webview and carries no menu checkmark. Keep the historical
    // action id so existing renderer event handling remains compatible.
    let toggle_sidebar = MenuItem::with_id(
        app,
        NAVIGATION_TOGGLE_ACTION,
        NAVIGATION_TOGGLE_LABEL,
        vault_open,
        Some("CmdOrCtrl+\\"),
    )?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&view_files)
        .item(&view_search)
        .separator()
        .item(&toggle_graph)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_chat)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let close_window = MenuItem::with_id(
        app,
        "close-window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&close_window)
        .build()?;

    // TODO(menu-help): add a Help submenu once there's something real to point it
    // at — external links (Documentation / Report an Issue) need the `opener`
    // plugin (a new dependency), and an in-app keyboard-shortcut sheet is net-new
    // UI. Deferred so every shipped menu item does something today.
    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &format_menu,
            &view_menu,
            &window_menu,
        ])
        .build()
}

/// Build and install the menu, and register the one-time click handler that
/// bridges custom items to the frontend. Called once at startup.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build_menu(app)?)?;
    app.on_menu_event(|app, event| {
        let Some(payload) = parse_menu_id(event.id().0.as_str()) else {
            return;
        };
        if let Err(e) = app.emit(MENU_ACTION, &payload) {
            log::warn!("could not emit menu action '{}': {e}", payload.action);
        }
    });
    Ok(())
}

/// Rebuild and reinstall the menu from current state — called after a vault
/// opens or closes so Open Recent and the vault-only items stay honest.
pub fn refresh(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build_menu(app)?)?;
    Ok(())
}

/// Notify the renderer that a native Cmd-Q / Dock Quit request needs to pass
/// through the unsaved-edit guard before the app may exit.
pub(crate) fn emit_quit_requested(app: &AppHandle) {
    let payload = MenuActionPayload::simple("quit-app");
    if let Err(error) = app.emit(MENU_ACTION, &payload) {
        log::warn!("could not emit guarded quit request: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_custom_action() {
        for action in CUSTOM_ACTIONS {
            let payload = parse_menu_id(action).expect("known action parses");
            assert_eq!(payload.action, *action);
            assert!(payload.path.is_none());
        }
    }

    #[test]
    fn tab_and_window_close_are_distinct_guardable_actions() {
        assert_eq!(
            parse_menu_id("close-tab").map(|payload| payload.action),
            Some("close-tab".to_string())
        );
        assert_eq!(
            parse_menu_id("close-window").map(|payload| payload.action),
            Some("close-window".to_string())
        );
    }

    #[test]
    fn navigation_toggle_keeps_legacy_action_id_with_explicit_label() {
        assert_eq!(NAVIGATION_TOGGLE_ACTION, "toggle-sidebar");
        assert_eq!(NAVIGATION_TOGGLE_LABEL, "Toggle Navigation Sidebar");
    }

    #[test]
    fn view_menu_contract_uses_neural_assistant_without_a_read_edit_toggle() {
        assert_eq!(ASSISTANT_PANEL_LABEL, "Neural Assistant AI Panel");
        assert!(!CUSTOM_ACTIONS.contains(&"toggle-mode"));
    }

    #[test]
    fn parses_recent_with_path() {
        let payload = parse_menu_id("open-recent:/Users/me/My Vault").expect("recent parses");
        assert_eq!(payload.action, "open-recent");
        assert_eq!(payload.path.as_deref(), Some("/Users/me/My Vault"));
    }

    #[test]
    fn rejects_empty_recent_path() {
        assert!(parse_menu_id("open-recent:").is_none());
    }

    #[test]
    fn rejects_predefined_and_unknown_ids() {
        // Predefined natives never reach the handler; unknown ids are ignored.
        assert!(parse_menu_id("quit").is_none());
        assert!(parse_menu_id("copy").is_none());
        assert!(parse_menu_id("recent-empty").is_none());
        assert!(parse_menu_id("").is_none());
        assert!(parse_menu_id("format-bogus").is_none());
    }

    #[test]
    fn recent_label_prefers_folder_name() {
        assert_eq!(recent_label("/Users/me/My Vault"), "My Vault");
        assert_eq!(recent_label("/Users/me/My Vault/"), "My Vault");
        assert_eq!(recent_label("Vault"), "Vault");
    }
}
