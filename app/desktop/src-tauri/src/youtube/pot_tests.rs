use super::pot::{
    parse_ping_response, parse_prewarm_response, redact_diagnostic, PotChild, PotHttpMethod,
    PotHttpRequest, PotHttpResponse, PotInstallation, PotRuntime, PotSidecar, PotSpawnSpec,
    PotTiming,
};
use async_trait::async_trait;
use neuralnote_core::ai::{CaptureCancellation, VideoId};
use neuralnote_core::capture::CaptureError;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::{Barrier, Notify};

const TEST_VIDEO_ID: &str = "jNQXAC9IVRw";
type SpawnGate = Arc<(Mutex<bool>, Condvar)>;

#[derive(Clone)]
struct ResponseStep {
    response: Result<PotHttpResponse, String>,
    barrier: Option<Arc<Barrier>>,
    release: Option<Arc<Notify>>,
}

impl ResponseStep {
    fn immediate(response: PotHttpResponse) -> Self {
        Self {
            response: Ok(response),
            barrier: None,
            release: None,
        }
    }

    fn behind_barrier(response: PotHttpResponse, barrier: Arc<Barrier>) -> Self {
        Self {
            response: Ok(response),
            barrier: Some(barrier),
            release: None,
        }
    }

    fn blocked(response: PotHttpResponse, release: Arc<Notify>) -> Self {
        Self {
            response: Ok(response),
            barrier: None,
            release: Some(release),
        }
    }
}

#[derive(Default)]
struct FakeChildState {
    alive: AtomicBool,
    killed: AtomicUsize,
    reaped: AtomicUsize,
    stderr: Mutex<String>,
    stderr_on_reap: Mutex<Option<String>>,
}

struct FakeChild {
    state: Arc<FakeChildState>,
}

impl PotChild for FakeChild {
    fn is_running(&mut self) -> Result<bool, String> {
        Ok(self.state.alive.load(Ordering::SeqCst))
    }

    fn stderr_tail(&self) -> String {
        self.state.stderr.lock().unwrap().clone()
    }

    fn kill_and_wait(&mut self) -> Result<(), String> {
        if self.state.alive.swap(false, Ordering::SeqCst) {
            self.state.killed.fetch_add(1, Ordering::SeqCst);
        }
        self.state.reaped.fetch_add(1, Ordering::SeqCst);
        if let Some(stderr) = self.state.stderr_on_reap.lock().unwrap().take() {
            *self.state.stderr.lock().unwrap() = stderr;
        }
        Ok(())
    }
}

#[derive(Default)]
struct FakeRuntime {
    ports: Mutex<VecDeque<u16>>,
    spawns: Mutex<Vec<PotSpawnSpec>>,
    children: Mutex<Vec<Arc<FakeChildState>>>,
    requests: Mutex<Vec<PotHttpRequest>>,
    responses: Mutex<VecDeque<ResponseStep>>,
    child_stderr: Mutex<String>,
    child_stderr_on_reap: Mutex<Option<String>>,
    exit_after_spawn: AtomicBool,
    spawn_gate: Mutex<Option<SpawnGate>>,
}

impl FakeRuntime {
    fn with_ports(ports: impl IntoIterator<Item = u16>) -> Arc<Self> {
        Arc::new(Self {
            ports: Mutex::new(ports.into_iter().collect()),
            ..Self::default()
        })
    }

    fn push_response(&self, step: ResponseStep) {
        self.responses.lock().unwrap().push_back(step);
    }

    fn spawns(&self) -> Vec<PotSpawnSpec> {
        self.spawns.lock().unwrap().clone()
    }

    fn requests(&self) -> Vec<PotHttpRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn children(&self) -> Vec<Arc<FakeChildState>> {
        self.children.lock().unwrap().clone()
    }

