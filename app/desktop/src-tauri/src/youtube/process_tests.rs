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

/// Run one spec under a HANG detector rather than a latency budget.
///
/// The distinction is the whole of this file's flakiness history. What was here
/// before was `timeout(2s)` around a call that measured 470-890ms under
/// deliberate CPU and fork pressure (load average 23-46 on 14 cores) — a ceiling
/// barely 2-3x the cost of spawning a shell, so a busier box overran it while
/// the runner was working perfectly. That is a latency assertion, and no test
/// here means to make one; it went red 4-of-6 at an untouched baseline.
///
/// The runner bounds itself instead: every outcome these tests assert is
/// produced at or before the spec's own `timeout`, and the work after that
/// deadline — SIGKILL the group, reap, join the readers — measured 30-80ms under
/// the same load. [`TAIL_ALLOWANCE`] is that tail's budget at roughly 400x its
/// measured cost, and **no passing assertion depends on its value**. It exists
/// for one case that is otherwise unbounded: a runner that stopped terminating
/// its child leaves a flooding stub with no EOF to reach, which would hang
/// `cargo test` forever rather than fail. Verified by mutation — removing the
/// termination reaches this panic; removing the output bound does not need it,
/// because the runner's own deadline resolves that one by name.
///
/// This is the irreducible timing element in these tests, stated rather than
/// tuned around: a duration has to stand in for "not coming back at all".
#[cfg(unix)]
async fn run_bounded_by_hang_detector(
    command: &ProcessSpec,
    cancellation: &CaptureCancellation,
) -> Result<ProcessOutput, ProcessError> {
    /// How long past the runner's own deadline is no longer slowness.
    const TAIL_ALLOWANCE: Duration = Duration::from_secs(30);

    tokio::time::timeout(
        command.timeout + TAIL_ALLOWANCE,
        TokioProcessRunner.run(command, cancellation),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "the runner did not resolve within {TAIL_ALLOWANCE:?} of its own {:?} deadline, \
             so it is not terminating the child",
            command.timeout
        )
    })
}

