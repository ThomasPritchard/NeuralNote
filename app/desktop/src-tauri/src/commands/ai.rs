//! AI + provider command surface: OpenRouter key management, provider selection,
//! provider-aware status, cited chat, and bundled-local-model pull / delete /
//! activate.
//!
//! The OS/transport plumbing (keychain, HTTP client, sidecar) lives in `crate::ai`
//! and `crate::local`; this module is the Tauri command layer over them. The shared
//! app state and the command registry live in `crate` (`lib.rs`).

use std::path::{Path, PathBuf};

use neuralnote_core::{ai::ReasoningSupport, CoreError};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::{ai, config_dir, local, lock_state, requirement_detection, skills, SharedState};

#[tauri::command]
pub(crate) fn api_key_status(app: AppHandle) -> Result<ai::ApiKeyStatus, CoreError> {
    ai::api_key_status(&config_dir(&app)?)
}

#[tauri::command]
pub(crate) fn save_api_key(app: AppHandle, key: String, model: String) -> Result<(), CoreError> {
    let model = model.trim();
    let model = if model.is_empty() {
        neuralnote_core::ai::DEFAULT_MODEL
    } else {
        model
    };
    ai::save_api_key(&config_dir(&app)?, key.trim(), model)
}

#[tauri::command]
pub(crate) fn clear_api_key(app: AppHandle) -> Result<(), CoreError> {
    ai::clear_api_key(&config_dir(&app)?)
}

/// Provider-aware AI status for the settings UI and the chat pane's first-run
/// decision. `active_provider` is the *effective* provider (an existing key user
/// with no explicit choice reads as OpenRouter), or `null` when nothing is set up
/// yet. This is a pure config read — it never starts the sidecar or touches the
/// keychain, so the UI can poll it cheaply.
#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct AiStatus {
    active_provider: Option<neuralnote_core::ai::ProviderKind>,
    reasoning_supported: neuralnote_core::ai::ReasoningSupport,
    openrouter: OpenRouterStatus,
    local: LocalStatus,
}

#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct OpenRouterStatus {
    has_key: bool,
    model: String,
    /// Whether the user has opted into reasoning tokens. This remains on the existing
    /// OpenRouter status DTO for compatibility, while both providers use the same
    /// persisted opt-in.
    reasoning: bool,
}

#[derive(serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct LocalStatus {
    active_model_tag: Option<String>,
}

#[tauri::command]
pub(crate) fn ai_status(app: AppHandle) -> Result<AiStatus, CoreError> {
    Ok(build_ai_status(neuralnote_core::ai::read_provider_config(
        &config_dir(&app)?,
    )?))
}

/// Map the persisted config onto the provider-aware status DTO. Split from the
/// command (which owns only the config read) so the config → status mapping — notably
/// that `reasoning` surfaces on the OpenRouter status — is unit-testable without an
/// `AppHandle`.
fn build_ai_status(cfg: neuralnote_core::ai::ProviderConfig) -> AiStatus {
    let reasoning_supported = cfg.cached_reasoning_support();
    AiStatus {
        active_provider: cfg.effective_provider(),
        reasoning_supported,
        openrouter: OpenRouterStatus {
            has_key: cfg.key_configured,
            model: cfg.model,
            reasoning: cfg.reasoning,
        },
        local: LocalStatus {
            active_model_tag: cfg.local_model_tag,
        },
    }
}

fn app_data_dir_or_warn(app: &AppHandle, purpose: &str) -> Option<PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            log::warn!(
                "could not resolve the app-data directory to {purpose}; continuing without it: {error}"
            );
            None
        }
    }
}