    fn spawn_count(&self) -> usize {
        self.spawns.lock().unwrap().len()
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

#[async_trait]
impl PotRuntime for FakeRuntime {
    fn reserve_loopback_port(&self) -> Result<u16, String> {
        self.ports
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| "no fake loopback ports remain".to_string())
    }

    fn spawn(&self, spec: &PotSpawnSpec) -> Result<Box<dyn PotChild>, String> {
        self.spawns.lock().unwrap().push(spec.clone());
        if let Some(gate) = self.spawn_gate.lock().unwrap().clone() {
            let (released, wake) = &*gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
        let state = Arc::new(FakeChildState {
            alive: AtomicBool::new(!self.exit_after_spawn.load(Ordering::SeqCst)),
            stderr: Mutex::new(self.child_stderr.lock().unwrap().clone()),
            stderr_on_reap: Mutex::new(self.child_stderr_on_reap.lock().unwrap().clone()),
            ..FakeChildState::default()
        });
        self.children.lock().unwrap().push(Arc::clone(&state));
        Ok(Box::new(FakeChild { state }))
    }

    async fn send(&self, request: PotHttpRequest) -> Result<PotHttpResponse, String> {
        self.requests.lock().unwrap().push(request.clone());
        let step = self.responses.lock().unwrap().pop_front();
        if let Some(barrier) = step.as_ref().and_then(|step| step.barrier.clone()) {
            barrier.wait().await;
        }
        if let Some(release) = step.as_ref().and_then(|step| step.release.clone()) {
            release.notified().await;
        }
        step.map_or_else(
            || match request.method {
                PotHttpMethod::Get => Ok(ping_ok()),
                PotHttpMethod::Post => Ok(prewarm_ok("test-token-must-not-escape")),
            },
            |step| step.response,
        )
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

fn ping_ok() -> PotHttpResponse {
    PotHttpResponse {
        status: 200,
        body: br#"{"server_uptime":3,"version":"0.8.1"}"#.to_vec(),
    }
}

fn prewarm_ok(token: &str) -> PotHttpResponse {
    PotHttpResponse {
        status: 200,
        body: format!(r#"{{"poToken":"{token}"}}"#).into_bytes(),
    }
}

fn test_timing() -> PotTiming {
    PotTiming {
        // Keep this above the fixed two-second per-probe ceiling so request-shape
        // assertions exercise the production value without making successful tests wait.
        startup_timeout: Duration::from_secs(3),
        ping_interval: Duration::from_millis(1),
    }
}

fn video_id() -> VideoId {
    VideoId::new(TEST_VIDEO_ID).unwrap()
}

fn valid_installation() -> (tempfile::TempDir, PotInstallation) {
    let temp = tempfile::tempdir().unwrap();
    let binary_path = temp.path().join("bin/bgutil-pot");
    let plugin_file = temp.path().join("assets/bgutil-plugin.zip");
    let runtime_dir = temp.path().join("pot-runtime");
    fs::create_dir_all(binary_path.parent().unwrap()).unwrap();
    fs::create_dir_all(plugin_file.parent().unwrap()).unwrap();
    fs::write(&binary_path, b"fake executable").unwrap();
    fs::write(&plugin_file, b"fake plugin zip").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&binary_path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let installation = PotInstallation::new(binary_path, plugin_file, runtime_dir);
    (temp, installation)
}

fn pot_error(result: Result<super::ytdlp::PotRouting, CaptureError>) -> CaptureError {
    let error = result.expect_err("POT sidecar operation should fail");
    assert!(matches!(error, CaptureError::PotUnavailable(_)));
    error
}

#[tokio::test]
async fn launch_and_prewarm_contract_is_exact() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_123]);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let routing = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();

    let spawns = runtime.spawns();
    assert_eq!(spawns.len(), 1);
    assert_eq!(spawns[0].program, installation.binary_path);
    assert_eq!(
        spawns[0].args,
        ["server", "--host", "127.0.0.1", "--port", "45123"]
            .map(OsString::from)
            .to_vec()
    );
    assert_eq!(spawns[0].cwd, installation.runtime_dir);
    assert_eq!(
        spawns[0].environment,
        BTreeMap::from([
            (OsString::from("LOG_LEVEL"), OsString::from("warn")),
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        ])
    );

    let requests = runtime.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, PotHttpMethod::Get);
    assert_eq!(requests[0].url, "http://127.0.0.1:45123/ping");
    assert_eq!(requests[0].timeout, Duration::from_secs(2));
    assert_eq!(requests[0].response_limit, 4 * 1024);
    assert_eq!(requests[1].method, PotHttpMethod::Post);
    assert_eq!(requests[1].url, "http://127.0.0.1:45123/get_pot");
    assert_eq!(requests[1].timeout, Duration::from_secs(60));
    assert_eq!(requests[1].response_limit, 16 * 1024);

    let payload: Value = serde_json::from_slice(requests[1].body.as_ref().unwrap()).unwrap();
    assert_eq!(payload.as_object().unwrap().len(), 8);
    assert_eq!(payload["bypass_cache"], false);
    assert!(payload["challenge"].is_null());
    assert_eq!(payload["content_binding"], TEST_VIDEO_ID);
    assert_eq!(payload["disable_innertube"], false);
    assert_eq!(payload["disable_tls_verification"], false);
    assert!(payload["proxy"].is_null());
    assert!(payload["innertube_context"].is_null());
    assert!(payload["source_address"].is_null());

    assert_eq!(
        routing.plugin_dir,
        installation.plugin_file.parent().unwrap()
    );
    assert_eq!(routing.base_url, "http://127.0.0.1:45123");
    assert_eq!(
        routing.disabled_cli_path,
        installation
            .runtime_dir
            .join("bgutil-cli-provider-disabled")
    );
    assert!(!routing.disabled_cli_path.exists());
}

#[test]
fn ping_response_requires_exact_v081_shape_and_nonnegative_uptime() {
    assert!(parse_ping_response(200, &ping_ok().body).is_ok());

    for body in [
        br#"{"server_uptime":-1,"version":"0.8.1"}"#.as_slice(),
        br#"{"server_uptime":1.5,"version":"0.8.1"}"#.as_slice(),
        br#"{"server_uptime":3,"version":"0.8.0"}"#.as_slice(),
        br#"{"server_uptime":3,"version":"0.8.1","extra":true}"#.as_slice(),
        br#"{"version":"0.8.1"}"#.as_slice(),
        b"not-json".as_slice(),
    ] {
        assert!(parse_ping_response(200, body).is_err(), "accepted {body:?}");
    }
    assert!(parse_ping_response(204, &ping_ok().body).is_err());
}

#[test]
fn prewarm_response_requires_one_nonempty_token_without_exposing_it() {
    assert!(parse_prewarm_response(200, &prewarm_ok("secret-value").body).is_ok());

    for body in [
        br#"{}"#.as_slice(),
        br#"{"poToken":""}"#.as_slice(),
        br#"{"poToken":7}"#.as_slice(),
        br#"{"poToken":"secret","extra":true}"#.as_slice(),
        br#"{"error":"secret-value"}"#.as_slice(),
        b"not-json".as_slice(),
    ] {
        let error = parse_prewarm_response(200, body).unwrap_err();
        assert!(
            !error.contains("secret"),
            "response leaked through: {error}"
        );
    }
    assert!(parse_prewarm_response(500, br#"{"poToken":"secret-value"}"#).is_err());
}

#[test]
fn pot_diagnostics_redact_common_po_token_spellings() {
    for diagnostic in [
        "po_token=web.subs+secret",
        "po-token: web.subs+secret",
        "youtube:po_token=web.subs+secret",
    ] {
        let redacted = redact_diagnostic(diagnostic);
        assert!(!redacted.contains("secret"), "leaked: {redacted}");
        assert!(redacted.contains("redacted"));
    }
}

#[test]
fn pot_loopback_client_explicitly_ignores_environment_proxies() {
    assert!(
        include_str!("pot_runtime.rs").contains(".no_proxy()"),
        "loopback POT traffic must never use an environment proxy"
    );
}

#[tokio::test]
async fn missing_plugin_failure_is_latched_for_the_host_session() {
    let (_temp, installation) = valid_installation();
    fs::remove_file(&installation.plugin_file).unwrap();
    let runtime = FakeRuntime::with_ports([41_001]);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let first = pot_error(sidecar.ensure_started(&installation, &video_id()).await);
    fs::write(&installation.plugin_file, b"installed later").unwrap();
    let second = pot_error(sidecar.ensure_started(&installation, &video_id()).await);

    assert_eq!(first, second);
    assert_eq!(runtime.spawn_count(), 0);
    assert_eq!(runtime.request_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_non_executable_binary_and_plugin_symlink() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let (_temp, installation) = valid_installation();
    fs::set_permissions(&installation.binary_path, fs::Permissions::from_mode(0o644)).unwrap();
    let runtime = FakeRuntime::with_ports([41_001]);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let error = pot_error(sidecar.ensure_started(&installation, &video_id()).await);
    assert!(error.detail().contains("executable"));
    assert_eq!(runtime.spawn_count(), 0);

    let (_temp, installation) = valid_installation();
    let real_plugin = installation.plugin_file.with_extension("real.zip");
    fs::rename(&installation.plugin_file, &real_plugin).unwrap();
    symlink(&real_plugin, &installation.plugin_file).unwrap();
    let runtime = FakeRuntime::with_ports([41_002]);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let error = pot_error(sidecar.ensure_started(&installation, &video_id()).await);
    assert!(error.detail().contains("regular file"));
    assert_eq!(runtime.spawn_count(), 0);
}

#[tokio::test]
async fn stale_cached_sidecar_is_reaped_and_restarted() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([42_001, 42_002]);
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("first-token")));
    runtime.push_response(ResponseStep::immediate(PotHttpResponse {
        status: 503,
        body: b"stale".to_vec(),
    }));
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("second-token")));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let first = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();
    let second = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();

    assert_eq!(first.base_url, "http://127.0.0.1:42001");
    assert_eq!(second.base_url, "http://127.0.0.1:42002");
    assert_eq!(runtime.spawn_count(), 2);
    let children = runtime.children();
    assert_eq!(children[0].killed.load(Ordering::SeqCst), 1);
    assert_eq!(children[0].reaped.load(Ordering::SeqCst), 1);
    assert!(children[1].alive.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_start_has_one_winner_and_reaps_the_duplicate() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([43_001, 43_002]);
    let ping_barrier = Arc::new(Barrier::new(2));
    runtime.push_response(ResponseStep::behind_barrier(
        ping_ok(),
        Arc::clone(&ping_barrier),
    ));
    runtime.push_response(ResponseStep::behind_barrier(ping_ok(), ping_barrier));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let first_sidecar = sidecar.clone();
    let first_installation = installation.clone();
    let first = tokio::spawn(async move {
        first_sidecar
            .ensure_started(&first_installation, &video_id())
            .await
    });
    let second_sidecar = sidecar.clone();
    let second_installation = installation.clone();
    let second = tokio::spawn(async move {
        second_sidecar
            .ensure_started(&second_installation, &video_id())
            .await
    });

    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();

    assert_eq!(first, second);
    assert_eq!(runtime.spawn_count(), 2);
    let children = runtime.children();
    assert_eq!(children.len(), 2);
    assert_eq!(
        children
            .iter()
            .filter(|child| child.alive.load(Ordering::SeqCst))
            .count(),
        1
    );
    assert_eq!(
        children
            .iter()
            .map(|child| child.reaped.load(Ordering::SeqCst))
            .sum::<usize>(),
        1
    );
}