/// A runner result rendered for a failure message, with buffer *lengths* where
/// `{:?}` would print buffer contents.
///
/// Captured output is 64 bytes when these tests pass and hundreds of megabytes
/// in the one world they exist to catch — a build that stopped bounding output,
/// which now reads a flooding stub until the runner's own deadline. A panic
/// nobody can scroll to the top of is the same dead end the destructuring in
/// `stdout_overflow_is_bounded_and_stops_the_child` was added to escape.
#[cfg(unix)]
fn outcome_label(result: &Result<ProcessOutput, ProcessError>) -> String {
    let sizes = |stdout: &[u8], stderr: &[u8]| {
        format!(
            "{} stdout bytes, {} stderr bytes",
            stdout.len(),
            stderr.len()
        )
    };
    match result {
        Ok(output) => format!(
            "Ok(exit {:?}, {})",
            output.status.code(),
            sizes(&output.stdout, &output.stderr)
        ),
        Err(error @ ProcessError::TimedOut { stdout, stderr, .. })
        | Err(error @ ProcessError::Cancelled { stdout, stderr })
        | Err(error @ ProcessError::OutputOverflow { stdout, stderr, .. }) => {
            format!("{error} ({})", sizes(stdout, stderr))
        }
        // Every remaining variant's `Display` carries its whole story and no
        // captured output, so it is safe to print as it stands.
        Err(error) => error.to_string(),
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

    // A hang detector, not a deadline the correct path has to beat — see
    // `run_bounded_by_hang_detector`. A build that stopped capping output reads
    // this flooding stub until `spec()`'s own timeout fires and returns
    // `TimedOut`, which the match below rejects by name, well inside it.
    let result = run_bounded_by_hang_detector(&command, &CaptureCancellation::default()).await;

    // Destructured rather than a single `matches!` so a failure names the clause. A
    // combined guard reports only "assertion failed" and drops every actual value,
    // which cost a full CI round-trip to get nowhere on 2026-08-10: the run went red
    // here, passed on re-run against identical code, and the panic carried no
    // evidence of which clause broke.
    match result {
        Err(ProcessError::OutputOverflow {
            stream,
            limit,
            stdout,
            stderr,
        }) => {
            assert_eq!(stream, OutputStream::Stdout);
            assert_eq!(limit, 64);
            // Guaranteed by construction, not a race: `read_bounded` caps each append
            // at `limit - retained.len()`, so the buffer cannot exceed the limit.
            assert_eq!(stdout.len(), 64, "stdout must be truncated at the limit");
            // The stub writes nothing to stderr and the child is SIGKILLed as a
            // process group, so this should hold — but it is the one clause here that
            // depends on timing rather than construction. If it ever trips, the
            // message is the evidence: it names what wrote, which static reading of
            // the runner could not explain.
            assert!(
                stderr.is_empty(),
                "expected no stderr from the overflow stub, got {:?}",
                String::from_utf8_lossy(&stderr),
            );
        }
        ref other => panic!(
            "expected a bounded stdout overflow, got {}",
            outcome_label(other)
        ),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn stderr_overflow_is_bounded_and_stops_the_child() {
    let script = stub_script("while :; do printf 'fedcba9876543210' >&2; done");
    let mut command = spec(&script.path);
    command.stderr_limit = 64;

    // Same detector, same reason, as its stdout twin above.
    let result = run_bounded_by_hang_detector(&command, &CaptureCancellation::default()).await;

    // Destructured like its stdout twin, and for the reason recorded there: the
    // `matches!` guard this replaces reported "assertion failed" and nothing
    // else, so the one time it went red it named neither the clause nor a value.
    match result {
        Err(ProcessError::OutputOverflow {
            stream,
            limit,
            ref stdout,
            ref stderr,
        }) => {
            assert_eq!(stream, OutputStream::Stderr);
            assert_eq!(limit, 64);
            // Guaranteed by construction: `read_bounded` caps each append at
            // `limit - retained.len()`, so the buffer cannot exceed the limit.
            assert_eq!(stderr.len(), 64, "stderr must be truncated at the limit");
            assert!(
                stdout.is_empty(),
                "expected no stdout from the overflow stub, got {:?}",
                String::from_utf8_lossy(stdout),
            );
        }
        ref other => panic!(
            "expected a bounded stderr overflow, got {}",
            outcome_label(other)
        ),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn timeout_kills_the_child_and_leaves_no_process_behind() {
    // Named for what it can prove. It used to be called
    // `timeout_kills_and_reaps_the_child`, and the reap half of that was a
    // promise this vantage point cannot keep: the runner's own reap — the
    // `child.wait()` in `terminate_process_tree` — is not observable from
    // outside `run()`, because tokio's `Reaper::drop` calls `try_wait()` on the
    // way out and collects any child that has already exited
    // (`tokio-1.53.1/src/process/unix/reap.rs:122`). The child is SIGKILLed
    // before that drop, so it is reaped either way and only the *identity of the
    // reaper* changes. Ablated to confirm rather than argued: deleting the
    // runner's `child.wait()` leaves this test green.
    //
    // What ablation does red, 3 runs of 3, is deleting the termination itself —
    // through the hang detector above rather than through the PID probe below,
    // because a child that is never killed never closes the pipes the runner is
    // still reading. That is why the kill survives in the name and the reap
    // does not.
    //
    // The child sleeps rather than spins. What this test needs is a child that
    // does not exit before the deadline; burning a whole core for the length of
    // that deadline adds nothing to any assertion here and adds real load to the
    // box they all then have to survive — three tests in this file used to do it
    // at once. `exec` keeps `$$`, the PID printed just above it, as the PID the
    // runner kills, and /bin/sleep is spelled absolutely because `spec()` clears
    // PATH. The 300s only has to outlast the deadline being tested.
    let script = stub_script("printf '%s\n' \"$$\"; exec /bin/sleep 300");
    let mut command = spec(&script.path);
    command.timeout = Duration::from_secs(3);

    // The runner's deadline is the subject here, and a monotonic sleep fires late
    // under load but never early, so nothing below measures elapsed time. What
    // this replaces — `timeout(8s)` — allowed 5s of scheduling around a 3s
    // deadline whose tail measures 30-80ms, which is a budget, not a detector.
    //
    // One irreducible timing element remains and is not tuned around: the child
    // must be scheduled once, to print its PID, inside the runner's own 3s
    // deadline. A box where spawning a shell takes three seconds fails here, and
    // that is a real signal rather than noise.
    let result = run_bounded_by_hang_detector(&command, &CaptureCancellation::default()).await;

    let Err(ProcessError::TimedOut {
        timeout,
        ref stdout,
        ref stderr,
    }) = result
    else {
        panic!("expected timeout, got {}", outcome_label(&result));
    };
    let (stdout, stderr) = (stdout.clone(), stderr.clone());
    let pid = String::from_utf8(stdout)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    assert_eq!(timeout, Duration::from_secs(3));
    assert!(stderr.is_empty());
    // Implied here rather than independently falsifiable — this stub holds its
    // inherited pipes until it dies, so the runner cannot have returned at all
    // unless the child was already gone. It is kept because the implication is
    // the runner's, not the child's: EOF means the write ends closed, which is
    // not the same fact as the process having exited. A runner that stopped
    // killing a child that closed its own output would return here with the
    // child still running, and this is the line that would catch it.
    assert!(
        !process_exists(pid),
        "the runner returned with timed-out child {pid} still present"
    );
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
async fn cancellation_kills_the_child_before_it_can_complete() {
    // Renamed for the same reason as `timeout_kills_the_child_and_leaves_no_
    // process_behind` above, and on the same evidence: cancellation terminates
    // through the same `terminate_process_tree`, so its reap is equally beyond
    // this vantage point. The ablation was run across the whole file at once —
    // deleting the runner's `child.wait()` leaves all ten of these green.
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
    assert!(
        !process_exists(pid),
        "the runner returned with cancelled child {pid} still present"
    );
}
