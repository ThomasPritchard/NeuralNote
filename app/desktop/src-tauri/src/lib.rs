//! NeuralNote desktop shell — the thin Tauri layer over `neuralnote-core`.
//!
//! Holds the open-vault session (root + filesystem watcher), exposes the vault
//! verbs as commands, and bridges the native folder picker. All path logic and
//! data safety live in the core crate; this file only wires it to the webview.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use neuralnote_core::model::{
    Backlinks, LinkGraph, NoteDoc, RecentVault, SearchResponse, TemplateInfo, TreeNode, Vault,
};
use neuralnote_core::CoreError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod ai;
mod local;
mod menu;

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

struct AppState {
    session: Option<VaultSession>,
    local_ai: local::LocalAiState,
    /// Folders the user explicitly chose via the native picker this session.
    /// Only these — or a path already in the on-disk recents list (itself written
    /// only from a prior explicit pick) — may become a vault root. This stops a
    /// compromised webview from pointing the vault, and thus every file command,
    /// at an arbitrary path it supplies to `open_vault`/`create_vault`.
    // TODO(authorized-set-unbounded): this grows once per folder picked and is
    // never pruned. Bounded by picks-per-session (tiny in practice), so deferred —
    // round-9 FYI. Cap or LRU-evict it if a session could realistically pick many.
    authorized: HashSet<PathBuf>,
    /// Whether the cited-recall chat panel is shown. Owned here (not just in the
    /// webview) because the native View-menu checkmark reflects it; the menu is
    /// its only toggle, so this stays authoritative. Reset to shown on each vault
    /// open so a freshly-mounted workspace and the checkmark start in agreement.
    chat_visible: bool,
    /// Whether a text note is currently open in edit mode. The Format menu items
    /// only do anything when the editor is mounted (edit mode), so they're enabled
    /// only when this is true — an enabled-but-inert Format item would be a silent
    /// no-op. Pushed from the webview via `set_menu_editing`; reset on vault change.
    editing: bool,
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

/// Rebuild the native menu after a vault open/close so "Open Recent" and the
/// vault-only items reflect the new state. A failure only degrades the menu (the
/// app keeps working), so it's logged rather than surfaced — but never dropped
/// silently.
fn refresh_menu(app: &AppHandle) {
    if let Err(e) = menu::refresh(app) {
        log::warn!("could not refresh the application menu: {e}");
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
    {
        // Replace only the session, preserving the authorized set for later opens.
        // Reset chat visibility so the fresh workspace and the menu checkmark agree,
        // and clear edit-mode (no note is open yet) so Format items start disabled.
        let mut guard = lock_state(&state);
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
    {
        let mut guard = lock_state(&state);
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
fn close_vault(app: AppHandle, state: SharedState) {
    {
        let mut guard = lock_state(&state);
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
fn set_menu_editing(app: AppHandle, state: SharedState, editing: bool) {
    {
        let mut guard = lock_state(&state);
        if guard.editing == editing {
            return;
        }
        guard.editing = editing;
    }
    refresh_menu(&app);
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
async fn read_backlinks(state: SharedState<'_>, path: String) -> Result<Backlinks, CoreError> {
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
async fn list_templates(state: SharedState<'_>) -> Result<Vec<TemplateInfo>, CoreError> {
    neuralnote_core::templates::list_templates(&root_of(&state)?)
}

#[tauri::command]
fn create_note_from_template(
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

/* ───────────────────────────  AI: cited chat  ──────────────────────────── */

#[tauri::command]
fn api_key_status(app: AppHandle) -> Result<ai::ApiKeyStatus, CoreError> {
    ai::api_key_status(&config_dir(&app)?)
}

#[tauri::command]
fn save_api_key(app: AppHandle, key: String, model: String) -> Result<(), CoreError> {
    let model = model.trim();
    let model = if model.is_empty() {
        neuralnote_core::ai::DEFAULT_MODEL
    } else {
        model
    };
    ai::save_api_key(&config_dir(&app)?, key.trim(), model)
}

#[tauri::command]
fn clear_api_key(app: AppHandle) -> Result<(), CoreError> {
    ai::clear_api_key(&config_dir(&app)?)
}

/* ─────────────────────────  AI: provider selection  ────────────────────── */

/// Provider-aware AI status for the settings UI and the chat pane's first-run
/// decision. `active_provider` is the *effective* provider (an existing key user
/// with no explicit choice reads as OpenRouter), or `null` when nothing is set up
/// yet. This is a pure config read — it never starts the sidecar or touches the
/// keychain, so the UI can poll it cheaply.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStatus {
    active_provider: Option<neuralnote_core::ai::ProviderKind>,
    openrouter: OpenRouterStatus,
    local: LocalStatus,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterStatus {
    has_key: bool,
    model: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStatus {
    active_model_tag: Option<String>,
}

#[tauri::command]
fn ai_status(app: AppHandle) -> Result<AiStatus, CoreError> {
    let cfg = neuralnote_core::ai::read_provider_config(&config_dir(&app)?)?;
    Ok(AiStatus {
        active_provider: cfg.effective_provider(),
        openrouter: OpenRouterStatus {
            has_key: cfg.key_configured,
            model: cfg.model,
        },
        local: LocalStatus {
            active_model_tag: cfg.local_model_tag,
        },
    })
}

/// Choose the active AI provider (and, for Local, the model tag to chat against).
/// Persisted to the non-secret AI config; the OpenRouter key stays in the keychain.
#[tauri::command]
fn set_active_provider(
    app: AppHandle,
    provider: neuralnote_core::ai::ProviderKind,
    local_model_tag: Option<String>,
) -> Result<(), CoreError> {
    // A Local selection must reference a curated, tool-calling-capable model —
    // enforced in Rust so a non-UI caller can't make an arbitrary model the
    // cited-chat model (protects the moat).
    if let Some(tag) = &local_model_tag {
        if !neuralnote_core::ai::is_curated_model(tag) {
            return Err(CoreError::LocalAi(format!(
                "\"{tag}\" isn't a supported local model."
            )));
        }
    }
    let dir = config_dir(&app)?;
    let mut cfg = neuralnote_core::ai::read_provider_config(&dir)?;
    cfg.active_provider = Some(provider);
    if let Some(tag) = local_model_tag {
        cfg.local_model_tag = Some(tag);
    }
    neuralnote_core::ai::write_provider_config(&dir, &cfg)
}

/// Detected host hardware (macOS-first; infallible — unknown fields read as
/// zero/empty). Feeds the recommendation and the settings hardware readout.
#[tauri::command]
fn detect_hardware() -> neuralnote_core::ai::HardwareSpec {
    local::detect_hardware()
}

/// The curated, tool-calling-capable local-model catalogue — the source of truth
/// for what may be installed (protects cited chat's tool-calling). The UI enriches
/// each entry with live `hf_model_metadata`.
#[tauri::command]
fn local_candidates() -> Vec<neuralnote_core::ai::CandidateModel> {
    neuralnote_core::ai::curated_candidates()
}

/// Which curated model this machine should safely run, or an explicit
/// "unsupported" verdict for weak/unsupported hardware.
#[tauri::command]
fn recommend_local_model() -> neuralnote_core::ai::Recommendation {
    neuralnote_core::ai::recommend_model(
        &local::detect_hardware(),
        &neuralnote_core::ai::curated_candidates(),
    )
}

/// Live Hugging Face metadata (downloads / licence / last-updated) for a model
/// repo, shown for transparency. Optional enrichment: callers treat an `Err` as
/// "no metadata available", never as a hard failure.
#[tauri::command]
async fn hf_model_metadata(hf_repo: String) -> Result<neuralnote_core::ai::HfModelMeta, CoreError> {
    local::fetch_hf_metadata(&hf_repo).await
}

/// Models currently installed in the app-owned Ollama store (starts the bundled
/// sidecar if it isn't running yet).
#[tauri::command]
async fn list_local_models(
    app: AppHandle,
    state: SharedState<'_>,
) -> Result<Vec<neuralnote_core::ai::InstalledModel>, CoreError> {
    let port = local::ensure_ollama_started(&app, &state).await?;
    local::list_local_models(port).await
}

/// Download a local model, streaming `PullEvent`s over `on_event`. Emits exactly
/// one terminal event (Success xor Error) so the UI always resolves; a transport
/// failure is surfaced, never silent. Starts the sidecar if needed.
#[tauri::command]
async fn pull_local_model(
    app: AppHandle,
    state: SharedState<'_>,
    tag: String,
    on_event: tauri::ipc::Channel<neuralnote_core::ai::PullEvent>,
) -> Result<(), ()> {
    use neuralnote_core::ai::{PullEvent, PullSink};
    use std::sync::atomic::Ordering;

    let mut sink = local::TauriPullSink::new(on_event);

    // Only curated, tool-calling-capable models may be installed — the allowlist
    // protects cited chat's tool-calling, enforced in Rust so a non-UI caller can't
    // pull an arbitrary model. Reject before spawning anything.
    if !neuralnote_core::ai::is_curated_model(&tag) {
        sink.send(PullEvent::Error {
            message: format!("\"{tag}\" isn't a supported local model."),
        });
        return Ok(());
    }

    // Install a FRESH cancel token for THIS download BEFORE startup, so a Cancel that
    // arrives while the sidecar is still starting still targets this pull (the old
    // sidecar-scoped flag didn't exist yet during first startup, and was reset after
    // startup — losing the cancel). The lock is released at the end of this stmt.
    let cancel = lock_state(&state).local_ai.install_pull_cancel();

    let port = match local::ensure_ollama_started(&app, &state).await {
        Ok(p) => p,
        Err(e) => {
            sink.send(PullEvent::Error {
                message: format!("Couldn't start Local AI: {}", ai::error_detail(e)),
            });
            return Ok(());
        }
    };

    // Honour a Cancel that landed while the sidecar was starting, before opening the
    // download.
    if cancel.load(Ordering::SeqCst) {
        sink.send(PullEvent::Error {
            message: "Download cancelled.".into(),
        });
        return Ok(());
    }

    match local::pull_local_model(port, &tag, &mut sink, &cancel).await {
        Ok(()) => sink.send(PullEvent::Success),
        Err(e) => sink.send(PullEvent::Error {
            message: ai::error_detail(e),
        }),
    }
    Ok(())
}

/// Cancel an in-flight local-model download. Targets the current pull's token,
/// which exists even while the sidecar is still starting (before the first pull).
#[tauri::command]
fn cancel_pull(state: SharedState) {
    lock_state(&state)
        .local_ai
        .pull_cancel()
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Remove an installed local model (starts the sidecar if needed).
#[tauri::command]
async fn delete_local_model(
    app: AppHandle,
    state: SharedState<'_>,
    tag: String,
) -> Result<(), CoreError> {
    let port = local::ensure_ollama_started(&app, &state).await?;
    local::delete_local_model(port, &tag).await
}

/// Whether an installed Ollama tag satisfies the user's selected model. Curated
/// tags are explicit (e.g. `qwen2.5:7b`), but Ollama may store a bare name as
/// `name:latest`, so match both directions defensively.
fn model_installed(installed: &str, wanted: &str) -> bool {
    installed == wanted
        || installed.strip_suffix(":latest") == Some(wanted)
        || wanted.strip_suffix(":latest") == Some(installed)
}

/// Run one cited-chat turn. Streams `ChatEvent`s to the frontend via `on_event`;
/// the API key is read here (Rust-side) and never crosses to the webview. Every
/// failure (no vault, no key, transport) is surfaced as a `ChatEvent::Error` —
/// never a panic, never silent. `async` so it runs on the worker pool, like the
/// other long-running commands; the state guard (inside `root_of`) is dropped
/// before the first await.
#[tauri::command]
async fn chat(
    app: AppHandle,
    state: SharedState<'_>,
    prompt: String,
    history: Vec<ai::ChatTurn>,
    on_event: tauri::ipc::Channel<neuralnote_core::ai::ChatEvent>,
) -> Result<(), ()> {
    use neuralnote_core::ai::{
        read_provider_config, ChatEvent, EventSink, Guards, KeywordRetriever, LlmMessage,
        ProviderKind,
    };

    let mut sink = ai::TauriChannelSink::new(on_event);

    let root = match root_of(&state) {
        Ok(r) => r,
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("No vault is open: {e}"),
            });
            return Ok(());
        }
    };

    // The active provider is a pure config read; a read failure is surfaced, not
    // guessed (guessing the provider could bill the user on the wrong one or fail
    // opaquely).
    let cfg = match config_dir(&app).and_then(|dir| read_provider_config(&dir)) {
        Ok(cfg) => cfg,
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't read your AI settings: {e}"),
            });
            return Ok(());
        }
    };

    let history: Vec<LlmMessage> = history.into_iter().map(Into::into).collect();
    let retriever = KeywordRetriever::new(root.clone());
    let guards = Guards::default();

    // Provider selection is the ONLY new decision: build the matching client, then
    // both arms converge on the SAME run_chat call (orchestration/verification is
    // untouched). The provider-independent inputs travel together as one `ChatRun`;
    // run_chat emits its own Done/Error, and a returned Err (defensive) is surfaced
    // as a final Error so a failure is never silent.
    let mut run = ChatRun {
        prompt: &prompt,
        history: &history,
        root: &root,
        retriever: &retriever,
        guards: &guards,
        sink: &mut sink,
    };
    match cfg.effective_provider() {
        None => {
            run.sink.send(ChatEvent::Error {
                message: "No AI provider is set up yet. Choose one in Settings.".into(),
            });
        }
        Some(ProviderKind::OpenRouter) => chat_via_openrouter(&mut run, &cfg.model).await,
        Some(ProviderKind::Local) => match cfg.local_model_tag {
            Some(tag) => chat_via_local(&mut run, &app, &state, &tag).await,
            None => {
                run.sink.send(ChatEvent::Error {
                    message: "No local model selected. Set up Local AI in Settings.".into(),
                });
            }
        },
    }
    Ok(())
}

/// The provider-independent inputs to one chat turn, bundled so each provider
/// helper takes a short, uniform argument list (keeping both under the arg-count
/// and cognitive-complexity bars). The sink is borrowed mutably for the whole turn.
struct ChatRun<'a> {
    prompt: &'a str,
    history: &'a [neuralnote_core::ai::LlmMessage],
    root: &'a Path,
    retriever: &'a neuralnote_core::ai::KeywordRetriever,
    guards: &'a neuralnote_core::ai::Guards,
    sink: &'a mut ai::TauriChannelSink,
}

/// The OpenRouter chat arm: read the key, build the client, run the shared
/// pipeline. Split out of `chat` so each provider's error handling stays flat;
/// every failure lands on the sink (never silent).
async fn chat_via_openrouter(run: &mut ChatRun<'_>, model: &str) {
    use neuralnote_core::ai::{run_chat, ChatEvent, EventSink};

    let key = match ai::read_api_key() {
        Ok(Some(k)) => k,
        Ok(None) => {
            run.sink.send(ChatEvent::Error {
                message: "No API key set. Add your OpenRouter key in Settings.".into(),
            });
            return;
        }
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!("Couldn't read the API key: {e}"),
            });
            return;
        }
    };
    let client = ai::OpenAiChatClient::new(key);
    if let Err(e) = run_chat(
        run.prompt,
        run.history,
        run.root,
        model,
        run.retriever,
        &client,
        run.sink,
        run.guards,
    )
    .await
    {
        run.sink.send(ChatEvent::Error {
            message: format!("Chat failed: {e}"),
        });
    }
}

/// The local (Ollama sidecar) chat arm: enforce the curated allowlist, ensure the
/// sidecar is up, pre-flight the model, then run the shared pipeline. Split out of
/// `chat` for the same reason; every failure is surfaced on the sink.
async fn chat_via_local(
    run: &mut ChatRun<'_>,
    app: &AppHandle,
    state: &SharedState<'_>,
    tag: &str,
) {
    use neuralnote_core::ai::{run_chat, ChatEvent, EventSink};

    // Refuse a non-curated model even if the config was hand-edited to one —
    // cited chat must run a tool-calling-capable model or not at all.
    if !neuralnote_core::ai::is_curated_model(tag) {
        run.sink.send(ChatEvent::Error {
            message: format!("\"{tag}\" isn't a supported local model. Pick one in Settings."),
        });
        return;
    }
    let port = match local::ensure_ollama_started(app, state).await {
        Ok(port) => port,
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!("Couldn't start Local AI: {}", ai::error_detail(e)),
            });
            return;
        }
    };
    // Pre-flight the model so a deleted / never-finished model reads as a clear
    // "reinstall in Settings", not an opaque mid-stream 404.
    match local::list_local_models(port).await {
        Ok(models) if models.iter().any(|m| model_installed(&m.tag, tag)) => {}
        Ok(_) => {
            run.sink.send(ChatEvent::Error {
                message: format!(
                    "The local model \"{tag}\" isn't installed. Reinstall it in Settings."
                ),
            });
            return;
        }
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!(
                    "Couldn't check your installed local models: {}",
                    ai::error_detail(e)
                ),
            });
            return;
        }
    }
    let client = local::ollama_chat_client(port);
    if let Err(e) = run_chat(
        run.prompt,
        run.history,
        run.root,
        tag,
        run.retriever,
        &client,
        run.sink,
        run.guards,
    )
    .await
    {
        run.sink.send(ChatEvent::Error {
            message: format!("Chat failed: {e}"),
        });
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
            list_recent_vaults,
            pick_vault_folder,
            pick_new_vault_location,
            open_vault,
            create_vault,
            close_vault,
            set_menu_editing,
            read_tree,
            read_note,
            write_note,
            search_vault,
            read_link_graph,
            read_backlinks,
            create_folder,
            create_note,
            list_templates,
            create_note_from_template,
            rename_entry,
            delete_entry,
            move_entry,
            api_key_status,
            save_api_key,
            clear_api_key,
            chat,
            ai_status,
            set_active_provider,
            detect_hardware,
            local_candidates,
            recommend_local_model,
            hf_model_metadata,
            list_local_models,
            pull_local_model,
            cancel_pull,
            delete_local_model,
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
