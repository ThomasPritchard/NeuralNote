//! Local-AI shell plumbing.
//!
//! This module is intentionally a thin I/O husk: it detects host hardware,
//! starts the bundled Ollama sidecar on loopback, performs HTTP management calls,
//! and hands response bytes to pure parsers in `neuralnote-core`.
//!
//! Phase 2 exposes plumbing that the AI commands in `lib.rs` wrap.

use futures_util::StreamExt;
use neuralnote_core::ai::{
    parse_hf_metadata, parse_installed_models, parse_pull_line, HardwareSpec, HfModelMeta,
    InstalledModel, PullEvent, PullSink,
};
use neuralnote_core::{CoreError, CoreResult};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const OLLAMA_SIDECAR_NAME: &str = "ollama";
const OLLAMA_MODELS_DIR: &str = "ollama-models";
const OLLAMA_HEALTH_INTERVAL: Duration = Duration::from_millis(300);
const OLLAMA_START_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct OllamaSidecar {
    child: CommandChild,
    port: u16,
}

#[derive(Default)]
pub(super) struct LocalAiState {
    sidecar: Option<OllamaSidecar>,
    /// Cancel flag for the CURRENT (most-recent) model download. Lives on the state,
    /// not the sidecar, so a Cancel that arrives while the sidecar is still starting
    /// — before any sidecar exists — still targets the pull. Each pull installs a
    /// fresh token via `install_pull_cancel`, so a stale cancel can't abort a later
    /// download.
    pull_cancel: Arc<AtomicBool>,
}

impl LocalAiState {
    fn running_port(&self) -> Option<u16> {
        self.sidecar.as_ref().map(|s| s.port)
    }

    fn take_sidecar(&mut self) -> Option<OllamaSidecar> {
        self.sidecar.take()
    }

    /// Install a fresh cancel token for a new download and return a clone. Dropping
    /// the previous token means a Cancel meant for an earlier pull can't abort this
    /// one. Cloning the `Arc` out lets a long download (and `cancel_pull`) share the
    /// flag without holding the app-state lock for the pull's whole lifetime.
    pub(super) fn install_pull_cancel(&mut self) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        self.pull_cancel = Arc::clone(&token);
        token
    }

    /// A clone of the current pull's cancel token, for `cancel_pull` and shutdown.
    pub(super) fn pull_cancel(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.pull_cancel)
    }
}

/// Forwards download [`PullEvent`]s to the frontend over a Tauri channel — the pull
/// analogue of `ai::TauriChannelSink`. `PullSink::send` is infallible, so a closed
/// channel is logged once and then silently ignored rather than retried.
pub(super) struct TauriPullSink {
    channel: tauri::ipc::Channel<PullEvent>,
    closed: bool,
}

impl TauriPullSink {
    pub(super) fn new(channel: tauri::ipc::Channel<PullEvent>) -> Self {
        Self {
            channel,
            closed: false,
        }
    }
}

impl PullSink for TauriPullSink {
    fn send(&mut self, event: PullEvent) {
        if self.closed {
            return;
        }
        if let Err(e) = self.channel.send(event) {
            log::warn!("pull event channel closed; dropping further events: {e}");
            self.closed = true;
        }
    }
}

pub(super) fn detect_hardware() -> HardwareSpec {
    let refresh = RefreshKind::nothing()
        .with_memory(MemoryRefreshKind::everything())
        .with_cpu(CpuRefreshKind::everything());
    // `new_with_specifics` is infallible in sysinfo 0.39 (it returns `System`, not
    // a `Result`): an unavailable field surfaces as a zero/empty reading, not an
    // error. macOS-first detection; `recommend_model` gates non-macOS hosts.
    let system = System::new_with_specifics(refresh);

    let cpu_brand = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim())
        .filter(|brand| !brand.is_empty())
        .unwrap_or("unknown")
        .to_string();

    HardwareSpec {
        total_ram_bytes: system.total_memory(),
        cpu_cores: System::physical_core_count().unwrap_or(0),
        cpu_brand,
        // TODO(local-gpu-detection): wire macOS GPU/unified-memory detail once
        // the recommendation UI needs it; RAM/OS/arch gates are enough for v1.
        gpu_label: None,
        arch: std::env::consts::ARCH.into(),
        os: std::env::consts::OS.into(),
    }
}

