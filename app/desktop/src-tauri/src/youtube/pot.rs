//! Session-scoped lifecycle for the optional bgutil POT HTTP provider.

use super::ytdlp::PotRouting;
use async_trait::async_trait;
use neuralnote_core::ai::{CaptureCancellation, VideoId};
use neuralnote_core::capture::CaptureError;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[path = "pot_protocol.rs"]
mod pot_protocol;
#[path = "pot_runtime.rs"]
mod pot_runtime;

pub(super) use pot_protocol::{parse_ping_response, parse_prewarm_response, redact_diagnostic};
use pot_protocol::{
    pot_failure, spawn_spec, validate_installation, PING_BODY_LIMIT, PREWARM_BODY_LIMIT,
};
use pot_runtime::RealPotRuntime;

const PING_TIMEOUT: Duration = Duration::from_secs(2);
const PREWARM_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PotInstallation {
    pub(super) binary_path: PathBuf,
    pub(super) plugin_file: PathBuf,
    pub(super) runtime_dir: PathBuf,
}

impl PotInstallation {
    pub(super) fn new(binary_path: PathBuf, plugin_file: PathBuf, runtime_dir: PathBuf) -> Self {
        Self {
            binary_path,
            plugin_file,
            runtime_dir,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PotHttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PotHttpRequest {
    pub(super) method: PotHttpMethod,
    pub(super) url: String,
    pub(super) body: Option<Vec<u8>>,
    pub(super) timeout: Duration,
    pub(super) response_limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PotHttpResponse {
    pub(super) status: u16,
    pub(super) body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PotSpawnSpec {
    pub(super) program: PathBuf,
    pub(super) args: Vec<OsString>,
    pub(super) cwd: PathBuf,
    pub(super) environment: BTreeMap<OsString, OsString>,
}

pub(super) trait PotChild: Send {
    fn is_running(&mut self) -> Result<bool, String>;
    fn stderr_tail(&self) -> String;
    fn kill_and_wait(&mut self) -> Result<(), String>;
}

#[async_trait]
pub(super) trait PotRuntime: Send + Sync {
    fn reserve_loopback_port(&self) -> Result<u16, String>;
    fn spawn(&self, spec: &PotSpawnSpec) -> Result<Box<dyn PotChild>, String>;
    async fn send(&self, request: PotHttpRequest) -> Result<PotHttpResponse, String>;
    async fn sleep(&self, duration: Duration);
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PotTiming {
    pub(super) startup_timeout: Duration,
    pub(super) ping_interval: Duration,
}

impl Default for PotTiming {
    fn default() -> Self {
        Self {
            startup_timeout: Duration::from_secs(30),
            ping_interval: Duration::from_millis(300),
        }
    }
}

struct StartingChild {
    id: u64,
    child: Box<dyn PotChild>,
}

struct RunningChild {
    id: u64,
    installation: PotInstallation,
    routing: PotRouting,
    child: Box<dyn PotChild>,
}

#[derive(Clone)]
struct RunningSnapshot {
    id: u64,
    routing: PotRouting,
}

#[derive(Default)]
struct PotState {
    next_id: u64,
    running: Option<RunningChild>,
    starting: Vec<StartingChild>,
    failure: Option<CaptureError>,
    shut_down: bool,
}

struct PotInner {
    runtime: Arc<dyn PotRuntime>,
    timing: PotTiming,
    state: Mutex<PotState>,
}

type StartOwnership = Arc<Mutex<Option<u64>>>;

#[derive(Clone)]
pub(super) struct PotSidecar(Arc<PotInner>);

impl Default for PotSidecar {
    fn default() -> Self {
        Self::with_runtime(Arc::new(RealPotRuntime::default()), PotTiming::default())
    }
}

impl PotSidecar {
    pub(super) fn new_real() -> Self {
        Self::default()
    }

    pub(super) fn with_runtime(runtime: Arc<dyn PotRuntime>, timing: PotTiming) -> Self {
        Self(Arc::new(PotInner {
            runtime,
            timing,
            state: Mutex::new(PotState::default()),
        }))
    }

    #[cfg(test)]
    pub(super) async fn ensure_started(
        &self,
        installation: &PotInstallation,
        video_id: &VideoId,
    ) -> Result<PotRouting, CaptureError> {
        self.ensure_started_inner(installation, video_id, None)
            .await
    }

    pub(super) async fn ensure_started_cancellable(
        &self,
        installation: &PotInstallation,
        video_id: &VideoId,
        cancellation: &CaptureCancellation,
    ) -> Result<PotRouting, CaptureError> {
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        let ownership = Arc::new(Mutex::new(None));
        let start = self.ensure_started_inner(installation, video_id, Some(&ownership));
        tokio::pin!(start);
        tokio::select! {
            biased;
            () = wait_for_cancellation(cancellation) => {
                self.reap_owned_start_after_cancellation(&ownership);
                Err(cancelled())
            }
            result = &mut start => result,
        }
    }

    async fn ensure_started_inner(
        &self,
        installation: &PotInstallation,
        video_id: &VideoId,
        ownership: Option<&StartOwnership>,
    ) -> Result<PotRouting, CaptureError> {
        if let Some(error) = self.blocked_error() {
            return Err(error);
        }
        let routing = validate_installation(installation).map_err(|error| self.latch(error))?;
        let (cached, replaced) = {
            let mut state = self.state();
            match state.running.as_ref() {
                Some(running) if running.installation == *installation => (
                    Some(RunningSnapshot {
                        id: running.id,
                        routing: running.routing.clone(),
                    }),
                    None,
                ),
                Some(_) => (None, state.running.take()),
                None => (None, None),
            }
        };
        reap_running(replaced, "replaced POT sidecar");
        if let Some(cached) = cached {
            return self
                .ensure_cached(cached, installation, routing, video_id, ownership)
                .await;
        }
        self.start(installation, routing, video_id, ownership).await
    }

    pub(super) fn shutdown(&self) {
        let (running, starting) = {
            let mut state = self.state();
            state.shut_down = true;
            (state.running.take(), std::mem::take(&mut state.starting))
        };
        reap_running(running, "running POT sidecar during shutdown");
        for starting in starting {
            reap(starting.child, "starting POT sidecar during shutdown");
        }
    }

    fn reap_owned_start_after_cancellation(&self, ownership: &StartOwnership) {
        let id = ownership
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(id) = id {
            if let Some(child) = self.take_starting(id) {
                reap(child, "owned POT sidecar after capture cancellation");
            }
        }
    }

    async fn ensure_cached(
        &self,
        cached: RunningSnapshot,
        installation: &PotInstallation,
        routing: PotRouting,
        video_id: &VideoId,
        ownership: Option<&StartOwnership>,
    ) -> Result<PotRouting, CaptureError> {
        let healthy = self.running_is_live(cached.id)
            && self.ping_once(&cached.routing, PING_TIMEOUT).await.is_ok();
        if !healthy {
            reap_running(self.take_running(cached.id), "stale POT sidecar");
            return self.start(installation, routing, video_id, ownership).await;
        }
        if let Err(reason) = self.prewarm(&cached.routing, video_id).await {
            let stderr = self
                .take_running(cached.id)
                .map(|running| {
                    reap_with_stderr(running.child, "POT sidecar after pre-warm failure")
                })
                .unwrap_or_default();
            return Err(self.latch(pot_failure(&reason, &stderr)));
        }
        if self.running_is_live(cached.id) {
            Ok(cached.routing)
        } else {
            reap_running(self.take_running(cached.id), "exited POT sidecar");
            self.start(installation, routing, video_id, ownership).await
        }
    }

    async fn start(
        &self,
        installation: &PotInstallation,
        mut routing: PotRouting,
        video_id: &VideoId,
        ownership: Option<&StartOwnership>,
    ) -> Result<PotRouting, CaptureError> {
        if let Some(error) = self.blocked_error() {
            return Err(error);
        }
        let port =
            self.0.runtime.reserve_loopback_port().map_err(|error| {
                self.latch(pot_failure("could not reserve loopback port", &error))
            })?;
        routing.base_url = format!("http://127.0.0.1:{port}");
        let spec = spawn_spec(installation, port);
        let child = self
            .0
            .runtime
            .spawn(&spec)
            .map_err(|error| self.latch(pot_failure("could not spawn sidecar", &error)))?;
        // Register synchronously before the first await so shutdown can always reap it.
        let start_id = {
            let mut state = self.state();
            if state.shut_down {
                drop(state);
                reap(child, "POT sidecar spawned during shutdown");
                return Err(self.shutdown_error());
            }
            let id = state.next_id;
            state.next_id += 1;
            state.starting.push(StartingChild { id, child });
            id
        };
        if let Some(ownership) = ownership {
            *ownership.lock().unwrap_or_else(|error| error.into_inner()) = Some(start_id);
        }

        let started = self.wait_for_ping(start_id, &routing).await.and_then(|()| {
            self.starting_is_live(start_id)
                .then_some(())
                .ok_or_else(|| "spawned sidecar exited after its health check".to_string())
        });
        if let Err(reason) = started {
            return Err(self.fail_start(start_id, &reason));
        }
        if let Err(reason) = self.prewarm(&routing, video_id).await {
            return Err(self.fail_start(start_id, &reason));
        }
        if !self.starting_is_live(start_id) {
            return Err(self.fail_start(start_id, "spawned sidecar exited during pre-warm"));
        }

        let child = match self.take_starting(start_id) {
            Some(child) => child,
            None => return Err(self.shutdown_error()),
        };
        clear_start_ownership(ownership, start_id);
        let duplicate = {
            let mut state = self.state();
            if state.shut_down {
                None
            } else if let Some(existing) = state.running.as_ref() {
                Some(RunningSnapshot {
                    id: existing.id,
                    routing: existing.routing.clone(),
                })
            } else if let Some(error) = state.failure.clone() {
                drop(state);
                reap(child, "POT sidecar rejected by failure latch");
                return Err(error);
            } else {
                state.running = Some(RunningChild {
                    id: start_id,
                    installation: installation.clone(),
                    routing: routing.clone(),
                    child,
                });
                return Ok(routing);
            }
        };
        reap(child, "duplicate POT sidecar");
        let Some(existing) = duplicate else {
            return Err(self.shutdown_error());
        };
        // The losing process warmed its own port. Warm the winner for this video too.
        self.prewarm(&existing.routing, video_id)
            .await
            .map_err(|reason| self.latch(pot_failure(&reason, "")))?;
        if self.running_is_live(existing.id) {
            Ok(existing.routing)
        } else {
            Err(self.latch(pot_failure("concurrent startup winner exited", "")))
        }
    }

    async fn wait_for_ping(&self, id: u64, routing: &PotRouting) -> Result<(), String> {
        let started = Instant::now();
        let mut last = "sidecar has not answered /ping".to_string();
        loop {
            if !self.starting_is_live(id) {
                return Err("spawned sidecar exited during startup".into());
            }
            let remaining = self
                .0
                .timing
                .startup_timeout
                .saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(format!("timed out waiting for /ping: {last}"));
            }
            match self.ping_once(routing, PING_TIMEOUT.min(remaining)).await {
                Ok(()) if self.starting_is_live(id) => return Ok(()),
                Ok(()) => return Err("spawned sidecar exited after /ping".into()),
                Err(error) => last = error,
            }
            let remaining = self
                .0
                .timing
                .startup_timeout
                .saturating_sub(started.elapsed());
            if remaining.is_zero() {
                continue;
            }
            self.0
                .runtime
                .sleep(self.0.timing.ping_interval.min(remaining))
                .await;
        }
    }

    async fn ping_once(&self, routing: &PotRouting, timeout: Duration) -> Result<(), String> {
        let response = self
            .send_bounded(PotHttpRequest {
                method: PotHttpMethod::Get,
                url: format!("{}/ping", routing.base_url),
                body: None,
                timeout,
                response_limit: PING_BODY_LIMIT,
            })
            .await?;
        parse_ping_response(response.status, &response.body)
    }

    async fn prewarm(&self, routing: &PotRouting, video_id: &VideoId) -> Result<(), String> {
        let body = serde_json::to_vec(&serde_json::json!({
            "bypass_cache": false,
            "challenge": null,
            "content_binding": video_id.as_ref(),
            "disable_innertube": false,
            "disable_tls_verification": false,
            "proxy": null,
            "innertube_context": null,
            "source_address": null,
        }))
        .map_err(|_| "could not encode the pre-warm request".to_string())?;
        let response = self
            .send_bounded(PotHttpRequest {
                method: PotHttpMethod::Post,
                url: format!("{}/get_pot", routing.base_url),
                body: Some(body),
                timeout: PREWARM_TIMEOUT,
                response_limit: PREWARM_BODY_LIMIT,
            })
            .await?;
        parse_prewarm_response(response.status, &response.body)
    }

    async fn send_bounded(&self, request: PotHttpRequest) -> Result<PotHttpResponse, String> {
        let timeout = request.timeout;
        tokio::time::timeout(timeout, self.0.runtime.send(request))
            .await
            .map_err(|_| "POT HTTP request timed out".to_string())?
            .map_err(|error| redact_diagnostic(&error))
    }

    fn blocked_error(&self) -> Option<CaptureError> {
        let state = self.state();
        state
            .shut_down
            .then(|| self.shutdown_error())
            .or_else(|| state.failure.clone())
    }

    fn latch(&self, error: CaptureError) -> CaptureError {
        let mut state = self.state();
        state.failure.get_or_insert_with(|| error.clone()).clone()
    }

    fn fail_start(&self, id: u64, reason: &str) -> CaptureError {
        let Some(child) = self.take_starting(id) else {
            return self.shutdown_error();
        };
        let stderr = reap_with_stderr(child, "failed POT sidecar startup");
        let error = pot_failure(reason, &stderr);
        let mut state = self.state();
        if state.running.is_none() && state.starting.is_empty() && !state.shut_down {
            state.failure.get_or_insert_with(|| error.clone()).clone()
        } else {
            error
        }
    }

    fn shutdown_error(&self) -> CaptureError {
        CaptureError::PotUnavailable("POT sidecar was shut down".into())
    }

    fn state(&self) -> MutexGuard<'_, PotState> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn starting_is_live(&self, id: u64) -> bool {
        self.state()
            .starting
            .iter_mut()
            .find(|child| child.id == id)
            .is_some_and(|child| child.child.is_running().unwrap_or(false))
    }

    fn running_is_live(&self, id: u64) -> bool {
        self.state()
            .running
            .as_mut()
            .filter(|child| child.id == id)
            .is_some_and(|child| child.child.is_running().unwrap_or(false))
    }

    fn take_starting(&self, id: u64) -> Option<Box<dyn PotChild>> {
        let mut state = self.state();
        let position = state.starting.iter().position(|child| child.id == id)?;
        Some(state.starting.swap_remove(position).child)
    }

    fn take_running(&self, id: u64) -> Option<RunningChild> {
        let mut state = self.state();
        (state.running.as_ref()?.id == id)
            .then(|| state.running.take())
            .flatten()
    }
}

async fn wait_for_cancellation(cancellation: &CaptureCancellation) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn cancelled() -> CaptureError {
    CaptureError::Cancelled("POT startup or pre-warm was cancelled".into())
}

fn reap_running(running: Option<RunningChild>, label: &str) {
    if let Some(running) = running {
        reap(running.child, label);
    }
}

fn clear_start_ownership(ownership: Option<&StartOwnership>, id: u64) {
    let Some(ownership) = ownership else {
        return;
    };
    let mut owned = ownership.lock().unwrap_or_else(|error| error.into_inner());
    if *owned == Some(id) {
        *owned = None;
    }
}

fn reap(mut child: Box<dyn PotChild>, label: &str) {
    if let Err(error) = child.kill_and_wait() {
        log::warn!("could not reap {label}: {}", redact_diagnostic(&error));
    }
}

fn reap_with_stderr(mut child: Box<dyn PotChild>, label: &str) -> String {
    if let Err(error) = child.kill_and_wait() {
        log::warn!("could not reap {label}: {}", redact_diagnostic(&error));
    }
    child.stderr_tail()
}
