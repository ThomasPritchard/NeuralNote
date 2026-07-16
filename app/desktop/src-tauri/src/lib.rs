//! NeuralNote desktop shell — the thin Tauri layer over `neuralnote-core`.
//!
//! Holds the shared app state (the open-vault session and the local-AI sidecar
//! handle) and the `run()` entry point that registers every command. The command
//! implementations live in [`commands`] — vault CRUD in [`commands::vault`] and the
//! AI/provider verbs in [`commands::ai`]. All path logic and data safety live in the
//! core crate; this shell only wires it to the webview.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use neuralnote_core::CoreError;
use notify::RecommendedWatcher;
use tauri::{AppHandle, Manager, State};

use crate::provider_config_mutation::ProviderConfigMutationGate;
use crate::vault_mutation::{VaultMutationContext, VaultMutationGate};

mod ai;
mod authorized_paths;
mod commands;
mod event_names;
mod local;
mod menu;
mod openrouter_catalogue;
#[cfg(test)]
mod openrouter_catalogue_contract_tests;
mod provider_config_mutation;
mod requirement_detection;
mod requirement_download;
mod requirement_install_lock;
mod requirement_installer;
mod requirement_source_build;
mod skills;
mod vault_mutation;
mod youtube;

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
    /// Session-scoped POT lifecycle and the single yt-dlp update allowance.
    pub(crate) youtube: youtube::YoutubeHostState,
    /// Parked structured-question responders. The Arc is cloned out under the
    /// short AppState lock before any chat future awaits an answer.
    pub(crate) pending_elicitations: Arc<skills::PendingElicitations>,
    /// Separate cancellation slot for app-data requirement downloads. It must
    /// never share Ollama's pull token: cancelling one download class must not
    /// abort the other.
    pub(crate) requirement_download: requirement_download::RequirementDownloadState,
    /// Content hashes for at most the last eight non-empty skill runs. Bounded so
    /// delete authority and memory cannot grow for the lifetime of the app.
    pub(crate) skill_undo_runs: skills::UndoRunStore,
    /// Session-only OpenRouter ranking cache and the exact validated model IDs
    /// last offered to the webview. Provider bodies and credentials never enter
    /// this state.
    pub(crate) openrouter_catalogue: openrouter_catalogue::OpenRouterCatalogueState,
    /// Serializes native read-modify-write updates to `ai-config.json`. Kept
    /// separate from the broad AppState lock so filesystem and keychain I/O do
    /// not block unrelated session-state access.
    pub(crate) provider_config_mutations: ProviderConfigMutationGate,
    /// Folders the user explicitly chose via the native picker this session.
    /// Only these — or a path already in the on-disk recents list (itself written
    /// only from a prior explicit pick) — may become a vault root. This stops a
    /// compromised webview from pointing the vault, and thus every file command,
    /// at an arbitrary path it supplies to `open_vault`/`create_vault`.
    ///
    /// Bounded LRU (see [`authorized_paths`]): capped so this can't grow for the
    /// life of the process, evicting the oldest pick first. Eviction only *forgets*
    /// — it never widens authority — and an evicted path fails closed on the next
    /// authorization check. Reopening a previously opened vault still works because
    /// that vault is also written to the on-disk recents list.
    pub(crate) authorized: authorized_paths::AuthorizedPaths,
    /// Whether the cited-recall chat panel is shown. The webview owns this now (a
    /// titlebar button competes with the View menu, so the menu can't be its sole
    /// toggle); this copy exists only so the native View-menu checkmark can be
    /// painted. From the webview, `set_chat_visible` is the only write path; vault
    /// open/create also force-reset it to `true`, and `Default` seeds it `true`,
    /// so a freshly-remounted workspace and the checkmark start in agreement. Any
    /// per-write logging/validation must cover those reset sites too, not just
    /// `set_chat_visible`.
    pub(crate) chat_visible: bool,
    /// Whether an editable text note is currently open. The Format menu items
    /// only do anything when the source editor is mounted, so they're enabled
    /// only when this is true — an enabled-but-inert Format item would be a silent
    /// no-op. Pushed from the webview via `set_menu_editing`; reset on vault change.
    pub(crate) editing: bool,
    /// Replaced whenever a different vault opens. All note writes and entry
    /// rename/move/delete commands capture this gate together with the root.
    pub(crate) vault_mutations: VaultMutationGate,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            session: None,
            local_ai: local::LocalAiState::default(),
            youtube: youtube::YoutubeHostState::default(),
            pending_elicitations: Arc::new(skills::PendingElicitations::default()),
            requirement_download: requirement_download::RequirementDownloadState::default(),
            skill_undo_runs: skills::UndoRunStore::default(),
            openrouter_catalogue: openrouter_catalogue::OpenRouterCatalogueState::default(),
            provider_config_mutations: ProviderConfigMutationGate::default(),
            authorized: authorized_paths::AuthorizedPaths::default(),
            chat_visible: true,
            editing: false,
            vault_mutations: VaultMutationGate::default(),
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

