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
//! per-publish-unique token cannot repeat, and needs no read-modify-write at all.
//!
//! **Reads fail closed.** Anything unreadable, unparsable, or otherwise unknown
//! resolves to `None`, which callers must treat as "may not reuse the cache" — a
//! spurious keychain read is the safe direction; a stale key is not.

use neuralnote_core::CoreError;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The sidecar, alongside the AI preference file and its lock.
const KEY_REVISION_FILE: &str = ".openrouter-key-revision";

/// Longest token accepted from disk. Tokens this module writes are ~40 bytes;
/// the ceiling exists so a hostile or corrupt file cannot be read wholesale into
/// a comparison on a hot path.
const MAX_TOKEN_BYTES: usize = 128;

/// What the sidecar said at one instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeyRevision {
    /// No sidecar: no instance has saved or cleared a key since this config
    /// directory existed, so nothing can have changed underneath a cached value.
    /// A distinct, self-equal state rather than "unknown", so the common case of
    /// an install that never configured a key still gets to cache.
    Unpublished,
    /// The token written by the most recent save or clear.
    Published(String),
}

/// The revision a cached key must still match to be reusable, or `None` when the
/// sidecar cannot be trusted — see the module note on failing closed.
pub(crate) fn observe(config_dir: &Path) -> Option<KeyRevision> {
    match read_capped(&config_dir.join(KEY_REVISION_FILE)) {
        Ok(contents) => match parse(&contents) {
            Some(revision) => Some(revision),
            None => {
                warn_once(|| unusable_sidecar(config_dir, "does not hold a valid revision"));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Some(KeyRevision::Unpublished)
        }
        Err(error) => {
            warn_once(|| unusable_sidecar(config_dir, &format!("could not be read: {error}")));
            None
        }
    }
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
    let staged = config_dir.join(format!("{KEY_REVISION_FILE}.{token}.tmp"));
    write_new_file(&staged, &token)?;
    std::fs::rename(&staged, config_dir.join(KEY_REVISION_FILE)).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        CoreError::Io(format!("could not publish the API key revision: {error}"))
    })?;
    Ok(KeyRevision::Published(token))
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
/// directory.
fn write_new_file(path: &Path, token: &str) -> Result<(), CoreError> {
    let staged = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    let mut staged = staged
        .map_err(|error| CoreError::Io(format!("could not stage the API key revision: {error}")))?;
    writeln!(staged, "{token}")
        .map_err(|error| CoreError::Io(format!("could not write the API key revision: {error}")))
}

/// Unique for every call in every process: the clock supplies uniqueness across
/// time, the process id across concurrent instances, and the sequence within one
/// process — so no two publishes can ever produce the same token, even if the
/// clock is broken or steps backwards.
fn next_token() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{}-{sequence}", std::process::id())
}

/// An unusable sidecar degrades performance rather than correctness, and
/// [`observe`] runs on polled status paths — so it is reported once per process
/// instead of on every read, which would bury the log it belongs in.
fn warn_once(message: impl FnOnce() -> String) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!("{}", message());
    }
}

#[cfg(test)]
#[path = "key_revision_tests.rs"]
mod tests;
