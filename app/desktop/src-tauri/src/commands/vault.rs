//! Vault command surface: the note / tree / search / template / graph CRUD verbs,
//! the native folder pickers, and the filesystem watcher that keeps the tree live.
//!
//! Path logic and data safety live in `neuralnote-core`; this module only wires
//! those verbs to the webview and owns the vault session's watcher / recents / menu
//! glue. The shared app state and the command registry live in `crate` (`lib.rs`).

use std::path::{Path, PathBuf};

use neuralnote_core::model::{
    Backlinks, LinkGraph, NoteDoc, RecentVault, SearchResponse, TemplateInfo, TreeNode, Vault,
};
use neuralnote_core::CoreError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

use crate::event_names::TREE_CHANGED;
use crate::{config_dir, lock_state, menu, root_of, AppState, SharedState, VaultSession};

/// Canonical form for authorization comparisons, falling back to the path as
/// given if it can't be resolved (e.g. just deleted). Without this, the PA-004
/// check compares paths textually and refuses a legitimately-picked vault whose
/// string differs by a trailing slash, symlink, or case.
fn canon_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Best-effort record of a just-opened vault in the recents list. Recents is UI
/// convenience, not vault data, so a failure is logged (file + stdout) rather than
/// surfaced — but never dropped silently, including a config-dir resolution failure.
fn record_recent(app: &AppHandle, vault: &Vault) {
    match config_dir(app) {
        Ok(cfg) => {
            if let Err(e) = neuralnote_core::recents::record_recent_vault(&cfg, vault) {
                log::warn!("could not record recent vault: {e}");
            }
        }
        Err(e) => log::warn!("could not resolve config dir to record recent vault: {e}"),
    }
}

/// Rebuild the native menu after a vault open/close so "Open Recent" and the
/// vault-only items reflect the new state. A failure only degrades the menu (the
/// app keeps working), so it's logged rather than surfaced — but never dropped
/// silently.
fn refresh_menu(app: &AppHandle) {
    if let Err(e) = menu::refresh(app) {
        log::warn!("could not refresh the application menu: {e}");
    }
}

/// End every chat tied to the workspace that is about to unmount. Closing or
/// replacing a vault removes the only UI capable of answering its elicitations;
/// retained run signals also stop a not-yet-parked question from racing teardown.
fn cancel_active_chat_runs(state: &mut AppState) {
    state.pending_elicitations.cancel_all_runs();
}

/// Whether `path` is already a known recent vault — a trusted root, since recents
/// are only ever written from a folder the user picked. Lets `open_vault` accept
/// a recent without re-prompting while still rejecting arbitrary paths (PA-004).
fn path_in_recents(app: &AppHandle, path: &Path) -> bool {
    let want = canon_or_self(path);
    config_dir(app)
        .ok()
        .and_then(|cfg| neuralnote_core::recents::list_recent_vaults(&cfg).ok())
        .is_some_and(|recents| {
            recents
                .iter()
                .any(|r| canon_or_self(Path::new(&r.path)) == want)
        })
}

/// A path whose final component is hidden (dot-prefixed): our atomic-write temp
/// siblings (`.<name>.<pid>.<seq>.nn-tmp`) and dotfiles/folders (`.obsidian`,
/// `.git`) that the tree scan already ignores.
fn is_hidden_path(p: &Path) -> bool {
    p.file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// Recursive filesystem watcher that pings the frontend on a visible change.
fn start_watcher(app: &AppHandle, root: &Path) -> Result<RecommendedWatcher, CoreError> {
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        match res {
            Ok(event) => {
                // Skip events that touch only hidden/temp paths — a save's temp
                // create/remove churn and dotfile edits aren't shown in the tree,
                // so they shouldn't each drive a full rescan (PA-009). The save's
                // final rename to the real file still carries a visible path.
                if !event.paths.is_empty() && event.paths.iter().all(|p| is_hidden_path(p)) {
                    return;
                }
                let _ = handle.emit(TREE_CHANGED, ());
            }
            // Don't drop watcher errors silently — a dropped watch means external
            // edits stop showing up live; at least make it visible in logs.
            Err(e) => log::warn!("vault watcher error: {e}"),
        }
    })
    .map_err(|e| CoreError::Io(format!("watcher init failed: {e}")))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| CoreError::Io(format!("watch failed: {e}")))?;
    Ok(watcher)
}

