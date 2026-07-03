//! NeuralNote desktop shell — the thin Tauri layer over `neuralnote-core`.
//!
//! Holds the open-vault session (root + filesystem watcher), exposes the vault
//! verbs as commands, and bridges the native folder picker. All path logic and
//! data safety live in the core crate; this file only wires it to the webview.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use neuralnote_core::model::{LinkGraph, NoteDoc, RecentVault, SearchResponse, TreeNode, Vault};
use neuralnote_core::CoreError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Event emitted to the frontend when the vault changes on disk (the frontend
/// debounces and re-reads the tree). Lets external edits — e.g. from Obsidian —
/// show up live.
const TREE_CHANGED: &str = "vault://tree-changed";

/// The currently-open vault, if any. The watcher is held here so it stays alive
/// for the session and is dropped (stopping the watch) on close.
struct VaultSession {
    root: PathBuf,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
struct AppState {
    session: Option<VaultSession>,
    /// Folders the user explicitly chose via the native picker this session.
    /// Only these — or a path already in the on-disk recents list (itself written
    /// only from a prior explicit pick) — may become a vault root. This stops a
    /// compromised webview from pointing the vault, and thus every file command,
    /// at an arbitrary path it supplies to `open_vault`/`create_vault`.
    // TODO(authorized-set-unbounded): this grows once per folder picked and is
    // never pruned. Bounded by picks-per-session (tiny in practice), so deferred —
    // round-9 FYI. Cap or LRU-evict it if a session could realistically pick many.
    authorized: HashSet<PathBuf>,
}

type SharedState<'a> = State<'a, Mutex<AppState>>;

/// Lock the shared state, recovering a poisoned mutex instead of panicking. A
/// panic in one short critical section must not brick every later vault command
/// for the rest of the process; `AppState` is plain data with no broken
/// invariant to protect, so adopting the inner value is safe.
fn lock_state<'a>(state: &'a SharedState) -> std::sync::MutexGuard<'a, AppState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The open vault root, or a typed error if none is open.
fn root_of(state: &SharedState) -> Result<PathBuf, CoreError> {
    lock_state(state)
        .session
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(|| CoreError::Io("no vault is open".into()))
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, CoreError> {
    app.path()
        .app_config_dir()
        .map_err(|e| CoreError::Io(format!("no config dir: {e}")))
}

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

/* ─────────────────────────────  Commands  ──────────────────────────────── */

#[tauri::command]
fn list_recent_vaults(app: AppHandle) -> Result<Vec<RecentVault>, CoreError> {
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
async fn pick_vault_folder(app: AppHandle, state: SharedState<'_>) -> Result<Option<String>, ()> {
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
async fn pick_new_vault_location(
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
fn open_vault(app: AppHandle, state: SharedState, path: String) -> Result<Vault, CoreError> {
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
    let watcher = start_watcher(&app, &root)?;
    // Replace only the session, preserving the authorized set for later opens.
    lock_state(&state).session = Some(VaultSession {
        root,
        _watcher: watcher,
    });
    record_recent(&app, &vault);
    Ok(vault)
}

#[tauri::command]
fn create_vault(
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
    let watcher = start_watcher(&app, &root)?;
    lock_state(&state).session = Some(VaultSession {
        root,
        _watcher: watcher,
    });
    record_recent(&app, &vault);
    Ok(vault)
}

#[tauri::command]
fn close_vault(state: SharedState) {
    lock_state(&state).session = None;
}

// `read_tree`/`read_note`/`write_note` are `async` so Tauri runs them on its
// async worker pool instead of the main/UI thread: a recursive walk of a large
// vault, or reading/writing a large note, no longer freezes the window. The body
// is synchronous `std::fs` work (no `.await`), so the `std::sync::Mutex` guard —
// taken and dropped inside `root_of` — never crosses an await point.
#[tauri::command]
async fn read_tree(state: SharedState<'_>) -> Result<Vec<TreeNode>, CoreError> {
    neuralnote_core::tree::read_tree(&root_of(&state)?)
}

#[tauri::command]
async fn read_note(state: SharedState<'_>, path: String) -> Result<NoteDoc, CoreError> {
    neuralnote_core::note::read_note(&root_of(&state)?, Path::new(&path))
}

#[tauri::command]
async fn write_note(
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
async fn search_vault(state: SharedState<'_>, query: String) -> Result<SearchResponse, CoreError> {
    neuralnote_core::search::search_vault(&root_of(&state)?, &query)
}

#[tauri::command]
async fn read_link_graph(state: SharedState<'_>) -> Result<LinkGraph, CoreError> {
    neuralnote_core::links::read_link_graph(&root_of(&state)?)
}

#[tauri::command]
fn create_folder(
    state: SharedState,
    parent_path: String,
    name: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::create_folder(&root_of(&state)?, Path::new(&parent_path), &name)
}

#[tauri::command]
fn create_note(
    state: SharedState,
    parent_path: String,
    name: String,
) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::create_note(&root_of(&state)?, Path::new(&parent_path), &name)
}

#[tauri::command]
fn rename_entry(state: SharedState, path: String, new_name: String) -> Result<TreeNode, CoreError> {
    neuralnote_core::entries::rename_entry(&root_of(&state)?, Path::new(&path), &new_name)
}

#[tauri::command]
fn delete_entry(state: SharedState, path: String) -> Result<(), CoreError> {
    neuralnote_core::entries::delete_entry(&root_of(&state)?, Path::new(&path))
}

#[tauri::command]
fn move_entry(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Persist backend diagnostics to stdout AND a file in the OS log dir, so a
        // silent watcher/recents failure leaves a trace in a bundled build where
        // stderr reaches no one (PA-007).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            list_recent_vaults,
            pick_vault_folder,
            pick_new_vault_location,
            open_vault,
            create_vault,
            close_vault,
            read_tree,
            read_note,
            write_note,
            search_vault,
            read_link_graph,
            create_folder,
            create_note,
            rename_entry,
            delete_entry,
            move_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
