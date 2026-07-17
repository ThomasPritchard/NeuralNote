//! Local-AI shell plumbing.
//!
//! This module is intentionally a thin I/O husk: it detects host hardware,
//! starts the bundled Ollama sidecar on loopback, performs HTTP management calls,
//! and hands response bytes to pure parsers in `neuralnote-core`.
//!
//! Phase 2 exposes plumbing that the AI commands in `lib.rs` wrap.

use futures_util::StreamExt;
use neuralnote_core::ai::{
    ollama_reasoning_support, parse_hf_metadata, parse_installed_models, HardwareSpec, HfModelMeta,
    InstalledModel, PullEvent, PullProgress, PullSink, ReasoningSupport,
};
use neuralnote_core::{CoreError, CoreResult};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const OLLAMA_SIDECAR_NAME: &str = "ollama";
const OLLAMA_MODELS_DIR: &str = "ollama-models";
/// Bundled-resource subdir holding the ggml/Metal runtime libraries. Ollama's
/// macOS runtime is three parts: the `ollama` orchestrator + the `llama-server`
/// runner (both shipped as `externalBin`, so they land co-located — ollama finds
/// the runner beside its own binary) + these libraries. The libraries can't be
/// `externalBin` (they're `.dylib`/`.so`, not target-triple executables), so they
/// ship as `bundle.resources` and are located at runtime via `OLLAMA_LIBRARY_PATH`
/// (which redirects the ggml lib search — but NOT the runner-binary discovery,
/// verified empirically, which is why `llama-server` must be the co-located sidecar).
const OLLAMA_LIBS_DIR: &str = "ollama-libs";
const OLLAMA_HEALTH_INTERVAL: Duration = Duration::from_millis(300);
const OLLAMA_START_TIMEOUT: Duration = Duration::from_secs(30);
/// Context window (tokens) for the local chat client. Ollama's built-in default is
/// ~4096 and it **silently truncates from the front**, which would drop the grounding
/// rules (sent first) and the earliest evidence — breaking cited recall on the Local
/// path (PA-001). Sized well above the retrieval budget (the orchestrator caps context
/// at 60_000 chars ≈ ~15k tokens); every curated model in the `ai::local` allowlist
/// supports a window this large.
const OLLAMA_NUM_CTX: u32 = 32_768;
/// Cap on the retained sidecar stderr. The only reader is the startup diagnostic,
/// which wants the TAIL (the most recent lines around a failure) — so we keep the
/// last N KiB and drop older bytes, bounding what would otherwise grow for the
/// sidecar's whole lifetime as `ollama serve` logs request/INFO lines (PA-009).
const MAX_STDERR_BYTES: usize = 16 * 1024;
/// Free bytes we insist on keeping ON TOP of the model's own download size before a
/// pull. Ollama streams the blob then verifies/renames it, and filling a volume to
/// its last byte is a hazard for every other app on it; 1 GiB is a conservative floor
/// that's negligible against the multi-GB models in the curated catalogue.
const PULL_DISK_HEADROOM_BYTES: u64 = 1 << 30;

pub(super) struct OllamaSidecar {
    child: CommandChild,
    port: u16,
}

/// A sidecar child that's been spawned but not yet health-checked into `sidecar`
/// (it's still in the startup poll). The `id` lets its own starter reclaim exactly
/// this child after the poll, so two concurrent starters never take each other's.
struct StartingSidecar {
    id: u64,
    child: CommandChild,
}

#[derive(Default)]
pub(super) struct LocalAiState {
    sidecar: Option<OllamaSidecar>,
    /// Children spawned but not yet promoted to `sidecar` — still in the ≤30s health
    /// poll. Parked HERE, where `shutdown_ollama` can reach them, so an app quit
    /// mid-startup reaps the child instead of orphaning `ollama serve` (macOS doesn't
    /// reap children on parent exit). A monotonic id per child keeps concurrent
    /// starters from clobbering one another.
    starting: Vec<StartingSidecar>,
    next_start_id: u64,
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

    /// Park a freshly-spawned child while it health-polls, returning the id
    /// [`take_starting`](Self::take_starting) uses to reclaim exactly this child.
    /// Reachable by `shutdown_ollama`, so a quit mid-startup can still reap it.
    fn register_starting(&mut self, child: CommandChild) -> u64 {
        let id = self.next_start_id;
        self.next_start_id += 1;
        self.starting.push(StartingSidecar { id, child });
        id
    }