/// Choose the active AI provider (and, for Local, the model tag to chat against).
/// Persisted to the non-secret AI config; the OpenRouter key stays in the keychain.
#[tauri::command]
pub(crate) fn set_active_provider(
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

/// Opt into (or out of) reasoning tokens on the answer turn. Persisted to the
/// non-secret AI config; `chat` combines it with the selected model's cached or
/// freshly-probed capability before building the provider client.
///
/// Returns the freshly persisted `AiStatus` (as `write_note` returns the saved
/// `NoteDoc`). The caller must render *this*, never a follow-up `ai_status` read: a
/// read that failed after the write landed would leave the toggle showing "off" while
/// the config says "on", silently billing the user for reasoning they never consented
/// to. Returning the state removes the window rather than detecting it.
#[tauri::command]
pub(crate) fn set_reasoning(app: AppHandle, enabled: bool) -> Result<AiStatus, CoreError> {
    let dir = config_dir(&app)?;
    let mut cfg = neuralnote_core::ai::read_provider_config(&dir)?;
    cfg.reasoning = enabled;
    neuralnote_core::ai::write_provider_config(&dir, &cfg)?;
    Ok(build_ai_status(cfg))
}

/// Probe the effective provider's selected model for reasoning/thinking support,
/// cache the verdict against that model, and return the freshly-persisted status.
/// Every probe failure is cached as `Unknown`, never `Unsupported` (fail open).
#[tauri::command]
pub(crate) async fn refresh_reasoning_support(
    app: AppHandle,
    state: SharedState<'_>,
) -> Result<AiStatus, CoreError> {
    let dir = config_dir(&app)?;
    let cfg = neuralnote_core::ai::read_provider_config(&dir)?;

    match probed_verdict(&app, &state, &cfg).await {
        Some((support, model)) => persist_reasoning_verdict(&dir, support, model),
        None => Ok(build_ai_status(cfg)),
    }
}

// TODO(config-write-serialization): the ai-config.json writers do read-modify-write
// without a shared lock. `persist_reasoning_verdict` already narrows the blast radius —
// it re-reads fresh and overwrites only the two capability fields, so the multi-second
// probe window can't clobber a concurrent `set_reasoning` / `set_active_provider` /
// `set_skill_enabled` / `save_api_key`. What remains is the sub-ms gap between each writer's
// own read and write:
// two writers landing in that window still lose one update. Acceptable while config writes
// are rare and user-driven (you can't realistically race yourself across two settings
// controls). Fix trigger: any writer that fires without direct user action (a background
// re-probe, a sync loop) — then serialize all writers behind one async mutex.

/// Persist a freshly-probed reasoning verdict without clobbering config that the
/// probe's multi-second window let another writer change. The probe can run for
/// seconds (OpenRouter ~8s, an Ollama cold-start ~30s); during it a concurrent
/// `set_reasoning` / `set_active_provider` / `set_skill_enabled` / `save_api_key` may land.
/// Re-read fresh and overwrite ONLY the two capability fields, so those writes survive.
/// Returns the persisted status so the caller renders exactly what reached disk.
fn persist_reasoning_verdict(
    dir: &Path,
    support: ReasoningSupport,
    probed_model: String,
) -> Result<AiStatus, CoreError> {
    let mut cfg = neuralnote_core::ai::read_provider_config(dir)?;
    cfg.reasoning_support = Some(support);
    cfg.reasoning_probed_model = Some(probed_model);
    neuralnote_core::ai::write_provider_config(dir, &cfg)?;
    Ok(build_ai_status(cfg))
}

async fn probed_verdict(
    app: &AppHandle,
    state: &SharedState<'_>,
    cfg: &neuralnote_core::ai::ProviderConfig,
) -> Option<(ReasoningSupport, String)> {
    match cfg.effective_provider()? {
        neuralnote_core::ai::ProviderKind::OpenRouter => Some((
            ai::probe_openrouter_reasoning(&cfg.model).await,
            cfg.model.clone(),
        )),
        neuralnote_core::ai::ProviderKind::Local => {
            let tag = cfg.local_model_tag.clone()?;
            let support = match local::ensure_ollama_started(app, state).await {
                Ok(port) => local::probe_ollama_reasoning(port, &tag).await,
                Err(e) => {
                    log::warn!(
                        "reasoning probe: local sidecar unavailable: {}",
                        ai::error_detail(e)
                    );
                    ReasoningSupport::Unknown
                }
            };
            Some((support, tag))
        }
    }
}

/// Detected host hardware (macOS-first; infallible — unknown fields read as
/// zero/empty). Feeds the recommendation and the settings hardware readout.
#[tauri::command]
pub(crate) fn detect_hardware(app: AppHandle) -> neuralnote_core::ai::HardwareSpec {
    let app_data_dir = app_data_dir_or_warn(&app, "detect hardware");
    local::detect_hardware(app_data_dir.as_deref())
}

/// The curated, tool-calling-capable local-model catalogue — the source of truth
/// for what may be installed (protects cited chat's tool-calling). The UI enriches
/// each entry with live `hf_model_metadata`.
#[tauri::command]
pub(crate) fn local_candidates() -> Vec<neuralnote_core::ai::CandidateModel> {
    neuralnote_core::ai::curated_candidates()
}

fn ensure_curated_model_tag(tag: &str) -> Result<(), CoreError> {
    if neuralnote_core::ai::is_curated_model(tag) {
        Ok(())
    } else {
        Err(CoreError::LocalAi(format!(
            "\"{tag}\" isn't a supported local model."
        )))
    }
}

fn ensure_curated_hf_repo(hf_repo: &str) -> Result<(), CoreError> {
    if neuralnote_core::ai::curated_candidates()
        .iter()
        .any(|candidate| candidate.hf_repo == hf_repo)
    {
        Ok(())
    } else {
        Err(CoreError::InvalidName(
            "Hugging Face metadata is limited to supported local models.".into(),
        ))
    }
}

/// Which curated model this machine should safely run, or an explicit
/// "unsupported" verdict for weak/unsupported hardware.
#[tauri::command]
pub(crate) fn recommend_local_model(app: AppHandle) -> neuralnote_core::ai::Recommendation {
    let app_data_dir = app_data_dir_or_warn(&app, "recommend a local model");
    neuralnote_core::ai::recommend_model(
        &local::detect_hardware(app_data_dir.as_deref()),
        &neuralnote_core::ai::curated_candidates(),
    )
}

/// Live Hugging Face metadata (downloads / licence / last-updated) for a model
/// repo, shown for transparency. Optional enrichment: callers treat an `Err` as
/// "no metadata available", never as a hard failure.
#[tauri::command]
pub(crate) async fn hf_model_metadata(
    hf_repo: String,
) -> Result<neuralnote_core::ai::HfModelMeta, CoreError> {
    ensure_curated_hf_repo(&hf_repo)?;
    local::fetch_hf_metadata(&hf_repo).await
}

/// Models currently installed in the app-owned Ollama store (starts the bundled
/// sidecar if it isn't running yet).
#[tauri::command]
pub(crate) async fn list_local_models(
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
pub(crate) async fn pull_local_model(
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
                message: ai::error_detail(e),
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
pub(crate) fn cancel_pull(state: SharedState) {
    lock_state(&state)
        .local_ai
        .pull_cancel()
        .store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Remove an installed local model (starts the sidecar if needed).
#[tauri::command]
pub(crate) async fn delete_local_model(
    app: AppHandle,
    state: SharedState<'_>,
    tag: String,
) -> Result<(), CoreError> {
    ensure_curated_model_tag(&tag)?;
    let port = local::ensure_ollama_started(&app, &state).await?;
    local::delete_local_model(port, &tag).await
}

fn build_skill_registry(
    cfg: &neuralnote_core::ai::ProviderConfig,
) -> Result<neuralnote_core::ai::SkillRegistry, neuralnote_core::ai::SkillLookupError> {
    neuralnote_core::ai::SkillRegistry::built_in(&cfg.disabled_skills)
}

fn skill_registry_error(error: neuralnote_core::ai::SkillLookupError) -> CoreError {
    CoreError::Io(format!("could not load built-in skills: {error}"))
}

fn build_skill_environment(app: &AppHandle) -> neuralnote_core::ai::SkillEnvironment {
    let app_data_dir = app_data_dir_or_warn(app, "prepare the skill environment");
    let available_binaries = app_data_dir
        .as_deref()
        .map(requirement_detection::detect_requirement_files)
        .unwrap_or_default();
    neuralnote_core::ai::SkillEnvironment {
        hardware: local::detect_hardware(app_data_dir.as_deref()),
        app_data_bin_dir: app_data_dir
            .as_ref()
            .map(|dir| dir.join("bin"))
            .unwrap_or_default(),
        available_binaries,
    }
}

/// List every built-in skill and its static requirement status for Settings.
/// Download-in-progress state remains frontend-owned and is not represented here.
#[tauri::command]
pub(crate) fn list_skills(
    app: AppHandle,
) -> Result<Vec<neuralnote_core::ai::SkillListing>, CoreError> {
    let cfg = neuralnote_core::ai::read_provider_config(&config_dir(&app)?)?;
    let registry = build_skill_registry(&cfg).map_err(skill_registry_error)?;
    let environment = build_skill_environment(&app);
    Ok(registry.listings(&environment))
}

/// Persist one built-in skill's enabled state and return the state read back from
/// disk. The caller renders this value rather than assuming the write landed.
#[tauri::command]
pub(crate) fn set_skill_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<bool, CoreError> {
    let dir = config_dir(&app)?;
    set_built_in_skill_enabled_in(&dir, &id, enabled)
}

fn set_built_in_skill_enabled_in(
    config_dir: &Path,
    id: &str,
    enabled: bool,
) -> Result<bool, CoreError> {
    let registry =
        neuralnote_core::ai::SkillRegistry::built_in(&[]).map_err(skill_registry_error)?;
    set_skill_enabled_in(config_dir, &registry, id, enabled)
}

fn set_skill_enabled_in(
    config_dir: &Path,
    registry: &neuralnote_core::ai::SkillRegistry,
    id: &str,
    enabled: bool,
) -> Result<bool, CoreError> {
    if !registry.contains_id(id) {
        return Err(CoreError::InvalidName(format!("unknown skill '{id}'")));
    }

    let mut cfg = neuralnote_core::ai::read_provider_config(config_dir)?;
    let mut seen = std::collections::BTreeSet::new();
    cfg.disabled_skills
        .retain(|skill_id| seen.insert(skill_id.clone()));
    cfg.disabled_skills.retain(|skill_id| skill_id != id);
    if !enabled {
        cfg.disabled_skills.push(id.to_string());
    }
    neuralnote_core::ai::write_provider_config(config_dir, &cfg)?;

    let persisted = neuralnote_core::ai::read_provider_config(config_dir)?;
    Ok(!persisted
        .disabled_skills
        .iter()
        .any(|skill_id| skill_id == id))
}

/// Run one cited-chat turn. Streams `ChatEvent`s to the frontend via `on_event`;
/// the API key is read here (Rust-side) and never crosses to the webview. Every
/// failure (no vault, no key, transport) is surfaced as a `ChatEvent::Error` —
/// never a panic, never silent. `async` so it runs on the worker pool, like the
/// other long-running commands; the state guard is dropped before the first
/// await.
#[tauri::command]
pub(crate) async fn chat(
    app: AppHandle,
    state: SharedState<'_>,
    prompt: String,
    history: Vec<ai::ChatTurn>,
    active_skills: Vec<String>,
    on_event: tauri::ipc::Channel<neuralnote_core::ai::ChatEvent>,
) -> Result<String, ()> {
    use neuralnote_core::ai::{
        read_provider_config, ChatEvent, EventSink, Guards, KeywordRetriever, LlmMessage,
        ProviderKind,
    };

    let run_id = skills::next_chat_run_id();
    let close_signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
    let mut sink =
        ai::TauriChannelSink::with_close_signal(on_event, std::sync::Arc::clone(&close_signal));
    // Root and lifecycle generation are one AppState snapshot. Vault mutations
    // take the same outer lock while incrementing the pending registry's
    // generation, so a command paused before registration can never bind itself
    // to a workspace that has already unmounted.
    let Some((pending, root, lifecycle_generation, youtube_host, requirement_download)) = ({
        let state = lock_state(&state);
        state.session.as_ref().map(|session| {
            let pending = std::sync::Arc::clone(&state.pending_elicitations);
            let generation = pending.lifecycle_generation();
            (
                pending,
                session.root.clone(),
                generation,
                state.youtube.clone(),
                state.requirement_download.clone(),
            )
        })
    }) else {
        sink.send(ChatEvent::Error {
            message: "No vault is open.".into(),
        });
        return Ok(run_id);
    };
    let _elicitation_cleanup = match skills::RunElicitationGuard::try_new(
        std::sync::Arc::clone(&pending),
        run_id.clone(),
        std::sync::Arc::clone(&close_signal),
        lifecycle_generation,
    ) {
        Ok(guard) => guard,
        Err(error) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't register the chat run: {error}"),
            });
            return Ok(run_id);
        }
    };
    let user_prompt = skills::ShellUserPrompt::new(
        pending,
        run_id.clone(),
        std::sync::Arc::clone(&close_signal),
    );
    let note_writer = skills::RunNoteWriteBackend::new(std::sync::Arc::clone(&close_signal));
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't resolve the open vault: {error}"),
            });
            return Ok(run_id);
        }
    };

    // The active provider is a pure config read; a read failure is surfaced, not
    // guessed (guessing the provider could bill the user on the wrong one or fail
    // opaquely).
    let ai_config_dir = match config_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't locate your AI settings: {e}"),
            });
            return Ok(run_id);
        }
    };
    let cfg = match read_provider_config(&ai_config_dir) {
        Ok(cfg) => cfg,
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't read your AI settings: {e}"),
            });
            return Ok(run_id);
        }
    };

    let history: Vec<LlmMessage> = history.into_iter().map(Into::into).collect();
    let retriever = KeywordRetriever::new(root.clone());
    let guards = Guards::default();
    let skill_registry = match build_skill_registry(&cfg) {
        Ok(registry) => registry,
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't load built-in skills: {e}"),
            });
            return Ok(run_id);
        }
    };
    let skill_environment = build_skill_environment(&app);
    let capture_cancellation = neuralnote_core::ai::CaptureCancellation::default();
    let _capture_cancellation_guard = CaptureCancellationGuard::new(
        std::sync::Arc::clone(&close_signal),
        capture_cancellation.clone(),
    );
    let app_data_dir = app.path().app_data_dir().ok();
    let youtube_requirements = app_data_dir.as_ref().map(|app_data_dir| {
        crate::requirement_download::ShellYoutubeRequirementInstaller::new(
            app_data_dir.clone(),
            requirement_download,
        )
    });
    let youtube_io = match app_data_dir {
        Some(app_data_dir) => {
            match youtube_host.create_io(app_data_dir, capture_cancellation.clone()) {
                Ok(io) => Some(io),
                Err(error) => {
                    log::warn!(
                        "could not prepare YouTube capture; ordinary chat remains available: {error}"
                    );
                    None
                }
            }
        }
        None => {
            log::warn!(
                "could not locate app data for YouTube capture; ordinary chat remains available"
            );
            None
        }
    };
    let youtube_io: &dyn neuralnote_core::ai::YoutubeIo = youtube_io.as_ref().map_or(
        &neuralnote_core::ai::youtube::UNAVAILABLE_YOUTUBE_IO,
        |io| io,
    );
    let youtube_requirements: &dyn neuralnote_core::ai::YoutubeRequirementInstaller =
        youtube_requirements.as_ref().map_or(
            &neuralnote_core::ai::youtube::UNAVAILABLE_YOUTUBE_REQUIREMENT_INSTALLER,
            |installer| installer,
        );

    // Provider selection is the ONLY new decision: build the matching client, then
    // both arms converge on the SAME run_chat call (orchestration/verification is
    // untouched). The provider-independent inputs travel together as one `ChatRun`;
    // run_chat emits its own Done/Error, and a returned Err (defensive) is surfaced
    // as a final Error so a failure is never silent.
    let mut run = ChatRun {
        prompt: &prompt,
        history: &history,
        active_skills: &active_skills,
        root: &root,
        retriever: &retriever,
        skill_registry: &skill_registry,
        skill_environment: &skill_environment,
        user_prompt: &user_prompt,
        note_writer: &note_writer,
        guards: &guards,
        youtube_io,
        youtube_requirements,
        capture_cancellation,
        extractor_updates: youtube_host.extractor_updates(),
        sink: &mut sink,
        close_signal: &close_signal,
    };
    let ledger = match cfg.effective_provider() {
        None => {
            run.sink.send(ChatEvent::Error {
                message: "No AI provider is set up yet. Choose one in Settings.".into(),
            });
            None
        }
        Some(ProviderKind::OpenRouter) => {
            let effective = neuralnote_core::ai::effective_reasoning(
                cfg.reasoning,
                cfg.cached_reasoning_support(),
            );
            chat_via_openrouter(&mut run, &cfg.model, effective).await
        }
        Some(ProviderKind::Local) => {
            let reasoning_opt_in = cfg.reasoning;
            match cfg.local_model_tag {
                Some(tag) => chat_via_local(&mut run, &app, &state, &tag, reasoning_opt_in).await,
                None => {
                    run.sink.send(ChatEvent::Error {
                        message: "No local model selected. Set up Local AI in Settings.".into(),
                    });
                    None
                }
            }
        }
    };
    skills::retain_chat_undo_ledger(state.inner(), run_id.clone(), canonical_root, ledger);
    Ok(run_id)
}

