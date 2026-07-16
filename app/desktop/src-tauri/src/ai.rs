//! The AI plumbing for the desktop shell — the host side of the client-agnostic
//! `neuralnote_core::ai` seam.
//!
//! Three responsibilities live here, all OS/transport concerns the core stays free
//! of: the **OS keychain** for the BYO API key (the key is read in Rust at call
//! time and NEVER returned to the webview), the **OpenRouter HTTP client**
//! (`reqwest`, OpenAI-compatible) implementing [`LlmClient`], and a
//! [`TauriChannelSink`] that forwards [`ChatEvent`]s to the frontend over a Tauri
//! channel. The `#[tauri::command]`s that expose this are in `commands/ai.rs`.

use async_trait::async_trait;
use futures_util::StreamExt;
use neuralnote_core::ai::{openai, provider_config};
use neuralnote_core::ai::{
    openrouter_reasoning_support, parse_openrouter_input_pricing, ChatEvent, Completion, EventSink,
    LlmClient, LlmMessage, LlmRequest, ReasoningSupport, Role,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiKeyStatus {
    pub has_key: bool,
    pub model: String,
}

struct CacheState {
    generation: u64,
    value: Option<Option<String>>,
}

// TODO(cross-process-key-cache): remove this process-lifetime cache or bind it
// to a cross-process key revision, then prove two running instances observe a
// save/clear before their next provider request.
static API_KEY_CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();
static OPENROUTER_PRICING_CACHE: OnceLock<Mutex<BTreeMap<String, ModelPricing>>> = OnceLock::new();

/* ─────────────────────────────  Keychain  ──────────────────────────────── */

fn api_key_cache() -> &'static Mutex<CacheState> {
    API_KEY_CACHE.get_or_init(|| {
        Mutex::new(CacheState {
            generation: 0,
            value: None,
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

fn set_api_key_cache(value: Option<String>) {
    let mut state = cache_guard();
    bump_cache_generation(&mut state);
    state.value = Some(normalized_api_key(value));
}

fn clear_api_key_cache() {
    let mut state = cache_guard();
    bump_cache_generation(&mut state);
    state.value = None;
}

fn entry(account: &str) -> Result<keyring::Entry, CoreError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
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
pub fn read_api_key() -> Result<Option<String>, CoreError> {
    let generation = {
        let state = cache_guard();
        if let Some(cached) = state.value.as_ref() {
            return Ok(cached.clone());
        }
        state.generation
    };

    let key = normalized_api_key(read_secret(KEY_ACCOUNT)?);
    {
        let mut state = cache_guard();
        if state.generation == generation && state.value.is_none() {
            state.value = Some(key.clone());
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
        has_key: read_api_key()?.is_some(),
        model: config.model,
    })
}

/// Store the API key in the OS keychain and refresh the in-session cache. This is
/// the *keychain-only* half of saving a key: it performs no config I/O and takes no
/// lock, so the caller can persist the non-secret model preference under the
/// config-mutation gate WITHOUT that lock ever spanning this keychain write (issue
/// #21 AC #2). An empty/whitespace key is rejected before anything is written, so a
/// bad request never mutates the keychain or the config that follows it.
pub fn set_keychain_api_key(key: &str) -> Result<(), CoreError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::InvalidName("API key cannot be empty".into()));
    }
    entry(KEY_ACCOUNT)?
        .set_password(key)
        .map_err(|e| CoreError::Io(format!("could not store API key in the keychain: {e}")))?;
    set_api_key_cache(Some(key.to_string()));
    Ok(())
}

/// Remove the stored key from the OS keychain and empty the in-session cache. The
/// keychain-only half of clearing a key — no config I/O, no lock (see
/// [`set_keychain_api_key`]). Idempotent: deleting an already-absent entry is
/// success, so a double-clear, or a clear before anything was ever set, is fine. The
/// cache is emptied *before* the delete so no concurrent reader can observe a key the
/// delete is about to remove.
pub fn clear_keychain_api_key() -> Result<(), CoreError> {
    clear_api_key_cache();
    match entry(KEY_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CoreError::Io(format!(
            "could not remove API key from the keychain: {e}"
        ))),
    }
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
            reasoning,
        }
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
}