    /// Reclaim a starting child once its poll finishes, to promote or kill it.
    /// `None` means `shutdown_ollama` already took (and killed) it mid-startup.
    fn take_starting(&mut self, id: u64) -> Option<CommandChild> {
        let pos = self.starting.iter().position(|s| s.id == id)?;
        Some(self.starting.swap_remove(pos).child)
    }

    /// Drain every not-yet-promoted starting child so `shutdown_ollama` reaps them.
    fn drain_starting(&mut self) -> Vec<CommandChild> {
        self.starting.drain(..).map(|s| s.child).collect()
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

pub(super) fn detect_hardware(app_data_dir: Option<&Path>) -> HardwareSpec {
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
    let free_disk_bytes = match free_disk_bytes(app_data_dir) {
        Ok(bytes) => bytes,
        Err(error) => {
            log::warn!("could not probe free space for skill requirements: {error}");
            0
        }
    };

    HardwareSpec {
        total_ram_bytes: system.total_memory(),
        cpu_cores: System::physical_core_count().unwrap_or(0),
        cpu_brand,
        // TODO(local-gpu-detection): wire macOS GPU/unified-memory detail once
        // the recommendation UI needs it; RAM/OS/arch gates are enough for v1.
        gpu_label: None,
        arch: std::env::consts::ARCH.into(),
        os: std::env::consts::OS.into(),
        free_disk_bytes,
    }
}

/// Available bytes on the exact volume that will hold skill binaries. Probe
/// failures stay distinct here so the caller can log them before mapping the wire
/// value to core's unknown `0`; a successful probe may also report a genuinely
/// full volume as `Ok(0)`.
fn free_disk_bytes(probe_path: Option<&Path>) -> CoreResult<u64> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let probe_path = probe_path.ok_or_else(|| {
            CoreError::Io("no app-data path was available for the disk-space probe".into())
        })?;
        let display_path = probe_path.display().to_string();
        let probe_path = CString::new(probe_path.as_os_str().as_bytes()).map_err(|_| {
            CoreError::Io(format!(
                "disk-space probe path '{display_path}' contains a NUL byte"
            ))
        })?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `probe_path` is a live NUL-terminated string and `stats` points
        // to writable storage for exactly one `statvfs` result. We only assume it
        // initialized after libc reports success.
        if unsafe { libc::statvfs(probe_path.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return Err(CoreError::Io(format!(
                "could not inspect free space at '{display_path}': {}",
                std::io::Error::last_os_error()
            )));
        }
        // SAFETY: guarded by statvfs's zero return above.
        let stats = unsafe { stats.assume_init() };
        let bytes = (stats.f_bavail as u128)
            .checked_mul(stats.f_frsize as u128)
            .ok_or_else(|| CoreError::Io("free disk-space calculation overflowed".into()))?;
        u64::try_from(bytes).map_err(|_| CoreError::Io("free disk-space result exceeds u64".into()))
    }

    #[cfg(not(unix))]
    {
        let _ = probe_path;
        Err(CoreError::Io(
            "free disk-space probing is not supported on this platform".into(),
        ))
    }
}

async fn await_start_step<F, T>(
    future: F,
    close_signal: Option<&crate::ai::ChatRunCloseSignal>,
) -> CoreResult<T>
where
    F: std::future::Future<Output = T>,
{
    let Some(close_signal) = close_signal else {
        return Ok(future.await);
    };
    tokio::pin!(future);
    tokio::select! {
        biased;
        output = &mut future => Ok(output),
        () = close_signal.wait_closed() => Err(chat_run_closed_error()),
    }
}

fn chat_run_closed_error() -> CoreError {
    CoreError::Conflict("chat run ended because its vault or window closed".into())
}

fn ensure_chat_run_active(close_signal: Option<&crate::ai::ChatRunCloseSignal>) -> CoreResult<()> {
    if close_signal.is_some_and(crate::ai::ChatRunCloseSignal::is_closed) {
        Err(chat_run_closed_error())
    } else {
        Ok(())
    }
}

pub(super) async fn ensure_ollama_started(
    app: &AppHandle,
    state: &crate::SharedState<'_>,
) -> CoreResult<u16> {
    ensure_ollama_started_inner(app, state, None).await
}

pub(super) async fn ensure_ollama_started_for_chat(
    app: &AppHandle,
    state: &crate::SharedState<'_>,
    close_signal: &crate::ai::ChatRunCloseSignal,
) -> CoreResult<u16> {
    ensure_ollama_started_inner(app, state, Some(close_signal)).await
}

async fn ensure_ollama_started_inner(
    app: &AppHandle,
    state: &crate::SharedState<'_>,
    close_signal: Option<&crate::ai::ChatRunCloseSignal>,
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
        if await_start_step(probe_ollama(port), close_signal).await? {
            ensure_chat_run_active(close_signal)?;
            return Ok(port);
        }
        log::warn!("Local AI sidecar on port {port} stopped answering; restarting it");
        stop_running_sidecar(state);
    }

