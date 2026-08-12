//! Two-instance acceptance tests for the API-key cache (issue #132).
//!
//! The defect is a **process-lifetime** cache: two running instances of the app
//! disagree about the stored key until one restarts. That is invisible to every
//! single-process test in `ai.rs` — a fake keychain, a fake clock or a "second
//! instance" simulated by resetting a static all share one `API_KEY_CACHE`, so
//! they would pass against the broken code. These tests therefore use the only
//! instrument that can see the bug: **two genuinely separate OS processes**,
//! talking to the **real OS keychain**, through the **real revision sidecar**.
//!
//! Each process is this same test binary, re-executed with
//! [`WORKER_CONFIG_DIR_ENV`] set, which makes it run [`key_revision_worker_process`]
//! as a tiny command loop over stdin/stdout. Same executable on both sides is
//! deliberate: macOS grants keychain access per code identity, so parent and
//! children share one, and no access prompt is provoked.
//!
//! The developer's real credential is never touched — every worker is redirected
//! to a throwaway account by [`TEST_KEYCHAIN_ACCOUNT_SUFFIX_ENV`], unique per run,
//! and [`Throwaway`] deletes it on the way out even when a test panics.

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Set on a child to turn it into a worker. Its value is the config directory the
/// worker publishes and observes key revisions in.
const WORKER_CONFIG_DIR_ENV: &str = "NEURALNOTE_KEY_REVISION_WORKER_DIR";

/// Prefix on every worker reply. libtest's own chatter shares the pipe under
/// `--nocapture`, so replies are marked rather than positional.
const WORKER_REPLY: &str = "#worker#";

/// Full path of the worker test, as libtest names it for `--exact`.
const WORKER_TEST: &str = "ai::key_revision_tests::key_revision_worker_process";

/// How long a worker gets to answer. Generous: this is a hang detector, not a
/// performance assertion — the failure it exists to name is a keychain access
/// prompt waiting for a human that no automated run will ever answer.
const WORKER_TIMEOUT: Duration = Duration::from_secs(30);

const NO_KEY: &str = "<none>";

/* ─────────────────────────────  the worker  ─────────────────────────────── */

/// One running "instance of the app": a command loop over the same keychain and
/// revision code the shell uses.
///
/// Registered as an ignored test so it is never run by a normal suite, and it
/// exits immediately unless [`WORKER_CONFIG_DIR_ENV`] marks this process as a
/// worker — so `cargo test -- --ignored` cannot leave it blocked on stdin.
#[test]
#[ignore = "spawned as a child process by the two-instance acceptance tests"]
fn key_revision_worker_process() {
    let Ok(config_dir) = std::env::var(WORKER_CONFIG_DIR_ENV) else {
        return;
    };
    serve_worker_commands(Path::new(&config_dir));
}

fn serve_worker_commands(config_dir: &Path) {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let request = line.trim();
        let (command, argument) = request.split_once(' ').unwrap_or((request, ""));
        let reply = match command {
            "read" => match read_api_key(config_dir) {
                Ok(Some(key)) => format!("key {key}"),
                Ok(None) => format!("key {NO_KEY}"),
                Err(error) => format!("error {error:?}"),
            },
            "save" => match set_keychain_api_key(config_dir, argument) {
                Ok(()) => "ok".to_string(),
                Err(error) => format!("error {error:?}"),
            },
            "clear" => match clear_keychain_api_key(config_dir) {
                Ok(()) => "ok".to_string(),
                Err(error) => format!("error {error:?}"),
            },
            "quit" => return,
            other => format!("error unknown command {other:?}"),
        };
        println!("{WORKER_REPLY}{reply}");
        let _ = std::io::stdout().flush();
    }
}

/* ────────────────────────────  the parent side  ─────────────────────────── */

/// A running instance, as the test drives it.
struct Instance {
    name: &'static str,
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<String>,
}

impl Instance {
    fn spawn(name: &'static str, throwaway: &Throwaway) -> Self {
        Self::try_spawn(name, throwaway)
            .unwrap_or_else(|error| panic!("could not start instance {name}: {error}"))
    }

