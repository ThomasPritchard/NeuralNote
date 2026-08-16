//! The AI plumbing for the desktop shell — the host side of the client-agnostic
//! `neuralnote_core::ai` seam.
//!
//! Three responsibilities live here, all OS/transport concerns the core stays free
//! of: the **OS keychain** for the BYO API key (the key is read in Rust at call
//! time and NEVER returned to the webview), the **OpenRouter HTTP client**
//! (`reqwest`, OpenAI-compatible) implementing [`LlmClient`], and a
//! [`TauriChannelSink`] that forwards [`ChatEvent`]s to the frontend over a Tauri
//! channel. The `#[tauri::command]`s that expose this are in `commands/ai.rs`.

use crate::key_revision::{self, KeyRevision};

use async_trait::async_trait;
use futures_util::StreamExt;
use neuralnote_core::ai::approval::{self, ToolApprovalSubject};
use neuralnote_core::ai::tool_turn_reader::{StreamedToolTurn, ToolTurnReader};
use neuralnote_core::ai::{openai, provider_config, tool_stream};
use neuralnote_core::ai::{
    openrouter_reasoning_support, parse_openrouter_context_windows, parse_openrouter_input_pricing,
    ChatEvent, Completion, EventSink, LlmClient, LlmMessage, LlmRequest, ReasoningSupport,
    RetryDelay, Role, TokenUsage,
};
use neuralnote_core::capture::ModelPricing;
use neuralnote_core::CoreError;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use ts_rs::TS;

/// OpenRouter's OpenAI-compatible chat-completions endpoint.
const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// OpenRouter's public model catalogue (no key, no auth header).
const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";

/// Keychain identity for the secret API key.
const KEYCHAIN_SERVICE: &str = "com.neuralnote.desktop";
const KEY_ACCOUNT: &str = "openrouter-api-key";
const E2E_KEYCHAIN_SERVICE: &str = "com.neuralnote.desktop.e2e";
const E2E_KEY_ACCOUNT: &str = "openrouter-api-key-e2e";

/// The bundle identifier this build is actually running as, bound once by the
/// shell's `setup()` hook (see [`init_keychain_service`]). It is what keeps a
/// separately-identified build — the `com.neuralnote.desktop.dev` smoke bundle —
/// out of the shipped app's credential namespace.
static KEYCHAIN_SERVICE_OVERRIDE: OnceLock<String> = OnceLock::new();

/// The running build could not name itself, so its credential namespace cannot be
/// derived. Fatal on purpose: carrying on means falling back to the shipped app's
/// namespace, which is the very defect a per-identity namespace prevents.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BlankBundleIdentifier;

impl std::fmt::Display for BlankBundleIdentifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the running bundle identifier is blank, so this build's keychain namespace cannot be \
             derived; refusing to start rather than binding it to the shipped app's credential \
             under '{KEYCHAIN_SERVICE}'"
        )
    }
}

impl std::error::Error for BlankBundleIdentifier {}

/// Bind `slot` to a bundle identifier. The slot is injected rather than read from
/// the static so the rules below are testable without a process-global race.
///
/// A blank identifier is an error, not a fallback: an empty namespace is not a
/// safer default than the historical one, and the historical one is the shipped
/// app's. Only the first non-blank value is kept, so nothing can move the
/// namespace out from under a session that has already read a key — a rejected
/// rebind is logged rather than fatal, because the namespace already in force is
/// a real one.
fn bind_identifier(slot: &OnceLock<String>, identifier: &str) -> Result<(), BlankBundleIdentifier> {
    let identifier = identifier.trim();
    if identifier.is_empty() {
        return Err(BlankBundleIdentifier);
    }
    if let Err(rejected) = slot.set(identifier.to_string()) {
        let bound = slot.get().map_or(KEYCHAIN_SERVICE, String::as_str);
        if rejected != bound {
            log::warn!("keychain namespace already bound to {bound}; ignoring {rejected}");
        }
    }
    Ok(())
}

/// Bind the credential namespace to the running app's bundle identifier. Called
/// once from the shell's Tauri `setup()` hook, before any command can read a key.
///
/// The resolved service is logged because "the dev build forgot my API key" has
/// exactly one first question — which keychain service did this process use — and
/// nothing else in a shipped run answers it. A service name is a bundle
/// identifier, never a secret; the account name and the key itself stay out of
/// the log.
pub(crate) fn init_keychain_service(identifier: &str) -> Result<(), BlankBundleIdentifier> {
    bind_identifier(&KEYCHAIN_SERVICE_OVERRIDE, identifier)
        .inspect_err(|error| log::error!("{error}"))?;
    log::info!("keychain namespace bound to {}", keychain_service());
    Ok(())
}

/// Which keychain service this build uses, given whatever identifier was bound.
/// Pure, so the resolution order is provable without a running Tauri app.
///
/// The `native-e2e` feature wins outright: an automation build must be unable to
/// reach a real user's keychain item whatever identifier its configuration
/// carries. Otherwise the bound bundle identifier wins, so a build with its own
/// app identity gets its own namespace. With nothing bound — unit tests, or any
/// call before `setup()` — the historical constant keeps behaviour deterministic.
fn resolve_keychain_service(bound_identifier: Option<&str>) -> &str {
    if cfg!(feature = "native-e2e") {
        return E2E_KEYCHAIN_SERVICE;
    }
    bound_identifier.unwrap_or(KEYCHAIN_SERVICE)
}

fn keychain_service() -> &'static str {
    resolve_keychain_service(KEYCHAIN_SERVICE_OVERRIDE.get().map(String::as_str))
}

const fn compiled_keychain_account() -> &'static str {
    if cfg!(feature = "native-e2e") {
        E2E_KEY_ACCOUNT
    } else {
        KEY_ACCOUNT
    }
}

#[cfg(not(test))]
fn keychain_account() -> &'static str {
    compiled_keychain_account()
}

/// Name of the environment variable a test process sets to move itself off the
/// real credential. Test builds only — see [`keychain_account`].
#[cfg(test)]
pub(crate) const TEST_KEYCHAIN_ACCOUNT_SUFFIX_ENV: &str = "NEURALNOTE_TEST_KEYCHAIN_ACCOUNT_SUFFIX";

/// The keychain account this process reads and writes.
///
/// Test builds honour [`TEST_KEYCHAIN_ACCOUNT_SUFFIX_ENV`] so a test that needs the
/// *real* OS keychain (the two-instance acceptance tests in
/// `ai_key_revision_tests.rs`, which cannot fake the process boundary) gets a
/// throwaway credential of its own instead of the developer's. The seam is a
/// suffix, never a whole account name: whatever the variable says, the result is
/// `<compiled account>-test-<sanitised suffix>`, so it can never resolve to the
/// production account, and it does not exist outside `cfg(test)` at all.
///
/// Resolved once per process — a worker sets the variable in the child's
/// environment before exec, which is the only supported way to use it. Setting it
/// from inside a running process after the first keychain touch has no effect.
#[cfg(test)]
fn keychain_account() -> &'static str {
    static ACCOUNT: OnceLock<Option<String>> = OnceLock::new();
    ACCOUNT
        .get_or_init(|| {
            std::env::var(TEST_KEYCHAIN_ACCOUNT_SUFFIX_ENV)
                .ok()
                .map(|suffix| throwaway_keychain_account(&suffix))
        })
        .as_deref()
        .unwrap_or_else(compiled_keychain_account)
}

/// Derive a throwaway account from a requested suffix. Whatever arrives — empty,
/// a path, punctuation — the result keeps the `-test-` infix and drops everything
/// that is not alphanumeric or a dash, so no value of the environment variable can
/// steer a test onto the production credential.
#[cfg(test)]
fn throwaway_keychain_account(suffix: &str) -> String {
    let sanitised: String = suffix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let sanitised = if sanitised.is_empty() {
        "unnamed"
    } else {
        &sanitised
    };
    format!("{}-test-{sanitised}", compiled_keychain_account())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiKeyStatus {
    pub has_key: bool,
    pub model: String,
}

/// What a save or clear reports beyond "it worked". The keychain change itself is
/// committed by the time this is returned; this carries the *other* guarantee —
/// whether every other running instance was told to stop trusting what it cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyChangeOutcome {
    /// `false` when the cross-process revision could not be published on one or
    /// both sides of the keychain change. The key really is stored (or really is
    /// gone), but another running instance keeps using the previous one until it
    /// restarts — so this must not be reported as an unqualified success, least
    /// of all for a revocation, where the user believes they revoked access.
    pub revision_published: bool,
}

/// A key read from the keychain, and the [`KeyRevision`] it was read under. The
/// revision is what makes reuse safe across processes: it is republished by every
/// save and clear, so a value cached against an older one can never be served.
struct CachedKey {
    revision: KeyRevision,
    key: Option<String>,
}

struct CacheState {
    generation: u64,
    cached: Option<CachedKey>,
}

/// The in-memory key cache. It exists because [`read_api_key`] is called from
/// polled status paths, not only from provider-request paths, and each keychain
/// read is an XPC round trip. It is bound to the cross-process revision in
/// `key_revision` so it can no longer outlive the truth (issue #132).
static API_KEY_CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();
static OPENROUTER_PRICING_CACHE: OnceLock<Mutex<BTreeMap<String, ModelPricing>>> = OnceLock::new();
/// Catalogue `context_length` per model id, warmed opportunistically from the public
/// `/models` body (reasoning probe, model-menu fetch). Read at chat time to budget
/// the prompt against the cloud model's real window (issue #22); a miss means
/// "unknown" and budgeting stays inert — never guessed.
static OPENROUTER_CONTEXT_WINDOW_CACHE: OnceLock<Mutex<BTreeMap<String, usize>>> = OnceLock::new();

/* ─────────────────────────────  Keychain  ──────────────────────────────── */

fn api_key_cache() -> &'static Mutex<CacheState> {
    API_KEY_CACHE.get_or_init(|| {
        Mutex::new(CacheState {
            generation: 0,
            cached: None,
        })
    })
}

fn cache_guard() -> std::sync::MutexGuard<'static, CacheState> {
    api_key_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn normalized_api_key(value: Option<String>) -> Option<String> {
    value.filter(|k| !k.trim().is_empty())
}

fn bump_cache_generation(state: &mut CacheState) {
    state.generation = state.generation.wrapping_add(1);
}

/// Drop the cached key and answer the generation that retirement left behind.
/// The generation is read under the same lock as the bump, deliberately: reading
/// it separately could observe a value another save or clear had already moved
/// on, which is the very interleaving it exists to detect.
fn clear_api_key_cache() -> u64 {
    let mut state = cache_guard();
    bump_cache_generation(&mut state);
    state.cached = None;
    state.generation
}

fn entry(account: &str) -> Result<keyring::Entry, CoreError> {
    keyring::Entry::new(keychain_service(), account)
        .map_err(|e| CoreError::Io(format!("keychain unavailable: {e}")))
}

/// Read one keychain string, mapping "no such entry" to `None` (not an error) so a
/// first run — where nothing is stored yet — is a normal state, not a failure.
fn read_secret(account: &str) -> Result<Option<String>, CoreError> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CoreError::Io(format!("keychain read failed: {e}"))),
    }
}

/// The stored OpenRouter API key, or `None` if the user hasn't set one. An
/// empty/whitespace stored value is treated as unset — defence in depth so a blank
/// key can never read as present (the setup UI also blocks empty saves).
///
/// `config_dir` is where the **non-secret** key revision lives, never the key: the
/// secret is only ever in the OS keychain. The revision is consulted first because
/// it is far cheaper than a keychain round trip, and the in-memory value is reused
/// only while the revision it was read under is still current — so a save or clear
/// in *another running instance* is observed before the next provider request
/// (issue #132). A revision that cannot be read at all disables reuse: re-reading
/// the keychain is always safe, serving a key the user replaced or revoked is not.
pub fn read_api_key(config_dir: &Path) -> Result<Option<String>, CoreError> {
    let observed = key_revision::observe(config_dir);
    let generation = {
        let mut state = cache_guard();
        match (&observed, &state.cached) {
            (Some(observed), Some(cached)) if cached.revision == *observed => {
                return Ok(cached.key.clone());
            }
            // Superseded, or unverifiable: drop it rather than leave a value behind
            // that a later read could mistake for current.
            _ => state.cached = None,
        }
        state.generation
    };

    let key = normalized_api_key(read_secret(keychain_account())?);
    if let Some(revision) = observed {
        let mut state = cache_guard();
        // A save or clear that landed while the keychain was being read has already
        // moved the generation on; caching this read would resurrect what it replaced.
        if state.generation == generation && state.cached.is_none() {
            state.cached = Some(CachedKey {
                revision,
                key: key.clone(),
            });
        }
    }
    Ok(key)
}

/* ─────────────────────────────  AI config  ─────────────────────────────── */

pub(crate) fn error_detail(error: CoreError) -> String {
    match error {
        CoreError::NotFound(msg)
        | CoreError::AlreadyExists(msg)
        | CoreError::OutsideVault(msg)
        | CoreError::InvalidName(msg)
        | CoreError::InvalidContent(msg)
        | CoreError::Conflict(msg)
        | CoreError::Io(msg)
        | CoreError::Frontmatter(msg)
        | CoreError::Llm(msg)
        | CoreError::LocalAi(msg) => msg,
    }
}