    ensure_chat_run_active(close_signal)?;
    let port = pick_loopback_port()?;
    let models_dir = ollama_models_dir(app)?;
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| CoreError::Io(format!("could not create Local AI models dir: {e}")))?;

    // Bundled ggml/Metal libraries, found via OLLAMA_LIBRARY_PATH (see OLLAMA_LIBS_DIR).
    let libs_dir = app
        .path()
        .resource_dir()
        .map(|dir| dir.join(OLLAMA_LIBS_DIR))
        .map_err(|e| CoreError::LocalAi(format!("no resource dir for Local AI libraries: {e}")))?;

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
        .env("OLLAMA_LIBRARY_PATH", libs_dir.as_os_str())
        .spawn()
        .map_err(|e| CoreError::LocalAi(format!("Couldn't start the Local AI sidecar: {e}")))?;

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

    // Park the freshly-spawned child in the "starting" slot BEFORE the health-poll,
    // so an app quit during the poll reaps it via shutdown_ollama. Without this the
    // child is unreachable until it's promoted to `sidecar`, and a quit mid-startup
    // would orphan `ollama serve` (macOS doesn't reap children on parent exit). The
    // std Mutex guard is released at the end of this statement — never held across
    // the `.await` below.
    let start_id = crate::lock_state(state).local_ai.register_starting(child);

    let poll_result =
        match await_start_step(wait_for_ollama(port, &stderr, &terminated), close_signal).await {
            Ok(result) => result,
            Err(cancellation) => Err(cancellation),
        };

    // Reclaim our child under a fresh short lock. It's gone only if shutdown_ollama
    // reaped it mid-startup, in which case it has already been killed — surface that
    // rather than claim a running sidecar.
    let mut guard = crate::lock_state(state);
    let Some(child) = guard.local_ai.take_starting(start_id) else {
        return Err(CoreError::LocalAi(
            "Local AI startup was interrupted by shutdown.".into(),
        ));
    };

    if let Err(e) = poll_result {
        drop(guard);
        if let Err(kill_err) = child.kill() {
            log::warn!("could not stop failed Local AI sidecar: {kill_err}");
        }
        return Err(e);
    }

    // Check-then-act, resolved atomically under this one lock: if a concurrent
    // starter won the race and already parked a sidecar, kill our duplicate and
    // reuse theirs.
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
    // App-exit teardown. Cancel any in-flight download, then take the running sidecar
    // AND every child still mid-startup out under one short lock (no `.await` held),
    // and kill them all outside it. Draining the "starting" slot is what closes the
    // quit-mid-startup orphan window: a child spawned but not yet promoted to
    // `sidecar` is still reachable here and gets reaped, instead of surviving as an
    // orphaned `ollama serve` (macOS doesn't reap children on parent exit).
    let (sidecar, starting) = {
        let mut guard = crate::lock_state(state);
        guard.local_ai.pull_cancel.store(true, Ordering::SeqCst);
        (
            guard.local_ai.take_sidecar(),
            guard.local_ai.drain_starting(),
        )
    };
    kill_sidecar(sidecar);
    for child in starting {
        if let Err(e) = child.kill() {
            log::warn!("could not stop starting Local AI sidecar during shutdown: {e}");
        }
    }
}

