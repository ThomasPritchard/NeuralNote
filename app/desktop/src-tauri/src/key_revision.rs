//! The cross-process invalidation marker for the cached OpenRouter API key.
//!
//! The key itself lives in the OS keychain and is read at call time, but reading
//! it costs an XPC round trip to `securityd`, and `ai::read_api_key` sits on hot
//! status paths rather than only on provider-request paths. So the shell caches
//! the value in memory — and a process-lifetime cache is exactly how two running
//! instances came to disagree about the key until one restarted (issue #132).
//!
//! This module is the cheap, shared piece of state that lets the cache be
//! correct: a **non-secret** sidecar file in the AI config directory holding one
//! opaque *revision token*. Every save and clear publishes a fresh token; a
//! reader may reuse its cached key only while the token it cached against is
//! still the one on disk. The file never holds the key, and never holds whether a
//! key exists — the keychain stays the only source of truth for the secret, and
//! anyone reading the sidecar learns only that *something* changed and when.
//!
//! **A token, not a counter.** Ordering is never compared here, only equality, and
//! a counter buys nothing for that while costing correctness in two ways: two
//! instances saving at once read the same previous value and would publish the
//! same next one, and a config directory that is deleted and recreated restarts
//! the count, so a live instance could hold a cached token that a later, unrelated
//! save reproduces. Both are ABA hazards that silently resurrect a stale key. A
//! per-publish-unique token needs no read-modify-write at all, and repeats only
//! under a clock that hands a restarted process an instant an earlier one already
//! used — see [`next_token`], which states exactly what that rests on.
//!
//! **Reads fail closed, with one carve-out.** Anything unreadable, unparsable or
//! otherwise unknown resolves to `None`, which callers must treat as "may not reuse
//! the cache" — a spurious keychain read is the safe direction, a stale key is not.
//! The carve-out is a sidecar that has never existed: until this process has seen
//! one published in that directory, its absence is [`KeyRevision::Unpublished`], a
//! cacheable state of its own. Afterwards, an absence means the file was *removed*,
//! which would otherwise complete an `Unpublished → Published → Unpublished` round
//! trip that compares equal at both ends — so from then on it fails closed like
//! everything else.

use neuralnote_core::CoreError;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The sidecar, alongside the AI preference file and its lock.
const KEY_REVISION_FILE: &str = ".openrouter-key-revision";

/// Longest token accepted from disk. Tokens this module writes are ~40 bytes;
/// the ceiling exists so a hostile or corrupt file cannot be read wholesale into
/// a comparison on a hot path.
const MAX_TOKEN_BYTES: usize = 128;

/// How long a directory's sidecar complaint stays quiet before it repeats. Long
/// enough that a permanently unusable sidecar cannot flood a polled path's log,
/// short enough that it is still visible in a session's worth of one.
const WARN_INTERVAL: Duration = Duration::from_secs(300);

/// What the sidecar said at one instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyRevision {
    /// No sidecar, and none seen in this directory since the process started: no
    /// instance has saved or cleared a key, so nothing can have changed underneath
    /// a cached value. A distinct, self-equal state rather than "unknown", so the
    /// common case of an install that never configured a key still gets to cache.
    ///
    /// Only reachable *before* the first published revision is observed, which is
    /// what stops it reopening the ABA a unique token exists to close: afterwards
    /// a missing sidecar means one was removed, and resolves to `None`.
    Unpublished,
    /// The token written by the most recent save or clear.
    Published(String),
}