/// What the frontend can know about the key: whether one is actually stored and the
/// model preference. `has_key` is read from the OS keychain — the authoritative
/// source — never from a persisted bool, so a crash between the keychain write and
/// the config write can't make the UI disagree with the real secret state (issue
/// #14). The key itself is never returned; a keychain failure is surfaced as an
/// error rather than silently read as "not configured". The config is read first so
/// a corrupt config still fails without a keychain read.
pub fn api_key_status(config_dir: &Path) -> Result<ApiKeyStatus, CoreError> {
    let config = provider_config::read_provider_config(config_dir)?;
    Ok(ApiKeyStatus {
        has_key: read_api_key(config_dir)?.is_some(),
        model: config.model,
    })
}

/// One published key revision, and the cache generation it left behind.
struct Revision {
    published: Result<KeyRevision, CoreError>,
    generation: u64,
}

/// Publish a new key revision and drop this process's cached key, so that from
/// this moment no instance — the caller's included — can serve a key it read
/// before now. Called on both sides of every keychain mutation; see
/// [`set_keychain_api_key`] for why both.
fn revise_key(config_dir: &Path) -> Revision {
    let published = key_revision::publish(config_dir);
    Revision {
        published,
        generation: clear_api_key_cache(),
    }
}

/// A revision that could not be published leaves other running instances unable to
/// learn the key changed — they keep whatever they cached until they restart,
/// which is where this code started (issue #132).
///
/// It is logged rather than returned as an error, and deliberately so. The keychain
/// is the source of truth and its change has already committed; failing here would
/// abort the caller *before* it persists the model preference or the reasoning-probe
/// invalidation, turning one degraded guarantee into a second, worse, half-applied
/// save. The caller is told through [`KeyChangeOutcome`] instead — this is not a
/// state the caller is about to fail on anyway: a perfectly writable config
/// directory with a *directory* sitting where the sidecar belongs fails every
/// rename here while `ai.json` writes fine, so the save returns success and #132 is
/// silently back until the app restarts.
fn log_unpublished_revision(outcome: &Result<KeyRevision, CoreError>, when: &str) {
    if let Err(error) = outcome {
        log::error!(
            "could not publish the API key revision {when} the keychain change: {error} — other \
             running instances may keep using the previous key until they restart"
        );
    }
}

/// Cache the key this process just stored, against the revision it just published,
/// so the save the user made costs no extra keychain round trip.
///
/// `began_at` is the generation the save's FIRST revision left behind, and exactly
/// one bump — the save's own second revision — may have happened since. Anything
/// more means another save or clear interleaved with the keychain write, so the
/// key in hand may already have been replaced or revoked; [`read_api_key`] applies
/// the same guard to what *it* reads. Without it here, a clear whose delete lands
/// after this write leaves the revoked key cached against the live revision, and
/// every later read serves it for the rest of the process's life.
///
/// A publish by another *instance* needs no guard: that only pins this entry to a
/// superseded revision, which can miss but never serve a stale key.
fn adopt_saved_key(revision: KeyRevision, began_at: u64, key: String) {
    let mut state = cache_guard();
    if state.generation != began_at.wrapping_add(1) {
        return;
    }
    state.cached = Some(CachedKey {
        revision,
        key: Some(key),
    });
}

/// Store the API key in the OS keychain and invalidate every instance's cached
/// copy. This is the *keychain-only* half of saving a key: it performs no config
/// I/O and takes no lock, so the caller can persist the non-secret model preference
/// under the config-mutation gate WITHOUT that lock ever spanning this keychain
/// write (issue #21 AC #2). An empty/whitespace key is rejected before anything is
/// written, so a bad request never mutates the keychain or the config that follows it.
///
/// The revision is republished on **both** sides of the keychain write, and both
/// publishes earn their place (issue #132):
/// * *Before*, so that a crash between the write and the publish still leaves every
///   instance invalidated. Re-reading the keychain is always correct; trusting
///   memory after an interrupted write is not.
/// * *After*, because an instance that re-read during the write would otherwise
///   have cached the OLD secret against the new revision and kept it indefinitely.
///
/// Either publish can fail without the keychain write failing, so success here is
/// qualified: the returned [`KeyChangeOutcome`] says whether the change actually
/// reached the other instances, and a caller that reports it as a plain success
/// tells the user something that is not true.
pub fn set_keychain_api_key(config_dir: &Path, key: &str) -> Result<KeyChangeOutcome, CoreError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::InvalidName("API key cannot be empty".into()));
    }
    let before = revise_key(config_dir);
    // Logged here rather than after the write: an unavailable keychain returns from
    // the very next line, and the half of the story already known would go with it.
    log_unpublished_revision(&before.published, "before");
    let stored = entry(keychain_account())?
        .set_password(key)
        .map_err(|e| CoreError::Io(format!("could not store API key in the keychain: {e}")));
    let after = revise_key(config_dir);
    log_unpublished_revision(&after.published, "after");

    stored?;
    let revision_published = before.published.is_ok() && after.published.is_ok();
    if let Ok(revision) = after.published {
        adopt_saved_key(revision, before.generation, key.to_string());
    }
    Ok(KeyChangeOutcome { revision_published })
}

/// Remove the stored key from the OS keychain and invalidate every instance's
/// cached copy. The keychain-only half of clearing a key — no config I/O, no lock
/// (see [`set_keychain_api_key`], which also explains the two revisions).
/// Idempotent: deleting an already-absent entry is success, so a double-clear, or a
/// clear before anything was ever set, is fine. The revision is republished and the
/// cache emptied *before* the delete so no reader can observe a key the delete is
/// about to remove — and unlike a save, nothing is cached afterwards: a revocation
/// leaves every reader having to ask the keychain again.
///
/// Success is qualified the same way a save's is, and it matters more here: a
/// [`KeyChangeOutcome`] with `revision_published: false` means another running
/// instance can still transmit the key the user just revoked.
pub fn clear_keychain_api_key(config_dir: &Path) -> Result<KeyChangeOutcome, CoreError> {
    let before = revise_key(config_dir);
    // Logged here rather than after the delete, for the reason given in
    // [`set_keychain_api_key`]: the next line can return without it.
    log_unpublished_revision(&before.published, "before");
    let deleted = match entry(keychain_account())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CoreError::Io(format!(
            "could not remove API key from the keychain: {e}"
        ))),
    };
    let after = revise_key(config_dir);
    log_unpublished_revision(&after.published, "after");

    deleted?;
    Ok(KeyChangeOutcome {
        revision_published: before.published.is_ok() && after.published.is_ok(),
    })
}

#[cfg(test)]
fn reset_api_key_cache_for_tests() {
    clear_api_key_cache();
}

/* ──────────────────────────  Frontend history  ─────────────────────────── */

/// One prior conversation turn as the frontend sends it. Only `user`/`assistant`
/// text turns cross the boundary; system + tool turns are assembled in the core.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

impl From<ChatTurn> for LlmMessage {
    fn from(t: ChatTurn) -> Self {
        // Anything that isn't explicitly "assistant" is treated as a user turn —
        // the core never trusts the client to inject system/tool roles.
        if t.role == "assistant" {
            LlmMessage {
                role: Role::Assistant,
                content: Some(t.content),
                tool_calls: Vec::new(),
                tool_call_id: None,
                name: None,
            }
        } else {
            LlmMessage::user(t.content)
        }
    }
}

/* ──────────────────────────────  Event sink  ───────────────────────────── */

/// Forwards [`ChatEvent`]s to the frontend over a Tauri channel. `EventSink::send`
/// is infallible by contract, so a closed channel (webview navigated away / closed)
/// can't propagate an error — instead we log it once and stop emitting, rather than
/// silently retrying against a dead UI for the rest of the run.
pub struct TauriChannelSink {
    channel: tauri::ipc::Channel<ChatEvent>,
    closed: bool,
    close_signal: std::sync::Arc<ChatRunCloseSignal>,
}

impl TauriChannelSink {
    /// Attach the lifecycle signal observed by the provider turn, shell prompt,
    /// and note writer. A failed delivery then cancels every layer instead of
    /// letting a dead webview retain work or write into an unmounted vault.
    pub(crate) fn with_close_signal(
        channel: tauri::ipc::Channel<ChatEvent>,
        close_signal: std::sync::Arc<ChatRunCloseSignal>,
    ) -> Self {
        Self {
            channel,
            closed: false,
            close_signal,
        }
    }
}

impl EventSink for TauriChannelSink {
    fn send(&mut self, event: ChatEvent) {
        if self.closed {
            return;
        }
        if let Err(e) = self.channel.send(event) {
            // EventSink cannot return this failure to core, so close the retained
            // run signal instead. RunLlmClient races each transport await against
            // it; prompt waits observe it separately, and the note backend checks it
            // around synchronous writes. Core is left to unwind and return its Undo
            // ledger rather than having the whole run future dropped.
            log::warn!("chat event channel closed; dropping further events: {e}");
            self.closed = true;
            self.close_signal.close();
        }
    }
}

/// One chat invocation's observable event-channel/workspace lifecycle. `watch`
/// retains the closed value, so a provider, prompt, or writer that checks after
/// teardown still fails immediately; there is no lost-notification window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChatRunCloseReason {
    UserStop,
    Lifecycle,
}

pub(crate) struct ChatRunCloseSignal {
    sender: tokio::sync::watch::Sender<Option<ChatRunCloseReason>>,
}

impl Default for ChatRunCloseSignal {
    fn default() -> Self {
        let (sender, _receiver) = tokio::sync::watch::channel(None);
        Self { sender }
    }
}

impl ChatRunCloseSignal {
    pub(crate) fn close(&self) {
        self.close_with(ChatRunCloseReason::Lifecycle);
    }

    /// Record a user-requested stop only if no lifecycle/completion boundary has
    /// already closed the run. The watch value is retained for every late waiter.
    pub(crate) fn stop_by_user(&self) -> bool {
        self.close_with(ChatRunCloseReason::UserStop)
    }