/// Drop a cached sidecar that stopped answering so `ensure_ollama_started` can
/// respawn a fresh one. Unlike [`shutdown_ollama`] this leaves any concurrent
/// starter's still-starting child alone — the app isn't exiting, so only the dead
/// running sidecar is cleared. Same short-lock-then-kill-outside discipline.
fn stop_running_sidecar(state: &crate::SharedState<'_>) {
    let sidecar = {
        let mut guard = crate::lock_state(state);
        guard.local_ai.pull_cancel.store(true, Ordering::SeqCst);
        guard.local_ai.take_sidecar()
    };
    kill_sidecar(sidecar);
}

/// Kill a sidecar child taken out of the state, outside any lock. A failure to reap
/// logs at warn — a teardown path that can't stop a child must not be silent.
fn kill_sidecar(sidecar: Option<OllamaSidecar>) {
    let Some(sidecar) = sidecar else {
        return;
    };
    if let Err(e) = sidecar.child.kill() {
        log::warn!(
            "could not stop Local AI sidecar on port {}: {e}",
            sidecar.port
        );
    }
}

/// Build the local chat client with the effective reasoning flag. Ollama's
/// OpenAI-compatible endpoint maps thinking onto `reasoning`, so a capable local
/// model can stream thinking when the user opts in.
pub fn ollama_chat_client(port: u16, reasoning: bool) -> crate::ai::OpenAiChatClient {
    crate::ai::OpenAiChatClient::new_with(
        format!("http://127.0.0.1:{port}/v1/chat/completions"),
        None,
        None,
        Duration::from_secs(10),
        Duration::from_secs(300),
        Some(OLLAMA_NUM_CTX),
        reasoning,
    )
}

/// Probe an installed model's thinking capability through the loopback sidecar.
/// Any transport, status, body, or parse failure returns `Unknown` (fail open).
pub(super) async fn probe_ollama_reasoning(port: u16, tag: &str) -> ReasoningSupport {
    let Ok(client) = management_client() else {
        return ReasoningSupport::Unknown;
    };
    let Ok(response) = client
        .post(api_url(port, "/api/show"))
        .json(&serde_json::json!({ "model": tag }))
        .send()
        .await
    else {
        return ReasoningSupport::Unknown;
    };
    if !response.status().is_success() {
        return ReasoningSupport::Unknown;
    }
    let Ok(body) = response.text().await else {
        return ReasoningSupport::Unknown;
    };

    ollama_reasoning_support(&body)
}

pub(super) async fn list_local_models(port: u16) -> CoreResult<Vec<InstalledModel>> {
    let body = get_text(port, "/api/tags").await?;
    parse_installed_models(&body)
}

/// Decimal size string (GB, base-1000) matching the catalogue's decimal
/// `download_bytes` — a curated `3_400_000_000` reads back as "3.4 GB".
fn format_gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_000_000_000.0)
}

/// Why a preflight couldn't fully verify, built only from the inputs that were
/// actually missing so it can never claim a value it had.
fn unverified_preflight_reason(expected_bytes: Option<u64>, free_bytes: Option<u64>) -> String {
    let mut missing = Vec::new();
    if expected_bytes.is_none() {
        missing.push("the model's download size");
    }
    if free_bytes.is_none() {
        missing.push("free space on the models volume");
    }
    format!("{} could not be determined", missing.join(" and "))
}

/// Pure disk-space decision, split out so the boundary and overflow rules are
/// testable without touching a real disk. `expected_bytes = None` means the model's
/// size is unknown; `free_bytes = None` means the volume probe failed.
///
/// Honesty rule for missing inputs: we only ever REFUSE on POSITIVE evidence of
/// insufficiency — a known requirement that exceeds known free space. A missing input
/// is *not* evidence a pull won't fit, so turning it into a refusal would be a lie in
/// the other direction that silently denies a download that may be perfectly fine.
/// Instead we PROCEED but hand back a warning for the caller to log (never silent —
/// mirrors `detect_hardware`'s warn-and-fall-back pattern), and Ollama's own pull
/// stream still surfaces a genuine out-of-space mid-download as an in-band error.
///
/// Boundary rule: the required figure is `expected + headroom`, and the pull is
/// refused iff `free < required` — so exactly `free == required` is treated as
/// sufficient and proceeds. `saturating_add` keeps a bogus/huge `expected` from
/// wrapping the headroom back down to a small `required` that would wave a pull
/// through; on overflow it pins to `u64::MAX`, which no real volume can satisfy.
///
/// `Ok(None)` = verified sufficient, `Ok(Some(reason))` = proceed but log the reason,
/// `Err` = refuse before any request is sent.
fn evaluate_pull_disk_space(
    expected_bytes: Option<u64>,
    free_bytes: Option<u64>,
) -> CoreResult<Option<String>> {
    let (Some(expected), Some(free)) = (expected_bytes, free_bytes) else {
        return Ok(Some(unverified_preflight_reason(
            expected_bytes,
            free_bytes,
        )));
    };

    let required = expected.saturating_add(PULL_DISK_HEADROOM_BYTES);
    if free < required {
        return Err(CoreError::LocalAi(format!(
            "Not enough disk space to download this model: it needs about {} \
             (including a safety margin) but only {} is free on the models volume. \
             Free up space and try again.",
            format_gb(required),
            format_gb(free),
        )));
    }
    Ok(None)
}

