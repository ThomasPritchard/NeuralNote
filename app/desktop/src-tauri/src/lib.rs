//! NeuralNote desktop shell — the thin Tauri layer over `neuralnote-core`.
//!
//! Holds the shared app state (the open-vault session and the local-AI sidecar
//! handle) and the `run()` entry point that registers every command. The command
//! implementations live in [`commands`] — vault CRUD in [`commands::vault`] and the
//! AI/provider verbs in [`commands::ai`]. All path logic and data safety live in the
//! core crate; this shell only wires it to the webview.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use neuralnote_core::CoreError;
use notify::RecommendedWatcher;
use tauri::{AppHandle, Manager, State};

mod ai;
mod commands;
mod event_names;
mod local;
mod menu;

// Re-exported solely for the network-gated behavioural eval integration test
// (tests/behavioural_eval.rs), which drives the REAL provider clients through
// run_chat outside the Tauri command plumbing. Not part of the app's own API.
pub use ai::OpenAiChatClient;
pub use local::ollama_chat_client;

/// The currently-open vault, if any. The watcher is held here so it stays alive
/// for the session and is dropped (stopping the watch) on close. It is `Option`
/// because watcher init is non-fatal — `None` when it failed, so the vault still
/// opens and only live external-edit refresh is lost (in-app edits self-refresh)
/// (PA-008).
pub(crate) struct VaultSession {
    pub(crate) root: PathBuf,
    pub(crate) _watcher: Option<RecommendedWatcher>,
}

pub(crate) struct AppState {
    pub(crate) session: Option<VaultSession>,
    pub(crate) local_ai: local::LocalAiState,
    /// Folders the user explicitly chose via the native picker this session.
    /// Only these — or a path already in the on-disk recents list (itself written
    /// only from a prior explicit pick) — may become a vault root. This stops a
    /// compromised webview from pointing the vault, and thus every file command,
    /// at an arbitrary path it supplies to `open_vault`/`create_vault`.
    // TODO(authorized-set-unbounded): this grows once per folder picked and is
    // never pruned. Bounded by picks-per-session (tiny in practice), so deferred —
    // round-9 FYI. Cap or LRU-evict it if a session could realistically pick many.
    pub(crate) authorized: HashSet<PathBuf>,
    /// Whether the cited-recall chat panel is shown. The webview owns this now (a
    /// titlebar button competes with the View menu, so the menu can't be its sole
    /// toggle); this copy exists only so the native View-menu checkmark can be
    /// painted. From the webview, `set_chat_visible` is the only write path; vault
    /// open/create also force-reset it to `true`, and `Default` seeds it `true`,
    /// so a freshly-remounted workspace and the checkmark start in agreement. Any
    /// per-write logging/validation must cover those reset sites too, not just
    /// `set_chat_visible`.
    pub(crate) chat_visible: bool,
    /// Whether a text note is currently open in edit mode. The Format menu items
    /// only do anything when the editor is mounted (edit mode), so they're enabled
    /// only when this is true — an enabled-but-inert Format item would be a silent
    /// no-op. Pushed from the webview via `set_menu_editing`; reset on vault change.
    pub(crate) editing: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: None,
            local_ai: local::LocalAiState::default(),
            authorized: HashSet::new(),
            chat_visible: true,
            editing: false,
        }
    }
}

pub(crate) type SharedState<'a> = State<'a, Mutex<AppState>>;

/// Lock the shared state, recovering a poisoned mutex instead of panicking. A
/// panic in one short critical section must not brick every later vault command
/// for the rest of the process; `AppState` is plain data with no broken
/// invariant to protect, so adopting the inner value is safe.
pub(crate) fn lock_state<'a>(state: &'a SharedState) -> std::sync::MutexGuard<'a, AppState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The open vault root, or a typed error if none is open.
pub(crate) fn root_of(state: &SharedState) -> Result<PathBuf, CoreError> {
    lock_state(state)
        .session
        .as_ref()
        .map(|s| s.root.clone())
        .ok_or_else(|| CoreError::Io("no vault is open".into()))
}

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, CoreError> {
    app.path()
        .app_config_dir()
        .map_err(|e| CoreError::Io(format!("no config dir: {e}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
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
                // Bound on-disk log growth and verbosity explicitly rather than relying on
                // the plugin's defaults (PA-030): ship Info-and-above in release while
                // keeping Debug in dev, cap each file, and keep only a few rotated files so
                // this long-lived desktop process can't grow the LogDir without limit.
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5_000_000) // 5 MB per file
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(AppState::default()))
        // Install the NeuralNote application menu, replacing Tauri's generic
        // default. A failure here would leave the app menu-less — surface it in
        // the log rather than dropping it silently (PA-007 discipline).
        .setup(|app| {
            if let Err(e) = menu::install(app.handle()) {
                log::error!("could not install the application menu: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault::list_recent_vaults,
            commands::vault::pick_vault_folder,
            commands::vault::pick_new_vault_location,
            commands::vault::open_vault,
            commands::vault::create_vault,
            commands::vault::close_vault,
            commands::vault::set_menu_editing,
            commands::vault::set_chat_visible,
            commands::vault::read_tree,
            commands::vault::read_note,
            commands::vault::write_note,
            commands::vault::search_vault,
            commands::vault::read_link_graph,
            commands::vault::read_backlinks,
            commands::vault::create_folder,
            commands::vault::create_note,
            commands::vault::list_templates,
            commands::vault::create_note_from_template,
            commands::vault::rename_entry,
            commands::vault::delete_entry,
            commands::vault::move_entry,
            commands::ai::api_key_status,
            commands::ai::save_api_key,
            commands::ai::clear_api_key,
            commands::ai::chat,
            commands::ai::ai_status,
            commands::ai::set_active_provider,
            commands::ai::set_reasoning,
            commands::ai::refresh_reasoning_support,
            commands::ai::detect_hardware,
            commands::ai::local_candidates,
            commands::ai::recommend_local_model,
            commands::ai::hf_model_metadata,
            commands::ai::list_local_models,
            commands::ai::pull_local_model,
            commands::ai::cancel_pull,
            commands::ai::delete_local_model,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let state = app.state::<Mutex<AppState>>();
                local::shutdown_ollama(&state);
            }
        });
}