/// Start the vault watcher, or `None` if it couldn't be set up. A watcher failure
/// (e.g. inotify `max_user_watches` exhausted on a large vault, or an unwatchable
/// filesystem) degrades only live external-edit refresh — in-app edits self-refresh
/// — so it must NEVER block opening the vault (PA-008). The failure is logged, not
/// silent, and not surfaced as a fatal error.
fn try_start_watcher(app: &AppHandle, root: &Path) -> Option<RecommendedWatcher> {
    match start_watcher(app, root) {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            log::warn!("vault watcher unavailable; opening without live external refresh: {e}");
            None
        }
    }
}

#[tauri::command]
pub(crate) fn list_recent_vaults(app: AppHandle) -> Result<Vec<RecentVault>, CoreError> {
    neuralnote_core::recents::list_recent_vaults(&config_dir(&app)?)
}

/// Record a user-picked folder as authorized (PA-004) and return it as a string.
/// The blocking dialog runs before the lock is taken, so the guard never crosses
/// an await point.
fn authorize_picked(state: &SharedState, picked: Option<PathBuf>) -> Option<String> {
    let p = picked?;
    // Store the canonical form so the later open/create check matches regardless
    // of how the same folder's path is spelled when it round-trips through JS.
    lock_state(state).authorized.insert(canon_or_self(&p));
    Some(p.to_string_lossy().into_owned())
}

/// Native folder picker for opening an existing vault. Runs on an async worker
/// thread (not the UI thread), so the blocking dialog can't freeze the app. The
/// chosen folder is recorded as authorized so it — and only it — may be opened.
#[tauri::command]
pub(crate) async fn pick_vault_folder(
    app: AppHandle,
    state: SharedState<'_>,
) -> Result<Option<String>, ()> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok());
    Ok(authorize_picked(&state, picked))
}

/// Native folder picker for choosing where a *new* vault will be created. The
/// chosen parent folder is recorded as authorized for `create_vault`.
#[tauri::command]
pub(crate) async fn pick_new_vault_location(
    app: AppHandle,
    state: SharedState<'_>,
) -> Result<Option<String>, ()> {
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok());
    Ok(authorize_picked(&state, picked))
}

#[tauri::command]
pub(crate) fn open_vault(
    app: AppHandle,
    state: SharedState,
    path: String,
) -> Result<Vault, CoreError> {
    let requested = PathBuf::from(&path);
    // PA-004: only a folder the user picked this session, or one already in the
    // recents list, may become a root — never an arbitrary path from the webview.
    // Compare canonically so spelling differences don't refuse a legitimate pick.
    let picked = lock_state(&state)
        .authorized
        .contains(&canon_or_self(&requested));
    if !picked && !path_in_recents(&app, &requested) {
        return Err(CoreError::OutsideVault(format!(
            "refusing to open a path not chosen via the folder picker: {path}"
        )));
    }
    let vault = neuralnote_core::vault::open_vault(&requested)?;
    let root = PathBuf::from(&vault.path);
    // Non-fatal: a watcher failure must not block opening the vault (PA-008).
    let watcher = try_start_watcher(&app, &root);
    {
        // Replace only the session, preserving the authorized set for later opens.
        // Reset the chat-visibility copy to shown so the menu checkmark starts on:
        // the root remounts the workspace on any vault change, so the webview (the
        // real owner of this flag now) resets its own copy to `true` too — they
        // agree, and `set_chat_visible`'s early-return means the mount-time push
        // that follows is a no-op, not a spurious menu rebuild. Clear edit-mode (no
        // note is open yet) so Format items start disabled.
        let mut guard = lock_state(&state);
        cancel_active_chat_runs(&mut guard);
        guard.session = Some(VaultSession {
            root,
            _watcher: watcher,
        });
        guard.chat_visible = true;
        guard.editing = false;
    }
    record_recent(&app, &vault);
    refresh_menu(&app);
    Ok(vault)
}