/// Real-disk wrapper around [`evaluate_pull_disk_space`]: probe the volume that
/// actually holds `models_dir` — `statvfs` follows symlinks and reports the
/// containing filesystem, so this is the true destination mount, not an assumed
/// `$HOME` — then apply the pure decision. A probe failure is logged and mapped to
/// "unknown free space" rather than swallowed, so it proceeds-with-warning instead of
/// masquerading as a verified pass.
///
/// When the check can't be completed (volume probe failed or the model size is
/// unknown) the pull still proceeds, but a one-line informational note is emitted
/// on the sink so the skipped check reaches the user inline rather than only the
/// log. There is no dedicated "note" `PullEvent`, so this reuses `Progress`'s
/// `status` — the same human-facing status channel the pipeline already streams
/// (Ollama's own "pulling manifest" etc.) — with no byte counters, which is honest:
/// it is progress information, not an error and not a completion.
fn preflight_pull_disk_space(
    models_dir: &Path,
    expected_bytes: Option<u64>,
    sink: &mut dyn PullSink,
) -> CoreResult<()> {
    let free_bytes = match free_disk_bytes(Some(models_dir)) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            log::warn!("could not probe free space before a model download: {error}");
            None
        }
    };
    if let Some(reason) = evaluate_pull_disk_space(expected_bytes, free_bytes)? {
        log::warn!(
            "proceeding with a model download despite an unverified disk preflight: {reason}"
        );
        sink.send(PullEvent::Progress {
            status: format!("Continuing the download without a disk-space check — {reason}."),
            digest: None,
            completed: None,
            total: None,
            percent: None,
        });
    }
    Ok(())
}