/// Capture the current root and its mutation gate in one AppState critical
/// section so a concurrent vault switch cannot mix two vault generations.
pub(crate) fn vault_mutation_of(state: &SharedState) -> Result<VaultMutationContext, CoreError> {
    let guard = lock_state(state);
    let root = guard
        .session
        .as_ref()
        .map(|session| session.root.clone())
        .ok_or_else(|| CoreError::Io("no vault is open".into()))?;
    Ok(VaultMutationContext::new(
        root,
        guard.vault_mutations.clone(),
    ))
}

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, CoreError> {
    app.path()
        .app_config_dir()
        .map_err(|e| CoreError::Io(format!("no config dir: {e}")))
}

fn updater_public_key_is_configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitRequestDisposition {
    GuardAndNotify,
    ExitNow,
}

/// Native user interaction has no exit code and must cross the renderer's
/// unsaved-edit guard. `AppHandle::exit` carries a code and is the explicit,
/// already-confirmed path back from that guard.
fn exit_request_disposition(code: Option<i32>) -> ExitRequestDisposition {
    if code.is_some() {
        ExitRequestDisposition::ExitNow
    } else {
        ExitRequestDisposition::GuardAndNotify
    }
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(AppState::default()))
        // Install the NeuralNote application menu, replacing Tauri's generic
        // default. A failure here would leave the app menu-less — surface it in
        // the log rather than dropping it silently (PA-007 discipline).
        .setup(|app| {
            #[cfg(desktop)]
            {
                if updater_public_key_is_configured(app.config()) {
                    app.handle()
                        .plugin(tauri_plugin_updater::Builder::new().build())?;
                } else {
                    // Release builds merge a config containing the real public key.
                    // Development and unsigned smoke builds deliberately have no
                    // placeholder key; leave updater IPC unavailable instead of
                    // crashing the whole app during setup.
                    log::warn!("updater disabled: no public verification key configured");
                }
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ))?;
            }
            if let Err(e) = menu::install(app.handle()) {
                log::error!("could not install the application menu: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::preferences::load_app_preferences,
            commands::preferences::save_app_preferences,
            commands::templates::load_template_settings,
            commands::templates::save_template_settings,
            commands::templates::reset_template_settings,
            commands::templates::pick_template_folder,
            commands::workspace_state::load_workspace_state,
            commands::workspace_state::save_workspace_state,
            commands::workspace_state::reset_workspace_state,
            commands::lifecycle::quit_app,
            commands::vault::list_recent_vaults,
            commands::vault::pick_vault_folder,
            commands::vault::pick_new_vault_location,
            commands::vault::open_vault,
            commands::vault::create_vault,
            commands::vault::close_vault,
            commands::vault::set_menu_editing,
            commands::vault::set_chat_visible,
            commands::vault::read_tree,
            commands::vault::list_dir,
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
            commands::ai::cancel_chat_run,
            commands::ai::open_youtube_timestamp,
            commands::ai::ai_status,
            commands::ai::openrouter_model_menu,
            commands::ai::select_openrouter_model,
            commands::ai::open_openrouter_rankings,
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
            commands::ai::list_skills,
            commands::ai::set_skill_enabled,
            skills::answer_elicitation,
            skills::undo_skill_run,
            requirement_download::download_requirement,
            requirement_download::cancel_requirement_download,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(
                &event,
                tauri::RunEvent::Exit
                    | tauri::RunEvent::WindowEvent {
                        event: tauri::WindowEvent::Destroyed,
                        ..
                    }
            ) {
                let state = app.state::<Mutex<AppState>>();
                lock_state(&state).pending_elicitations.cancel_all_runs();
            }
            let should_shutdown = match &event {
                tauri::RunEvent::ExitRequested { code, api, .. }
                    if exit_request_disposition(*code)
                        == ExitRequestDisposition::GuardAndNotify =>
                {
                    api.prevent_exit();
                    menu::emit_quit_requested(app);
                    false
                }
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => true,
                _ => false,
            };
            if should_shutdown {
                let state = app.state::<Mutex<AppState>>();
                let youtube = lock_state(&state).youtube.clone();
                youtube.shutdown();
                local::shutdown_ollama(&state);
            }
        });
}

#[cfg(test)]
mod updater_config_tests {
    use super::{
        exit_request_disposition, updater_public_key_is_configured, ExitRequestDisposition,
    };

    #[test]
    fn native_exit_requests_are_guarded_but_confirmed_programmatic_exits_are_allowed() {
        assert_eq!(
            exit_request_disposition(None),
            ExitRequestDisposition::GuardAndNotify
        );
        assert_eq!(
            exit_request_disposition(Some(0)),
            ExitRequestDisposition::ExitNow
        );
    }

    #[test]
    fn updater_requires_a_nonempty_public_key() {
        let mut config = tauri::Config::default();
        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "endpoints": ["https://example.invalid/latest.json"] }),
        );
        assert!(!updater_public_key_is_configured(&config));

        config
            .plugins
            .0
            .insert("updater".into(), serde_json::json!({ "pubkey": "  " }));
        assert!(!updater_public_key_is_configured(&config));

        config.plugins.0.insert(
            "updater".into(),
            serde_json::json!({ "pubkey": "trusted-public-key" }),
        );
        assert!(updater_public_key_is_configured(&config));
    }
}
