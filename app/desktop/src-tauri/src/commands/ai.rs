//! AI + provider command surface: OpenRouter key management, provider selection,
//! provider-aware status, cited chat, and bundled-local-model pull / delete /
//! activate.
//!
//! The OS/transport plumbing (keychain, HTTP client, sidecar) lives in `crate::ai`
//! and `crate::local`; this module is the Tauri command layer over them. The shared
//! app state and the command registry live in `crate` (`lib.rs`).

use std::path::{Path, PathBuf};

use neuralnote_core::{
    ai::{ProviderKind, ReasoningProbeTarget, ReasoningSupport},
    CoreError,
};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::{
    ai, config_dir, local, lock_state, openrouter_catalogue,
    provider_config_mutation::ProviderConfigMutationGate, requirement_detection, skills,
    SharedState,
};

fn provider_config_mutation_gate(state: &SharedState<'_>) -> ProviderConfigMutationGate {
    provider_config_mutation_gate_from(&lock_state(state))
}

fn provider_config_mutation_gate_from(app_state: &crate::AppState) -> ProviderConfigMutationGate {
    app_state.provider_config_mutations.clone()
}

fn openrouter_selection_context(
    app_state: &crate::AppState,
) -> (
    std::collections::HashSet<String>,
    ProviderConfigMutationGate,
) {
    (
        app_state.openrouter_catalogue.offered_models(),
        provider_config_mutation_gate_from(app_state),
    )
}

#[tauri::command]
pub(crate) fn api_key_status(app: AppHandle) -> Result<ai::ApiKeyStatus, CoreError> {
    ai::api_key_status(&config_dir(&app)?)
}

#[tauri::command]
pub(crate) fn save_api_key(
    app: AppHandle,
    state: SharedState<'_>,
    key: String,
    model: String,
) -> Result<(), CoreError> {
    let model = model.trim();
    let model = if model.is_empty() {
        neuralnote_core::ai::DEFAULT_MODEL
    } else {
        model
    };
    let dir = config_dir(&app)?;
    save_api_key_in(
        &dir,
        &provider_config_mutation_gate(&state),
        key.trim(),
        model,
    )
}

/// Save an OpenRouter key: write the secret to the keychain FIRST, outside the
/// config-mutation gate, then persist the non-secret model preference under the gate.
/// The gate lock therefore never spans keychain I/O (issue #21 AC #2).
///
/// Failure ordering (pre-existing, preserved — only the lock boundary moved): an
/// empty key is rejected before anything is written. If the keychain write fails, the
/// config is never touched. If the config write fails *after* the keychain write
/// committed, the key stays in the keychain and the in-session cache while the failure
/// is surfaced — a half-applied save is reported, never silent. Key-configured state
/// is no longer persisted at all: it is derived from keychain presence (issue #14), so
/// this crash window can no longer make the UI or routing disagree with the real
/// secret state. The only config change here is the non-secret model preference.
///
/// The reasoning-probe invalidation is driven by the key transition absent → present:
/// after a save the effective OpenRouter target exists, so any stale verdict is
/// dropped. `false` for the "before" side is fail-safe — it can only over-invalidate
/// (a harmless re-probe), never keep a stale verdict — and needs no keychain read.
pub(crate) fn save_api_key_in(
    config_dir: &Path,
    mutation_gate: &ProviderConfigMutationGate,
    key: &str,
    model: &str,
) -> Result<(), CoreError> {
    ai::set_keychain_api_key(key)?;
    mutation_gate
        .update_with_key_transition(config_dir, false, true, |cfg| {
            cfg.model = model.to_string();
            Ok(())
        })
        .map(|_| ())
        .map_err(|e| {
            CoreError::Io(format!(
                "API key was stored in the keychain, but the AI preference file could not be updated: {}",
                ai::error_detail(e)
            ))
        })
}

#[tauri::command]
pub(crate) fn clear_api_key(app: AppHandle, state: SharedState<'_>) -> Result<(), CoreError> {
    let dir = config_dir(&app)?;
    clear_api_key_in(&dir, &provider_config_mutation_gate(&state))
}

/// Clear the OpenRouter key: delete the secret from the keychain FIRST, outside the
/// config-mutation gate, then persist the reasoning-probe invalidation under the gate
/// — so the lock never spans keychain I/O (issue #21 AC #2). Key-configured state is
/// derived from keychain presence (issue #14), so there is no persisted flag to clear;
/// the only config effect is dropping the now-stale reasoning verdict via the key
/// transition present → absent. If the config write fails after the keychain delete
/// succeeded, the failure is surfaced and a corrupt config is left untouched rather
/// than clobbered to a default. `true` for the "before" side is fail-safe — it can
/// only over-invalidate — and needs no keychain read.
pub(crate) fn clear_api_key_in(
    config_dir: &Path,
    mutation_gate: &ProviderConfigMutationGate,
) -> Result<(), CoreError> {
    ai::clear_keychain_api_key()?;
    mutation_gate
        .update_with_key_transition(config_dir, true, false, |_cfg| Ok(()))
        .map(|_| ())
        .map_err(|e| {
            CoreError::Io(format!(
                "The keychain was cleared, but the AI preference file could not be updated: {}",
                ai::error_detail(e)
            ))
        })
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
    let cfg = neuralnote_core::ai::read_provider_config(&config_dir(&app)?)?;
    Ok(build_ai_status(cfg, ai::read_api_key()?.is_some()))
}

