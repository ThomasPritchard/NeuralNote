use super::*;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const HOLDER_DIR_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_DIR";
const HOLDER_READY_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_READY";
const HOLDER_RELEASE_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_RELEASE";
const HOLDER_NAME_ENV: &str = "NEURALNOTE_TEST_REQUIREMENT_LOCK_NAME";
const DEFAULT_HOLDER_NAME: &str = "cross-process-tool";

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
    let name = std::env::var(HOLDER_NAME_ENV).unwrap_or_else(|_| DEFAULT_HOLDER_NAME.to_string());
    let installer = RequirementInstaller::begin(
        Path::new(&app_data_dir),
        &name,
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

/// Start a second process holding the install lock for `name`, and block until
/// it has actually taken it.
fn hold_the_lock_elsewhere(dir: &Path, name: &str, release: &Path) -> ChildGuard {
    let ready = dir.join(format!("{name}-holder-ready"));
    let child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--exact")
        .arg("requirement_installer::lock_tests::advisory_lock_holder_process")
        .arg("--nocapture")
        .env(HOLDER_DIR_ENV, dir)
        .env(HOLDER_READY_ENV, &ready)
        .env(HOLDER_RELEASE_ENV, release)
        .env(HOLDER_NAME_ENV, name)
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
    child
}

/// The repair path's safety rests entirely on deciding under the advisory lock —
/// proximity to the rename is not the guarantee, because a whole file copy and an
/// fsync run in between. This is what goes red if the decision ever escapes the
/// lock: with another process holding it, a publish must refuse outright rather
/// than inspect the installed binary and overwrite it.
#[cfg(unix)]
#[test]
fn a_repair_refuses_while_another_process_holds_the_install_lock() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let broken = crate::macho_fixtures::executable(
        &["@rpath/libwhisper.1.dylib"],
        &[],
        &[&dir.path().join("gone").to_string_lossy()],
    );
    let installed = bin.join("whisper-cli");
    std::fs::write(&installed, &broken).unwrap();
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755)).unwrap();
    let source = dir.path().join("rebuilt-whisper");
    std::fs::write(&source, b"repaired build").unwrap();
    let release = dir.path().join("holder-release");
    let mut holder = hold_the_lock_elsewhere(dir.path(), "whisper-cli", &release);

    let result = publish_built_executable(dir.path(), "whisper-cli", &source);

    assert!(
        matches!(result, Err(CoreError::Conflict(_))),
        "a locked install path must refuse, got {result:?}"
    );
    assert_eq!(
        std::fs::read(&installed).unwrap(),
        broken,
        "the installed binary must be untouched while another process holds the lock"
    );
    std::fs::write(&release, b"release").unwrap();
    holder.wait_success();
}

#[test]
fn advisory_lock_blocks_another_process_without_removing_the_owned_partial() {
    let dir = tempfile::tempdir().unwrap();
    let release = dir.path().join("holder-release");
    let mut child = hold_the_lock_elsewhere(dir.path(), DEFAULT_HOLDER_NAME, &release);

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