pub(super) async fn pull_local_model(
    port: u16,
    tag: &str,
    models_dir: &Path,
    expected_bytes: Option<u64>,
    sink: &mut dyn PullSink,
    cancel: &AtomicBool,
) -> CoreResult<()> {
    // Refuse a known-too-big pull on the EXACT destination volume before opening the
    // download, so a multi-GB stream never starts only to die mid-flight with a
    // half-written blob. Surfaced through the returned `Err` (the command turns it
    // into the one terminal `PullEvent::Error`).
    preflight_pull_disk_space(models_dir, expected_bytes, sink)?;
    let client = pull_client()?;
    let resp = client
        .post(api_url(port, "/api/pull"))
        .json(&serde_json::json!({ "model": tag, "stream": true }))
        .send()
        .await
        .map_err(|e| CoreError::LocalAi(format!("Couldn't start the Local AI download: {e}")))?;
    let mut stream = ensure_response_success(resp, "Local AI download")
        .await?
        .bytes_stream();
    let mut buf = Vec::new();
    // One tally for the whole pull, so the reported percent aggregates across every
    // digest (layer) instead of resetting per-frame as Ollama advances layers (#28).
    let mut progress = PullProgress::default();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| CoreError::LocalAi(format!("Local AI download stream failed: {e}")))?;
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = buf.drain(..=pos).collect::<Vec<_>>();
            if handle_pull_line(&line, &mut progress, sink, cancel)? {
                return Ok(());
            }
        }
    }

    if !buf.is_empty() && handle_pull_line(&buf, &mut progress, sink, cancel)? {
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

pub(super) fn ollama_models_dir(app: &AppHandle) -> CoreResult<PathBuf> {
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
            format!("Couldn't start Local AI: {reason}")
        } else {
            format!("Couldn't start Local AI: {reason}; stderr: {captured}")
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

fn handle_pull_line(
    line: &[u8],
    progress: &mut PullProgress,
    sink: &mut dyn PullSink,
    cancel: &AtomicBool,
) -> CoreResult<bool> {
    if cancel.load(Ordering::SeqCst) {
        return Err(CoreError::LocalAi("Download cancelled.".into()));
    }

    let line = String::from_utf8(line.to_vec()).map_err(|e| {
        CoreError::LocalAi(format!("Local AI download emitted non-UTF-8 JSON: {e}"))
    })?;
    if let Some(event) = progress.ingest(&line) {
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
    // Keep only the last MAX_STDERR_BYTES so a long-lived sidecar can't grow this
    // unbounded (PA-009). Drop the leading bytes, backing the cut up to a char
    // boundary so a multibyte scalar is never split (`len()` is always a boundary,
    // so this always terminates).
    if output.len() > MAX_STDERR_BYTES {
        let mut cut = output.len() - MAX_STDERR_BYTES;
        while !output.is_char_boundary(cut) {
            cut += 1;
        }
        output.drain(..cut);
    }
}

fn captured_stderr(output: &Arc<Mutex<String>>) -> String {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn free_disk_probe_reports_space_for_a_real_volume() {
        let dir = tempfile::tempdir().unwrap();

        assert!(free_disk_bytes(Some(dir.path())).is_ok());
    }

    #[test]
    fn free_disk_probe_reports_when_the_path_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        assert!(free_disk_bytes(Some(&missing)).is_err());
        assert!(free_disk_bytes(None).is_err());
    }

    const MODEL_BYTES: u64 = 6_600_000_000; // qwen3.5:9b, a real catalogue size.

    #[test]
    fn pull_preflight_allows_a_pull_that_fits() {
        // Ample headroom over required (model + margin) → verified sufficient, no warn.
        let free = MODEL_BYTES + PULL_DISK_HEADROOM_BYTES + 10_000_000_000;
        assert_eq!(
            evaluate_pull_disk_space(Some(MODEL_BYTES), Some(free)).unwrap(),
            None,
        );
    }

    #[test]
    fn pull_preflight_refuses_a_pull_that_cannot_fit() {
        // Free space below required is positive evidence of insufficiency → refuse,
        // with a message that names both figures so the failure isn't opaque.
        let result = evaluate_pull_disk_space(Some(MODEL_BYTES), Some(1_000_000_000));
        let Err(CoreError::LocalAi(message)) = result else {
            panic!("an undersized volume must be refused, got {result:?}");
        };
        assert!(message.contains("Not enough disk space"), "{message}");
        assert!(
            message.contains("1.0 GB"),
            "must report the free figure: {message}"
        );
    }

    #[test]
    fn pull_preflight_treats_exact_required_as_sufficient() {
        // Boundary rule: refuse iff `free < required`, so `free == required` proceeds.
        let required = MODEL_BYTES + PULL_DISK_HEADROOM_BYTES;
        assert_eq!(
            evaluate_pull_disk_space(Some(MODEL_BYTES), Some(required)).unwrap(),
            None,
            "free == required is sufficient (inclusive lower bound)",
        );
        assert!(
            evaluate_pull_disk_space(Some(MODEL_BYTES), Some(required - 1)).is_err(),
            "one byte under required must be refused",
        );
    }

    #[test]
    fn pull_preflight_does_not_overflow_on_a_huge_size() {
        // A bogus/huge expected size must not wrap the headroom addition back to a
        // small required figure and wave the pull through; saturating_add pins it to
        // u64::MAX, which no real volume satisfies → refuse, no panic.
        assert!(
            evaluate_pull_disk_space(Some(u64::MAX), Some(500_000_000_000)).is_err(),
            "u64::MAX + headroom must saturate and refuse, not wrap",
        );
    }

    #[test]
    fn pull_preflight_warns_but_proceeds_when_size_is_unknown() {
        // Unknown size is not evidence of insufficiency → proceed with a surfaced
        // reason naming the missing input, never a silent pass.
        let reason = evaluate_pull_disk_space(None, Some(50_000_000_000))
            .unwrap()
            .expect("unknown size must yield a warning, not a silent pass");
        assert!(reason.contains("download size"), "{reason}");
    }

    #[test]
    fn pull_preflight_warns_but_proceeds_when_probe_failed() {
        // A failed free-space probe is likewise surfaced-and-proceed, not swallowed.
        let reason = evaluate_pull_disk_space(Some(MODEL_BYTES), None)
            .unwrap()
            .expect("a failed probe must yield a warning, not a silent pass");
        assert!(reason.contains("free space"), "{reason}");
    }

    #[test]
    fn pull_preflight_names_both_missing_inputs() {
        let reason = evaluate_pull_disk_space(None, None).unwrap().unwrap();
        assert!(
            reason.contains("download size") && reason.contains("free space"),
            "{reason}"
        );
    }

    #[test]
    fn format_gb_reads_decimal_catalogue_sizes() {
        assert_eq!(format_gb(3_400_000_000), "3.4 GB");
    }

    #[cfg(unix)]
    #[test]
    fn preflight_wrapper_refuses_when_the_model_dwarfs_a_real_volume() {
        // End-to-end through the real statvfs probe: an exabyte-scale model can't fit
        // any real test volume, so the wrapper refuses before any request.
        let dir = tempfile::tempdir().unwrap();
        let mut sink = RecordingSink::default();
        assert!(preflight_pull_disk_space(dir.path(), Some(u64::MAX / 2), &mut sink).is_err());
        assert!(
            sink.events.is_empty(),
            "a refusal emits no continue-anyway note"
        );
    }

    #[cfg(unix)]
    #[test]
    fn preflight_wrapper_allows_a_tiny_model_on_a_real_volume() {
        // A kilobyte "model" fits any working volume that has room for the headroom.
        let dir = tempfile::tempdir().unwrap();
        let mut sink = RecordingSink::default();
        assert!(preflight_pull_disk_space(dir.path(), Some(1024), &mut sink).is_ok());
        assert!(
            sink.events.is_empty(),
            "a verified-sufficient preflight emits no note"
        );
    }

    #[cfg(unix)]
    #[test]
    fn preflight_wrapper_proceeds_and_notes_when_the_probe_path_is_missing() {
        // A probe failure (missing path) is surfaced as a warning and proceeds — it is
        // not treated as zero free space, which would wrongly block a valid pull. The
        // skipped check is now also surfaced inline to the user as one status note.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let mut sink = RecordingSink::default();
        assert!(preflight_pull_disk_space(&missing, Some(MODEL_BYTES), &mut sink).is_ok());
        assert!(
            matches!(
                sink.events.as_slice(),
                [PullEvent::Progress { status, completed: None, total: None, .. }]
                    if status.contains("disk-space check")
            ),
            "the skipped preflight must emit exactly one informational note, got {:?}",
            sink.events
        );
    }

    #[test]
    fn append_output_bounds_to_tail() {
        // Simulate a long-lived sidecar streaming far more stderr than the cap: the
        // accumulator must stay bounded and keep the TAIL (what the diagnostic reads),
        // evicting the oldest lines (PA-009).
        let buf = Arc::new(Mutex::new(String::new()));
        for i in 0..5000 {
            append_output(&buf, format!("line {i}\n").as_bytes());
        }
        let out = buf.lock().unwrap();
        assert!(
            out.len() <= MAX_STDERR_BYTES,
            "stderr accumulator must stay bounded, was {}",
            out.len()
        );
        assert!(out.contains("line 4999"), "the recent tail must be kept");
        assert!(!out.contains("line 0\n"), "old output must be evicted");
    }

    #[test]
    fn append_output_keeps_short_output_intact() {
        // Below the cap, nothing is dropped — the whole diagnostic is preserved.
        let buf = Arc::new(Mutex::new(String::new()));
        append_output(&buf, b"short diagnostic\n");
        assert_eq!(&*buf.lock().unwrap(), "short diagnostic\n");
    }

    /// Captures every event a pull emits, so a test can assert what reached the UI.
    #[derive(Default)]
    struct RecordingSink {
        events: Vec<PullEvent>,
    }

    impl PullSink for RecordingSink {
        fn send(&mut self, event: PullEvent) {
            self.events.push(event);
        }
    }

    fn handle_line(line: &str, cancel: &AtomicBool) -> (CoreResult<bool>, Vec<PullEvent>) {
        let mut sink = RecordingSink::default();
        let mut progress = PullProgress::default();
        let result = handle_pull_line(line.as_bytes(), &mut progress, &mut sink, cancel);
        (result, sink.events)
    }

    #[test]
    fn handle_pull_line_cancels_before_parsing() {
        // A Cancel that landed mid-download aborts at the next line boundary, and no
        // further progress leaks to the UI after the cancel.
        let cancel = AtomicBool::new(true);
        let (result, events) = handle_line(r#"{"status":"pulling manifest"}"#, &cancel);
        assert!(
            matches!(result, Err(CoreError::LocalAi(msg)) if msg == "Download cancelled."),
            "a set cancel flag must abort the line",
        );
        assert!(events.is_empty(), "a cancelled pull emits no progress");
    }

    #[test]
    fn handle_pull_line_forwards_progress_and_continues() {
        // Progress is non-terminal: forwarded to the sink, poll continues (Ok(false)).
        let cancel = AtomicBool::new(false);
        let (result, events) = handle_line(r#"{"status":"pulling manifest"}"#, &cancel);
        assert!(
            matches!(result, Ok(false)),
            "progress lines are non-terminal"
        );
        assert!(
            matches!(events.as_slice(), [PullEvent::Progress { status, .. }] if status == "pulling manifest"),
        );
    }

    #[test]
    fn handle_pull_line_reports_success_terminally() {
        // Success is the terminal signal, surfaced via the Result (Ok(true)), never
        // as a sink event — the command owns emitting the one terminal PullEvent.
        let cancel = AtomicBool::new(false);
        let (result, events) = handle_line(r#"{"status":"success"}"#, &cancel);
        assert!(matches!(result, Ok(true)), "success ends the stream");
        assert!(
            events.is_empty(),
            "success is not forwarded through the sink"
        );
    }

    #[test]
    fn handle_pull_line_surfaces_inband_error() {
        // An in-band `error` frame (HTTP already committed 200) becomes an Err so the
        // failure is never silent.
        let cancel = AtomicBool::new(false);
        let (result, events) = handle_line(r#"{"error":"file does not exist"}"#, &cancel);
        assert!(matches!(result, Err(CoreError::LocalAi(msg)) if msg == "file does not exist"),);
        assert!(events.is_empty());
    }

    #[test]
    fn handle_pull_line_ignores_unrecognized_lines() {
        // A frame with neither status nor error (e.g. a keep-alive) is skipped as
        // non-terminal noise, emitting nothing.
        let cancel = AtomicBool::new(false);
        let (result, events) = handle_line("{}", &cancel);
        assert!(matches!(result, Ok(false)));
        assert!(events.is_empty());
    }

    #[test]
    fn handle_pull_line_rejects_non_utf8() {
        // Non-UTF-8 bytes surface as an error rather than a panic or a silent skip.
        let cancel = AtomicBool::new(false);
        let mut sink = RecordingSink::default();
        let mut progress = PullProgress::default();
        let result = handle_pull_line(&[0xff, 0xfe], &mut progress, &mut sink, &cancel);
        assert!(matches!(result, Err(CoreError::LocalAi(_))));
        assert!(sink.events.is_empty());
    }

    #[tokio::test]
    async fn local_start_wait_is_interrupted_by_chat_lifecycle_close() {
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let closer = Arc::clone(&signal);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            closer.close();
        });

        assert!(matches!(
            await_start_step(std::future::pending::<()>(), Some(&signal)).await,
            Err(CoreError::Conflict(message)) if message.contains("vault or window closed")
        ));
    }

    #[tokio::test]
    async fn completed_local_start_step_wins_a_simultaneous_close() {
        let signal = crate::ai::ChatRunCloseSignal::default();
        signal.close();

        assert_eq!(
            await_start_step(async { 7 }, Some(&signal)).await.unwrap(),
            7
        );
    }

    #[test]
    fn pick_loopback_port_reserves_a_free_port() {
        // The function reserves an ephemeral loopback port and releases it so the
        // sidecar can bind it: the port must be a real assignment (non-zero) and
        // immediately bindable again.
        let port = pick_loopback_port().expect("should reserve a loopback port");
        assert_ne!(port, 0, "a :0 bind resolves to a real assigned port");
        TcpListener::bind(("127.0.0.1", port))
            .expect("the reserved port must be released for the sidecar to bind");
    }
}