    fn close_with(&self, reason: ChatRunCloseReason) -> bool {
        self.sender.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason);
            true
        })
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.sender.borrow().is_some()
    }

    pub(crate) fn reason(&self) -> Option<ChatRunCloseReason> {
        *self.sender.borrow()
    }

    pub(crate) async fn wait_closed(&self) {
        let mut receiver = self.sender.subscribe();
        if receiver.borrow().is_some() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if receiver.borrow().is_some() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod chat_run_close_tests {
    use super::*;

    #[test]
    fn close_reason_is_typed_and_first_writer_wins() {
        let lifecycle_first = ChatRunCloseSignal::default();
        lifecycle_first.close();
        assert_eq!(
            lifecycle_first.reason(),
            Some(ChatRunCloseReason::Lifecycle)
        );
        assert!(!lifecycle_first.stop_by_user());
        assert_eq!(
            lifecycle_first.reason(),
            Some(ChatRunCloseReason::Lifecycle)
        );

        let user_first = ChatRunCloseSignal::default();
        assert!(user_first.stop_by_user());
        user_first.close();
        assert_eq!(user_first.reason(), Some(ChatRunCloseReason::UserStop));
    }
}

/// Probe whether `model` supports reasoning via OpenRouter's public models
/// endpoint. No API key is attached: the endpoint needs none, and the key must
/// never leave the keychain boundary. Any failure returns `Unknown` (fail open).
pub async fn probe_openrouter_reasoning(model: &str) -> ReasoningSupport {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build()
    else {
        return ReasoningSupport::Unknown;
    };
    let Ok(response) = openrouter_models_request(&client).send().await else {
        return ReasoningSupport::Unknown;
    };
    if !response.status().is_success() {
        return ReasoningSupport::Unknown;
    }
    let Ok(body) = response.text().await else {
        return ReasoningSupport::Unknown;
    };

    cache_openrouter_pricing(&body, model);
    cache_openrouter_model_windows(&body);
    openrouter_reasoning_support(&body, model)
}

fn openrouter_models_request(client: &reqwest::Client) -> reqwest::RequestBuilder {
    client.get(OPENROUTER_MODELS_URL)
}

fn cache_openrouter_pricing(models_json: &str, model: &str) {
    let Ok(pricing) = parse_openrouter_input_pricing(models_json, model) else {
        return;
    };
    OPENROUTER_PRICING_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(model.to_string(), pricing);
}

pub fn cached_openrouter_pricing(model: &str) -> Option<ModelPricing> {
    OPENROUTER_PRICING_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(model)
        .cloned()
}

/// Warm the context-window cache from a validated public `/models` body. Tolerant:
/// an unparseable body warms nothing (the cache simply stays stale), matching the
/// fail-open probe above — chat must never fail because an opportunistic cache didn't.
pub fn cache_openrouter_model_windows(models_json: &str) {
    let Some(windows) = parse_openrouter_context_windows(models_json) else {
        return;
    };
    let mut cache = OPENROUTER_CONTEXT_WINDOW_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (id, context_length) in windows {
        if let Ok(tokens) = usize::try_from(context_length) {
            cache.insert(id, tokens);
        }
    }
}

/// The selected model's catalogue window, when a warmed cache knows it. `None` =
/// unknown (a hand-typed id, or no catalogue fetch has run yet this session).
pub fn cached_openrouter_context_window(model: &str) -> Option<usize> {
    OPENROUTER_CONTEXT_WINDOW_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(model)
        .copied()
}

/* ─────────────────────────────  LLM client  ────────────────────────────── */

/// OpenAI-compatible [`LlmClient`]. Holds one reusable HTTP client and endpoint
/// config; the model id travels per-request in [`LlmRequest::model`].
pub struct OpenAiChatClient {
    http: reqwest::Client,
    url: String,
    bearer: Option<String>,
    title: Option<&'static str>,
    /// Ollama context window (tokens); `None` for OpenRouter. Set for Local so
    /// Ollama doesn't fall back to ~4096 and silently truncate the grounding rules
    /// + earliest evidence — protecting cited recall on the Local path (PA-001).
    num_ctx: Option<u32>,
    /// The cloud model's catalogue window (`context_length`), looked up from the
    /// warmed cache when the client is built. Reported to the orchestrator so it
    /// budgets the assembled prompt against the real window (issue #22); `None`
    /// means unknown and budgeting stays inert.
    context_window_tokens: Option<usize>,
    /// Whether to request streamed reasoning tokens on the answer turn. The caller
    /// combines the user's opt-in with the selected model's capability before client
    /// construction, for both OpenRouter and Ollama.
    reasoning: bool,
}

impl OpenAiChatClient {
    pub fn new_with(
        url: String,
        bearer: Option<String>,
        title: Option<&'static str>,
        connect_timeout: Duration,
        read_timeout: Duration,
        num_ctx: Option<u32>,
        reasoning: bool,
    ) -> Self {
        // Timeouts so a stalled/half-open endpoint can't hang `chat` forever with no
        // event (the "failures are never silent" contract). `connect_timeout` guards
        // connection setup; `read_timeout` is the per-read idle timeout — it aborts a
        // stream that goes quiet without capping a legitimately long one (a blanket
        // `.timeout()` would kill long streams, so it is deliberately omitted).
        let http = reqwest::Client::builder()
            .connect_timeout(connect_timeout)
            .read_timeout(read_timeout)
            .build()
            .unwrap_or_else(|e| {
                log::warn!("failed to build the HTTP client with timeouts ({e}); using default");
                reqwest::Client::new()
            });
        Self {
            http,
            url,
            bearer,
            title,
            num_ctx,
            context_window_tokens: None,
            reasoning,
        }
    }

    /// Report the cloud model's catalogue context window to the orchestrator's
    /// prompt budgeting. Local clients need nothing here — their window is already
    /// the `num_ctx` they send.
    pub fn with_context_window(mut self, context_window_tokens: Option<usize>) -> Self {
        self.context_window_tokens = context_window_tokens;
        self
    }

    pub fn new(api_key: String, reasoning: bool) -> Self {
        Self::new_with(
            OPENROUTER_URL.to_string(),
            Some(api_key),
            Some("NeuralNote"),
            Duration::from_secs(10),
            Duration::from_secs(120),
            None,      // OpenRouter sizes its own (large) context window.
            reasoning, // Billed reasoning tokens — on only when the user opts in.
        )
    }

    /// The answer-turn wire body: streamed, output-capped, and carrying the reasoning
    /// request only when this client has it enabled. Split out of `complete_streaming`
    /// so a test can inspect exactly what the client would send, without a live
    /// endpoint.
    fn answer_wire_body(&self, req: &LlmRequest) -> serde_json::Value {
        openai::to_wire_request(
            req,
            true,
            self.num_ctx,
            Some(openai::ANSWER_MAX_TOKENS),
            self.reasoning,
        )
    }

    /// The tool-deciding turn's wire body. Streamed, but otherwise identical to
    /// what [`LlmClient::complete`] sends: **uncapped**, so long tool-call JSON is
    /// never truncated mid-note, and with **no reasoning** — the tool turn drops
    /// reasoning frames on the floor, so requesting them here is pure cost. Split
    /// out so a test can inspect exactly what would be sent, without an endpoint.
    fn tool_wire_body(&self, req: &LlmRequest, stream: bool) -> serde_json::Value {
        openai::to_wire_request(
            req,
            stream,
            self.num_ctx,
            /* max_tokens */ None,
            /* reasoning */ false,
        )
    }

    /// Read one streamed tool turn to its end.
    ///
    /// Split out of [`LlmClient::complete_tool_streaming`] so that every way this
    /// can fail — the socket, a frame, or settling the turn — leaves by the one
    /// `Err` its caller clears the live previews on.
    async fn read_tool_stream(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> Result<StreamedToolTurn, CoreError> {
        let resp = self
            .post(&self.tool_wire_body(req, /* stream */ true))
            .await?;

        // Same byte-buffered line loop as the answer turn, and for the same
        // reason: a chunk can split a multibyte character but never the `\n`
        // delimiter, so every complete line decodes cleanly. The reassembly
        // itself lives in core, where it is tested against the captured turn.
        let mut stream = resp.bytes_stream();
        let mut reader = ToolTurnReader::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CoreError::Llm(format!("stream read error: {e}")))?;
            if reader.push_bytes(&chunk, sink)? {
                break;
            }
        }
        reader.finish(sink)
    }

    /// One buffered turn: the completion the model returned, and what the
    /// provider said it cost (`None` when it said nothing).
    async fn buffered_turn(
        &self,
        req: &LlmRequest,
    ) -> Result<(Completion, Option<TokenUsage>), CoreError> {
        let body = self.tool_wire_body(req, /* stream */ false);
        let resp = self.post(&body).await?;
        let provider = self.provider_label();
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CoreError::Llm(format!("could not parse {provider} response: {e}")))?;
        let usage = openai::parse_usage(&value);
        Ok((openai::parse_completion(value)?, usage))
    }

    /// Read the streamed answer to its end, returning the text exactly as it was
    /// streamed.
    ///
    /// Split out of [`LlmClient::complete_streaming`] so the turn has ONE exit:
    /// the `[DONE]` early return and the end-of-body flush used to be two, and a
    /// turn that reports its price on only one of them reports it on neither
    /// reliably.
    ///
    /// Buffers BYTES, not str: a chunk can split a multibyte char, but never the
    /// `\n` line delimiter (a single byte, never part of a UTF-8 sequence), so
    /// decoding each complete line is always valid. The string returned is the
    /// exact concatenation of the deltas streamed — the orchestrator scans it for
    /// cited ids, so returned MUST equal streamed (it does here by construction).
    async fn read_answer_stream(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
        answer: &mut openai::AnswerStream,
    ) -> Result<String, CoreError> {
        let body = self.answer_wire_body(req);
        let resp = self.post(&body).await?;
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CoreError::Llm(format!("stream read error: {e}")))?;
            buf.extend_from_slice(&chunk);

            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                if let Some(done) = openai::consume_sse_line(&line_bytes, sink, answer)? {
                    return Ok(done);
                }
            }
        }
        // Flush a final line the stream left without a trailing newline — otherwise a
        // last delta, or a terminal error frame, in the tail would be silently lost
        // (and a cited id in that tail would go missing, corrupting verification).
        if !buf.is_empty() {
            openai::consume_sse_line(&buf, sink, answer)?;
        }
        Ok(answer.text().to_string())
    }

    fn provider_label(&self) -> &'static str {
        if self.bearer.is_none() && self.title.is_none() {
            "Local AI"
        } else {
            "OpenRouter"
        }
    }

    /// POST a request body to OpenRouter with auth + attribution headers. `stream`
    /// selects SSE vs a single JSON response. Returns the raw response for the
    /// caller to parse (buffered JSON or streamed SSE).
    async fn post(&self, body: &serde_json::Value) -> Result<reqwest::Response, CoreError> {
        let provider = self.provider_label();
        let mut req = self.http.post(&self.url);
        if let Some(bearer) = &self.bearer {
            req = req.bearer_auth(bearer);
        }
        if let Some(title) = self.title {
            // OpenRouter attribution (optional, but polite + helps rate limits).
            req = req.header("X-Title", title);
        }
        let resp = req
            .json(body)
            .send()
            .await
            .map_err(|e| CoreError::Llm(format!("request to {provider} failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            // Prefer the provider's error body (it explains bad-key / rate-limit /
            // bad-model); fall back to the status line so the error is never blank.
            let body = resp.text().await.unwrap_or_default();
            // Redact the key before it can reach a user-facing error or a log: a
            // provider/proxy error body could echo the Authorization header, and a
            // leaked key is catastrophic. Defence in depth on the secret boundary.
            let key = self.bearer.as_deref().unwrap_or("");
            let detail = openai::redact(body.trim(), key);
            let detail = detail.trim();
            return Err(CoreError::Llm(if detail.is_empty() {
                format!("{provider} returned {status}")
            } else {
                format!("{provider} returned {status}: {detail}")
            }));
        }
        Ok(resp)
    }

    /// POST a hand-built body and decode the JSON response.
    ///
    /// Used by the approval judge, whose request is deliberately NOT an
    /// [`LlmClient`] call: it carries `temperature: 0` and a 32-token ceiling that
    /// no chat turn wants, and it must never go anywhere near the orchestrator's
    /// message list.
    async fn post_json(&self, body: &serde_json::Value) -> Result<serde_json::Value, CoreError> {
        let provider = self.provider_label();
        self.post(body)
            .await?
            .json()
            .await
            .map_err(|e| CoreError::Llm(format!("could not parse {provider} response: {e}")))
    }
}

/// The tool-approval judge, over the same HTTP client the chat turn uses.
///
/// **The model is the user's already-selected chat model, not a separate cheap
/// slug.** The design would prefer a small dedicated model and says so, but it
/// also records that the choice "is not yet locked" — and hard-coding a model
/// identifier that has not been verified against the provider's live catalogue
/// would put a fabricated fact on the security path, which is worse than a
/// slightly dearer call. Pricing a real candidate and pinning it here is a
/// follow-up; until then this bills the model the user already chose, and the
/// request is a few hundred tokens in and at most 32 out.
pub(crate) struct ApprovalJudge<'a> {
    client: &'a OpenAiChatClient,
    model: String,
}

impl<'a> ApprovalJudge<'a> {
    pub(crate) fn new(client: &'a OpenAiChatClient, model: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
        }
    }

    /// The exact request body. Split out so a test can assert the sampling knobs
    /// without a network round trip — a judge that silently drifted to a warmer
    /// temperature or a bigger ceiling is a change to the security decision's cost
    /// and reproducibility, and that should not be able to land unseen.
    fn request_body(&self, subject: &ToolApprovalSubject) -> serde_json::Value {
        serde_json::json!({
            "model": self.model,
            "temperature": approval::CLASSIFIER_TEMPERATURE,
            "max_tokens": approval::CLASSIFIER_MAX_TOKENS,
            "stream": false,
            "messages": [
                { "role": "system", "content": approval::classifier_system_prompt() },
                // The ONLY variable part, and it is the serialised subject: a
                // closed struct of enums, integers and bools with no free-text
                // field. There is nowhere in this body for an instruction to live.
                { "role": "user", "content": approval::classifier_prompt(subject) },
            ],
        })
    }
}

#[async_trait]
impl approval::ApprovalClassifier for ApprovalJudge<'_> {
    async fn classify(
        &self,
        subject: &ToolApprovalSubject,
    ) -> Result<approval::ClassifierVerdict, CoreError> {
        // The budget is enforced HERE, where the runtime timer lives, because the
        // core owns no clock. No retries: a retry on a security decision doubles
        // the exposure window for zero gain when the fallback is cheap and correct.
        let value = tokio::time::timeout(
            approval::CLASSIFIER_BUDGET,
            self.client.post_json(&self.request_body(subject)),
        )
        .await
        .map_err(|_| {
            CoreError::Llm("the approval check did not answer within its budget".into())
        })??;

        // An answer that arrived but does not parse is NOT a transport failure: the
        // provider is up and the model simply did not cooperate, so it resolves to
        // "ask" without counting toward the two-failures-in-a-run degradation.
        let text = value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default();
        Ok(approval::parse_verdict(text))
    }
}

#[async_trait]
impl LlmClient for OpenAiChatClient {
    fn context_window_tokens(&self) -> Option<usize> {
        // The window this client will actually see enforced: the local `num_ctx`
        // sent to Ollama, else the cloud model's catalogue window (if known).
        self.num_ctx
            .map(|num_ctx| num_ctx as usize)
            .or(self.context_window_tokens)
    }

    async fn complete(&self, req: &LlmRequest) -> Result<Completion, CoreError> {
        Ok(self.buffered_turn(req).await?.0)
    }

    async fn complete_tool_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> Result<Completion, CoreError> {
        // Track the previews rather than clearing at each failure site: the turn
        // can fail at the socket, at a frame, or as it settles, and a card left on
        // screen by ANY of them reads as a note that landed. One exit, one clear.
        // Cards the turn already retired are not re-reported.
        let mut tracked = tool_stream::LivePreviews::new(sink);
        match self.read_tool_stream(req, &mut tracked).await {
            Ok(StreamedToolTurn::Completed(completion)) => Ok(completion),
            // The provider sent no tool-call fragments and no prose, so it does
            // not stream this turn. Returning the empty turn would read to the
            // orchestrator as "the model chose to answer" and silently skip
            // retrieval for the whole run, so re-run it buffered instead. Nothing
            // was emitted (no calls means no previews), so this replays over
            // nothing the user has seen and the retry contract still holds.
            Ok(StreamedToolTurn::NotStreamed) => {
                // The buffered response carries its own `usage` object, so the
                // fallback prices itself. Reporting through `tracked` rather than
                // dropping it is what keeps the run's total complete on a provider
                // that cannot stream a tool turn at all.
                let (completion, usage) = self.buffered_turn(req).await?;
                tracked.record_usage(usage);
                Ok(completion)
            }
            Err(error) => {
                tracked.abandon_live(tool_stream::ABANDONED_TURN_FAILED);
                Err(error)
            }
        }
    }

