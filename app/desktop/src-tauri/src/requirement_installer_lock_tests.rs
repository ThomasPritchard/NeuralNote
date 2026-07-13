use super::*;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const HOLDER_DIR_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_DIR";
const HOLDER_READY_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_READY";
const HOLDER_RELEASE_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_RELEASE";

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn wait_success(&mut self) {
        let status = self
            .0
            .take()
            .expect("child is present")
            .wait()
            .expect("lock-holder child should exit");
        assert!(status.success(), "lock-holder child failed: {status}");
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn advisory_lock_holder_process() {
    let Some(app_data_dir) = std::env::var_os(HOLDER_DIR_ENV) else {
        return;
    };
    let ready = PathBuf::from(std::env::var_os(HOLDER_READY_ENV).expect("ready path"));
    let release = PathBuf::from(std::env::var_os(HOLDER_RELEASE_ENV).expect("release path"));
    let installer = RequirementInstaller::begin(
        Path::new(&app_data_dir),
        "cross-process-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .expect("holder should acquire the install lock");
    std::fs::write(&ready, b"ready").expect("holder should signal readiness");

    let deadline = Instant::now() + Duration::from_secs(5);
    while !release.exists() {
        assert!(Instant::now() < deadline, "release signal timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(installer);
}

#[test]
fn advisory_lock_blocks_another_process_without_removing_the_owned_partial() {
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("holder-ready");
    let release = dir.path().join("holder-release");
    let child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--exact")
        .arg("requirement_installer::lock_tests::advisory_lock_holder_process")
        .arg("--nocapture")
        .env(HOLDER_DIR_ENV, dir.path())
        .env(HOLDER_READY_ENV, &ready)
        .env(HOLDER_RELEASE_ENV, &release)
        .spawn()
        .expect("lock-holder child should start");
    let mut child = ChildGuard(Some(child));

    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline, "holder readiness timed out");
        assert!(
            child.0.as_mut().unwrap().try_wait().unwrap().is_none(),
            "lock-holder child exited before signalling readiness"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let second = RequirementInstaller::begin(
        dir.path(),
        "cross-process-tool",
        RequirementInstallKind::Executable,
        None,
    );
    assert!(matches!(second, Err(CoreError::Conflict(_))));
    assert!(dir.path().join("bin/cross-process-tool.part").exists());

    std::fs::write(&release, b"release").unwrap();
    child.wait_success();

    let retry = RequirementInstaller::begin(
        dir.path(),
        "cross-process-tool",
        RequirementInstallKind::Executable,
        None,
    )
    .expect("kernel should release the lock when the holder exits");
    drop(retry);
    assert!(dir.path().join("bin/cross-process-tool.lock").exists());
}