pub(super) async fn ensure_ollama_started(
    app: &AppHandle,
    state: &crate::SharedState<'_>,
) -> CoreResult<u16> {
    // Trust a cached port only if the sidecar still answers. A sidecar that
    // crashed, was OOM-killed, or was killed externally mid-session leaves stale
    // "running" state; without this probe every later call would fail with an
    // opaque transport error and no recovery short of restarting the whole app. A
    // failed probe drops the dead child and falls through to a clean respawn.
    // (Bind the port out first so the std Mutex guard is released before the
    // `.await` — never hold it across an await point.)
    let cached_port = crate::lock_state(state).local_ai.running_port();
    if let Some(port) = cached_port {
        if probe_ollama(port).await {
            return Ok(port);
        }
        log::warn!("Local AI sidecar on port {port} stopped answering; restarting it");
        shutdown_ollama(state);
    }

    let port = pick_loopback_port()?;
    let models_dir = ollama_models_dir(app)?;
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| CoreError::Io(format!("could not create Local AI models dir: {e}")))?;

    let stderr = Arc::new(Mutex::new(String::new()));
    // Set when our spawned child exits, so the startup health-poll can tell "our
    // Ollama died" from "someone else is answering on this port" (see wait_for_ollama).
    let terminated = Arc::new(AtomicBool::new(false));
    let (mut rx, child) = app
        .shell()
        .sidecar(OLLAMA_SIDECAR_NAME)
        .map_err(|e| CoreError::LocalAi(format!("could not prepare Local AI sidecar: {e}")))?
        .args(["serve"])
        .env("OLLAMA_HOST", format!("127.0.0.1:{port}"))
        .env("OLLAMA_MODELS", models_dir.as_os_str())
        .spawn()
        .map_err(|e| CoreError::LocalAi(format!("could not start Local AI sidecar: {e}")))?;

    let stderr_rx = Arc::clone(&stderr);
    let terminated_rx = Arc::clone(&terminated);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => append_output(&stderr_rx, &bytes),
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    log::debug!("Local AI sidecar stdout: {}", text.trim());
                }
                CommandEvent::Error(error) => {
                    append_output(&stderr_rx, error.as_bytes());
                    log::warn!("Local AI sidecar stream error: {error}");
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("Local AI sidecar exited with code {:?}", payload.code);
                    terminated_rx.store(true, Ordering::SeqCst);
                    break;
                }
                _ => {}
            }
        }
    });

    // TODO(startup-orphan): the child isn't parked in AppState until it's healthy,
    // so an app quit during this ≤30s health-poll can't be reaped by
    // shutdown_ollama and leaves an orphaned `ollama serve` (macOS doesn't reap
    // children on parent exit). Narrow window; the next launch picks a fresh free
    // port so there's no clash. Fix later with a "starting" state slot shutdown
    // can reach. (Below the review bar — deferred, not dropped.)
    if let Err(e) = wait_for_ollama(port, &stderr, &terminated).await {
        if let Err(kill_err) = child.kill() {
            log::warn!("could not stop failed Local AI sidecar: {kill_err}");
        }
        return Err(e);
    }

    let mut guard = crate::lock_state(state);
    if let Some(existing_port) = guard.local_ai.running_port() {
        drop(guard);
        if let Err(e) = child.kill() {
            log::warn!("could not stop duplicate Local AI sidecar: {e}");
        }
        return Ok(existing_port);
    }

    guard.local_ai.sidecar = Some(OllamaSidecar { child, port });
    Ok(port)
}

pub(super) fn shutdown_ollama(state: &crate::SharedState<'_>) {
    // Cancel any in-flight download and take the sidecar out under one short lock
    // (no `.await` held), then kill the child outside the lock.
    let sidecar = {
        let mut guard = crate::lock_state(state);
        guard.local_ai.pull_cancel.store(true, Ordering::SeqCst);
        guard.local_ai.take_sidecar()
    };
    let Some(sidecar) = sidecar else {
        return;
    };
    if let Err(e) = sidecar.child.kill() {
        log::warn!(
            "could not stop Local AI sidecar on port {} during shutdown: {e}",
            sidecar.port
        );
    }
}