    async fn complete_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> Result<String, CoreError> {
        // The answer turn carries the output ceiling; tool-deciding turns do not. It
        // also carries the reasoning request (OpenRouter only, when opted in) — this is
        // the one turn whose reasoning tokens surface as live `Thinking` events.
        let mut answer = openai::AnswerStream::new();
        let text = self.read_answer_stream(req, sink, &mut answer).await?;
        if !answer.usage_reported() {
            // The provider never priced this turn. Saying so is what makes the
            // run's footer come out ABSENT rather than quietly reporting the
            // tool turns' tokens as the whole bill.
            sink.record_usage(None);
        }
        openai::finish_answer(text)
    }
}

/// The runtime-backed [`RetryDelay`]: the core owns the backoff value, the shell owns the
/// clock. Non-blocking — it awaits the Tokio timer rather than sleeping a worker thread.
pub struct TokioRetryDelay;

#[async_trait]
impl RetryDelay for TokioRetryDelay {
    async fn delay(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// The two-instance acceptance tests for issue #132. They live in their own file
/// because they run **real child processes against the real OS keychain** — the
/// defect they pin (two instances disagreeing about the key) is invisible to any
/// single-process test, so none of the fakes below can be used.
///
/// macOS only, because that is where a real cross-process credential store exists:
/// `keyring` is pulled in with the `apple-native` feature alone (see Cargo.toml),
/// so on every other target it falls back to a *per-process* store, against which
/// two processes could never agree and this would fail for a reason that has
/// nothing to do with the code under test. PR CI runs the workspace suite on
/// Linux. Widen this `cfg` when `windows-native` or `sync-secret-service` land.
#[cfg(all(test, target_os = "macos"))]
#[path = "ai_key_revision_tests.rs"]
mod key_revision_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai::{clear_api_key_in, save_api_key_in};
    use crate::provider_config_mutation::ProviderConfigMutationGate;
    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
    use keyring::{Error as KeyringError, Result as KeyringResult};
    use neuralnote_core::ai::provider_config::{
        config_file, write_provider_config, ProviderConfig,
    };
    use neuralnote_core::ai::DEFAULT_MODEL;
    use std::any::Any;
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex as StdMutex, OnceLock};

    /* ─────────────────────────  the approval judge  ────────────────────── */

    /// A subject to judge. `fetch_captions` is used because it needs no vault on
    /// disk — the judge under test does not care which subject it is handed, only
    /// that it is one.
    fn judge_subject() -> ToolApprovalSubject {
        neuralnote_core::ai::approval::build_subject(
            neuralnote_core::ai::approval::GatedTool::FetchCaptions,
            &neuralnote_core::ai::ToolCall {
                id: "c1".into(),
                name: neuralnote_core::ai::approval::GatedTool::FetchCaptions
                    .name()
                    .into(),
                arguments: r#"{"video_id":"abc123"}"#.into(),
            },
            Path::new("/nonexistent-vault"),
            &neuralnote_core::ai::approval::PathDigestSalt::fixed(3),
            8,
        )
        .expect("a call with no filesystem target always describes")
        .subject
    }

    #[test]
    fn the_judges_request_pins_the_sampling_knobs_and_carries_only_the_subject() {
        // `request_body` was split out with a doc comment saying a test would
        // assert the sampling knobs. No such test existed, so a drift to a warmer
        // temperature or a wider ceiling — a change to the cost and the
        // reproducibility of a SECURITY decision — could land unseen.
        //
        // What goes red: change `temperature`, `max_tokens`, or `stream` in
        // `request_body`, or let anything other than the serialised subject into
        // the user message.
        let client = client_for("http://127.0.0.1:1/v1/chat/completions".into());
        let judge = ApprovalJudge::new(&client, "some/model");
        let body = judge.request_body(&judge_subject());

        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["max_tokens"], 32);
        assert_eq!(body["stream"], false);
        assert_eq!(body["model"], "some/model");
        // Two messages, and the variable one is the serialised subject verbatim.
        // Anything else here would be a channel the subject's closed shape was
        // designed to remove.
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["messages"][1]["content"],
            approval::classifier_prompt(&judge_subject())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_judge_that_never_answers_fails_closed_at_its_own_budget() {
        // The budget is enforced HERE, in the shell, because the core owns no
        // clock — and deleting the `tokio::time::timeout` wrapper left the whole
        // suite green, so the one thing standing between a hung provider and a
        // stalled chat turn was untested.
        //
        // Clock-driven rather than wall-clock: time is paused, so the runtime
        // auto-advances to the next deadline once nothing can make progress. The
        // client's own connect and read timeouts are set an hour out, which makes
        // `CLASSIFIER_BUDGET` the ONLY short timer in play — so the elapsed
        // assertion below is measuring the budget and nothing else.
        //
        // What goes red: delete the `tokio::time::timeout` wrapper in `classify`
        // and the only remaining deadline is an hour away, so both the message
        // and the elapsed assertion fail.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        // Accept and then say nothing at all: a provider that took the request
        // and never answered, which is the failure a read timeout alone handles
        // far too late for a prompt the user is waiting behind.
        let _silent = std::thread::spawn(move || {
            let accepted = listener.accept();
            std::thread::sleep(Duration::from_secs(30));
            drop(accepted);
        });

        let client = OpenAiChatClient::new_with(
            url,
            None,
            None,
            Duration::from_secs(3600),
            Duration::from_secs(3600),
            None,
            false,
        );
        let judge = ApprovalJudge::new(&client, "some/model");

        let started = tokio::time::Instant::now();
        let error = approval::ApprovalClassifier::classify(&judge, &judge_subject())
            .await
            .expect_err("a judge that never answers must not produce a verdict");
        let elapsed = started.elapsed();

        assert!(
            error.to_string().contains("within its budget"),
            "expected the budget error, got: {error}"
        );
        assert_eq!(
            elapsed,
            approval::CLASSIFIER_BUDGET,
            "the judge must give up at its own budget, not at the transport's timeout"
        );
    }

    #[test]
    fn native_e2e_uses_a_distinct_keychain_namespace() {
        assert_eq!(KEYCHAIN_SERVICE, "com.neuralnote.desktop");
        assert_eq!(KEY_ACCOUNT, "openrouter-api-key");
        if cfg!(feature = "native-e2e") {
            assert_eq!(keychain_service(), "com.neuralnote.desktop.e2e");
            assert_eq!(keychain_account(), "openrouter-api-key-e2e");
            assert_ne!(keychain_service(), KEYCHAIN_SERVICE);
            assert_ne!(keychain_account(), KEY_ACCOUNT);
        } else {
            assert_eq!(keychain_service(), KEYCHAIN_SERVICE);
            assert_eq!(keychain_account(), KEY_ACCOUNT);
        }
        // The E2E namespace outranks the bundle identifier. An automation build
        // must be unable to reach a real user's keychain item whatever identifier
        // its configuration happens to carry.
        if cfg!(feature = "native-e2e") {
            assert_eq!(
                resolve_keychain_service(Some("com.neuralnote.desktop")),
                E2E_KEYCHAIN_SERVICE,
                "the native-e2e namespace must not be overridable by an identifier"
            );
        }
    }

    /// The top-level bundle `identifier` a config declares, or `None` when it
    /// leaves the identifier to the config it overlays.
    ///
    /// Only the top-level key names the application. `app.security.capabilities[]`
    /// entries carry an `identifier` too — that is a capability name and has
    /// nothing to do with the credential namespace, so a search that went looking
    /// anywhere in the tree would report the wrong thing.
    fn declared_identifier(path: &Path) -> Option<String> {
        let raw = fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
        let config: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
        config.get("identifier").map(|identifier| {
            identifier
                .as_str()
                .unwrap_or_else(|| panic!("{} declares a non-string `identifier`", path.display()))
                .to_string()
        })
    }

    /// The bundle identifier a shipped configuration actually carries, read from
    /// the real file so an edit to it trips the pins below instead of silently
    /// moving the keychain namespace.
    fn configured_identifier(config_file_name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(config_file_name);
        declared_identifier(&path)
            .unwrap_or_else(|| panic!("{} has no string `identifier`", path.display()))
    }

    /// Config files that may legitimately carry an identifier other than the
    /// shipped one, because neither can produce a build a user installs: the
    /// macOS smoke bundle and the WebdriverIO automation bundle.
    ///
    /// Repository-relative and listed one by one on purpose. Matching on the file
    /// name alone would let a new `tauri.dev-build.conf.json` in some other
    /// directory inherit the exemption by accident.
    const NON_SHIPPING_CONFIG_OVERLAYS: [&str; 2] = [
        "app/desktop/e2e-native/tauri.e2e.conf.json",
        "app/desktop/src-tauri/tauri.dev-build.conf.json",
    ];

    /// Directories with no authored configuration in them. `target` and
    /// `node_modules` in particular hold vendored copies that are not ours.
    const UNSEARCHED_DIRECTORIES: [&str; 3] = [".git", "node_modules", "target"];