/// Return today's validated OpenRouter model choices. A successful result,
/// including an empty list, is cached for the completed UTC day. `force_refresh`
/// bypasses that cache but never discards it when the replacement request fails.
#[tauri::command]
pub(crate) async fn openrouter_model_menu(
    app: AppHandle,
    state: SharedState<'_>,
    force_refresh: bool,
) -> Result<openrouter_catalogue::OpenRouterModelMenu, CoreError> {
    let dir = config_dir(&app)?;
    let config = neuralnote_core::ai::read_provider_config(&dir)?;
    let selected_model = config.model;
    let day = neuralnote_core::ai::latest_completed_utc_day(chrono::Utc::now());

    if !force_refresh {
        let mut app_state = lock_state(&state);
        if app_state
            .openrouter_catalogue
            .cached_for(day, false)
            .is_some()
        {
            return app_state
                .openrouter_catalogue
                .offer_for(day, &selected_model);
        }
    }

    let api_key = ai::read_api_key()?.ok_or_else(|| {
        CoreError::Llm("Set an OpenRouter API key before loading model choices.".into())
    })?;
    let transport = openrouter_catalogue::ReqwestCatalogueTransport::new()?;
    let ranked =
        openrouter_catalogue::fetch_validated_catalogue(&transport, &day.to_string(), &api_key)
            .await?;
    let selected_model = neuralnote_core::ai::read_provider_config(&dir)?.model;

    // The AppState guard is acquired only after both network requests and core
    // validation complete. No shared-state lock crosses an await boundary.
    let mut app_state = lock_state(&state);
    app_state.openrouter_catalogue.remember(day, ranked);
    app_state
        .openrouter_catalogue
        .offer_for(day, &selected_model)
}

/// Persist only the model selected from the exact validated list last offered
/// to this app session, then return the freshly-read status. The API key never
/// crosses IPC and every other AI preference remains unchanged.
#[tauri::command]
pub(crate) fn select_openrouter_model(
    app: AppHandle,
    state: SharedState<'_>,
    model: String,
) -> Result<AiStatus, CoreError> {
    let (offered, mutation_gate) = {
        let app_state = lock_state(&state);
        openrouter_selection_context(&app_state)
    };
    let key_present = ai::read_api_key()?.is_some();
    let config = openrouter_catalogue::persist_selected_model(
        &config_dir(&app)?,
        &mutation_gate,
        key_present,
        &offered,
        &model,
    )?;
    Ok(build_ai_status(config, key_present))
}

/// Open OpenRouter's rankings attribution page. The target is compiled into
/// Rust; the webview cannot supply or redirect this privileged URL.
#[tauri::command]
#[allow(deprecated)]
pub(crate) fn open_openrouter_rankings(app: AppHandle) -> Result<(), CoreError> {
    use tauri_plugin_shell::ShellExt as _;

    app.shell()
        .open(
            openrouter_catalogue::OPENROUTER_RANKINGS_ATTRIBUTION_URL,
            None,
        )
        .map_err(|_| CoreError::Io("Could not open the OpenRouter rankings page.".into()))
}