    fn try_spawn(name: &'static str, throwaway: &Throwaway) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut child = Command::new(executable)
            .args([
                "--exact",
                WORKER_TEST,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(WORKER_CONFIG_DIR_ENV, throwaway.config_dir())
            .env(TEST_KEYCHAIN_ACCOUNT_SUFFIX_ENV, &throwaway.suffix)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("child stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("child stdout was not piped")?;
        let (replies_tx, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // Anywhere in the line, not just at its start: libtest writes the
                // "test <name> ... " progress line WITHOUT a trailing newline, so
                // the first reply lands on the end of it.
                if let Some((_, reply)) = line.split_once(WORKER_REPLY) {
                    if replies_tx.send(reply.to_string()).is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Self {
            name,
            child,
            stdin,
            replies,
        })
    }

    fn ask(&mut self, command: &str) -> String {
        self.try_ask(command)
            .unwrap_or_else(|error| panic!("instance {}: {error}", self.name))
    }

    fn try_ask(&mut self, command: &str) -> Result<String, String> {
        writeln!(self.stdin, "{command}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        match self.replies.recv_timeout(WORKER_TIMEOUT) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => Err(format!(
                "no answer to {command:?} within {WORKER_TIMEOUT:?} — the instance is wedged; on \
                 macOS the usual cause is a keychain access prompt waiting for a human"
            )),
            Err(RecvTimeoutError::Disconnected) => {
                Err(format!("died before answering {command:?}"))
            }
        }
    }

    /// The key this instance would send on its next provider request.
    fn key_for_next_request(&mut self) -> String {
        let reply = self.ask("read");
        reply
            .strip_prefix("key ")
            .unwrap_or_else(|| panic!("instance {} could not read the key: {reply}", self.name))
            .to_string()
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/* ──────────────────────  the throwaway credential  ──────────────────────── */

/// A keychain account and config directory that belong to one test run, removed
/// on the way out — including when the test panics, since the credential outlives
/// the process that created it.
struct Throwaway {
    suffix: String,
    directory: tempfile::TempDir,
}

impl Throwaway {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0);
        Self {
            suffix: format!("{label}-{}-{nanos}", std::process::id()),
            directory: tempfile::tempdir().expect("a temp config dir"),
        }
    }

    fn config_dir(&self) -> &Path {
        self.directory.path()
    }
}

impl Drop for Throwaway {
    /// Best effort and never panicking (this runs during unwind), but never
    /// silent either: a credential we failed to remove is named on stderr so it
    /// can be deleted by hand.
    fn drop(&mut self) {
        let cleared =
            Instance::try_spawn("cleanup", self).and_then(|mut instance| instance.try_ask("clear"));
        match cleared.as_deref() {
            Ok("ok") => {}
            Ok(unexpected) => eprintln!(
                "LEFTOVER TEST CREDENTIAL: account suffix {:?} could not be cleared: {unexpected}",
                self.suffix
            ),
            Err(error) => eprintln!(
                "LEFTOVER TEST CREDENTIAL: account suffix {:?} could not be cleared: {error}",
                self.suffix
            ),
        }
    }
}

/* ─────────────────────────────  the tests  ──────────────────────────────── */

#[test]
fn a_second_instance_observes_a_saved_key_before_its_next_request() {
    let throwaway = Throwaway::new("save");
    let mut first = Instance::spawn("A", &throwaway);
    let mut second = Instance::spawn("B", &throwaway);

    assert_eq!(first.ask("save sk-or-seeded"), "ok");
    // Both instances read the seeded key, which is what fills both in-memory
    // caches — the state that goes stale.
    assert_eq!(first.key_for_next_request(), "sk-or-seeded");
    assert_eq!(second.key_for_next_request(), "sk-or-seeded");

    assert_eq!(first.ask("save sk-or-rotated"), "ok");

    assert_eq!(
        second.key_for_next_request(),
        "sk-or-rotated",
        "the second instance must send the newly saved key on its next request, \
         not the key it cached before the save"
    );
}

#[test]
fn a_second_instance_observes_a_cleared_key_before_its_next_request() {
    let throwaway = Throwaway::new("clear");
    let mut first = Instance::spawn("A", &throwaway);
    let mut second = Instance::spawn("B", &throwaway);

    assert_eq!(first.ask("save sk-or-revoked"), "ok");
    assert_eq!(first.key_for_next_request(), "sk-or-revoked");
    assert_eq!(second.key_for_next_request(), "sk-or-revoked");

    assert_eq!(first.ask("clear"), "ok");

    assert_eq!(
        second.key_for_next_request(),
        NO_KEY,
        "the second instance must stop sending a key the user revoked, rather than \
         keep working until it restarts"
    );
}