#[tokio::test]
async fn prewarm_failure_reaps_child_latches_failure_and_never_leaks_tokens() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([44_001, 44_002]);
    *runtime.child_stderr_on_reap.lock().unwrap() =
        Some("Generated POT token: stderr-super-secret\nbind diagnostic\n".into());
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(PotHttpResponse {
        status: 500,
        body: br#"{"error":"response-super-secret"}"#.to_vec(),
    }));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let first = pot_error(sidecar.ensure_started(&installation, &video_id()).await);
    let second = pot_error(sidecar.ensure_started(&installation, &video_id()).await);

    assert_eq!(first, second);
    assert_eq!(runtime.spawn_count(), 1);
    assert_eq!(runtime.children()[0].reaped.load(Ordering::SeqCst), 1);
    let detail = first.detail().to_ascii_lowercase();
    assert!(!detail.contains("response-super-secret"));
    assert!(!detail.contains("stderr-super-secret"));
    assert!(!detail.contains("test-token-must-not-escape"));
    assert!(detail.contains("redacted"));
    assert!(detail.contains("bind diagnostic"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_during_prewarm_returns_promptly_and_reaps_the_child() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_124]);
    let release = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::blocked(
        prewarm_ok("must-not-escape"),
        Arc::clone(&release),
    ));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let cancellation = CaptureCancellation::default();
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let task_cancellation = cancellation.clone();
    let start = tokio::spawn(async move {
        task_sidecar
            .ensure_started_cancellable(&task_installation, &video_id(), &task_cancellation)
            .await
    });

    for _ in 0..100 {
        if runtime.request_count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.request_count(), 2, "pre-warm request never arrived");
    cancellation.cancel();

    let result = tokio::time::timeout(Duration::from_millis(250), start)
        .await
        .expect("POT cancellation did not resolve promptly")
        .unwrap();
    assert!(matches!(result, Err(CaptureError::Cancelled(_))));
    let child = &runtime.children()[0];
    assert_eq!(child.killed.load(Ordering::SeqCst), 1);
    assert_eq!(child.reaped.load(Ordering::SeqCst), 1);
    release.notify_one();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_during_startup_ping_returns_promptly_and_reaps_the_child() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_125]);
    let release = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::blocked(ping_ok(), Arc::clone(&release)));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let cancellation = CaptureCancellation::default();
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let task_cancellation = cancellation.clone();
    let start = tokio::spawn(async move {
        task_sidecar
            .ensure_started_cancellable(&task_installation, &video_id(), &task_cancellation)
            .await
    });

    for _ in 0..100 {
        if runtime.request_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.request_count(), 1, "startup ping never arrived");
    cancellation.cancel();

    let result = tokio::time::timeout(Duration::from_millis(250), start)
        .await
        .expect("POT cancellation did not resolve promptly")
        .unwrap();
    assert!(matches!(result, Err(CaptureError::Cancelled(_))));
    let child = &runtime.children()[0];
    assert_eq!(child.killed.load(Ordering::SeqCst), 1);
    assert_eq!(child.reaped.load(Ordering::SeqCst), 1);
    release.notify_one();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_cached_prewarm_does_not_reap_the_shared_running_sidecar() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_126]);
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("first-run")));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let first_routing = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();

    let blocked = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::blocked(
        prewarm_ok("second-run"),
        Arc::clone(&blocked),
    ));
    let cancellation = CaptureCancellation::default();
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let task_cancellation = cancellation.clone();
    let second = tokio::spawn(async move {
        task_sidecar
            .ensure_started_cancellable(&task_installation, &video_id(), &task_cancellation)
            .await
    });
    for _ in 0..100 {
        if runtime.request_count() == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.request_count(), 4, "cached pre-warm never arrived");
    cancellation.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_millis(250), second)
            .await
            .expect("cancelled cached pre-warm did not resolve")
            .unwrap(),
        Err(CaptureError::Cancelled(_))
    ));

    let child = &runtime.children()[0];
    assert!(child.alive.load(Ordering::SeqCst));
    assert_eq!(child.killed.load(Ordering::SeqCst), 0);
    assert_eq!(child.reaped.load(Ordering::SeqCst), 0);

    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("third-run")));
    let third_routing = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();
    assert_eq!(third_routing, first_routing);
    assert_eq!(runtime.spawn_count(), 1);
    blocked.notify_one();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_one_concurrent_start_reaps_only_its_owned_child() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_127, 45_128]);
    let blocked_ping = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::blocked(ping_ok(), Arc::clone(&blocked_ping)));
    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("winner")));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    let cancellation_a = CaptureCancellation::default();
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let task_cancellation = cancellation_a.clone();
    let run_a = tokio::spawn(async move {
        task_sidecar
            .ensure_started_cancellable(&task_installation, &video_id(), &task_cancellation)
            .await
    });
    for _ in 0..100 {
        if runtime.request_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.request_count(), 1, "run A did not reach /ping");

    let cancellation_b = CaptureCancellation::default();
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let run_b = tokio::spawn(async move {
        task_sidecar
            .ensure_started_cancellable(&task_installation, &video_id(), &cancellation_b)
            .await
    });
    let routing_b = tokio::time::timeout(Duration::from_millis(250), run_b)
        .await
        .expect("run B did not promote its healthy child")
        .unwrap()
        .unwrap();

    cancellation_a.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_millis(250), run_a)
            .await
            .expect("run A cancellation did not resolve")
            .unwrap(),
        Err(CaptureError::Cancelled(_))
    ));
    let children = runtime.children();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0].reaped.load(Ordering::SeqCst), 1);
    assert!(!children[0].alive.load(Ordering::SeqCst));
    assert_eq!(children[1].reaped.load(Ordering::SeqCst), 0);
    assert!(children[1].alive.load(Ordering::SeqCst));

    runtime.push_response(ResponseStep::immediate(ping_ok()));
    runtime.push_response(ResponseStep::immediate(prewarm_ok("later-run")));
    let later_routing = sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();
    assert_eq!(later_routing, routing_b);
    assert_eq!(runtime.spawn_count(), 2);
    blocked_ping.notify_one();
}