pub(super) fn ollama_chat_client(port: u16) -> crate::ai::OpenAiChatClient {
    crate::ai::OpenAiChatClient::new_with(
        format!("http://127.0.0.1:{port}/v1/chat/completions"),
        None,
        None,
        Duration::from_secs(10),
        Duration::from_secs(300),
    )
}

pub(super) async fn list_local_models(port: u16) -> CoreResult<Vec<InstalledModel>> {
    let body = get_text(port, "/api/tags").await?;
    parse_installed_models(&body)
}

pub(super) async fn pull_local_model(
    port: u16,
    tag: &str,
    sink: &mut dyn PullSink,
    cancel: &AtomicBool,
) -> CoreResult<()> {
    // TODO(pull-disk-precheck): thread the chosen `CandidateModel` or models dir
    // through Phase 3 so this can compare available bytes on the exact volume
    // before starting a multi-GB download.
    let client = pull_client()?;
    let resp = client
        .post(api_url(port, "/api/pull"))
        .json(&serde_json::json!({ "model": tag, "stream": true }))
        .send()
        .await
        .map_err(|e| CoreError::LocalAi(format!("could not start Local AI download: {e}")))?;
    let mut stream = ensure_response_success(resp, "Local AI download")
        .await?
        .bytes_stream();
    let mut buf = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| CoreError::LocalAi(format!("Local AI download stream failed: {e}")))?;
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = buf.drain(..=pos).collect::<Vec<_>>();
            if handle_pull_line(&line, sink, cancel)? {
                return Ok(());
            }
        }
    }

    if !buf.is_empty() && handle_pull_line(&buf, sink, cancel)? {
        return Ok(());
    }

    Err(CoreError::LocalAi(
        "Local AI download ended before Ollama reported success.".into(),
    ))
}

pub(super) async fn delete_local_model(port: u16, tag: &str) -> CoreResult<()> {
    let client = management_client()?;
    let resp = client
        .delete(api_url(port, "/api/delete"))
        .json(&serde_json::json!({ "model": tag }))
        .send()
        .await
        .map_err(|e| CoreError::LocalAi(format!("could not delete Local AI model: {e}")))?;
    ensure_success(resp, "Local AI delete").await.map(|_| ())
}

pub(super) async fn fetch_hf_metadata(hf_repo: &str) -> CoreResult<HfModelMeta> {
    let url = format!("https://huggingface.co/api/models/{hf_repo}");
    let resp =
        management_client()?.get(url).send().await.map_err(|e| {
            CoreError::LocalAi(format!("could not fetch Hugging Face metadata: {e}"))
        })?;
    let body = ensure_success(resp, "Hugging Face metadata").await?;
    parse_hf_metadata(&body)
}

fn pick_loopback_port() -> CoreResult<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| CoreError::Io(format!("could not reserve a Local AI loopback port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CoreError::Io(format!("could not read Local AI loopback port: {e}")))?
        .port();
    drop(listener);
    Ok(port)
}

fn ollama_models_dir(app: &AppHandle) -> CoreResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(OLLAMA_MODELS_DIR))
        .map_err(|e| CoreError::Io(format!("no app data dir for Local AI models: {e}")))
}

async fn wait_for_ollama(
    port: u16,
    stderr: &Arc<Mutex<String>>,
    terminated: &AtomicBool,
) -> CoreResult<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| CoreError::LocalAi(format!("could not create Local AI health client: {e}")))?;
    let started = Instant::now();
    let fail = |reason: &str| {
        let captured = captured_stderr(stderr);
        CoreError::LocalAi(if captured.is_empty() {
            format!("couldn't start Local AI: {reason}")
        } else {
            format!("couldn't start Local AI: {reason}; stderr: {captured}")
        })
    };

    while started.elapsed() < OLLAMA_START_TIMEOUT {
        // If OUR child already exited (e.g. it couldn't bind the loopback port
        // because another local process grabbed it after we released the
        // reservation), stop polling: a success now would be an impostor on that
        // port, not our sidecar. This also fails fast on a crash-at-start instead of
        // waiting out the full timeout.
        if terminated.load(Ordering::SeqCst) {
            return Err(fail("the Ollama process exited during startup"));
        }
        match client.get(api_url(port, "/api/tags")).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => log::debug!("Local AI health check returned {}", resp.status()),
            Err(e) => log::debug!("Local AI health check failed: {e}"),
        }
        tokio::time::sleep(OLLAMA_HEALTH_INTERVAL).await;
    }

    Err(fail("timed out waiting for Ollama health check"))
}