#[async_trait]
impl LlmClient for OpenAiChatClient {
    async fn complete(&self, req: &LlmRequest) -> Result<Completion, CoreError> {
        // No reasoning on tool-deciding turns: they aren't streamed and their content
        // is parsed for tool_calls, so reasoning tokens here would be invisible cost.
        let body = openai::to_wire_request(
            req,
            /* stream */ false,
            self.num_ctx,
            /* max_tokens */ None,
            /* reasoning */ false,
        );
        let resp = self.post(&body).await?;
        let provider = self.provider_label();
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CoreError::Llm(format!("could not parse {provider} response: {e}")))?;
        openai::parse_completion(value)
    }

    async fn complete_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> Result<String, CoreError> {
        // The answer turn carries the output ceiling; tool-deciding turns do not. It
        // also carries the reasoning request (OpenRouter only, when opted in) — this is
        // the one turn whose reasoning tokens surface as live `Thinking` events.
        let body = self.answer_wire_body(req);
        let resp = self.post(&body).await?;

        // Buffer BYTES, not str: a chunk can split a multibyte char, but never the
        // `\n` line delimiter (a single byte, never part of a UTF-8 sequence), so
        // decoding each complete line is always valid. The `full` string we return
        // is the exact concatenation of the deltas we streamed — the orchestrator
        // scans it for cited ids, so returned MUST equal streamed (it does here by
        // construction).
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut full = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CoreError::Llm(format!("stream read error: {e}")))?;
            buf.extend_from_slice(&chunk);

            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                if let Some(answer) = openai::consume_sse_line(&line_bytes, sink, &mut full)? {
                    return openai::finish_answer(answer);
                }
            }
        }
        // Flush a final line the stream left without a trailing newline — otherwise a
        // last delta, or a terminal error frame, in the tail would be silently lost
        // (and a cited id in that tail would go missing, corrupting verification).
        if !buf.is_empty() {
            openai::consume_sse_line(&buf, sink, &mut full)?;
        }
        openai::finish_answer(full)
    }
}

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
            self.store
                .secrets
                .lock()
                .unwrap()
                .remove(&(self.service.clone(), self.user.clone()))
                .map(|_| ())
                .ok_or(KeyringError::NoEntry)
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

    #[test]
    fn public_openrouter_models_request_never_carries_authorization() {
        let client = reqwest::Client::new();
        let request = openrouter_models_request(&client).build().unwrap();

        assert!(!request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION));
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
        keychain.set(KEYCHAIN_SERVICE, KEY_ACCOUNT, "sk-or-present");

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
        keychain.fail_reads();

        match crate::commands::ai::resolve_key_presence(read_api_key()) {
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
            keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
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
                keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
                Some("sk-or-original")
            );
            assert_eq!(read_config_text(&config_dir), original_config);
            assert_eq!(keychain.writes.load(Ordering::SeqCst), original_writes);
            assert_eq!(read_api_key().unwrap().as_deref(), Some("sk-or-original"));
            assert_eq!(
                keychain.reads.load(Ordering::SeqCst),
                original_reads,
                "rejecting a blank key must leave the in-memory cache untouched"
            );
        }
    }

    #[test]
    fn save_api_key_caches_written_key_when_config_persistence_fails() {
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
            keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
            Some("sk-or-session")
        );
        assert_eq!(
            read_api_key().unwrap().as_deref(),
            Some("sk-or-session"),
            "chat in this session should see the key cached from the successful keychain write"
        );
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "the cached key should be used without an extra keychain read"
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
                keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
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
            keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
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

        assert!(!keychain.contains(KEYCHAIN_SERVICE, KEY_ACCOUNT));
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
        assert_eq!(read_api_key().unwrap(), None);
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
            !keychain.contains(KEYCHAIN_SERVICE, KEY_ACCOUNT),
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
        keychain.set(KEYCHAIN_SERVICE, KEY_ACCOUNT, "sk-or-old");
        let clear_config_dir = config_dir.clone();
        let clear_gate = ProviderConfigMutationGate::default();
        keychain.after_next_read(move || {
            clear_api_key_in(&clear_config_dir, &clear_gate).unwrap();
        });

        assert_eq!(read_api_key().unwrap().as_deref(), Some("sk-or-old"));
        assert!(!keychain.contains(KEYCHAIN_SERVICE, KEY_ACCOUNT));
        assert_eq!(read_api_key().unwrap(), None);
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
        keychain.set(KEYCHAIN_SERVICE, KEY_ACCOUNT, "sk-or-cached");

        assert_eq!(read_api_key().unwrap().as_deref(), Some("sk-or-cached"));
        assert_eq!(read_api_key().unwrap().as_deref(), Some("sk-or-cached"));

        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            1,
            "the keychain should be read only on the first cache miss"
        );
    }
}