/// Map the persisted config onto the provider-aware status DTO. Split from the
/// command (which owns only the config read) so the config → status mapping — notably
/// that `reasoning` surfaces on the OpenRouter status — is unit-testable without an
/// `AppHandle`.
fn build_ai_status(cfg: neuralnote_core::ai::ProviderConfig, key_present: bool) -> AiStatus {
    let reasoning_supported = cfg.cached_reasoning_support(key_present);
    AiStatus {
        active_provider: cfg.effective_provider(key_present),
        reasoning_supported,
        openrouter: OpenRouterStatus {
            has_key: key_present,
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
    state: SharedState<'_>,
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
    let key_present = ai::read_api_key()?.is_some();
    provider_config_mutation_gate(&state)
        .update(&dir, key_present, move |cfg| {
            cfg.active_provider = Some(provider);
            if let Some(tag) = local_model_tag {
                cfg.local_model_tag = Some(tag);
            }
            Ok(())
        })
        .map(|_| ())
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
pub(crate) fn set_reasoning(
    app: AppHandle,
    state: SharedState<'_>,
    enabled: bool,
) -> Result<AiStatus, CoreError> {
    let dir = config_dir(&app)?;
    let key_present = ai::read_api_key()?.is_some();
    set_reasoning_in(
        &dir,
        &provider_config_mutation_gate(&state),
        key_present,
        enabled,
    )
}

fn set_reasoning_in(
    config_dir: &Path,
    mutation_gate: &ProviderConfigMutationGate,
    key_present: bool,
    enabled: bool,
) -> Result<AiStatus, CoreError> {
    let cfg = mutation_gate.update(config_dir, key_present, |cfg| {
        cfg.reasoning = enabled;
        Ok(())
    })?;
    Ok(build_ai_status(cfg, key_present))
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
    let mutation_gate = provider_config_mutation_gate(&state);
    let key_present = ai::read_api_key()?.is_some();
    let (cfg, target) = begin_reasoning_probe(&dir, &mutation_gate, key_present)?;

    match target {
        Some(target) => {
            let support = probed_verdict(&app, &state, &target).await;
            persist_reasoning_verdict(&dir, &mutation_gate, key_present, support, target)
        }
        None => Ok(build_ai_status(cfg, key_present)),
    }
}

/// Allocate and persist probe ownership while holding the cross-process config
/// gate. The returned guard is plain data; no lock survives into provider I/O.
fn begin_reasoning_probe(
    dir: &Path,
    mutation_gate: &ProviderConfigMutationGate,
    key_present: bool,
) -> Result<
    (
        neuralnote_core::ai::ProviderConfig,
        Option<ReasoningProbeTarget>,
    ),
    CoreError,
> {
    mutation_gate.run(dir, || {
        let mut cfg = neuralnote_core::ai::read_provider_config(dir)?;
        let target = cfg.start_reasoning_probe(key_present)?;
        if target.is_some() {
            neuralnote_core::ai::write_provider_config(dir, &cfg)?;
        }
        Ok((cfg, target))
    })
}

/// Persist a freshly-probed reasoning verdict only while its provider/model target
/// is still selected. The probe can run for seconds (OpenRouter ~8s, an Ollama
/// cold-start ~30s); during it another process may select and probe a newer target.
/// Re-read under the cross-process mutation gate and leave that newer verdict intact.
fn persist_reasoning_verdict(
    dir: &Path,
    mutation_gate: &ProviderConfigMutationGate,
    key_present: bool,
    support: ReasoningSupport,
    target: ReasoningProbeTarget,
) -> Result<AiStatus, CoreError> {
    mutation_gate.run(dir, || {
        let mut cfg = neuralnote_core::ai::read_provider_config(dir)?;
        if cfg.apply_reasoning_probe(key_present, &target, support) {
            neuralnote_core::ai::write_provider_config(dir, &cfg)?;
        }
        Ok(build_ai_status(cfg, key_present))
    })
}

async fn probed_verdict(
    app: &AppHandle,
    state: &SharedState<'_>,
    target: &ReasoningProbeTarget,
) -> ReasoningSupport {
    match target.provider {
        ProviderKind::OpenRouter => ai::probe_openrouter_reasoning(&target.model).await,
        ProviderKind::Local => match local::ensure_ollama_started(app, state).await {
            Ok(port) => local::probe_ollama_reasoning(port, &target.model).await,
            Err(e) => {
                log::warn!(
                    "reasoning probe: local sidecar unavailable: {}",
                    ai::error_detail(e)
                );
                ReasoningSupport::Unknown
            }
        },
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

    // The exact destination volume and this model's expected size, threaded into the
    // pull's disk preflight. The tag is curated (checked above), so the size is
    // normally known; an unexpected lookup miss surfaces as `None` (unknown size),
    // which the preflight handles honestly rather than assuming zero.
    let models_dir = match local::ollama_models_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            sink.send(PullEvent::Error {
                message: ai::error_detail(e),
            });
            return Ok(());
        }
    };
    let expected_bytes = neuralnote_core::ai::curated_candidates()
        .into_iter()
        .find(|candidate| candidate.tag == tag)
        .map(|candidate| candidate.download_bytes);

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

    match local::pull_local_model(port, &tag, &models_dir, expected_bytes, &mut sink, &cancel).await
    {
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
    state: SharedState<'_>,
    id: String,
    enabled: bool,
) -> Result<bool, CoreError> {
    let dir = config_dir(&app)?;
    provider_config_mutation_gate(&state)
        .run(&dir, || set_built_in_skill_enabled_in(&dir, &id, enabled))
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
    turn_id: String,
    prompt: String,
    history: Vec<ai::ChatTurn>,
    active_skills: Vec<String>,
    on_event: tauri::ipc::Channel<neuralnote_core::ai::ChatEvent>,
) -> Result<String, ()> {
    use neuralnote_core::ai::{
        read_provider_config, ChatEvent, EventSink, Guards, KeywordRetriever, LlmMessage,
        ProviderKind,
    };

    let close_signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
    let mut sink =
        ai::TauriChannelSink::with_close_signal(on_event, std::sync::Arc::clone(&close_signal));
    let turn_id = match parse_chat_turn_id(&turn_id) {
        Ok(turn_id) => turn_id,
        Err(error) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't start chat: {error}"),
            });
            return Ok(turn_id);
        }
    };
    let run_id = turn_id.to_string();
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
        turn_id,
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
    // Key presence (the keychain — the authoritative source, issue #14) resolves the
    // effective OpenRouter provider for a legacy install with no explicit choice. A
    // keychain failure here is surfaced, never silently routed as "no provider".
    let key_present = match ai::read_api_key() {
        Ok(key) => key.is_some(),
        Err(e) => {
            sink.send(ChatEvent::Error {
                message: format!("Couldn't read the API key: {e}"),
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
    let cancellation_observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut causal_sink = CausalRunEventSink::new(
        &mut sink,
        std::sync::Arc::clone(&close_signal),
        std::sync::Arc::clone(&cancellation_observed),
    );
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
        sink: &mut causal_sink,
        close_signal: &close_signal,
        cancellation_observed,
    };
    let ledger = match cfg.effective_provider(key_present) {
        None => {
            run.sink.send(ChatEvent::Error {
                message: "No AI provider is set up yet. Choose one in Settings.".into(),
            });
            None
        }
        Some(ProviderKind::OpenRouter) => {
            let effective = neuralnote_core::ai::effective_reasoning(
                cfg.reasoning,
                cfg.cached_reasoning_support(key_present),
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
pub(crate) fn cancel_chat_run(
    state: SharedState<'_>,
    turn_id: String,
) -> Result<skills::CancelChatRunOutcome, CoreError> {
    let turn_id = parse_chat_turn_id(&turn_id)?;
    let pending = std::sync::Arc::clone(&crate::lock_state(&state).pending_elicitations);
    Ok(pending.cancel_run(turn_id))
}

fn parse_chat_turn_id(value: &str) -> Result<uuid::Uuid, CoreError> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| CoreError::InvalidName("chat turn id must be a UUID".into()))?;
    if parsed.to_string() != value {
        return Err(CoreError::InvalidName(
            "chat turn id must use canonical lowercase hyphenated UUID form".into(),
        ));
    }
    Ok(parsed)
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
    cancellation_observed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Suppress only the core terminal error caused by the matching run's typed user
/// stop. Partial answer events pass through unchanged, and provider/lifecycle
/// failures never set `cancellation_observed`, so they retain normal error UI.
struct CausalRunEventSink<'a> {
    inner: &'a mut dyn neuralnote_core::ai::EventSink,
    close_signal: std::sync::Arc<ai::ChatRunCloseSignal>,
    cancellation_observed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl<'a> CausalRunEventSink<'a> {
    fn new(
        inner: &'a mut dyn neuralnote_core::ai::EventSink,
        close_signal: std::sync::Arc<ai::ChatRunCloseSignal>,
        cancellation_observed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self {
            inner,
            close_signal,
            cancellation_observed,
        }
    }
}

impl neuralnote_core::ai::EventSink for CausalRunEventSink<'_> {
    fn send(&mut self, event: neuralnote_core::ai::ChatEvent) {
        let is_causal_user_stop = matches!(event, neuralnote_core::ai::ChatEvent::Error { .. })
            && self.close_signal.reason() == Some(ai::ChatRunCloseReason::UserStop)
            && self
                .cancellation_observed
                .swap(false, std::sync::atomic::Ordering::SeqCst);
        if !is_causal_user_stop {
            self.inner.send(event);
        }
    }
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
        cancellation_observed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Self {
            inner,
            close_signal,
            cancellation_observed,
        }
    }

    fn closed_error(&self) -> CoreError {
        match self.close_signal.reason() {
            Some(ai::ChatRunCloseReason::UserStop) => {
                self.cancellation_observed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                CoreError::Conflict("chat run stopped by the user".into())
            }
            Some(ai::ChatRunCloseReason::Lifecycle) | None => {
                CoreError::Conflict("chat run ended because its vault or window closed".into())
            }
        }
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
            .ok_or_else(|| self.closed_error())?
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
        .ok_or_else(|| self.closed_error())?
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
    sink: &'a mut dyn neuralnote_core::ai::EventSink,
    close_signal: &'a ai::ChatRunCloseSignal,
    cancellation_observed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn stop_if_chat_run_closed(run: &mut ChatRun<'_>) -> bool {
    if !run.close_signal.is_closed() {
        return false;
    }
    if run.close_signal.reason() == Some(ai::ChatRunCloseReason::Lifecycle) {
        neuralnote_core::ai::EventSink::send(
            run.sink,
            neuralnote_core::ai::ChatEvent::Error {
                message: "Chat ended because its vault or window closed.".into(),
            },
        );
    }
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
    use neuralnote_core::ai::{run_chat, ChatEvent, SkillServices};

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
    let client = RunLlmClient::new(
        &transport,
        run.close_signal,
        std::sync::Arc::clone(&run.cancellation_observed),
    );
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
    use neuralnote_core::ai::{run_chat, ChatEvent, SkillServices};

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
    let client = RunLlmClient::new(
        &transport,
        run.close_signal,
        std::sync::Arc::clone(&run.cancellation_observed),
    );
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
    use crate::provider_config_mutation::ProviderConfigMutationGate;
    use neuralnote_core::ai::{
        read_provider_config, run_chat, write_provider_config, ChatEvent, Completion, EventSink,
        Guards, HardwareSpec, KeywordRetriever, LlmClient, LlmRequest, NoUserPrompt,
        ProbedReasoning, ProviderConfig, ProviderKind, ReasoningProbeTarget, ReasoningSupport,
        SkillEnvironment, SkillLookupError, SkillRegistry, SkillServices, ToolCall,
        FIXTURE_SKILL_ID, YOUTUBE_DISTIL_SKILL_ID,
    };
    use neuralnote_core::CoreResult;
    use std::collections::BTreeSet;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};

    /// A paired reasoning verdict for building test configs.
    fn probed(model: &str, support: ReasoningSupport) -> Option<ProbedReasoning> {
        Some(ProbedReasoning {
            model: model.into(),
            support,
        })
    }

    const STALE_PROBE_CHILD_DIR: &str = "NEURALNOTE_STALE_PROBE_CHILD_DIR";
    const MATCHING_PROBE_CHILD_DIR: &str = "NEURALNOTE_MATCHING_PROBE_CHILD_DIR";
    const SAME_TARGET_PROBE_CHILD_DIR: &str = "NEURALNOTE_SAME_TARGET_PROBE_CHILD_DIR";

    /// Drive two overlapping `ai-config.json` writers through the shared gate,
    /// forcing the second into the gate *while the first still holds its snapshot*,
    /// then releasing the first. Barriers replace every timing/scheduler assumption,
    /// so the interleave is deterministic rather than flaky: the second command
    /// provably runs in the exact stale-snapshot window that would lose an update
    /// without serialization. `first` mutates the config the first writer holds;
    /// `second` is any real gated operation (it must take this same gate so its
    /// entry barrier fires). The caller asserts both fields survived.
    fn overlapping_gated_writers(
        dir: &Path,
        first: impl FnOnce(&mut ProviderConfig) + Send,
        second: impl FnOnce(&Path, &ProviderConfigMutationGate) -> CoreResult<()> + Send,
    ) {
        let gate = ProviderConfigMutationGate::default();
        let first_loaded = Arc::new(Barrier::new(2));
        let release_first = Arc::new(Barrier::new(2));
        let second_entering_gate = Arc::new(Barrier::new(2));

        std::thread::scope(|scope| {
            let first_loaded_for_thread = Arc::clone(&first_loaded);
            let release_first_for_thread = Arc::clone(&release_first);
            let first_gate = gate.clone();
            let first_dir = dir.to_path_buf();
            let first_handle = scope.spawn(move || {
                first_gate.update(&first_dir, false, |config| {
                    first(config);
                    first_loaded_for_thread.wait();
                    release_first_for_thread.wait();
                    Ok(())
                })
            });

            // The first writer has read its snapshot but cannot write it yet. Start
            // the real second command in that exact stale-snapshot window.
            first_loaded.wait();
            let second_gate = gate.clone_with_entry_barrier(Arc::clone(&second_entering_gate));
            let second_dir = dir.to_path_buf();
            let second_handle = scope.spawn(move || second(&second_dir, &second_gate));

            // The second command has reached the shared gate while the first
            // still owns it. Releasing the first now gives a deterministic
            // serialized ordering without timing or scheduler assumptions.
            second_entering_gate.wait();
            release_first.wait();
            first_handle.join().unwrap().unwrap();
            second_handle.join().unwrap().unwrap();
        });
    }

    fn concurrent_provider_updates_preserve_both_fields(reasoning_starts_first: bool) {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                model: "vendor/old".into(),
                reasoning: true,
                ..Default::default()
            },
        )
        .unwrap();
        let offered: std::collections::HashSet<String> =
            ["vendor/new".to_string()].into_iter().collect();

        overlapping_gated_writers(
            dir.path(),
            |config| {
                if reasoning_starts_first {
                    config.reasoning = false;
                } else {
                    config.model = "vendor/new".into();
                }
            },
            |second_dir, second_gate| {
                if reasoning_starts_first {
                    openrouter_catalogue::persist_selected_model(
                        second_dir,
                        second_gate,
                        false,
                        &offered,
                        "vendor/new",
                    )
                    .map(|_| ())
                } else {
                    set_reasoning_in(second_dir, second_gate, false, false).map(|_| ())
                }
            },
        );

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.model, "vendor/new");
        assert!(
            !persisted.reasoning,
            "a concurrent reasoning opt-out must not be restored from a stale model-selection snapshot"
        );
    }

    #[test]
    fn reasoning_off_then_model_selection_does_not_lose_either_update() {
        concurrent_provider_updates_preserve_both_fields(true);
    }

    #[test]
    fn model_selection_then_reasoning_off_does_not_lose_either_update() {
        concurrent_provider_updates_preserve_both_fields(false);
    }

    /// The hazard the gate exists to remove: two writers that each read the *same*
    /// snapshot and then write in turn. The later write restores the earlier
    /// writer's field from its stale copy — a lost update. This is deliberately
    /// *ungated* to prove the interleave the gated tests force is genuinely
    /// dangerous, so a green gated test is meaningful and not vacuously passing.
    #[test]
    fn ungated_read_modify_write_interleave_loses_a_concurrent_field() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                model: "vendor/old".into(),
                reasoning: true,
                ..Default::default()
            },
        )
        .unwrap();

        // Both writers snapshot the same starting config — the stale-read window.
        let mut first = read_provider_config(dir.path()).unwrap();
        let mut second = read_provider_config(dir.path()).unwrap();

        // First opts reasoning OFF and commits.
        first.reasoning = false;
        write_provider_config(dir.path(), &first).unwrap();
        // Second selects a new model from its stale snapshot and commits.
        second.model = "vendor/new".into();
        write_provider_config(dir.path(), &second).unwrap();

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.model, "vendor/new");
        assert!(
            persisted.reasoning,
            "without serialization the stale second write restores reasoning=true: the opt-out is lost"
        );
    }

    #[test]
    fn provider_switch_and_reasoning_opt_out_do_not_lose_either_update() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                reasoning: true,
                ..Default::default()
            },
        )
        .unwrap();

        // First: the user opts reasoning OFF. Second (overlapping): the user switches
        // the active provider to Local — the exact `set_active_provider` config write.
        overlapping_gated_writers(
            dir.path(),
            |config| config.reasoning = false,
            |second_dir, second_gate| {
                second_gate
                    .update(second_dir, false, |cfg| {
                        cfg.active_provider = Some(ProviderKind::Local);
                        cfg.local_model_tag = Some("vendor/local".into());
                        Ok(())
                    })
                    .map(|_| ())
            },
        );

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(
            persisted.active_provider,
            Some(ProviderKind::Local),
            "the concurrent provider switch must survive"
        );
        assert!(
            !persisted.reasoning,
            "the provider switch must not restore reasoning from a stale snapshot"
        );
    }

    #[test]
    fn skill_toggle_and_model_selection_do_not_lose_either_update() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                model: "vendor/old".into(),
                ..Default::default()
            },
        )
        .unwrap();

        // First: select a new model. Second (overlapping): disable a built-in skill —
        // the exact `set_skill_enabled` read-modify-write, run under the same gate.
        overlapping_gated_writers(
            dir.path(),
            |config| config.model = "vendor/new".into(),
            |second_dir, second_gate| {
                second_gate.run(second_dir, || {
                    set_built_in_skill_enabled_in(second_dir, FIXTURE_SKILL_ID, false).map(|_| ())
                })
            },
        );

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(
            persisted.model, "vendor/new",
            "the concurrent model selection must survive a skill toggle"
        );
        assert_eq!(
            persisted.disabled_skills,
            [FIXTURE_SKILL_ID],
            "the concurrent skill toggle must survive"
        );
    }

    #[test]
    fn model_write_and_reasoning_opt_out_do_not_lose_either_update() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                model: "vendor/old".into(),
                reasoning: true,
                ..Default::default()
            },
        )
        .unwrap();

        // First: the user opts reasoning OFF. Second (overlapping): a model write.
        // Neither gated read-modify-write may lose the other's field. (Key state is no
        // longer a config field — it lives in the keychain, issue #14 — so the save's
        // config half is modelled here by the model write it actually performs.)
        overlapping_gated_writers(
            dir.path(),
            |config| config.reasoning = false,
            |second_dir, second_gate| {
                second_gate
                    .update(second_dir, false, |cfg| {
                        cfg.model = "vendor/new".into();
                        Ok(())
                    })
                    .map(|_| ())
            },
        );

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(
            persisted.model, "vendor/new",
            "the concurrent model write must survive"
        );
        assert!(
            !persisted.reasoning,
            "the model write must not restore reasoning from a stale snapshot"
        );
    }

    #[test]
    fn provider_commands_clone_one_app_state_mutation_gate() {
        let app_state = crate::AppState::default();
        let reasoning_gate = provider_config_mutation_gate_from(&app_state);
        let (_, model_gate) = openrouter_selection_context(&app_state);

        assert!(reasoning_gate.shares_lock_with(&model_gate));
    }

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
        // The legacy `keyConfigured` field is ignored on read (issue #14); the model
        // preference beside it survives untouched.
        // Legacy configs without the field pick up the compiled-in enabled default.
        assert!(persisted.disabled_skills.is_empty());
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("ai-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["disabledSkills"], serde_json::json!([]));
    }

    #[test]
    fn persist_reasoning_verdict_ignores_an_old_model_after_a_newer_probe() {
        // Reproduces the probe-window race: refresh_reasoning_support reads config,
        // then awaits a multi-second probe (OpenRouter ~8s, an Ollama cold-start ~30s).
        // During that await the user disables reasoning, selects model B, and B's
        // own probe persists a verdict. The late A result has no fields left to own.
        let dir = tempfile::tempdir().unwrap();
        let concurrent = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "user/switched-to-this".into(),
            reasoning: false, // the user toggled reasoning OFF mid-probe
            reasoning_probe: probed("user/switched-to-this", ReasoningSupport::Unsupported),
            ..Default::default()
        };
        write_provider_config(dir.path(), &concurrent).unwrap();

        // Persistence re-reads under the mutation gate and rejects the obsolete target.
        let status = persist_reasoning_verdict(
            dir.path(),
            &ProviderConfigMutationGate::default(),
            true,
            ReasoningSupport::Supported,
            ReasoningProbeTarget {
                provider: ProviderKind::OpenRouter,
                model: "old/model".into(),
                generation: 0,
            },
        )
        .unwrap();

        let persisted = read_provider_config(dir.path()).unwrap();
        // The obsolete A probe must not replace the newer B verdict.
        assert_eq!(
            persisted.reasoning_probe,
            probed("user/switched-to-this", ReasoningSupport::Unsupported)
        );
        assert!(
            !persisted.reasoning,
            "a concurrent opt-out must survive the probe"
        );
        assert_eq!(persisted.model, "user/switched-to-this");
        assert!(!status.openrouter.reasoning);
        assert_eq!(status.openrouter.model, "user/switched-to-this");
        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
    }

    #[test]
    fn persist_reasoning_verdict_requires_the_same_effective_provider() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::Local),
                model: "shared/model".into(),
                local_model_tag: Some("shared/model".into()),
                reasoning_probe: probed("shared/model", ReasoningSupport::Unsupported),
                ..Default::default()
            },
        )
        .unwrap();

        let status = persist_reasoning_verdict(
            dir.path(),
            &ProviderConfigMutationGate::default(),
            true,
            ReasoningSupport::Supported,
            ReasoningProbeTarget {
                provider: ProviderKind::OpenRouter,
                model: "shared/model".into(),
                generation: 0,
            },
        )
        .unwrap();

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.active_provider, Some(ProviderKind::Local));
        assert_eq!(
            persisted.reasoning_probe.as_ref().map(|p| p.support),
            Some(ReasoningSupport::Unsupported)
        );
        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
    }

    #[test]
    fn persist_reasoning_verdict_writes_for_the_matching_target() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/current".into(),
                reasoning_probe_generation: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let status = persist_reasoning_verdict(
            dir.path(),
            &ProviderConfigMutationGate::default(),
            true,
            ReasoningSupport::Supported,
            ReasoningProbeTarget {
                provider: ProviderKind::OpenRouter,
                model: "vendor/current".into(),
                generation: 1,
            },
        )
        .unwrap();

        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(
            persisted.reasoning_probe,
            probed("vendor/current", ReasoningSupport::Supported)
        );
        assert_eq!(status.reasoning_supported, ReasoningSupport::Supported);
    }

    fn run_probe_persistence_child(env_key: &str, config: ProviderConfig) -> bool {
        let Ok(directory) = std::env::var(env_key) else {
            return false;
        };
        let directory = std::path::PathBuf::from(directory);
        ProviderConfigMutationGate::default()
            .run(&directory, || {
                write_provider_config(&directory, &config)?;
                std::fs::write(directory.join("probe-child-ready"), b"ready").unwrap();
                while !directory.join("release-probe-child").exists() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(())
            })
            .unwrap();
        true
    }

    fn persist_probe_behind_separate_process(
        test_name: &str,
        env_key: &str,
        initial: ProviderConfig,
        support: ReasoningSupport,
        target: ReasoningProbeTarget,
    ) -> (AiStatus, ProviderConfig) {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(dir.path(), &initial).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(test_name)
            .arg("--nocapture")
            .env(env_key, dir.path())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.path().join("probe-child-ready").exists() {
            assert!(Instant::now() < deadline, "probe child never acquired lock");
            std::thread::sleep(Duration::from_millis(5));
        }

        let entering_gate = Arc::new(Barrier::new(2));
        let gate = ProviderConfigMutationGate::default()
            .clone_with_entry_barrier(Arc::clone(&entering_gate));
        let dir_path = dir.path().to_path_buf();
        let status = std::thread::spawn(move || {
            persist_reasoning_verdict(&dir_path, &gate, true, support, target)
        });
        entering_gate.wait();
        std::fs::write(dir.path().join("release-probe-child"), b"release").unwrap();

        let status = status.join().unwrap().unwrap();
        assert!(child.wait().unwrap().success());
        let persisted = read_provider_config(dir.path()).unwrap();
        (status, persisted)
    }

    #[test]
    fn separate_process_new_model_probe_wins_over_an_older_probe() {
        let newer = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/new".into(),
            reasoning_probe: probed("vendor/new", ReasoningSupport::Unsupported),
            reasoning_probe_generation: 2,
            ..Default::default()
        };
        if run_probe_persistence_child(STALE_PROBE_CHILD_DIR, newer.clone()) {
            return;
        }

        let (status, persisted) = persist_probe_behind_separate_process(
            "commands::ai::tests::separate_process_new_model_probe_wins_over_an_older_probe",
            STALE_PROBE_CHILD_DIR,
            ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/old".into(),
                ..Default::default()
            },
            ReasoningSupport::Supported,
            ReasoningProbeTarget {
                provider: ProviderKind::OpenRouter,
                model: "vendor/old".into(),
                generation: 1,
            },
        );

        assert_eq!(persisted, newer);
        assert_eq!(status.openrouter.model, "vendor/new");
        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
    }

    #[test]
    fn separate_process_matching_target_accepts_the_probe() {
        let current = ProviderConfig {
            active_provider: Some(ProviderKind::OpenRouter),
            model: "vendor/current".into(),
            reasoning_probe_generation: 1,
            ..Default::default()
        };
        if run_probe_persistence_child(MATCHING_PROBE_CHILD_DIR, current.clone()) {
            return;
        }

        let (status, persisted) = persist_probe_behind_separate_process(
            "commands::ai::tests::separate_process_matching_target_accepts_the_probe",
            MATCHING_PROBE_CHILD_DIR,
            current,
            ReasoningSupport::Supported,
            ReasoningProbeTarget {
                provider: ProviderKind::OpenRouter,
                model: "vendor/current".into(),
                generation: 1,
            },
        );

        assert_eq!(
            persisted.reasoning_probe,
            probed("vendor/current", ReasoningSupport::Supported)
        );
        assert_eq!(status.reasoning_supported, ReasoningSupport::Supported);
    }

    #[test]
    fn same_target_probe_completion_order_keeps_the_newer_verdict() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/current".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let gate = ProviderConfigMutationGate::default();
        let (_, older) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();
        let (_, newer) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();
        let older = older.unwrap();
        let newer = newer.unwrap();

        persist_reasoning_verdict(
            dir.path(),
            &gate,
            true,
            ReasoningSupport::Unsupported,
            newer,
        )
        .unwrap();
        let status =
            persist_reasoning_verdict(dir.path(), &gate, true, ReasoningSupport::Supported, older)
                .unwrap();

        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_probe
                .as_ref()
                .map(|p| p.support),
            Some(ReasoningSupport::Unsupported)
        );
    }

    #[test]
    fn aba_model_selection_does_not_revalidate_the_first_probe() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/a".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let gate = ProviderConfigMutationGate::default();
        let (_, old_a) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();
        gate.update(dir.path(), true, |cfg| {
            cfg.model = "vendor/b".into();
            Ok(())
        })
        .unwrap();
        let _ = begin_reasoning_probe(dir.path(), &gate, true).unwrap();
        gate.update(dir.path(), true, |cfg| {
            cfg.model = "vendor/a".into();
            Ok(())
        })
        .unwrap();
        let (_, new_a) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();

        persist_reasoning_verdict(
            dir.path(),
            &gate,
            true,
            ReasoningSupport::Unsupported,
            new_a.unwrap(),
        )
        .unwrap();
        let status = persist_reasoning_verdict(
            dir.path(),
            &gate,
            true,
            ReasoningSupport::Supported,
            old_a.unwrap(),
        )
        .unwrap();

        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
        assert_eq!(
            read_provider_config(dir.path())
                .unwrap()
                .reasoning_probe_generation,
            5
        );
    }

    #[test]
    fn aba_target_change_rejects_the_first_probe_before_a_replacement_is_allocated() {
        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/a".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let gate = ProviderConfigMutationGate::default();
        let (_, old_a) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();

        gate.update(dir.path(), true, |cfg| {
            cfg.model = "vendor/b".into();
            Ok(())
        })
        .unwrap();
        gate.update(dir.path(), true, |cfg| {
            cfg.model = "vendor/a".into();
            Ok(())
        })
        .unwrap();

        let status = persist_reasoning_verdict(
            dir.path(),
            &gate,
            true,
            ReasoningSupport::Supported,
            old_a.unwrap(),
        )
        .unwrap();

        assert_eq!(status.reasoning_supported, ReasoningSupport::Unknown);
        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.reasoning_probe_generation, 3);
        assert_eq!(persisted.reasoning_probe, None);
    }

    #[test]
    fn separate_process_newer_same_target_probe_wins() {
        if let Ok(directory) = std::env::var(SAME_TARGET_PROBE_CHILD_DIR) {
            let directory = std::path::PathBuf::from(directory);
            let gate = ProviderConfigMutationGate::default();
            let (_, target) = begin_reasoning_probe(&directory, &gate, true).unwrap();
            persist_reasoning_verdict(
                &directory,
                &gate,
                true,
                ReasoningSupport::Unsupported,
                target.unwrap(),
            )
            .unwrap();
            gate.run(&directory, || {
                std::fs::write(directory.join("probe-child-ready"), b"ready").unwrap();
                while !directory.join("release-probe-child").exists() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(())
            })
            .unwrap();
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        write_provider_config(
            dir.path(),
            &ProviderConfig {
                active_provider: Some(ProviderKind::OpenRouter),
                model: "vendor/current".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let gate = ProviderConfigMutationGate::default();
        let (_, older) = begin_reasoning_probe(dir.path(), &gate, true).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("commands::ai::tests::separate_process_newer_same_target_probe_wins")
            .arg("--nocapture")
            .env(SAME_TARGET_PROBE_CHILD_DIR, dir.path())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.path().join("probe-child-ready").exists() {
            assert!(Instant::now() < deadline, "probe child never acquired lock");
            std::thread::sleep(Duration::from_millis(5));
        }

        let entering_gate = Arc::new(Barrier::new(2));
        let stale_gate = ProviderConfigMutationGate::default()
            .clone_with_entry_barrier(Arc::clone(&entering_gate));
        let dir_path = dir.path().to_path_buf();
        let stale = std::thread::spawn(move || {
            persist_reasoning_verdict(
                &dir_path,
                &stale_gate,
                true,
                ReasoningSupport::Supported,
                older.unwrap(),
            )
        });
        entering_gate.wait();
        std::fs::write(dir.path().join("release-probe-child"), b"release").unwrap();

        let status = stale.join().unwrap().unwrap();
        assert!(child.wait().unwrap().success());
        let persisted = read_provider_config(dir.path()).unwrap();
        assert_eq!(persisted.reasoning_probe_generation, 2);
        assert_eq!(
            persisted.reasoning_probe.as_ref().map(|p| p.support),
            Some(ReasoningSupport::Unsupported)
        );
        assert_eq!(status.reasoning_supported, ReasoningSupport::Unsupported);
    }

    #[test]
    fn ai_status_surfaces_reasoning_flag_on_openrouter() {
        // The opt-in must reach the UI on the OpenRouter status specifically — the one
        // place a reasoning toggle is meaningful. A wrong source (hardcode, or the
        // local/key field) would be caught here.
        let on = build_ai_status(
            ProviderConfig {
                reasoning: true,
                ..Default::default()
            },
            true,
        );
        assert!(on.openrouter.reasoning);

        let off = build_ai_status(
            ProviderConfig {
                reasoning: false,
                ..Default::default()
            },
            true,
        );
        assert!(!off.openrouter.reasoning);
    }

    #[test]
    fn ai_status_validates_reasoning_cache_against_selected_model() {
        let valid = build_ai_status(
            ProviderConfig {
                model: "openai/gpt-4.1".into(),
                reasoning_probe: probed("openai/gpt-4.1", ReasoningSupport::Supported),
                ..Default::default()
            },
            true,
        );
        assert_eq!(valid.reasoning_supported, ReasoningSupport::Supported);

        let stale = build_ai_status(
            ProviderConfig {
                model: "new/model".into(),
                reasoning_probe: probed("old/model", ReasoningSupport::Unsupported),
                ..Default::default()
            },
            true,
        );
        assert_eq!(stale.reasoning_supported, ReasoningSupport::Unknown);
    }

    #[test]
    fn chat_turn_ids_require_canonical_lowercase_hyphenated_uuids() {
        let canonical = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21";
        assert_eq!(
            parse_chat_turn_id(canonical).unwrap().to_string(),
            canonical
        );

        for invalid in [
            "",
            "not-a-uuid",
            "018F5F6C-8D5F-7C64-B8E7-8F9F238D9E21",
            "018f5f6c8d5f7c64b8e78f9f238d9e21",
            " 018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21",
        ] {
            assert!(matches!(
                parse_chat_turn_id(invalid),
                Err(CoreError::InvalidName(_))
            ));
        }
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

    #[derive(Default)]
    struct RecordedEvents(Vec<ChatEvent>);

    impl EventSink for RecordedEvents {
        fn send(&mut self, event: ChatEvent) {
            self.0.push(event);
        }
    }

    #[test]
    fn causal_sink_suppresses_only_an_observed_user_stop_error() {
        let signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut events = RecordedEvents::default();
        {
            let mut sink = CausalRunEventSink::new(
                &mut events,
                std::sync::Arc::clone(&signal),
                std::sync::Arc::clone(&observed),
            );
            signal.stop_by_user();
            observed.store(true, Ordering::SeqCst);
            sink.send(ChatEvent::Answer {
                delta: "partial".into(),
            });
            sink.send(ChatEvent::Error {
                message: "typed cancellation reached core".into(),
            });
            sink.send(ChatEvent::Error {
                message: "later independent failure".into(),
            });
        }
        assert_eq!(
            events.0,
            vec![
                ChatEvent::Answer {
                    delta: "partial".into()
                },
                ChatEvent::Error {
                    message: "later independent failure".into()
                }
            ]
        );

        let signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut events = RecordedEvents::default();
        let mut sink = CausalRunEventSink::new(&mut events, signal, observed);
        sink.send(ChatEvent::Error {
            message: "provider failed".into(),
        });
        assert!(
            matches!(events.0.as_slice(), [ChatEvent::Error { message }] if message == "provider failed")
        );

        let signal = std::sync::Arc::new(ai::ChatRunCloseSignal::default());
        signal.close();
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut events = RecordedEvents::default();
        let mut sink = CausalRunEventSink::new(&mut events, signal, observed);
        sink.send(ChatEvent::Error {
            message: "vault closed".into(),
        });
        assert!(
            matches!(events.0.as_slice(), [ChatEvent::Error { message }] if message == "vault closed")
        );
    }

    struct PendingUntilDropped {
        started: std::sync::Arc<tokio::sync::Notify>,
        dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    struct DropObservation(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl Drop for DropObservation {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait::async_trait]
    impl LlmClient for PendingUntilDropped {
        async fn complete(&self, _request: &LlmRequest) -> CoreResult<Completion> {
            self.started.notify_one();
            let _observation = DropObservation(std::sync::Arc::clone(&self.dropped));
            std::future::pending().await
        }

        async fn complete_streaming(
            &self,
            _request: &LlmRequest,
            _sink: &mut dyn EventSink,
        ) -> CoreResult<String> {
            unreachable!("this probe exercises the non-streaming transport await")
        }
    }

    #[tokio::test]
    async fn deterministic_provider_is_interrupted_promptly_by_user_stop() {
        let signal = ai::ChatRunCloseSignal::default();
        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let provider = PendingUntilDropped {
            started: std::sync::Arc::clone(&started),
            dropped: std::sync::Arc::clone(&dropped),
        };
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let client = RunLlmClient::new(&provider, &signal, observed);
        let request = LlmRequest {
            model: "test".into(),
            messages: vec![],
            tools: vec![],
        };

        let run = client.complete(&request);
        let cancel = async {
            started.notified().await;
            let started_at = std::time::Instant::now();
            assert!(signal.stop_by_user());
            tokio::time::timeout(std::time::Duration::from_millis(100), async {
                while !dropped.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("provider must observe cancellation within 100 ms");
            started_at
        };

        let (result, started_at) = tokio::join!(run, cancel);
        assert!(result.is_err());
        assert!(started_at.elapsed() < std::time::Duration::from_secs(1));
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
        let llm = RunLlmClient::new(
            &inner,
            &close_signal,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
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