    /// The repository root, proven to be the repository root. A walk rooted at
    /// the wrong directory finds no configs at all and would pass vacuously.
    fn repository_root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("the desktop crate sits three directories below the repository root")
            .to_path_buf();
        assert!(
            root.join("Cargo.toml").is_file() && root.join(".github").is_dir(),
            "{} is not the repository root; the config walk below would search nothing",
            root.display()
        );
        root
    }

    /// Every Tauri configuration file in the repository, collected as paths
    /// relative to `root` and separator-normalised so they can be compared
    /// against the literals above.
    ///
    /// `.conf.json` is the whole search space, not a guess: `tauri` and
    /// `tauri-build` are both built with `features = []`, so `config-json5` and
    /// `config-toml` are off and a `tauri.conf.json5` or `Tauri.toml` would be
    /// ignored by the build rather than merged.
    fn tauri_config_files(root: &Path) -> Vec<String> {
        fn walk(directory: &Path, root: &Path, found: &mut Vec<String>) {
            let entries = fs::read_dir(directory)
                .unwrap_or_else(|e| panic!("could not read {}: {e}", directory.display()));
            for entry in entries {
                let entry =
                    entry.unwrap_or_else(|e| panic!("could not read {}: {e}", directory.display()));
                let name = entry.file_name().to_string_lossy().into_owned();
                // `file_type` does not follow symlinks, so a link pointing back up
                // the tree is skipped rather than walked forever.
                let file_type = entry
                    .file_type()
                    .unwrap_or_else(|e| panic!("could not stat {}: {e}", entry.path().display()));
                if file_type.is_dir() {
                    if !UNSEARCHED_DIRECTORIES.contains(&name.as_str()) {
                        walk(&entry.path(), root, found);
                    }
                } else if file_type.is_file() && name.ends_with(".conf.json") {
                    let relative = entry
                        .path()
                        .strip_prefix(root)
                        .expect("the walk never leaves the repository root")
                        .to_string_lossy()
                        .replace('\\', "/");
                    found.push(relative);
                }
            }
        }

        let mut found = Vec::new();
        walk(root, root, &mut found);
        found.sort();
        found
    }

    /// The other half of the no-migration pin. The production `tauri.conf.json`
    /// is not the only file that can set the shipped identifier: Tauri merges
    /// platform overlays (`tauri.macos.conf.json`) with no flag at all, and any
    /// file can be passed to `tauri build --config`. Pinning only the base config
    /// leaves every one of those free to move the keychain namespace.
    ///
    /// What goes red: add an in-repo config that sets an `identifier` other than
    /// the shipped one without declaring it non-shipping.
    ///
    /// What this cannot see: an overlay that never lands in the repository —
    /// `--config` with inline JSON, or the `TAURI_CONFIG` environment variable.
    /// The release workflow's own overlay is covered by
    /// `scripts/check-release-workflow.mjs`.
    #[test]
    fn no_in_repository_config_overlay_moves_the_keychain_namespace() {
        let root = repository_root();
        let configs = tauri_config_files(&root);

        // The walk proves itself before it is trusted: one that cannot find the
        // configs we know exist could not find a new one either, and its silence
        // would mean nothing.
        for known in std::iter::once("app/desktop/src-tauri/tauri.conf.json")
            .chain(NON_SHIPPING_CONFIG_OVERLAYS)
        {
            assert!(
                configs.iter().any(|found| found == known),
                "the config walk did not find {known}, so it cannot be trusted to find a new \
                 overlay either — found: {configs:?}"
            );
        }

        for config in &configs {
            if NON_SHIPPING_CONFIG_OVERLAYS.contains(&config.as_str()) {
                continue;
            }
            let Some(identifier) = declared_identifier(&root.join(config)) else {
                continue;
            };
            assert_eq!(
                identifier, KEYCHAIN_SERVICE,
                "{config} sets the bundle identifier to '{identifier}'. The keychain service \
                 follows the running identifier, so a build carrying this config would look for \
                 the API key under '{identifier}' while every existing user's key is stored under \
                 '{KEYCHAIN_SERVICE}' — theirs would be orphaned and the app would simply report \
                 no key configured. Ship a keychain migration first, or add the file to \
                 NON_SHIPPING_CONFIG_OVERLAYS if it can never produce an installed build"
            );
        }
    }

    /// The no-migration pin. Deriving the keychain namespace from the bundle
    /// identifier is only a no-op for existing users while the production
    /// identifier is byte-identical to the constant their key was stored under.
    ///
    /// What goes red: change `identifier` in `tauri.conf.json`. That must fail
    /// here — loudly, at build time — rather than orphaning every stored API key
    /// in a namespace the app no longer looks in.
    #[test]
    fn the_production_identifier_is_the_legacy_keychain_service() {
        assert_eq!(
            configured_identifier("tauri.conf.json"),
            KEYCHAIN_SERVICE,
            "the production bundle identifier moved: existing keys live under \
             '{KEYCHAIN_SERVICE}' and would be orphaned — ship a keychain migration \
             before changing it"
        );
    }

    /// The defect this seam exists for: the debug/smoke bundle has its own app
    /// identity precisely so it stays separate from the shipped app, so it must
    /// get its own credential namespace rather than reaching for the user's real
    /// production key (and tripping that item's macOS ACL prompt on every launch).
    #[test]
    fn a_separate_bundle_identity_gets_a_separate_keychain_namespace() {
        let dev_identifier = configured_identifier("tauri.dev-build.conf.json");
        assert_ne!(
            dev_identifier, KEYCHAIN_SERVICE,
            "the dev build's whole purpose is a separate identity"
        );

        let resolved = resolve_keychain_service(Some(&dev_identifier));
        if cfg!(feature = "native-e2e") {
            assert_eq!(resolved, E2E_KEYCHAIN_SERVICE);
        } else {
            assert_eq!(
                resolved, dev_identifier,
                "a build running as '{dev_identifier}' must not read the production keychain item"
            );
            assert_ne!(resolved, KEYCHAIN_SERVICE);
        }
    }

    /// Nothing bound — unit tests, and any call before the shell's `setup()` hook
    /// runs — keeps the historical namespace, so behaviour is deterministic
    /// without a running Tauri app. A blank identifier is not a namespace: it
    /// falls back rather than inventing an empty one.
    #[test]
    fn an_unbound_identifier_falls_back_to_the_legacy_namespace() {
        let expected = if cfg!(feature = "native-e2e") {
            E2E_KEYCHAIN_SERVICE
        } else {
            KEYCHAIN_SERVICE
        };
        assert_eq!(resolve_keychain_service(None), expected);
    }

    /// The binding rules, exercised against a *local* slot. `OnceLock` is
    /// process-wide and cargo runs this binary's tests in parallel, so binding
    /// some other identifier into the real static would race every test that
    /// reads `keychain_service()`. Injecting the slot makes these assertions
    /// deterministic and repeatable.
    #[test]
    fn binding_takes_the_first_non_blank_identifier_and_nothing_later() {
        let slot = OnceLock::new();

        bind_identifier(&slot, "  com.neuralnote.desktop.dev  ")
            .expect("a non-blank identifier binds");
        assert_eq!(
            slot.get().map(String::as_str),
            Some("com.neuralnote.desktop.dev"),
            "the bound identifier is what the keychain namespace follows"
        );

        // First write wins: nothing may move the namespace out from under a
        // session that has already read a key. A rebind is rejected, not fatal —
        // the namespace in force is still a real one.
        bind_identifier(&slot, "com.neuralnote.desktop").expect("a rebind is refused, not fatal");
        assert_eq!(
            slot.get().map(String::as_str),
            Some("com.neuralnote.desktop.dev")
        );
    }

    /// A blank identifier is the one case where "carry on" and "fall back" are
    /// the same wrong answer: falling back binds this build to the shipped app's
    /// credential, which is the exact defect the identifier-scoped namespace
    /// exists to prevent. A build that cannot name itself refuses to start.
    ///
    /// What goes red: return `Ok(())` from the blank branch. The process would
    /// start, resolve to the legacy constant, and a `warn` line nobody reads
    /// would be the only trace that a build took the real user's API key.
    #[test]
    fn a_blank_identifier_refuses_to_start_instead_of_falling_back() {
        let slot = OnceLock::new();

        for blank in ["", "   ", "\t\n"] {
            assert_eq!(
                bind_identifier(&slot, blank),
                Err(BlankBundleIdentifier),
                "a blank identifier must fail closed, not be warned about and ignored"
            );
            assert_eq!(
                slot.get(),
                None,
                "a blank identifier must never become a keychain namespace"
            );
        }

        // The shell calls the entry point, not the helper, so the refusal has to
        // hold there too. Safe against the process-wide static in a parallel
        // suite: a blank identifier is rejected before the slot is ever touched.
        assert_eq!(
            init_keychain_service("   "),
            Err(BlankBundleIdentifier),
            "the shell's entry point must refuse a blank identifier, not just the helper"
        );

        // The refusal aborts startup, so its message is all a maintainer gets. It
        // has to name what was refused and what it refused to fall back to.
        let refusal = BlankBundleIdentifier.to_string();
        assert!(
            refusal.contains(KEYCHAIN_SERVICE) && refusal.contains("refusing to start"),
            "the refusal must explain itself, got: {refusal}"
        );

        // The stakes, made explicit: this is the namespace the process would have
        // gone on to use had the refusal above been a fallback instead.
        if !cfg!(feature = "native-e2e") {
            assert_eq!(
                resolve_keychain_service(slot.get().map(String::as_str)),
                KEYCHAIN_SERVICE
            );
        }
    }

    /// The real process-wide static, end to end: `init_keychain_service` and
    /// `keychain_service()` must be wired to the same slot.
    ///
    /// Binding the *production* identifier here is safe in a parallel suite
    /// precisely because `the_production_identifier_is_the_legacy_keychain_service`
    /// pins it byte-identical to `KEYCHAIN_SERVICE` — whatever order the suite
    /// runs in, no other test can observe a different value. The dev-identifier
    /// case is covered through the pure resolver and the local slot above.
    #[test]
    fn the_shell_binds_the_process_wide_namespace() {
        let identifier = configured_identifier("tauri.conf.json");
        init_keychain_service(&identifier).expect("the production identifier is not blank");

        // Reading the real static is what distinguishes "bound" from "silently
        // ignored" — the resolved service alone cannot, while the production
        // identifier and the legacy constant are deliberately the same string.
        assert_eq!(
            KEYCHAIN_SERVICE_OVERRIDE.get().map(String::as_str),
            Some(identifier.as_str()),
            "init_keychain_service must write the slot keychain_service() reads"
        );

        let expected = if cfg!(feature = "native-e2e") {
            E2E_KEYCHAIN_SERVICE
        } else {
            identifier.as_str()
        };
        assert_eq!(keychain_service(), expected);
    }

    #[test]
    fn a_throwaway_keychain_account_can_never_name_the_production_one() {
        // The test-only redirection is a seam onto the developer's real credential
        // store. It takes a suffix, not an account, and this is what keeps that
        // true: every input lands under `<account>-test-…`, however hostile.
        for suffix in ["save-1", "", "   ", "../../openrouter-api-key", "\0\n"] {
            let account = throwaway_keychain_account(suffix);

            assert!(
                account.starts_with(&format!("{}-test-", compiled_keychain_account())),
                "a suffix of {suffix:?} escaped the throwaway namespace: {account}"
            );
            assert_ne!(account, compiled_keychain_account());
            assert!(account
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'));
        }
        assert_eq!(
            throwaway_keychain_account("   "),
            throwaway_keychain_account(""),
            "a suffix that sanitises to nothing must still be a named account"
        );
    }

    #[test]
    fn chat_turn_maps_roles_and_defaults_to_user() {
        let a: LlmMessage = ChatTurn {
            role: "assistant".into(),
            content: "hi".into(),
        }
        .into();
        assert_eq!(a.role, Role::Assistant);
        let u: LlmMessage = ChatTurn {
            role: "system".into(), // an injected non-user role is coerced to user
            content: "ignore me".into(),
        }
        .into();
        assert_eq!(u.role, Role::User);
    }

    static TEST_ID: AtomicU64 = AtomicU64::new(0);
    static KEYCHAIN_TEST_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

    type SecretKey = (String, String);
    type SecretStore = Arc<StdMutex<HashMap<SecretKey, Vec<u8>>>>;
    type AfterReadHook = Arc<StdMutex<Option<Box<dyn FnOnce() + Send + 'static>>>>;

    #[derive(Clone, Default)]
    struct TestKeychain {
        secrets: SecretStore,
        reads: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
        deletes: Arc<AtomicUsize>,
        after_next_read: AfterReadHook,
        after_next_write: AfterReadHook,
        after_next_delete: AfterReadHook,
        /// When set, `get_secret` returns a hard keychain failure (not `NoEntry`), so
        /// tests can prove a genuine keychain error is surfaced honestly rather than
        /// read as "no key".
        fail_reads: Arc<std::sync::atomic::AtomicBool>,
    }

    impl TestKeychain {
        fn install() -> Self {
            let store = Self::default();
            keyring::set_default_credential_builder(Box::new(TestCredentialBuilder {
                store: store.clone(),
            }));
            reset_api_key_cache_for_tests();
            store
        }

        fn set(&self, service: &str, user: &str, secret: &str) {
            self.secrets.lock().unwrap().insert(
                (service.to_string(), user.to_string()),
                secret.as_bytes().to_vec(),
            );
        }

        fn get(&self, service: &str, user: &str) -> Option<String> {
            self.secrets
                .lock()
                .unwrap()
                .get(&(service.to_string(), user.to_string()))
                .map(|bytes| String::from_utf8(bytes.clone()).unwrap())
        }

        fn after_next_read<F>(&self, hook: F)
        where
            F: FnOnce() + Send + 'static,
        {
            *self.after_next_read.lock().unwrap() = Some(Box::new(hook));
        }

        fn take_after_read_hook(&self) -> Option<Box<dyn FnOnce() + Send + 'static>> {
            self.after_next_read.lock().unwrap().take()
        }

        fn after_next_write<F>(&self, hook: F)
        where
            F: FnOnce() + Send + 'static,
        {
            *self.after_next_write.lock().unwrap() = Some(Box::new(hook));
        }

        fn take_after_write_hook(&self) -> Option<Box<dyn FnOnce() + Send + 'static>> {
            self.after_next_write.lock().unwrap().take()
        }

        fn after_next_delete<F>(&self, hook: F)
        where
            F: FnOnce() + Send + 'static,
        {
            *self.after_next_delete.lock().unwrap() = Some(Box::new(hook));
        }

        fn take_after_delete_hook(&self) -> Option<Box<dyn FnOnce() + Send + 'static>> {
            self.after_next_delete.lock().unwrap().take()
        }

        fn contains(&self, service: &str, user: &str) -> bool {
            self.secrets
                .lock()
                .unwrap()
                .contains_key(&(service.to_string(), user.to_string()))
        }

        fn fail_reads(&self) {
            self.fail_reads.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct TestCredentialBuilder {
        store: TestKeychain,
    }

    impl CredentialBuilderApi for TestCredentialBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> KeyringResult<Box<Credential>> {
            Ok(Box::new(TestCredential {
                store: self.store.clone(),
                service: service.to_string(),
                user: user.to_string(),
            }))
        }

        fn as_any(&self) -> &dyn Any {
            self
        }

        fn persistence(&self) -> keyring::credential::CredentialPersistence {
            keyring::credential::CredentialPersistence::ProcessOnly
        }
    }

    struct TestCredential {
        store: TestKeychain,
        service: String,
        user: String,
    }

    impl CredentialApi for TestCredential {
        fn set_secret(&self, secret: &[u8]) -> KeyringResult<()> {
            self.store.writes.fetch_add(1, Ordering::SeqCst);
            self.store
                .secrets
                .lock()
                .unwrap()
                .insert((self.service.clone(), self.user.clone()), secret.to_vec());
            if let Some(hook) = self.store.take_after_write_hook() {
                hook();
            }
            Ok(())
        }

        fn get_secret(&self) -> KeyringResult<Vec<u8>> {
            self.store.reads.fetch_add(1, Ordering::SeqCst);
            if self.store.fail_reads.load(Ordering::SeqCst) {
                return Err(KeyringError::Invalid(
                    "keychain".into(),
                    "simulated keychain failure".into(),
                ));
            }
            let secret = self
                .store
                .secrets
                .lock()
                .unwrap()
                .get(&(self.service.clone(), self.user.clone()))
                .cloned();
            if let Some(hook) = self.store.take_after_read_hook() {
                hook();
            }
            secret.ok_or(KeyringError::NoEntry)
        }

        fn delete_credential(&self) -> KeyringResult<()> {
            self.store.deletes.fetch_add(1, Ordering::SeqCst);
            let removed = self
                .store
                .secrets
                .lock()
                .unwrap()
                .remove(&(self.service.clone(), self.user.clone()));
            if let Some(hook) = self.store.take_after_delete_hook() {
                hook();
            }
            removed.map(|_| ()).ok_or(KeyringError::NoEntry)
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    fn temp_config_dir(test_name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neuralnote-ai-{test_name}-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_config_text(config_dir: &Path) -> String {
        fs::read_to_string(config_file(config_dir)).unwrap()
    }

    /// The revision sidecar, as `key_revision` names it on disk. Putting a
    /// *directory* here is how these tests reach the state where the keychain and
    /// `ai.json` both write fine and every revision publish fails permanently.
    fn key_revision_file(config_dir: &Path) -> PathBuf {
        config_dir.join(".openrouter-key-revision")
    }

    fn provider_config(model: &str) -> ProviderConfig {
        ProviderConfig {
            model: model.into(),
            ..ProviderConfig::default()
        }
    }

    #[test]
    fn openai_client_requests_reasoning_only_when_enabled() {
        // The answer turn is the one that can carry OpenRouter's billed reasoning
        // request. `new(key, false)` must omit it entirely; `new(key, true)` must ask
        // for it — proving the opt-in flag threads through to the wire body.
        let req = LlmRequest {
            model: "anthropic/claude-sonnet-4.5".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };

        let off = OpenAiChatClient::new("sk-test".into(), false).answer_wire_body(&req);
        assert!(
            off.get("reasoning").is_none(),
            "reasoning must be omitted when the user hasn't opted in"
        );

        let on = OpenAiChatClient::new("sk-test".into(), true).answer_wire_body(&req);
        assert_eq!(on["reasoning"]["enabled"], true);
    }

    /* ─────────────  The streamed tool-deciding turn (contract C6)  ───────────── */

    /// The captured OpenRouter turn that core's parser was derived from. Shared
    /// rather than re-captured so the shell and core can never disagree about the
    /// wire, and so no test here writes a tool-call frame of its own.
    const CAPTURE: &str = include_str!(
        "../../../../crates/neuralnote-core/src/ai/fixtures/openrouter_tool_stream.sse"
    );

    /// The capture's completed `write_note`, whose body arrived in 386 fragments.
    const COMPLETED_CALL: u32 = 1;

    /// The capture's raw lines carrying fragments for exactly one call.
    fn frames_for(index: u32) -> Vec<&'static str> {
        use neuralnote_core::ai::openai::{parse_tool_sse_line, ToolSseEvent};
        CAPTURE
            .lines()
            .filter(|line| match parse_tool_sse_line(line) {
                ToolSseEvent::Delta { fragments, .. } => {
                    !fragments.is_empty() && fragments.iter().all(|f| f.index == index)
                }
                _ => false,
            })
            .collect()
    }

    /// Everything the capture sent as `arguments` for one call, in order.
    fn captured_arguments(index: u32) -> String {
        use neuralnote_core::ai::openai::{parse_tool_sse_line, ToolSseEvent};
        frames_for(index)
            .into_iter()
            .filter_map(|line| match parse_tool_sse_line(line) {
                ToolSseEvent::Delta { fragments, .. } => Some(fragments),
                _ => None,
            })
            .flatten()
            .filter_map(|fragment| fragment.arguments)
            .collect()
    }

    fn sse_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
        )
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// A loopback endpoint that answers each request with the next canned
    /// response, and hands back the request bodies it received.
    ///
    /// A real socket on purpose: the point of this change is that the client
    /// actually streams, and a hand-rolled fake transport would prove the parser
    /// works while the wiring stayed inert — which is exactly the state this
    /// feature was already in.
    fn fake_provider(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let handle = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut raw = Vec::new();
                let mut byte = [0u8; 1];
                // Read the head, then exactly the declared body — responding
                // before draining the request would break the pipe under reqwest.
                while !raw.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    raw.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&raw).to_lowercase();
                let length: usize = head
                    .split("content-length:")
                    .nth(1)
                    .and_then(|rest| rest.split("\r\n").next())
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; length];
                stream.read_exact(&mut body).unwrap();
                bodies.push(String::from_utf8_lossy(&body).to_string());
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
            bodies
        });
        (url, handle)
    }

    fn client_for(url: String) -> OpenAiChatClient {
        OpenAiChatClient::new_with(
            url,
            None,
            None,
            Duration::from_secs(5),
            Duration::from_secs(5),
            None,
            false,
        )
    }

    /// The same client as the local (Ollama) provider builds — the one that must
    /// size Ollama's context window on every turn.
    fn local_client_for(url: String, num_ctx: u32) -> OpenAiChatClient {
        OpenAiChatClient::new_with(
            url,
            None,
            None,
            Duration::from_secs(5),
            Duration::from_secs(5),
            Some(num_ctx),
            false,
        )
    }

    fn tool_request() -> LlmRequest {
        LlmRequest {
            model: "z-ai/glm-5.2".into(),
            messages: vec![LlmMessage::user("write up spaced repetition")],
            tools: vec![serde_json::json!({"type": "function"})],
        }
    }

    #[derive(Default)]
    struct RecordingSink(Vec<ChatEvent>, Vec<Option<TokenUsage>>);
    impl EventSink for RecordingSink {
        fn send(&mut self, event: ChatEvent) {
            self.0.push(event);
        }
        fn record_usage(&mut self, usage: Option<TokenUsage>) {
            self.1.push(usage);
        }
    }

    impl RecordingSink {
        fn previews(&self) -> Vec<(&str, &str, bool)> {
            self.0
                .iter()
                .filter_map(|event| match event {
                    ChatEvent::NoteEditPreview {
                        id, body, complete, ..
                    } => Some((id.as_str(), body.as_str(), *complete)),
                    _ => None,
                })
                .collect()
        }
    }

    /// A real streamed answer turn captured from the LOCAL lane (Ollama 0.31.1),
    /// with the `stream_options` this client now sends. Its usage frame carries
    /// an EMPTY `choices` array — the shape the answer parser has to survive.
    const LOCAL_CAPTURE: &str =
        include_str!("../../../../crates/neuralnote-core/src/ai/fixtures/ollama_answer_stream.sse");

    #[tokio::test]
    async fn a_streamed_answer_turn_reports_what_the_provider_charged_for_it() {
        // Over a real socket, through the real client: the parser working in core
        // proves nothing about whether this wiring carries the report out.
        let (url, server) = fake_provider(vec![sse_response(LOCAL_CAPTURE)]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let answer = client
            .complete_streaming(&tool_request(), &mut sink)
            .await
            .unwrap();

        assert!(!answer.is_empty(), "the answer still streamed");
        assert_eq!(
            sink.1,
            vec![Some(TokenUsage {
                tokens_in: 17,
                tokens_out: 153,
            })],
            "exactly one report, carrying the captured counts"
        );
        let body: serde_json::Value = serde_json::from_str(&server.join().unwrap()[0]).unwrap();
        assert_eq!(
            body["stream_options"]["include_usage"], true,
            "the local lane reports nothing at all without this"
        );
    }

    #[tokio::test]
    async fn an_answer_turn_the_provider_never_priced_is_reported_as_unpriced() {
        // Not silence: silence would let the run total its tool turns alone and
        // show that as the whole bill.
        let (url, server) = fake_provider(vec![sse_response(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\ndata: [DONE]\n",
        )]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        client
            .complete_streaming(&tool_request(), &mut sink)
            .await
            .unwrap();

        assert_eq!(sink.1, vec![None]);
        server.join().unwrap();
    }

    #[test]
    fn the_tool_turn_is_streamed_uncapped_and_without_reasoning() {
        // Uncapped because a ceiling hit mid tool-call truncates the note JSON;
        // no reasoning because the tool turn discards reasoning frames, so asking
        // for them would be billed and thrown away. True even for a client whose
        // user opted into reasoning — that opt-in belongs to the answer turn.
        let client = OpenAiChatClient::new("sk-test".into(), true);

        let streamed = client.tool_wire_body(&tool_request(), true);

        assert_eq!(streamed["stream"], true);
        assert!(
            streamed.get("max_tokens").is_none(),
            "a ceiling here would truncate the note the model is composing"
        );
        assert!(
            streamed.get("reasoning").is_none(),
            "the tool turn drops reasoning frames, so requesting them is pure cost"
        );
        assert!(streamed.get("tools").is_some(), "it is still a tool turn");
    }

    #[test]
    fn the_local_tool_turn_still_sizes_ollamas_context_window() {
        // Without `options.num_ctx` Ollama falls back to ~4096 and silently
        // truncates FROM THE FRONT — dropping the grounding rules and earliest
        // evidence, which breaks cited recall on the Local path (PA-001).
        // Streaming the turn must not lose it, so both bodies carry the window.
        let local = local_client_for("http://127.0.0.1:1/chat".into(), 32_768);

        assert_eq!(
            local.tool_wire_body(&tool_request(), true)["options"]["num_ctx"],
            32_768,
            "the streamed tool turn must size the window it will be judged against"
        );
        assert_eq!(
            local.tool_wire_body(&tool_request(), false)["options"]["num_ctx"],
            32_768,
            "and the buffered fallback must size it identically"
        );
    }

    #[tokio::test]
    async fn a_streamed_tool_turn_previews_the_note_as_it_composes_and_returns_the_call() {
        // The whole point of the change: the real client, over a real socket,
        // showing the note arrive and handing back the same call the buffered
        // turn would have.
        let body: String = frames_for(COMPLETED_CALL)
            .iter()
            .map(|line| format!("{line}\n"))
            .chain(std::iter::once("data: [DONE]\n".to_string()))
            .collect();
        let (url, server) = fake_provider(vec![sse_response(&body)]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let completion = client
            .complete_tool_streaming(&tool_request(), &mut sink)
            .await
            .unwrap();

        let previews = sink.previews();
        assert!(
            previews.len() > 100,
            "the body arrives in fragments, so it previews many times ({} here)",
            previews.len()
        );
        assert!(previews.last().unwrap().2, "the last preview is complete");
        let call = completion.tool_calls.first().expect("the call came back");
        assert_eq!(call.name, "write_note");
        assert_eq!(call.arguments, captured_arguments(COMPLETED_CALL));

        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1, "one turn, one request");
        let sent: serde_json::Value = serde_json::from_str(&requests[0]).unwrap();
        assert_eq!(sent["stream"], true, "the turn really was streamed");
    }

    #[tokio::test]
    async fn a_whole_call_in_one_frame_streams_the_same_call_it_previews() {
        // The local-Ollama shape, measured: the entire arguments blob lands in a
        // SINGLE frame. The preview appears already complete rather than
        // composing, and the call handed on must be identical to the fragmented
        // provider's — same capture, one frame instead of 386.
        let first_sight = frames_for(COMPLETED_CALL)
            .into_iter()
            .find(|line| line.contains(r#""name":"write_note""#))
            .expect("the capture's first-sight frame");
        let escaped = serde_json::to_string(&captured_arguments(COMPLETED_CALL)).unwrap();
        let atomic = first_sight.replace(r#""arguments":"""#, &format!(r#""arguments":{escaped}"#));
        assert_ne!(atomic, first_sight, "the substitution really happened");
        let (url, server) = fake_provider(vec![sse_response(&format!("{atomic}\ndata: [DONE]\n"))]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let completion = client
            .complete_tool_streaming(&tool_request(), &mut sink)
            .await
            .unwrap();

        let previews = sink.previews();
        assert_eq!(previews.len(), 1, "one fragment previews exactly once");
        assert!(
            previews[0].2,
            "a whole call is complete the moment it lands"
        );
        assert!(
            previews[0].1.len() > 4000,
            "the whole note previewed at once"
        );
        assert_eq!(
            completion.tool_calls.first().unwrap().arguments,
            captured_arguments(COMPLETED_CALL),
            "atomic and fragmented providers must dispatch the same call"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_provider_that_streams_no_tool_calls_falls_back_to_the_buffered_turn() {
        // Ollama does stream tool calls, but a provider that ignores `stream` on a
        // tool turn would otherwise hand the orchestrator an empty turn — read as
        // "the model chose to answer", silently skipping retrieval for the run.
        let buffered = serde_json::json!({
            "choices": [{"message": {"content": null, "tool_calls": [{
                "id": "call-1",
                "function": {"name": "search_notes", "arguments": "{\"query\":\"x\"}"}
            }]}}]
        })
        .to_string();
        let (url, server) = fake_provider(vec![
            sse_response("data: [DONE]\n"),
            json_response(&buffered),
        ]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let completion = client
            .complete_tool_streaming(&tool_request(), &mut sink)
            .await
            .unwrap();

        assert_eq!(
            completion.tool_calls.first().unwrap().name,
            "search_notes",
            "the turn still completed, via the buffered fallback"
        );
        assert!(
            sink.0.is_empty(),
            "nothing reached the user before the fallback, so it replays over nothing"
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2, "the streamed attempt, then the fallback");
        let retried: serde_json::Value = serde_json::from_str(&requests[1]).unwrap();
        assert_eq!(
            retried["stream"], false,
            "the fallback is the buffered turn"
        );
    }

    #[tokio::test]
    async fn a_turn_that_fails_as_it_settles_still_clears_its_completed_card() {
        // The nastiest case: the note finished composing, so its card reads as
        // DONE, and only then does the turn fail — here on a second call whose
        // first-sight frame never arrived, leaving it with no id to answer. The
        // completed card must still go, or it stands as a note that landed.
        let first_sight = frames_for(COMPLETED_CALL)
            .into_iter()
            .find(|line| line.contains(r#""name":"write_note""#))
            .expect("the capture's first-sight frame");
        let escaped = serde_json::to_string(&captured_arguments(COMPLETED_CALL)).unwrap();
        let atomic = first_sight.replace(r#""arguments":"""#, &format!(r#""arguments":{escaped}"#));
        // A real continuation frame, re-keyed to a call that was never announced.
        let orphan = CAPTURE
            .lines()
            .find(|line| line.contains(r#"{\"query\""#))
            .expect("the capture's search_notes continuation frame")
            .replace(r#""index":0"#, r#""index":3"#);
        let (url, server) = fake_provider(vec![sse_response(&format!(
            "{atomic}\n{orphan}\ndata: [DONE]\n"
        ))]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let error = client
            .complete_tool_streaming(&tool_request(), &mut sink)
            .await
            .expect_err("a call with no id cannot be answered");

        assert!(error.to_string().contains("index 3"), "{error}");
        let completed = sink.previews();
        assert_eq!(completed.len(), 1, "the first note composed in full");
        assert!(completed[0].2, "and its card read as complete");
        assert!(
            sink.0.iter().any(|event| matches!(
                event,
                ChatEvent::NoteEditAbandoned { id, .. } if id == completed[0].0
            )),
            "a completed card must not survive a turn that failed to settle"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_mid_stream_provider_failure_clears_the_note_it_left_on_screen() {
        // The capture's own ending. A half-composed note left on screen would read
        // as one that landed — the exact failure NoteEditAbandoned exists for.
        let body: String = frames_for(COMPLETED_CALL)
            .iter()
            .take(40)
            .map(|line| format!("{line}\n"))
            .chain(std::iter::once(
                CAPTURE
                    .lines()
                    .find(|line| line.contains(r#""finish_reason":"error""#))
                    .map(|line| format!("{line}\n"))
                    .expect("the capture ends on a provider error frame"),
            ))
            .collect();
        let (url, server) = fake_provider(vec![sse_response(&body)]);
        let client = client_for(url);
        let mut sink = RecordingSink::default();

        let error = client
            .complete_tool_streaming(&tool_request(), &mut sink)
            .await
            .expect_err("a provider-declared failure must surface");

        assert!(error.to_string().contains("unfinished plan"), "{error}");
        assert!(!sink.previews().is_empty(), "a card was on screen");
        assert!(
            sink.0
                .iter()
                .any(|event| matches!(event, ChatEvent::NoteEditAbandoned { .. })),
            "the failure must clear the card it left behind"
        );
        server.join().unwrap();
    }

    #[test]
    fn public_openrouter_models_request_never_carries_authorization() {
        let client = reqwest::Client::new();
        let request = openrouter_models_request(&client).build().unwrap();

        assert!(!request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION));
    }

    #[test]
    fn context_window_cache_warms_from_catalogue_body_and_misses_unknown_models() {
        let id = TEST_ID.fetch_add(1, Ordering::SeqCst);
        let known = format!("test/window-known-{id}");
        let unknown = format!("test/window-unknown-{id}");
        assert_eq!(cached_openrouter_context_window(&known), None);

        cache_openrouter_model_windows(
            &serde_json::json!({
                "data": [
                    { "id": known, "context_length": 65_536 },
                    { "id": format!("test/window-zero-{id}"), "context_length": 0 },
                    { "id": format!("test/window-absent-{id}") }
                ]
            })
            .to_string(),
        );

        assert_eq!(cached_openrouter_context_window(&known), Some(65_536));
        assert_eq!(cached_openrouter_context_window(&unknown), None);
        // Absent/zero lengths never warm the cache — an unknown window stays inert.
        assert_eq!(
            cached_openrouter_context_window(&format!("test/window-zero-{id}")),
            None
        );
        assert_eq!(
            cached_openrouter_context_window(&format!("test/window-absent-{id}")),
            None
        );

        // A malformed body warms nothing and leaves the cache intact (fail-open).
        cache_openrouter_model_windows("{not json");
        assert_eq!(cached_openrouter_context_window(&known), Some(65_536));
    }

    #[test]
    fn chat_client_reports_the_window_it_will_enforce() {
        // Local: the window is the `num_ctx` sent to Ollama — the shared core
        // constant, so the budget and the enforced window can never drift.
        let local = OpenAiChatClient::new_with(
            "http://127.0.0.1:1/v1/chat/completions".into(),
            None,
            None,
            Duration::from_secs(1),
            Duration::from_secs(1),
            Some(neuralnote_core::ai::local::OLLAMA_NUM_CTX),
            false,
        );
        assert_eq!(
            local.context_window_tokens(),
            Some(neuralnote_core::ai::local::OLLAMA_NUM_CTX as usize)
        );

        // OpenRouter: unknown until the catalogue cache warms (inert-with-reason),
        // then the catalogue `context_length`.
        let cloud = OpenAiChatClient::new("sk-test".into(), false);
        assert_eq!(cloud.context_window_tokens(), None);
        let cloud = cloud.with_context_window(Some(200_000));
        assert_eq!(cloud.context_window_tokens(), Some(200_000));
    }

    #[test]
    fn pricing_cache_is_optional_for_ordinary_chat_and_accepts_validated_catalogue_data() {
        let model = format!("test/model-{}", TEST_ID.fetch_add(1, Ordering::SeqCst));
        assert_eq!(cached_openrouter_pricing(&model), None);

        cache_openrouter_pricing(
            &serde_json::json!({
                "data": [{
                    "id": model,
                    "pricing": { "prompt": "0.000003" }
                }]
            })
            .to_string(),
            &model,
        );

        assert_eq!(
            cached_openrouter_pricing(&model),
            Some(ModelPricing {
                model,
                input_usd_per_token: 0.000003,
            })
        );
    }

    #[test]
    fn api_key_status_returns_err_for_present_corrupt_config_without_touching_keychain() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-corrupt-config");
        fs::write(config_file(&config_dir), "{not json").unwrap();

        let err = api_key_status(&config_dir).unwrap_err();

        match err {
            CoreError::Io(msg) => {
                assert!(msg.contains("could not parse AI config"));
                assert!(msg.contains("ai-config.json"));
            }
            other => panic!("expected corrupt config to surface as CoreError::Io, got {other:?}"),
        }
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "status must not perform a keychain read, even when config is corrupt"
        );
    }

    #[test]
    fn api_key_status_reports_no_key_when_config_absent_and_keychain_empty() {
        // Missing config + empty keychain: first run reads as "no key" and still
        // reports the default model, without needing a persisted config file.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let _keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-absent-config");

        let status = api_key_status(&config_dir).unwrap();

        assert!(!status.has_key);
        assert_eq!(status.model, DEFAULT_MODEL);
        assert!(!config_file(&config_dir).exists());
    }

    #[test]
    fn api_key_status_reports_present_from_keychain_ignoring_a_stale_false_flag() {
        // Issue #14: a stale `keyConfigured:false` in the config must NOT hide a key
        // that is actually present in the keychain — presence is authoritative.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-stale-false");
        fs::write(
            config_file(&config_dir),
            r#"{"model":"openai/gpt-4.1","keyConfigured":false}"#,
        )
        .unwrap();
        keychain.set(keychain_service(), keychain_account(), "sk-or-present");

        let status = api_key_status(&config_dir).unwrap();

        assert!(
            status.has_key,
            "a present key must not be hidden by a stale flag"
        );
        assert_eq!(status.model, "openai/gpt-4.1");
    }

    #[test]
    fn api_key_status_reports_absent_from_keychain_ignoring_a_stale_true_flag() {
        // Issue #14: a stale `keyConfigured:true` (e.g. a crash after a clear wrote
        // the keychain delete but not the config) must read as "no key" because the
        // keychain is empty.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let _keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-stale-true");
        fs::write(
            config_file(&config_dir),
            r#"{"model":"openai/gpt-4.1","keyConfigured":true}"#,
        )
        .unwrap();

        let status = api_key_status(&config_dir).unwrap();

        assert!(!status.has_key, "an empty keychain must read as no key");
        assert_eq!(status.model, "openai/gpt-4.1");
    }

    #[test]
    fn api_key_status_surfaces_a_keychain_failure_instead_of_reading_no_key() {
        // A genuine keychain failure must be surfaced honestly, never silently
        // collapsed to has_key:false.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-keychain-failure");
        write_provider_config(&config_dir, &provider_config("openai/gpt-4.1")).unwrap();
        keychain.fail_reads();

        match api_key_status(&config_dir).unwrap_err() {
            CoreError::Io(msg) => assert!(msg.contains("keychain read failed")),
            other => panic!("expected a keychain failure to surface as Io, got {other:?}"),
        }
    }

    #[test]
    fn chat_key_routing_surfaces_a_keychain_failure_end_to_end() {
        // End-to-end through the real `read_api_key` seam: a keychain fault must
        // reach the chat provider-routing guard as the couldn't-read error event,
        // never as "no key" (issue #14). Guards `resolve_key_presence` against a
        // future refactor that collapses the read error to `false`.
        use neuralnote_core::ai::ChatEvent;

        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("chat-key-routing");
        keychain.fail_reads();

        match crate::commands::ai::resolve_key_presence(read_api_key(&config_dir)) {
            Err(ChatEvent::Error { message }) => {
                assert!(
                    message.contains("Couldn't read the API key"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("a keychain read failure must not route as a key state, got {other:?}"),
        }
    }

    #[test]
    fn save_api_key_writes_secret_to_keychain_and_only_model_flag_to_config() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("save-no-secret-in-config");
        let key = "sk-or-secret-should-never-hit-json";

        save_api_key_in(
            &config_dir,
            &ProviderConfigMutationGate::default(),
            key,
            "anthropic/claude-opus-4.1",
        )
        .unwrap();

        assert_eq!(
            keychain
                .get(keychain_service(), keychain_account())
                .as_deref(),
            Some(key)
        );
        let raw = read_config_text(&config_dir);
        assert!(raw.contains(r#""model""#));
        assert!(raw.contains("anthropic/claude-opus-4.1"));
        assert!(
            !raw.contains("keyConfigured"),
            "key state is derived from the keychain and must never be persisted (issue #14)"
        );
        assert!(!raw.contains(key), "the API key must never be serialized");
        assert_eq!(
            provider_config::read_provider_config(&config_dir)
                .unwrap()
                .reasoning_probe_generation,
            1,
            "enabling the legacy effective OpenRouter target must invalidate old probe ownership"
        );
    }

    #[test]
    fn save_api_key_rejects_empty_and_whitespace_keys_without_writing() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let gate = ProviderConfigMutationGate::default();
        let config_dir = temp_config_dir("reject-empty-key");
        save_api_key_in(&config_dir, &gate, "sk-or-original", "openai/gpt-4.1").unwrap();
        let original_config = read_config_text(&config_dir);
        let original_writes = keychain.writes.load(Ordering::SeqCst);
        let original_reads = keychain.reads.load(Ordering::SeqCst);

        for blank in ["", "   "] {
            let err = save_api_key_in(&config_dir, &gate, blank, "anthropic/claude-opus-4.1")
                .unwrap_err();

            assert!(matches!(
                err,
                CoreError::InvalidName(msg) if msg == "API key cannot be empty"
            ));
            assert_eq!(
                keychain
                    .get(keychain_service(), keychain_account())
                    .as_deref(),
                Some("sk-or-original")
            );
            assert_eq!(read_config_text(&config_dir), original_config);
            assert_eq!(keychain.writes.load(Ordering::SeqCst), original_writes);
            assert_eq!(
                read_api_key(&config_dir).unwrap().as_deref(),
                Some("sk-or-original")
            );
            assert_eq!(
                keychain.reads.load(Ordering::SeqCst),
                original_reads,
                "rejecting a blank key must leave the in-memory cache untouched"
            );
        }
    }

    #[test]
    fn save_api_key_still_reads_the_written_key_when_config_persistence_fails() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let parent = temp_config_dir("save-config-persist-fails");
        // A file where the config *dir* should be: the config step can neither read
        // nor write it, so persistence fails after the keychain write succeeds.
        let blocked_config_dir = parent.join("not-a-dir");
        fs::write(&blocked_config_dir, "blocks the config dir").unwrap();

        let err = save_api_key_in(
            &blocked_config_dir,
            &ProviderConfigMutationGate::default(),
            "sk-or-session",
            "openai/gpt-4.1",
        )
        .expect_err("config persistence should fail after the keychain write succeeds");

        // The keychain write already committed (outside the config gate); the gated
        // config step then fails. Save surfaces that as Io — never silently, never a
        // guessed default that would flip the user's provider — and leaves the key in
        // the keychain (and the in-session cache).
        match err {
            CoreError::Io(msg) => {
                assert!(
                    msg.starts_with(
                        "API key was stored in the keychain, but the AI preference file could not be updated: "
                    ),
                    "unexpected message: {msg}"
                );
            }
            other => panic!(
                "expected config persistence failure to surface as CoreError::Io, got {other:?}"
            ),
        }
        assert_eq!(
            keychain
                .get(keychain_service(), keychain_account())
                .as_deref(),
            Some("sk-or-session")
        );
        assert_eq!(
            read_api_key(&blocked_config_dir).unwrap().as_deref(),
            Some("sk-or-session"),
            "chat in this session should still see the key the keychain write committed"
        );
        // One read, not zero: this config dir cannot hold a key revision either, so
        // the cache has nothing to bind to and fails closed to the keychain. That is
        // the intended trade — a directory this broken costs a round trip per read
        // rather than risking a key no revision can ever invalidate (issue #132).
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            1,
            "an unusable config dir must disable cache reuse, not silently keep a key \
             nothing can invalidate"
        );
    }

    /// Issue #21 AC #2: the config-mutation gate lock must NOT span keychain I/O.
    /// Proven deterministically: a holder thread takes the shared gate and keeps it;
    /// a saver thread then runs the full `save_api_key_in` and its keychain write
    /// lands (asserted) WHILE the holder still owns the gate. If the keychain write
    /// were inside the gate, it could not run until the holder released it. Barriers
    /// replace every timing assumption, so the interleave is exact, not flaky.
    #[test]
    fn save_writes_keychain_before_taking_the_config_gate() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("save-keychain-outside-gate");
        write_provider_config(&config_dir, &provider_config("vendor/old")).unwrap();
        let gate = ProviderConfigMutationGate::default();

        let gate_held = Arc::new(Barrier::new(2));
        let keychain_written = Arc::new(Barrier::new(2));
        let release_holder = Arc::new(Barrier::new(2));

        // Fires the instant the keychain write lands. We assert it fires while the
        // holder still owns the gate — impossible if the write were under the lock.
        let keychain_written_hook = Arc::clone(&keychain_written);
        keychain.after_next_write(move || {
            keychain_written_hook.wait();
        });

        std::thread::scope(|scope| {
            let holder_gate = gate.clone();
            let holder_dir = config_dir.clone();
            let gate_held_holder = Arc::clone(&gate_held);
            let release_holder_holder = Arc::clone(&release_holder);
            scope.spawn(move || {
                holder_gate
                    .run(&holder_dir, || {
                        gate_held_holder.wait();
                        release_holder_holder.wait();
                        Ok(())
                    })
                    .unwrap();
            });

            // The holder now owns the gate; start the real save in that window.
            gate_held.wait();
            let saver_gate = gate.clone();
            let saver_dir = config_dir.clone();
            let saver = scope.spawn(move || {
                save_api_key_in(&saver_dir, &saver_gate, "sk-or-unblocked", "vendor/new")
            });

            // The keychain write completed while the gate was held by another thread.
            keychain_written.wait();
            assert_eq!(
                keychain.get(keychain_service(), keychain_account()).as_deref(),
                Some("sk-or-unblocked"),
                "keychain write landed while the config gate was held elsewhere: the lock does not span keychain I/O"
            );

            // Release the holder; the saver's gated config step now proceeds.
            release_holder.wait();
            saver.join().unwrap().unwrap();
        });

        let persisted = provider_config::read_provider_config(&config_dir).unwrap();
        assert_eq!(
            persisted.model, "vendor/new",
            "the config step must still land once the gate is free"
        );
        assert_eq!(
            keychain
                .get(keychain_service(), keychain_account())
                .as_deref(),
            Some("sk-or-unblocked"),
            "the key stays in the keychain — the authoritative key-configured source"
        );
    }

    #[test]
    fn clear_api_key_deletes_key_sets_flag_false_and_empties_cache() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let gate = ProviderConfigMutationGate::default();
        let config_dir = temp_config_dir("clear-cache");
        save_api_key_in(&config_dir, &gate, "sk-or-clear-me", "openai/gpt-4.1").unwrap();

        clear_api_key_in(&config_dir, &gate).unwrap();

        assert!(!keychain.contains(keychain_service(), keychain_account()));
        let status = api_key_status(&config_dir).unwrap();
        assert!(!status.has_key);
        assert_eq!(status.model, "openai/gpt-4.1");
        assert_eq!(
            provider_config::read_provider_config(&config_dir)
                .unwrap()
                .reasoning_probe_generation,
            2,
            "clearing the legacy effective OpenRouter target must invalidate old probe ownership"
        );
        assert_eq!(read_api_key(&config_dir).unwrap(), None);
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            1,
            "reading after clear should hit the keychain once, proving the old cached key was removed"
        );
    }

    #[test]
    fn clear_api_key_surfaces_corrupt_config_without_clobbering_it() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let gate = ProviderConfigMutationGate::default();
        let config_dir = temp_config_dir("clear-corrupt-config");
        save_api_key_in(&config_dir, &gate, "sk-or-clear-corrupt", "openai/gpt-4.1").unwrap();
        let corrupt_config = "{not json";
        fs::write(config_file(&config_dir), corrupt_config).unwrap();

        let err = clear_api_key_in(&config_dir, &gate)
            .expect_err("clearing a key must not overwrite a corrupt model config");

        match err {
            CoreError::Io(msg) => {
                assert!(msg.starts_with(
                    "The keychain was cleared, but the AI preference file could not be updated: "
                ));
                assert!(msg.contains("could not parse AI config"));
            }
            other => panic!("expected corrupt config to surface as CoreError::Io, got {other:?}"),
        }
        assert!(
            !keychain.contains(keychain_service(), keychain_account()),
            "the keychain delete already succeeded and should stay deleted"
        );
        assert_eq!(
            read_config_text(&config_dir),
            corrupt_config,
            "clearing the key must not replace a corrupt config with the default model"
        );
        assert!(api_key_status(&config_dir).is_err());
    }

    #[test]
    fn read_api_key_does_not_cache_stale_key_when_clear_happens_during_cache_miss() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("cache-clear-race");
        write_provider_config(&config_dir, &provider_config("openai/gpt-4.1")).unwrap();
        keychain.set(keychain_service(), keychain_account(), "sk-or-old");
        let clear_config_dir = config_dir.clone();
        let clear_gate = ProviderConfigMutationGate::default();
        keychain.after_next_read(move || {
            clear_api_key_in(&clear_config_dir, &clear_gate).unwrap();
        });

        assert_eq!(
            read_api_key(&config_dir).unwrap().as_deref(),
            Some("sk-or-old")
        );
        assert!(!keychain.contains(keychain_service(), keychain_account()));
        assert_eq!(read_api_key(&config_dir).unwrap(), None);
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            2,
            "the next read must re-check keychain instead of returning the stale cached key"
        );
    }

    #[test]
    fn read_api_key_populates_cache_once_and_reuses_it() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("cache-reuse");
        keychain.set(keychain_service(), keychain_account(), "sk-or-cached");

        assert_eq!(
            read_api_key(&config_dir).unwrap().as_deref(),
            Some("sk-or-cached")
        );
        assert_eq!(
            read_api_key(&config_dir).unwrap().as_deref(),
            Some("sk-or-cached")
        );

        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            1,
            "the keychain should be read only on the first cache miss"
        );
    }

    #[test]
    fn a_revision_published_by_another_instance_retires_the_cached_key() {
        // The single-process shadow of the two-instance acceptance test in
        // `ai_key_revision_tests.rs`: that one proves the real boundary, this one
        // pins the mechanism deterministically and cheaply. What goes red here is
        // comparing the cache against anything other than the published revision.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-retires-cache");
        keychain.set(keychain_service(), keychain_account(), "sk-or-first");

        assert_eq!(
            read_api_key(&config_dir).unwrap().as_deref(),
            Some("sk-or-first")
        );

        // What another running instance's save looks like from here: the keychain
        // holds something new, and a revision nothing has seen is published.
        keychain.set(keychain_service(), keychain_account(), "sk-or-second");
        key_revision::publish(&config_dir).unwrap();

        assert_eq!(
            read_api_key(&config_dir).unwrap().as_deref(),
            Some("sk-or-second"),
            "a key cached against a superseded revision must not be served"
        );
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_save_retires_cached_keys_both_before_and_after_it_writes_the_keychain() {
        // Neither publish is redundant, and the two-instance test cannot see either
        // on its own — it only proves the end state.
        //
        // BEFORE the write, because a crash in between would otherwise leave every
        // other instance serving a key that no longer exists, with nothing left to
        // tell them. AFTER it, because an instance that re-read *during* the write
        // would otherwise have cached the OLD secret against the new revision and
        // kept it indefinitely.
        //
        // What goes red: moving either publish to the other side of the write, or
        // dropping one of them.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-around-write");
        key_revision::publish(&config_dir).unwrap();
        let before_save = key_revision::observe(&config_dir);

        let observed_mid_write = Arc::new(StdMutex::new(None));
        let recorder = Arc::clone(&observed_mid_write);
        let recorder_dir = config_dir.clone();
        keychain.after_next_write(move || {
            *recorder.lock().unwrap() = key_revision::observe(&recorder_dir);
        });

        set_keychain_api_key(&config_dir, "sk-or-ordered").unwrap();

        let mid_write = observed_mid_write.lock().unwrap().clone();
        assert!(
            mid_write.is_some() && mid_write != before_save,
            "the revision must already have moved when the keychain write lands, or a \
             crash before the second publish strands every other instance"
        );
        assert!(
            key_revision::observe(&config_dir) != mid_write,
            "the revision must move again after the write, or an instance that re-read \
             mid-write keeps the old secret against a revision that never changes again"
        );
    }

    #[test]
    fn a_clear_retires_cached_keys_both_before_and_after_it_deletes_the_credential() {
        // The clear path's counterpart to the save's ordering test above, and the
        // more security-relevant of the two: this is the revocation. Until now
        // either publish could be deleted and the whole suite stayed green.
        //
        // BEFORE the delete, because a crash in between would otherwise leave
        // every other instance still serving a key the user just revoked, with
        // nothing left to tell them. AFTER it, because an instance that re-read
        // *during* the delete could have cached the still-present secret against
        // the new revision and kept it indefinitely.
        //
        // What goes red: dropping either publish, or moving one to the other side
        // of the delete.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-around-delete");
        keychain.set(keychain_service(), keychain_account(), "sk-or-revoked");
        key_revision::publish(&config_dir).unwrap();
        let before_clear = key_revision::observe(&config_dir);

        let observed_mid_delete = Arc::new(StdMutex::new(None));
        let recorder = Arc::clone(&observed_mid_delete);
        let recorder_dir = config_dir.clone();
        keychain.after_next_delete(move || {
            *recorder.lock().unwrap() = key_revision::observe(&recorder_dir);
        });

        clear_keychain_api_key(&config_dir).unwrap();

        let mid_delete = observed_mid_delete.lock().unwrap().clone();
        assert!(
            mid_delete.is_some() && mid_delete != before_clear,
            "the revision must already have moved when the delete lands, or a crash \
             before the second publish leaves every other instance sending a revoked key"
        );
        assert!(
            key_revision::observe(&config_dir) != mid_delete,
            "the revision must move again after the delete, or an instance that re-read \
             mid-delete keeps the revoked secret against a revision that never changes again"
        );
    }

    #[test]
    fn a_clear_landing_mid_save_is_not_undone_by_the_saves_own_cache_adoption() {
        // `set_keychain_api_key` and `clear_keychain_api_key` are both lock-free
        // commands, so a user rotating a key in one window while revoking it in
        // another interleaves exactly like this: the save writes the new key, the
        // clear then publishes, deletes the credential and publishes again, and
        // only afterwards does the save publish its own second revision and adopt
        // what it wrote. The sidecar's current token is the save's, so an
        // unguarded adoption leaves a REVOKED key cached against the live
        // revision — and every later read hits it, for as long as the process
        // runs. That is the class of bug the revision exists to kill.
        //
        // What goes red: dropping the generation guard in `adopt_saved_key`.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("save-racing-a-clear");

        let clearing_dir = config_dir.clone();
        keychain.after_next_write(move || {
            clear_keychain_api_key(&clearing_dir).unwrap();
        });

        set_keychain_api_key(&config_dir, "sk-or-rotated").unwrap();

        assert!(
            !keychain.contains(keychain_service(), keychain_account()),
            "the clear won the race, so the credential must be gone"
        );
        assert_eq!(
            read_api_key(&config_dir).unwrap(),
            None,
            "a key revoked while the save was in flight must not be served from the cache"
        );
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            1,
            "the read must have asked the keychain rather than answered from a cache \
             the save adopted after the revocation"
        );
    }

    #[test]
    fn an_ordinary_save_and_clear_report_their_revision_as_published() {
        // The other half of the pair below: without this, hardwiring
        // `revision_published: false` would pass every other test in the file.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let _keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-published");

        let saved = set_keychain_api_key(&config_dir, "sk-or-published").unwrap();
        let cleared = clear_keychain_api_key(&config_dir).unwrap();

        assert!(saved.revision_published);
        assert!(cleared.revision_published);
    }

    #[test]
    fn a_key_change_that_cannot_publish_its_revision_says_so_rather_than_reporting_a_clean_change()
    {
        // Reachable with nothing else wrong, and this repo's own
        // `key_revision_tests` builds the state: a perfectly writable config
        // directory with a DIRECTORY sitting where the sidecar belongs. The
        // keychain still takes the change, `ai.json` still writes, and every
        // rename fails permanently. Reported as a plain success, that is issue
        // #132 silently re-armed — and on the clear path the user is told their
        // key is revoked while another instance keeps transmitting it.
        //
        // What goes red: reporting `revision_published: true` unconditionally, or
        // deciding it from only one of the two publishes.
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-unpublishable");
        fs::create_dir(key_revision_file(&config_dir)).unwrap();

        let saved = set_keychain_api_key(&config_dir, "sk-or-unpublishable").unwrap();

        assert!(
            !saved.revision_published,
            "a save whose revision never landed must not report a clean save"
        );
        assert_eq!(
            keychain
                .get(keychain_service(), keychain_account())
                .as_deref(),
            Some("sk-or-unpublishable"),
            "the keychain change itself committed — that is why this is reported, not returned"
        );

        let cleared = clear_keychain_api_key(&config_dir).unwrap();

        assert!(
            !cleared.revision_published,
            "a revocation whose revision never landed must not report a clean revocation"
        );
        assert!(!keychain.contains(keychain_service(), keychain_account()));
    }

    #[test]
    fn a_revision_that_cannot_be_read_disables_reuse_rather_than_trusting_memory() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("revision-unreadable");
        keychain.set(keychain_service(), keychain_account(), "sk-or-unverifiable");
        fs::write(key_revision_file(&config_dir), "not a token").unwrap();

        for _ in 0..3 {
            assert_eq!(
                read_api_key(&config_dir).unwrap().as_deref(),
                Some("sk-or-unverifiable")
            );
        }

        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            3,
            "with no trustworthy revision every read must re-ask the keychain — a spare \
             round trip is the safe direction, a key nothing can invalidate is not"
        );
    }
}