#[tauri::command]
pub(crate) fn cancel_chat_run(state: SharedState<'_>) -> Result<(), String> {
    let pending = std::sync::Arc::clone(&crate::lock_state(&state).pending_elicitations);
    pending
        .cancel_active_run()
        .map(|_| ())
        .map_err(crate::ai::error_detail)
}

#[tauri::command]
#[allow(deprecated)] // Rust-owned ShellExt::open keeps arbitrary URLs out of the webview API.
pub(crate) fn open_youtube_timestamp(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt as _;

    let url = neuralnote_core::capture::validate_youtube_timestamp_url(&url)
        .map_err(|error| format!("Invalid YouTube timestamp link ({})", error.code()))?;
    app.shell()
        .open(url, None)
        .map_err(|error| format!("Couldn't open the YouTube timestamp: {error}"))
}

/// Await one cancellable transport operation. The completed branch is deliberately
/// first so a response that is already ready is not discarded at the teardown
/// boundary.
async fn await_run_or_close<F, T>(future: F, close_signal: &ai::ChatRunCloseSignal) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    tokio::pin!(future);
    tokio::select! {
        biased;
        output = &mut future => Some(output),
        () = close_signal.wait_closed() => None,
    }
}

/// Cancellation-aware adapter for the two await points owned by core's chat loop.
/// It turns lifecycle closure into a normal core error instead of dropping
/// `run_chat`; core can then unwind its `WriteSession` and return every partial
/// Undo entry accumulated before cancellation.
struct RunLlmClient<'a> {
    inner: &'a dyn neuralnote_core::ai::LlmClient,
    close_signal: &'a ai::ChatRunCloseSignal,
}