#[tokio::test]
async fn a_valid_ping_cannot_promote_an_exited_spawned_child() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([45_001]);
    runtime.exit_after_spawn.store(true, Ordering::SeqCst);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());

    pot_error(sidecar.ensure_started(&installation, &video_id()).await);

    assert_eq!(runtime.request_count(), 0);
    assert_eq!(runtime.children()[0].reaped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn synchronous_shutdown_reaps_running_child_and_prevents_restart() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([46_001, 46_002]);
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    sidecar
        .ensure_started(&installation, &video_id())
        .await
        .unwrap();

    sidecar.shutdown();
    let error = pot_error(sidecar.ensure_started(&installation, &video_id()).await);

    assert!(error.detail().contains("shut down"));
    assert_eq!(runtime.spawn_count(), 1);
    let child = &runtime.children()[0];
    assert_eq!(child.killed.load(Ordering::SeqCst), 1);
    assert_eq!(child.reaped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synchronous_shutdown_reaps_child_registered_during_startup() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([47_001]);
    let release = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::blocked(ping_ok(), Arc::clone(&release)));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let start = tokio::spawn(async move {
        task_sidecar
            .ensure_started(&task_installation, &video_id())
            .await
    });

    for _ in 0..100 {
        if runtime.request_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.request_count(), 1, "startup request never arrived");
    sidecar.shutdown();
    release.notify_one();
    pot_error(start.await.unwrap());

    let child = &runtime.children()[0];
    assert_eq!(child.killed.load(Ordering::SeqCst), 1);
    assert_eq!(child.reaped.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_spawn_reaps_before_any_startup_await() {
    let (_temp, installation) = valid_installation();
    let runtime = FakeRuntime::with_ports([48_001]);
    let spawn_gate = Arc::new((Mutex::new(false), Condvar::new()));
    *runtime.spawn_gate.lock().unwrap() = Some(Arc::clone(&spawn_gate));
    let http_release = Arc::new(Notify::new());
    runtime.push_response(ResponseStep::blocked(ping_ok(), Arc::clone(&http_release)));
    let sidecar = PotSidecar::with_runtime(runtime.clone(), test_timing());
    let task_sidecar = sidecar.clone();
    let task_installation = installation.clone();
    let start = tokio::spawn(async move {
        task_sidecar
            .ensure_started(&task_installation, &video_id())
            .await
    });

    for _ in 0..100 {
        if runtime.spawn_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(runtime.spawn_count(), 1, "spawn seam was never entered");
    sidecar.shutdown();
    let (released, wake) = &*spawn_gate;
    *released.lock().unwrap() = true;
    wake.notify_one();

    for _ in 0..100 {
        if !runtime.children().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let children = runtime.children();
    assert_eq!(children.len(), 1);
    assert_eq!(
        children[0].reaped.load(Ordering::SeqCst),
        1,
        "a process returned from spawn after shutdown and survived into HTTP polling"
    );
    assert_eq!(runtime.request_count(), 0);
    http_release.notify_one();
    pot_error(start.await.unwrap());
}

#[test]
fn public_installation_shape_is_path_owned() {
    let installation = PotInstallation::new(
        PathBuf::from("/tmp/bin"),
        PathBuf::from("/tmp/plugin.zip"),
        PathBuf::from("/tmp/runtime"),
    );
    assert_eq!(installation.binary_path, PathBuf::from("/tmp/bin"));
    assert_eq!(installation.plugin_file, PathBuf::from("/tmp/plugin.zip"));
    assert_eq!(installation.runtime_dir, PathBuf::from("/tmp/runtime"));
}