/// The revision a cached key must still match to be reusable, or `None` when the
/// sidecar cannot be trusted — see the module note on failing closed.
pub(crate) fn observe(config_dir: &Path) -> Option<KeyRevision> {
    match read_capped(&config_dir.join(KEY_REVISION_FILE)) {
        Ok(contents) => match parse(&contents) {
            Some(revision) => {
                remember_published(config_dir);
                Some(revision)
            }
            None => {
                warn_about_sidecar(config_dir, || "does not hold a valid revision".to_string());
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if has_ever_published(config_dir) {
                warn_about_sidecar(config_dir, || {
                    "was published earlier but is now gone".to_string()
                });
                return None;
            }
            Some(KeyRevision::Unpublished)
        }
        Err(error) => {
            warn_about_sidecar(config_dir, || format!("could not be read: {error}"));
            None
        }
    }
}

/// Config directories this process has seen a published revision in — one entry in
/// a running app, which only ever has one; the test binary is what makes it a set.
static PUBLISHED_DIRECTORIES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn published_directories() -> MutexGuard<'static, HashSet<PathBuf>> {
    PUBLISHED_DIRECTORIES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record that this directory has a revision on disk, so a later *absence* of the
/// sidecar can be told apart from one that was never there. Latching this way, and
/// never unlatching, is what keeps [`KeyRevision::Unpublished`] safe to cache: it
/// stays reachable only while the round trip that would resurrect a stale key is
/// still impossible.
fn remember_published(config_dir: &Path) {
    let mut published = published_directories();
    if !published.contains(config_dir) {
        published.insert(config_dir.to_path_buf());
    }
}

fn has_ever_published(config_dir: &Path) -> bool {
    published_directories().contains(config_dir)
}

/// The operator-facing explanation for a sidecar that cannot be trusted: what is
/// wrong, where it is, and what it costs until someone fixes it. Built apart from
/// the logging so its content can be asserted — a warning that fails to say which
/// file, or why it matters, is barely better than silence.
fn unusable_sidecar(config_dir: &Path, problem: &str) -> String {
    format!(
        "the API key revision file in {} {problem}; running instances will re-read the OS \
         keychain on every check until it is repaired or removed",
        config_dir.display()
    )
}

/// Read no more than one token's worth, whatever the file turns out to be. This
/// runs on a polled path against a file any local process can replace, so the
/// length limit has to bound the *read*, not just the value: `read_to_string`
/// would happily pull a multi-gigabyte file into memory before the check.
fn read_capped(path: &Path) -> std::io::Result<String> {
    use std::io::Read;

    let mut contents = String::new();
    std::fs::File::open(path)?
        .take(MAX_TOKEN_BYTES as u64 + 1)
        .read_to_string(&mut contents)?;
    Ok(contents)
}

/// Publish a revision nothing has seen before, so every instance — the caller's
/// included — must re-read the keychain before it trusts a cached key again.
///
/// The write is atomic (a fresh file renamed over the old one), so a reader can
/// never observe a half-written token, and a crash mid-publish leaves either the
/// previous revision or the new one. It is deliberately not `fsync`ed: the sidecar
/// only has to outlive the running instances that share it, and after a reboot
/// every cache starts empty anyway.
pub(crate) fn publish(config_dir: &Path) -> Result<KeyRevision, CoreError> {
    std::fs::create_dir_all(config_dir).map_err(|error| {
        CoreError::Io(format!(
            "could not create the AI config directory for the key revision: {error}"
        ))
    })?;
    let token = next_token();
    let staged_path = config_dir.join(format!("{KEY_REVISION_FILE}.{token}.tmp"));
    let staged = write_new_file(&staged_path, &token)?;
    std::fs::rename(&staged_path, config_dir.join(KEY_REVISION_FILE)).map_err(|error| {
        CoreError::Io(format!("could not publish the API key revision: {error}"))
    })?;
    staged.claim();
    remember_published(config_dir);
    Ok(KeyRevision::Published(token))
}

/// A staged sidecar write, removed on drop unless the rename claimed it. Every way
/// out of [`publish`] once the file exists then reaps it the same way — only the
/// rename branch used to, so a `create_new` that succeeded followed by a write that
/// failed (a full disk) left a zero-byte file behind that nothing ever collects, in
/// a directory the user can open.
struct StagedFile(Option<PathBuf>);

impl StagedFile {
    /// Take responsibility for a file this call has just created. Never handed a
    /// path that was already there: reaping is only ever ours to do.
    fn ours(path: &Path) -> Self {
        Self(Some(path.to_path_buf()))
    }

    /// The rename took the file; there is nothing left to remove.
    fn claim(mut self) {
        self.0 = None;
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn parse(contents: &str) -> Option<KeyRevision> {
    let token = contents.trim();
    let well_formed = !token.is_empty()
        && token.len() <= MAX_TOKEN_BYTES
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    well_formed.then(|| KeyRevision::Published(token.to_string()))
}

/// `create_new` refuses to follow a symlink or clobber an existing file, so a
/// staged write can never be redirected onto something else in a shared config
/// directory. It is also the line that makes the file *ours*: everything after it
/// is guarded by [`StagedFile`], and nothing before it can remove a file this call
/// did not create.
fn write_new_file(path: &Path, token: &str) -> Result<StagedFile, CoreError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| CoreError::Io(format!("could not stage the API key revision: {error}")))?;
    let staged = StagedFile::ours(path);
    writeln!(file, "{token}")
        .map_err(|error| CoreError::Io(format!("could not write the API key revision: {error}")))?;
    Ok(staged)
}

/// Unique for every call within one process (the sequence) and among processes
/// running at the same time (the process id). Across process *restarts* it rests
/// entirely on the clock: a pid can be reused and the sequence restarts at zero, so
/// a clock that hands a later run an instant an earlier one already used — stepped
/// backwards, or set before the epoch, where `duration_since` fails and the reading
/// collapses to 0 for every call — can reproduce that run's token. Stated rather
/// than defended: closing it needs a source of entropy, and reaching it needs a
/// third instance that cached the repeated token and stayed alive across both runs.
fn next_token() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{}-{sequence}", std::process::id())
}

/// Report a sidecar this process cannot trust. An unusable one degrades performance
/// rather than correctness, and [`observe`] runs on polled status paths, so this is
/// suppressed between complaints — a line per poll would bury the log it belongs in.
///
/// Suppressed per config directory and per interval, rather than once per process.
/// A single unkeyed latch is spent by the first transient failure at startup, and a
/// sidecar that goes permanently corrupt afterwards then costs a keychain round trip
/// per status poll for the rest of the run with nothing in the log to say why.
fn warn_about_sidecar(config_dir: &Path, problem: impl FnOnce() -> String) {
    if warning_is_due(config_dir, Instant::now()) {
        log::warn!("{}", unusable_sidecar(config_dir, &problem()));
    }
}

/// When each config directory last had a complaint logged about it.
static LAST_WARNED: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

/// Whether this directory's complaint is due now, recording it when it is. Split
/// from the logging so the suppression can be asserted at an arbitrary instant
/// rather than by waiting out a real interval.
fn warning_is_due(config_dir: &Path, now: Instant) -> bool {
    let mut warned = LAST_WARNED
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match warned.get(config_dir) {
        Some(last) if now.saturating_duration_since(*last) < WARN_INTERVAL => false,
        _ => {
            warned.insert(config_dir.to_path_buf(), now);
            true
        }
    }
}

#[cfg(test)]
#[path = "key_revision_tests.rs"]
mod tests;