/// Bridges the existing webview/vault lifecycle signal into core's runtime-neutral
/// capture token, and aborts the watcher when a normally completed chat unwinds.
struct CaptureCancellationGuard {
    watcher: tokio::task::JoinHandle<()>,
}

impl CaptureCancellationGuard {
    fn new(
        close_signal: std::sync::Arc<ai::ChatRunCloseSignal>,
        cancellation: neuralnote_core::ai::CaptureCancellation,
    ) -> Self {
        let watcher = tokio::spawn(async move {
            close_signal.wait_closed().await;
            cancellation.cancel();
        });
        Self { watcher }
    }
}

impl Drop for CaptureCancellationGuard {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

impl<'a> RunLlmClient<'a> {
    fn new(
        inner: &'a dyn neuralnote_core::ai::LlmClient,
        close_signal: &'a ai::ChatRunCloseSignal,
    ) -> Self {
        Self {
            inner,
            close_signal,
        }
    }

    fn closed_error() -> CoreError {
        CoreError::Conflict("chat run was cancelled or its vault or window closed".into())
    }
}

#[async_trait::async_trait]
impl neuralnote_core::ai::LlmClient for RunLlmClient<'_> {
    async fn complete(
        &self,
        request: &neuralnote_core::ai::LlmRequest,
    ) -> neuralnote_core::CoreResult<neuralnote_core::ai::Completion> {
        await_run_or_close(self.inner.complete(request), self.close_signal)
            .await
            .ok_or_else(Self::closed_error)?
    }

