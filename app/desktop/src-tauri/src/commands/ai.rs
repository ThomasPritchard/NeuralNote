//! AI + provider command surface: OpenRouter key management, provider selection,
//! provider-aware status, cited chat, and bundled-local-model pull / delete /
//! activate.
//!
//! The OS/transport plumbing (keychain, HTTP client, sidecar) lives in `crate::ai`
//! and `crate::local`; this module is the Tauri command layer over them. The shared
//! app state and the command registry live in `crate` (`lib.rs`).

use std::path::Path;

use neuralnote_core::{ai::ReasoningSupport, CoreError};
use tauri::AppHandle;
use ts_rs::TS;

use crate::{ai, config_dir, local, lock_state, root_of, SharedState};

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
// `save_api_key`. What remains is the sub-ms gap between each writer's own read and write:
// two writers landing in that window still lose one update. Acceptable while config writes
// are rare and user-driven (you can't realistically race yourself across two settings
// controls). Fix trigger: any writer that fires without direct user action (a background
// re-probe, a sync loop) — then serialize all writers behind one async mutex.

/// Persist a freshly-probed reasoning verdict without clobbering config that the
/// probe's multi-second window let another writer change. The probe can run for
/// seconds (OpenRouter ~8s, an Ollama cold-start ~30s); during it a concurrent
/// `set_reasoning` / `set_active_provider` / `save_api_key` may land. Re-read fresh
/// and overwrite ONLY the two capability fields, so those writes survive. Returns the
/// persisted status so the caller renders exactly what reached disk.
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
pub(crate) fn detect_hardware() -> neuralnote_core::ai::HardwareSpec {
    local::detect_hardware()
}

/// The curated, tool-calling-capable local-model catalogue — the source of truth
/// for what may be installed (protects cited chat's tool-calling). The UI enriches
/// each entry with live `hf_model_metadata`.
#[tauri::command]
pub(crate) fn local_candidates() -> Vec<neuralnote_core::ai::CandidateModel> {
    neuralnote_core::ai::curated_candidates()
}

/// Which curated model this machine should safely run, or an explicit
/// "unsupported" verdict for weak/unsupported hardware.
#[tauri::command]
pub(crate) fn recommend_local_model() -> neuralnote_core::ai::Recommendation {
    neuralnote_core::ai::recommend_model(
        &local::detect_hardware(),
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
    let port = local::ensure_ollama_started(&app, &state).await?;
    local::delete_local_model(port, &tag).await
}

/// Run one cited-chat turn. Streams `ChatEvent`s to the frontend via `on_event`;
/// the API key is read here (Rust-side) and never crosses to the webview. Every
/// failure (no vault, no key, transport) is surfaced as a `ChatEvent::Error` —
/// never a panic, never silent. `async` so it runs on the worker pool, like the
/// other long-running commands; the state guard (inside `root_of`) is dropped
/// before the first await.
#[tauri::command]
pub(crate) async fn chat(
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
                }
            }
        }
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
/// every failure lands on the sink (never silent). `reasoning` is the effective
/// cached-capability-aware flag computed by the caller.
async fn chat_via_openrouter(run: &mut ChatRun<'_>, model: &str, reasoning: bool) {
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
    let client = ai::OpenAiChatClient::new(key, reasoning);
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
    reasoning_opt_in: bool,
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
                message: ai::error_detail(e),
            });
            return;
        }
    };
    // Pre-flight the model so a deleted / never-finished model reads as a clear
    // "reinstall in Settings", not an opaque mid-stream 404.
    match local::list_local_models(port).await {
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
    let support = local::probe_ollama_reasoning(port, tag).await;
    let effective = neuralnote_core::ai::effective_reasoning(reasoning_opt_in, support);
    let client = local::ollama_chat_client(port, effective);
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

#[cfg(test)]
mod tests {
    use super::*;
    use neuralnote_core::ai::{
        read_provider_config, write_provider_config, ProviderConfig, ProviderKind, ReasoningSupport,
    };

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
}