#[tauri::command]
pub(crate) fn create_vault(
    app: AppHandle,
    state: SharedState,
    parent_dir: String,
    name: String,
) -> Result<Vault, CoreError> {
    let parent = PathBuf::from(&parent_dir);
    // PA-004: the parent must be a folder the user chose via the picker (compared
    // canonically so spelling differences don't refuse a legitimate choice).
    if !lock_state(&state)
        .authorized
        .contains(&canon_or_self(&parent))
    {
        return Err(CoreError::OutsideVault(format!(
            "refusing to create a vault outside a folder chosen via the picker: {parent_dir}"
        )));
    }
    let vault = neuralnote_core::vault::create_vault(&parent, &name)?;
    let root = PathBuf::from(&vault.path);
    // Non-fatal: a watcher failure must not block creating/opening the vault (PA-008).
    let watcher = try_start_watcher(&app, &root);
    {
        // Reset chat-visibility and edit-mode for the same reasons as `open_vault`:
        // the workspace remounts, so the webview's own chat-visibility copy resets
        // to `true` in agreement with this one, and no note is open yet.
        let mut guard = lock_state(&state);
        cancel_active_chat_runs(&mut guard);
        guard.session = Some(VaultSession {
            root,
            _watcher: watcher,
        });
        guard.chat_visible = true;
        guard.editing = false;
    }
    record_recent(&app, &vault);
    refresh_menu(&app);
    Ok(vault)
}

#[tauri::command]
pub(crate) fn close_vault(app: AppHandle, state: SharedState) {
    {
        let mut guard = lock_state(&state);
        cancel_active_chat_runs(&mut guard);
        guard.session = None;
        // No note is open once the vault closes; keep Format items from lingering
        // enabled (they gate on `editing`).
        guard.editing = false;
    }
    refresh_menu(&app);
}

/// Pushed from the webview whenever a text note enters or leaves edit mode. The
/// native Format menu items only do anything while the editor is mounted, so they
/// track this flag rather than mere vault-open — an enabled Format item that did
/// nothing would be a silent no-op. Skips the rebuild when the flag is unchanged.
#[tauri::command]
pub(crate) fn set_menu_editing(app: AppHandle, state: SharedState, editing: bool) {
    {
        let mut guard = lock_state(&state);
        if guard.editing == editing {
            return;
        }
        guard.editing = editing;
    }
    refresh_menu(&app);
}

/// Pushed from the webview whenever the cited-recall chat panel is shown or
/// hidden. The webview owns that boolean now (a titlebar button competes with the
/// View menu, so the menu can no longer be its sole toggle); Rust keeps a copy for
/// one job — painting the View-menu checkmark. From the webview, this command is
/// the only write path; `open_vault`/`create_vault` also force-reset it directly to
/// `true`, and `Default` seeds it `true`. Anyone adding validation/logging here
/// must cover those reset sites too. Skips the rebuild when unchanged, so the
/// mount-time push after a vault opens (already `chat_visible = true`) triggers no
/// spurious menu rebuild.
///
/// The guard is scoped to the inner block and MUST drop before `refresh_menu`:
/// `refresh_menu` → `menu::refresh` → `build_menu` → `menu_state` re-locks the same
/// non-reentrant `std::sync::Mutex`, so holding it across the call would deadlock.
#[tauri::command]
pub(crate) fn set_chat_visible(app: AppHandle, state: SharedState, visible: bool) {
    {
        let mut guard = lock_state(&state);
        if guard.chat_visible == visible {
            return;
        }
        guard.chat_visible = visible;
    }
    refresh_menu(&app);
}