    async fn complete_streaming(
        &self,
        request: &neuralnote_core::ai::LlmRequest,
        sink: &mut dyn neuralnote_core::ai::EventSink,
    ) -> neuralnote_core::CoreResult<String> {
        await_run_or_close(
            self.inner.complete_streaming(request, sink),
            self.close_signal,
        )
        .await
        .ok_or_else(Self::closed_error)?
    }
}

/// The provider-independent inputs to one chat turn, bundled so each provider
/// helper takes a short, uniform argument list (keeping both under the arg-count
/// and cognitive-complexity bars). The sink is borrowed mutably for the whole turn.
struct ChatRun<'a> {
    prompt: &'a str,
    history: &'a [neuralnote_core::ai::LlmMessage],
    active_skills: &'a [String],
    root: &'a Path,
    retriever: &'a neuralnote_core::ai::KeywordRetriever,
    skill_registry: &'a neuralnote_core::ai::SkillRegistry,
    skill_environment: &'a neuralnote_core::ai::SkillEnvironment,
    user_prompt: &'a dyn neuralnote_core::ai::UserPrompt,
    note_writer: &'a dyn neuralnote_core::ai::NoteWriteBackend,
    guards: &'a neuralnote_core::ai::Guards,
    youtube_io: &'a dyn neuralnote_core::ai::YoutubeIo,
    youtube_requirements: &'a dyn neuralnote_core::ai::YoutubeRequirementInstaller,
    capture_cancellation: neuralnote_core::ai::CaptureCancellation,
    extractor_updates: neuralnote_core::ai::ExtractorUpdateSession,
    sink: &'a mut ai::TauriChannelSink,
    close_signal: &'a ai::ChatRunCloseSignal,
}

fn stop_if_chat_run_closed(run: &mut ChatRun<'_>) -> bool {
    if !run.close_signal.is_closed() {
        return false;
    }
    neuralnote_core::ai::EventSink::send(
        run.sink,
        neuralnote_core::ai::ChatEvent::Error {
            message: "Chat ended because its vault or window closed.".into(),
        },
    );
    true
}

