use super::*;
use neuralnote_core::ai::CaptureCancellation;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
struct StubScript {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

#[cfg(unix)]
fn stub_script(body: &str) -> StubScript {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("create stub directory");
    let path = dir.path().join("stub-process");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).expect("write stub");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("make stub executable");
    StubScript { _dir: dir, path }
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 does not deliver a signal; it only probes this numeric PID.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(unix)]
async fn process_disappears_within(pid: i32, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !process_exists(pid) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        // A killed grandchild is reaped by its new parent, not by this runner.
        // Under host load it can remain briefly observable as a zombie.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn spec(program: impl Into<PathBuf>) -> ProcessSpec {
    ProcessSpec {
        program: program.into(),
        args: Vec::new(),
        cwd: None,
        environment: EnvironmentPolicy::ClearAndSet(BTreeMap::new()),
        // Workspace tests run hundreds of cases concurrently; this is only the
        // default for quick-success stubs, not a production process timeout.
        timeout: Duration::from_secs(10),
        stdout_limit: 1_024,
        stderr_limit: 1_024,
    }
}

#[tokio::test]
async fn relative_program_is_rejected_before_spawn() {
    let result = TokioProcessRunner
        .run(
            &spec(PathBuf::from("relative/program")),
            &CaptureCancellation::default(),
        )
        .await;

    assert!(matches!(
        result,
        Err(ProcessError::ProgramNotAbsolute { program })
            if program == std::path::Path::new("relative/program")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn argv_is_passed_exactly_including_leading_dash_data_after_separator() {
    let script = stub_script(r#"for arg in "$@"; do printf '%s\n' "$arg"; done"#);
    let mut command = spec(&script.path);
    command.args = ["--mode", "metadata", "--", "-abcdefghij"]
        .into_iter()
        .map(OsString::from)
        .collect();

    let output = TokioProcessRunner
        .run(&command, &CaptureCancellation::default())
        .await
        .expect("stub should run");

    assert_eq!(output.stdout, b"--mode\nmetadata\n--\n-abcdefghij\n");
}

#[cfg(unix)]
#[tokio::test]
async fn clear_environment_sets_only_the_explicit_sanitized_path() {
    let script = stub_script(r#"printf '%s\n%s\n' "${PATH-unset}" "${HOME-unset}""#);
    let mut command = spec(&script.path);
    command.environment = EnvironmentPolicy::ClearAndSet(BTreeMap::from([(
        OsString::from("PATH"),
        OsString::from("/usr/bin:/bin"),
    )]));

    let output = TokioProcessRunner
        .run(&command, &CaptureCancellation::default())
        .await
        .expect("stub should run");

    assert_eq!(output.stdout, b"/usr/bin:/bin\nunset\n");
}

#[cfg(unix)]
#[tokio::test]
async fn configured_working_directory_is_used() {
    let script = stub_script("pwd");
    let cwd = tempfile::tempdir().expect("create working directory");
    let mut command = spec(&script.path);
    command.cwd = Some(cwd.path().to_path_buf());

    let output = TokioProcessRunner
        .run(&command, &CaptureCancellation::default())
        .await
        .expect("stub should run");

    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        cwd.path().canonicalize().unwrap().to_string_lossy()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn nonzero_exit_preserves_status_and_both_output_streams() {
    let script = stub_script("printf 'partial'; printf 'failed' >&2; exit 17");

    let output = TokioProcessRunner
        .run(&spec(&script.path), &CaptureCancellation::default())
        .await
        .expect("a child exit is output, not a runner failure");

    assert_eq!(output.status.code(), Some(17));
    assert_eq!(output.stdout, b"partial");
    assert_eq!(output.stderr, b"failed");
}

#[cfg(unix)]
#[tokio::test]
async fn stdout_overflow_is_bounded_and_stops_the_child() {
    let script = stub_script("while :; do printf '0123456789abcdef'; done");
    let mut command = spec(&script.path);
    command.stdout_limit = 64;

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        TokioProcessRunner.run(&command, &CaptureCancellation::default()),
    )
    .await
    .expect("overflow must stop a noisy process");

    assert!(matches!(
        result,
        Err(ProcessError::OutputOverflow {
            stream: OutputStream::Stdout,
            limit: 64,
            stdout,
            stderr,
        }) if stdout.len() == 64 && stderr.is_empty()
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn stderr_overflow_is_bounded_and_stops_the_child() {
    let script = stub_script("while :; do printf 'fedcba9876543210' >&2; done");
    let mut command = spec(&script.path);
    command.stderr_limit = 64;

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        TokioProcessRunner.run(&command, &CaptureCancellation::default()),
    )
    .await
    .expect("overflow must stop a noisy process");

    assert!(matches!(
        result,
        Err(ProcessError::OutputOverflow {
            stream: OutputStream::Stderr,
            limit: 64,
            stdout,
            stderr,
        }) if stderr.len() == 64 && stdout.is_empty()
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_kills_and_reaps_the_child() {
    let script = stub_script("printf '%s\n' \"$$\"; while :; do :; done");
    let mut command = spec(&script.path);
    command.timeout = Duration::from_secs(3);

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        TokioProcessRunner.run(&command, &CaptureCancellation::default()),
    )
    .await
    .expect("runner timeout must resolve");

    let Err(ProcessError::TimedOut {
        timeout,
        stdout,
        stderr,
    }) = result
    else {
        panic!("expected timeout, got {result:?}");
    };
    let pid = String::from_utf8(stdout)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    assert_eq!(timeout, Duration::from_secs(3));
    assert!(stderr.is_empty());
    assert!(!process_exists(pid), "timed-out child {pid} must be reaped");
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_remains_active_until_inherited_output_pipes_close() {
    let mut command = spec("/bin/sh");
    command.args = ["-c", r#"/bin/sleep 5 & printf '%s\n' "$!""#]
        .into_iter()
        .map(OsString::from)
        .collect();
    command.timeout = Duration::from_millis(200);

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        TokioProcessRunner.run(&command, &CaptureCancellation::default()),
    )
    .await
    .expect("inherited pipes must remain under the runner deadline");

    let Err(ProcessError::TimedOut { stdout, .. }) = result else {
        panic!("expected timeout, got {result:?}");
    };
    let descendant_pid = String::from_utf8(stdout)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    assert!(
        process_disappears_within(descendant_pid, Duration::from_secs(1)).await,
        "timed-out descendant {descendant_pid} must be terminated"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_kills_and_reaps_before_process_completion() {
    let script =
        stub_script("printf '%s\n' \"$$\"; printf '%s\n' \"$$\" > \"$1\"; while :; do :; done");
    let readiness = tempfile::tempdir().expect("create readiness directory");
    let ready_path = readiness.path().join("child-ready");
    let mut command = spec(&script.path);
    command.args = vec![ready_path.as_os_str().to_owned()];
    command.timeout = Duration::from_secs(5);
    let cancellation = CaptureCancellation::default();
    let cancel_from_task = cancellation.clone();
    tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if tokio::fs::read_to_string(&ready_path)
                    .await
                    .is_ok_and(|pid| !pid.trim().is_empty())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stub process must announce readiness");
        cancel_from_task.cancel();
    });

    let result = tokio::time::timeout(
        Duration::from_secs(4),
        TokioProcessRunner.run(&command, &cancellation),
    )
    .await
    .expect("cancellation must resolve before the process can complete");

    let Err(ProcessError::Cancelled { stdout, stderr }) = result else {
        panic!("expected cancellation, got {result:?}");
    };
    let pid = String::from_utf8(stdout)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    assert!(stderr.is_empty());
    assert!(!process_exists(pid), "cancelled child {pid} must be reaped");
}