/// Short-lived HTTP client for quick management calls (list/delete, HF metadata,
/// health probes). A stalled endpoint must ERROR OUT, not hang a command forever:
/// a hang is not an `Err`, so it would defeat "failures are never silent" (and, for
/// HF, the non-fatal-enrichment contract that treats an `Err` as "no metadata").
/// Loopback calls resolve in ms; HF is the only remote caller and sits well inside
/// the total.
fn management_client() -> CoreResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| CoreError::LocalAi(format!("could not create Local AI HTTP client: {e}")))
}

/// HTTP client for the model download. A per-read IDLE timeout — deliberately NOT a
/// total timeout, since a multi-GB pull is legitimately long — so a half-open stall
/// (sleep/resume, Wi-Fi drop, VPN flap) becomes a surfaced stream error instead of
/// a frozen progress bar with no terminal event, and an in-flight Cancel is
/// observed at the next read boundary rather than never.
fn pull_client() -> CoreResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| CoreError::LocalAi(format!("could not create Local AI download client: {e}")))
}

/// A fast liveness probe of a possibly-stale cached sidecar port, using the short
/// management timeout so a dead/hung sidecar is detected quickly and never hangs.
async fn probe_ollama(port: u16) -> bool {
    let Ok(client) = management_client() else {
        return false;
    };
    matches!(
        client.get(api_url(port, "/api/tags")).send().await,
        Ok(resp) if resp.status().is_success()
    )
}

async fn get_text(port: u16, path: &str) -> CoreResult<String> {
    let resp = management_client()?
        .get(api_url(port, path))
        .send()
        .await
        .map_err(|e| CoreError::LocalAi(format!("Local AI request failed: {e}")))?;
    ensure_success(resp, "Local AI request").await
}

async fn ensure_success(resp: reqwest::Response, label: &str) -> CoreResult<String> {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }

    let detail = body.trim();
    Err(CoreError::LocalAi(if detail.is_empty() {
        format!("{label} returned {status}")
    } else {
        format!("{label} returned {status}: {detail}")
    }))
}

async fn ensure_response_success(
    resp: reqwest::Response,
    label: &str,
) -> CoreResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = body.trim();
    Err(CoreError::LocalAi(if detail.is_empty() {
        format!("{label} returned {status}")
    } else {
        format!("{label} returned {status}: {detail}")
    }))
}

fn handle_pull_line(line: &[u8], sink: &mut dyn PullSink, cancel: &AtomicBool) -> CoreResult<bool> {
    if cancel.load(Ordering::SeqCst) {
        return Err(CoreError::LocalAi("Download cancelled.".into()));
    }

    let line = String::from_utf8(line.to_vec()).map_err(|e| {
        CoreError::LocalAi(format!("Local AI download emitted non-UTF-8 JSON: {e}"))
    })?;
    if let Some(event) = parse_pull_line(&line) {
        // Terminal states are surfaced through the `Result`; the command owns
        // emitting exactly one terminal `PullEvent` (Success xor Error) so the UI
        // always resolves and a failure is never silent. Only progress streams here.
        match event {
            PullEvent::Success => return Ok(true),
            PullEvent::Error { message } => return Err(CoreError::LocalAi(message)),
            progress => sink.send(progress),
        }
    }

    Ok(false)
}

fn api_url(port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}{path}")
}

fn append_output(output: &Arc<Mutex<String>>, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let mut output = output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    output.push_str(&text);
}

fn captured_stderr(output: &Arc<Mutex<String>>) -> String {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .trim()
        .to_string()
}