/// The OpenRouter chat arm: read the key, build the client, run the shared
/// pipeline. Split out of `chat` so each provider's error handling stays flat;
/// every failure lands on the sink (never silent). `reasoning` is the effective
/// cached-capability-aware flag computed by the caller.
async fn chat_via_openrouter(
    run: &mut ChatRun<'_>,
    model: &str,
    reasoning: bool,
) -> Option<neuralnote_core::ai::UndoLedger> {
    use neuralnote_core::ai::{run_chat, ChatEvent, EventSink, SkillServices};

    if stop_if_chat_run_closed(run) {
        return None;
    }
    let key = match ai::read_api_key() {
        Ok(Some(k)) => k,
        Ok(None) => {
            run.sink.send(ChatEvent::Error {
                message: "No API key set. Add your OpenRouter key in Settings.".into(),
            });
            return None;
        }
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!("Couldn't read the API key: {e}"),
            });
            return None;
        }
    };
    // Pricing is opportunistically cached by the existing public model-capability
    // probe. Ordinary chat never waits on catalogue I/O; the playlist tool itself
    // returns the explicit requirement error only if >20 videos need an estimate.
    let pricing =
        ai::cached_openrouter_pricing(model).map(neuralnote_core::capture::PricingInput::Hosted);
    let transport = ai::OpenAiChatClient::new(key, reasoning);
    let client = RunLlmClient::new(&transport, run.close_signal);
    let mut skill_services = SkillServices::new(
        run.skill_registry,
        run.skill_environment,
        run.user_prompt,
        run.note_writer,
        1,
    )
    .with_youtube_io(run.youtube_io)
    .with_youtube_requirements(run.youtube_requirements)
    .with_capture_cancellation(run.capture_cancellation.clone())
    .with_extractor_update_session(run.extractor_updates.clone());
    if let Some(pricing) = pricing.as_ref() {
        skill_services = skill_services.with_pricing(pricing);
    }
    match run_chat(
        run.prompt,
        run.history,
        run.active_skills.to_vec(),
        run.root,
        model,
        run.retriever,
        &client,
        &skill_services,
        run.sink,
        run.guards,
    )
    .await
    {
        Ok(ledger) => Some(ledger),
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!("Chat failed: {e}"),
            });
            None
        }
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
    reasoning_opt_in: bool,
) -> Option<neuralnote_core::ai::UndoLedger> {
    use neuralnote_core::ai::{run_chat, ChatEvent, EventSink, SkillServices};

    if stop_if_chat_run_closed(run) {
        return None;
    }
    // Refuse a non-curated model even if the config was hand-edited to one —
    // cited chat must run a tool-calling-capable model or not at all.
    if !neuralnote_core::ai::is_curated_model(tag) {
        run.sink.send(ChatEvent::Error {
            message: format!("\"{tag}\" isn't a supported local model. Pick one in Settings."),
        });
        return None;
    }
    let port_result = local::ensure_ollama_started_for_chat(app, state, run.close_signal).await;
    if stop_if_chat_run_closed(run) {
        return None;
    }
    let port = match port_result {
        Ok(port) => port,
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: ai::error_detail(e),
            });
            return None;
        }
    };
    // Pre-flight the model so a deleted / never-finished model reads as a clear
    // "reinstall in Settings", not an opaque mid-stream 404.
    let Some(models_result) =
        await_run_or_close(local::list_local_models(port), run.close_signal).await
    else {
        stop_if_chat_run_closed(run);
        return None;
    };
    if stop_if_chat_run_closed(run) {
        return None;
    }
    match models_result {
        Ok(models)
            if models
                .iter()
                .any(|m| neuralnote_core::ai::model_installed(&m.tag, tag)) => {}
        Ok(_) => {
            run.sink.send(ChatEvent::Error {
                message: format!(
                    "The local model \"{tag}\" isn't installed. Reinstall it in Settings."
                ),
            });
            return None;
        }
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!(
                    "Couldn't check your installed local models: {}",
                    ai::error_detail(e)
                ),
            });
            return None;
        }
    }
    let Some(support) =
        await_run_or_close(local::probe_ollama_reasoning(port, tag), run.close_signal).await
    else {
        stop_if_chat_run_closed(run);
        return None;
    };
    if stop_if_chat_run_closed(run) {
        return None;
    }
    let effective = neuralnote_core::ai::effective_reasoning(reasoning_opt_in, support);
    let transport = local::ollama_chat_client(port, effective);
    let client = RunLlmClient::new(&transport, run.close_signal);
    let pricing = neuralnote_core::capture::PricingInput::Local;
    let skill_services = SkillServices::new(
        run.skill_registry,
        run.skill_environment,
        run.user_prompt,
        run.note_writer,
        1,
    )
    .with_youtube_io(run.youtube_io)
    .with_youtube_requirements(run.youtube_requirements)
    .with_pricing(&pricing)
    .with_capture_cancellation(run.capture_cancellation.clone())
    .with_extractor_update_session(run.extractor_updates.clone());
    match run_chat(
        run.prompt,
        run.history,
        run.active_skills.to_vec(),
        run.root,
        tag,
        run.retriever,
        &client,
        &skill_services,
        run.sink,
        run.guards,
    )
    .await
    {
        Ok(ledger) => Some(ledger),
        Err(e) => {
            run.sink.send(ChatEvent::Error {
                message: format!("Chat failed: {e}"),
            });
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neuralnote_core::ai::{
        read_provider_config, run_chat, write_provider_config, ChatEvent, Completion, EventSink,
        Guards, HardwareSpec, KeywordRetriever, LlmClient, LlmRequest, NoUserPrompt,
        ProviderConfig, ProviderKind, ReasoningSupport, SkillEnvironment, SkillLookupError,
        SkillRegistry, SkillServices, ToolCall, FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
    };
    use neuralnote_core::CoreResult;
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn curated_model_boundary_accepts_only_catalogue_tags_and_repositories() {
        let candidate = neuralnote_core::ai::curated_candidates()
            .into_iter()
            .next()
            .expect("the curated catalogue is non-empty");

        assert!(ensure_curated_model_tag(&candidate.tag).is_ok());
        assert!(ensure_curated_hf_repo(&candidate.hf_repo).is_ok());
        assert!(ensure_curated_model_tag("attacker/model:latest").is_err());
        assert!(ensure_curated_hf_repo("attacker/model").is_err());
    }

    #[test]
    fn build_skill_registry_enables_fixture_for_default_config() {
        let registry = build_skill_registry(&ProviderConfig::default()).unwrap();

        assert!(registry.lookup(FIXTURE_SKILL_ID).is_ok());
        assert!(registry.lookup(YOUTUBE_DISTIL_SKILL_ID).is_ok());
    }

    #[test]
    fn build_skill_registry_disables_fixture_when_explicitly_configured() {
        let config = ProviderConfig {
            disabled_skills: vec![FIXTURE_SKILL_ID.into()],
            ..Default::default()
        };
        let registry = build_skill_registry(&config).unwrap();

        assert!(matches!(
            registry.lookup(FIXTURE_SKILL_ID),
            Err(SkillLookupError::Disabled(id)) if id == FIXTURE_SKILL_ID
        ));
    }

    #[test]
    fn skill_registry_error_maps_registry_build_failures_to_io_not_conflict() {
        let error = skill_registry_error(SkillLookupError::Duplicate("duplicate".into()));

        assert!(matches!(&error, CoreError::Io(_)));
        assert!(!matches!(&error, CoreError::Conflict(_)));
    }

    #[test]
    fn set_skill_enabled_rejects_unknown_id_before_reading_corrupt_config() {
        let dir = tempfile::tempdir().unwrap();
        let unknown_id = "unknown-skill";
        std::fs::write(dir.path().join("ai-config.json"), "{not json").unwrap();

        let error = set_built_in_skill_enabled_in(dir.path(), unknown_id, false).unwrap_err();

        assert!(matches!(
            error,
            CoreError::InvalidName(message) if message.contains(unknown_id)
        ));
    }

    #[test]
    fn set_skill_enabled_persists_enable_disable_enable_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let registry = SkillRegistry::built_in(&[]).unwrap();

        // A missing config starts with every built-in skill enabled.
        assert!(set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, true).unwrap());
        assert!(read_provider_config(dir.path())
            .unwrap()
            .disabled_skills
            .is_empty());

        assert!(!set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, false).unwrap());
        assert_eq!(
            read_provider_config(dir.path()).unwrap().disabled_skills,
            [FIXTURE_SKILL_ID]
        );

        assert!(set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, true).unwrap());
        assert!(read_provider_config(dir.path())
            .unwrap()
            .disabled_skills
            .is_empty());
    }

    #[test]
    fn set_skill_enabled_double_disable_keeps_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let registry = SkillRegistry::built_in(&[]).unwrap();

        assert!(!set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, false).unwrap());
        assert!(!set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, false).unwrap());

        assert_eq!(
            read_provider_config(dir.path()).unwrap().disabled_skills,
            [FIXTURE_SKILL_ID]
        );
    }

    #[test]
    fn set_skill_enabled_deduplicates_existing_disabled_entries() {
        let dir = tempfile::tempdir().unwrap();
        let registry = SkillRegistry::built_in(&[]).unwrap();
        let config = ProviderConfig {
            disabled_skills: vec![FIXTURE_SKILL_ID.into(), FIXTURE_SKILL_ID.into()],
            ..Default::default()
        };
        write_provider_config(dir.path(), &config).unwrap();

        assert!(!set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, false).unwrap());

        assert_eq!(
            read_provider_config(dir.path()).unwrap().disabled_skills,
            [FIXTURE_SKILL_ID]
        );
    }

    #[test]
    fn set_skill_enabled_round_trips_config_without_disabled_skills_field() {
        let dir = tempfile::tempdir().unwrap();
        let registry = SkillRegistry::built_in(&[]).unwrap();
        std::fs::write(
            dir.path().join("ai-config.json"),
            r#"{"model":"legacy/model","keyConfigured":true}"#,
        )
        .unwrap();

        assert!(set_skill_enabled_in(dir.path(), &registry, FIXTURE_SKILL_ID, true).unwrap());

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.model, "legacy/model");
        assert!(persisted.key_configured);
        // Legacy configs without the field pick up the compiled-in enabled default.
        assert!(persisted.disabled_skills.is_empty());
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("ai-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["disabledSkills"], serde_json::json!([]));
    }

    #[test]
    fn persist_reasoning_verdict_preserves_a_concurrent_write() {
        // Reproduces the probe-window race: refresh_reasoning_support reads config,
        // then awaits a multi-second probe (OpenRouter ~8s, an Ollama cold-start ~30s).
        // During that await a concurrent writer — set_reasoning here, plus a model
        // switch — persists new values. Persisting the verdict must NOT revert them:
        // only the two capability fields are ours to write.
        let dir = tempfile::tempdir().unwrap();
        let concurrent = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "user/switched-to-this".into(),
            key_configured: true,
            reasoning: false, // the user toggled reasoning OFF mid-probe
            ..Default::default()
        };
        write_provider_config(dir.path(), &concurrent).unwrap();

        // The fix drops the pre-await snapshot from the write path entirely: the verdict
        // is persisted by re-reading the CURRENT config, so the concurrent write survives.
        let status =
            persist_reasoning_verdict(dir.path(), ReasoningSupport::Supported, "old/model".into())
                .unwrap();

        let persisted = read_provider_config(dir.path()).unwrap();
        // The two capability fields are updated…
        assert_eq!(
            persisted.reasoning_support,
            Some(ReasoningSupport::Supported)
        );
        assert_eq!(
            persisted.reasoning_probed_model.as_deref(),
            Some("old/model")
        );
        // …but every other field reflects the concurrent write, not the stale snapshot.
        assert!(
            !persisted.reasoning,
            "a concurrent opt-out must survive the probe"
        );
        assert_eq!(persisted.model, "user/switched-to-this");
        assert!(!status.openrouter.reasoning);
        assert_eq!(status.openrouter.model, "user/switched-to-this");
    }

    #[test]
    fn ai_status_surfaces_reasoning_flag_on_openrouter() {
        // The opt-in must reach the UI on the OpenRouter status specifically — the one
        // place a reasoning toggle is meaningful. A wrong source (hardcode, or the
        // local/key field) would be caught here.
        let on = build_ai_status(ProviderConfig {
            key_configured: true,
            reasoning: true,
            ..Default::default()
        });
        assert!(on.openrouter.reasoning);

        let off = build_ai_status(ProviderConfig {
            key_configured: true,
            reasoning: false,
            ..Default::default()
        });
        assert!(!off.openrouter.reasoning);
    }

    #[test]
    fn ai_status_validates_reasoning_cache_against_selected_model() {
        let valid = build_ai_status(ProviderConfig {
            model: "openai/gpt-4.1".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Supported),
            reasoning_probed_model: Some("openai/gpt-4.1".into()),
            ..Default::default()
        });
        assert_eq!(valid.reasoning_supported, ReasoningSupport::Supported);

        let stale = build_ai_status(ProviderConfig {
            model: "new/model".into(),
            key_configured: true,
            reasoning_support: Some(ReasoningSupport::Unsupported),
            reasoning_probed_model: Some("old/model".into()),
            ..Default::default()
        });
        assert_eq!(stale.reasoning_supported, ReasoningSupport::Unknown);
    }

    #[tokio::test]
    async fn chat_run_future_stops_when_its_lifecycle_closes() {
        let signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        let closer = std::sync::Arc::clone(&signal);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            closer.close();
        });

        assert_eq!(
            await_run_or_close(std::future::pending::<u8>(), &signal).await,
            None
        );
    }

    #[tokio::test]
    async fn chat_lifecycle_closure_cancels_capture_work() {
        let signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        let cancellation = neuralnote_core::ai::CaptureCancellation::default();
        let _guard =
            CaptureCancellationGuard::new(std::sync::Arc::clone(&signal), cancellation.clone());

        signal.close();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !cancellation.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn completed_chat_result_wins_a_simultaneous_close() {
        let signal = ai::ChatRunCloseSignal::default();
        signal.close();

        assert_eq!(await_run_or_close(async { 42 }, &signal).await, Some(42));
    }

    struct CloseAfterWriteLlm {
        calls: AtomicUsize,
        close_signal: std::sync::Arc<ai::ChatRunCloseSignal>,
    }

    #[async_trait::async_trait]
    impl LlmClient for CloseAfterWriteLlm {
        async fn complete(&self, _request: &LlmRequest) -> CoreResult<Completion> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(Completion {
                    content: None,
                    tool_calls: vec![ToolCall {
                        id: "write".into(),
                        name: "write_note".into(),
                        arguments: r#"{"rel_path":"Kept.md","content":"committed","kind":"literature","work_item":0}"#.into(),
                    }],
                });
            }
            self.close_signal.close();
            std::future::pending().await
        }

        async fn complete_streaming(
            &self,
            _request: &LlmRequest,
            _sink: &mut dyn EventSink,
        ) -> CoreResult<String> {
            std::future::pending().await
        }
    }

    #[derive(Default)]
    struct DiscardEvents;

    impl EventSink for DiscardEvents {
        fn send(&mut self, _event: ChatEvent) {}
    }

    #[tokio::test]
    async fn lifecycle_cancellation_returns_undo_for_an_already_committed_write() {
        let vault = tempfile::tempdir().unwrap();
        let close_signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        let inner = CloseAfterWriteLlm {
            calls: AtomicUsize::new(0),
            close_signal: std::sync::Arc::clone(&close_signal),
        };
        let llm = RunLlmClient::new(&inner, &close_signal);
        let registry = SkillRegistry::built_in(&[]).unwrap();
        let environment = SkillEnvironment {
            hardware: HardwareSpec {
                total_ram_bytes: 16_000_000_000,
                cpu_cores: 8,
                cpu_brand: "test".into(),
                gpu_label: None,
                arch: "aarch64".into(),
                os: "macos".into(),
                free_disk_bytes: 10_000_000_000,
            },
            app_data_bin_dir: vault.path().join("bin"),
            available_binaries: BTreeSet::new(),
        };
        let note_writer = skills::RunNoteWriteBackend::new(std::sync::Arc::clone(&close_signal));
        let services = SkillServices::new(&registry, &environment, &NoUserPrompt, &note_writer, 1);
        let retriever = KeywordRetriever::new(vault.path());
        let mut sink = DiscardEvents;

        let ledger = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            run_chat(
                "write the note",
                &[],
                vec![FIXTURE_SKILL_ID.into()],
                vault.path(),
                "test-model",
                &retriever,
                &llm,
                &services,
                &mut sink,
                &Guards::default(),
            ),
        )
        .await
        .expect("cancellation-aware LLM must unwind rather than hang")
        .unwrap();

        assert_eq!(ledger.entries().len(), 1);
        assert_eq!(
            std::fs::read_to_string(vault.path().join("Kept.md")).unwrap(),
            "committed"
        );
    }
}