// `read_tree`/`read_note`/`write_note` are `async` so Tauri runs them on its
// async worker pool instead of the main/UI thread: a recursive walk of a large
// vault, or reading/writing a large note, no longer freezes the window. The body
// is synchronous `std::fs` work (no `.await`), so the `std::sync::Mutex` guard —
// taken and dropped inside `root_of` — never crosses an await point.
#[tauri::command]
pub(crate) async fn read_tree(state: SharedState<'_>) -> Result<Vec<TreeNode>, CoreError> {
    neuralnote_core::tree::read_tree(&root_of(&state)?)
}

#[tauri::command]
pub(crate) async fn read_note(state: SharedState<'_>, path: String) -> Result<NoteDoc, CoreError> {
    neuralnote_core::note::read_note(&root_of(&state)?, Path::new(&path))
}

#[tauri::command]
pub(crate) async fn write_note(
    state: SharedState<'_>,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<NoteDoc, CoreError> {
    neuralnote_core::note::write_note(&root_of(&state)?, Path::new(&path), &content, expected_hash)
}

// `search_vault`/`read_link_graph` follow the same recipe as `read_tree` above:
// async → worker pool (a full-vault scan must not freeze the window), sync body,
// and the state guard (inside `root_of`) never crosses an await point.
#[tauri::command]
pub(crate) async fn search_vault(
    state: SharedState<'_>,
    query: String,
) -> Result<SearchResponse, CoreError> {
    neuralnote_core::search::search_vault(&root_of(&state)?, &query)
}

#[tauri::command]
pub(crate) async fn read_link_graph(state: SharedState<'_>) -> Result<LinkGraph, CoreError> {
    neuralnote_core::links::read_link_graph(&root_of(&state)?)
}

#[tauri::command]
pub(crate) async fn read_backlinks(
    state: SharedState<'_>,
    path: String,
) -> Result<Backlinks, CoreError> {
    let root = root_of(&state)?;
    let requested = Path::new(&path);
    let target = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let target = neuralnote_core::paths::ensure_within(&root, &target)?;
    let rel = neuralnote_core::paths::rel_path(&root, &target);
    neuralnote_core::backlinks::read_backlinks(&root, &rel)
}

#[tauri::command]
pub(crate) fn create_folder(
    state: SharedState,
    parent_path: String,
    name: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::create_folder(&root_of(&state)?, Path::new(&parent_path), &name)
}

#[tauri::command]
pub(crate) fn create_note(
    state: SharedState,
    parent_path: String,
    name: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::create_note(&root_of(&state)?, Path::new(&parent_path), &name)
}

#[tauri::command]
pub(crate) async fn list_templates(state: SharedState<'_>) -> Result<Vec<TemplateInfo>, CoreError> {
    neuralnote_core::templates::list_templates(&root_of(&state)?)
}

#[tauri::command]
pub(crate) fn create_note_from_template(
    state: SharedState,
    parent_path: String,
    name: String,
    template: Option<String>,
) -> Result<TreeNode, CoreError> {
    let root = root_of(&state)?;
    let parent = neuralnote_core::paths::ensure_within(&root, Path::new(&parent_path))?;
    let template_rel = template
        .map(|template| {
            let requested = Path::new(&template);
            let target = if requested.is_absolute() {
                requested.to_path_buf()
            } else {
                root.join(requested)
            };
            neuralnote_core::paths::ensure_within(&root, &target)
                .map(|target| neuralnote_core::paths::rel_path(&root, &target))
        })
        .transpose()?;

    neuralnote_core::templates::create_note_from_template(
        &root,
        &parent,
        &name,
        template_rel.as_deref(),
        chrono::Local::now(),
    )
}

#[tauri::command]
pub(crate) fn rename_entry(
    state: SharedState,
    path: String,
    new_name: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::rename_entry(&root_of(&state)?, Path::new(&path), &new_name)
}

#[tauri::command]
pub(crate) fn delete_entry(state: SharedState, path: String) -> Result<(), CoreError> {
    neuralnote_core::entries::delete_entry(&root_of(&state)?, Path::new(&path))
}

#[tauri::command]
pub(crate) fn move_entry(
    state: SharedState,
    path: String,
    new_parent_path: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::move_entry(
        &root_of(&state)?,
        Path::new(&path),
        Path::new(&new_parent_path),
    )
}
