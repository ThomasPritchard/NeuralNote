//! The AI plumbing for the desktop shell — the host side of the client-agnostic
//! `neuralnote_core::ai` seam.
//!
//! Three responsibilities live here, all OS/transport concerns the core stays free
//! of: the **OS keychain** for the BYO API key (the key is read in Rust at call
//! time and NEVER returned to the webview), the **OpenRouter HTTP client**
//! (`reqwest`, OpenAI-compatible) implementing [`LlmClient`], and a
//! [`TauriChannelSink`] that forwards [`ChatEvent`]s to the frontend over a Tauri
//! channel. The four `#[tauri::command]`s that expose this are in `lib.rs`.

use async_trait::async_trait;
use futures_util::StreamExt;
use neuralnote_core::ai::{
    ChatEvent, Completion, EventSink, LlmClient, LlmMessage, LlmRequest, Role, ToolCall,
    DEFAULT_MODEL,
};
use neuralnote_core::CoreError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

/// OpenRouter's OpenAI-compatible chat-completions endpoint.
const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";

/// Keychain identity for the secret API key.
const KEYCHAIN_SERVICE: &str = "com.neuralnote.desktop";
const KEY_ACCOUNT: &str = "openrouter-api-key";
const AI_CONFIG_FILE: &str = "ai-config.json";
static AI_CONFIG_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub has_key: bool,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAiConfig {
    model: String,
    key_configured: bool,
}

impl Default for StoredAiConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.to_string(),
            key_configured: false,
        }
    }
}

struct CacheState {
    generation: u64,
    value: Option<Option<String>>,
}

static API_KEY_CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();

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

fn config_file(config_dir: &Path) -> PathBuf {
    config_dir.join(AI_CONFIG_FILE)
}

fn normalized_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        model.to_string()
    }
}

fn normalize_config(mut config: StoredAiConfig) -> StoredAiConfig {
    config.model = normalized_model(&config.model);
    config
}

fn read_config_fallible(config_dir: &Path) -> Result<StoredAiConfig, CoreError> {
    let path = config_file(config_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredAiConfig::default());
        }
        Err(e) => {
            return Err(CoreError::Io(format!(
                "could not read AI config at {}: {e}",
                path.display()
            )))
        }
    };

    match serde_json::from_str::<StoredAiConfig>(&raw) {
        Ok(config) => Ok(normalize_config(config)),
        Err(e) => Err(CoreError::Io(format!(
            "could not parse AI config at {}: {e}",
            path.display()
        ))),
    }
}

fn read_config_lenient(config_dir: &Path) -> StoredAiConfig {
    match read_config_fallible(config_dir) {
        Ok(config) => config,
        Err(CoreError::Io(msg)) => {
            log::warn!("{msg}");
            StoredAiConfig::default()
        }
        Err(e) => {
            log::warn!("could not read AI config: {e}");
            StoredAiConfig::default()
        }
    }
}

fn error_detail(error: CoreError) -> String {
    match error {
        CoreError::NotFound(msg)
        | CoreError::AlreadyExists(msg)
        | CoreError::OutsideVault(msg)
        | CoreError::InvalidName(msg)
        | CoreError::Conflict(msg)
        | CoreError::Io(msg)
        | CoreError::Frontmatter(msg)
        | CoreError::Llm(msg) => msg,
    }
}

fn write_config(config_dir: &Path, config: &StoredAiConfig) -> Result<(), CoreError> {
    fs::create_dir_all(config_dir)
        .map_err(|e| CoreError::Io(format!("could not create AI config dir: {e}")))?;
    let config = StoredAiConfig {
        model: normalized_model(&config.model),
        key_configured: config.key_configured,
    };
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|e| CoreError::Io(format!("could not serialize AI config: {e}")))?;
    let path = config_file(config_dir);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| AI_CONFIG_FILE.into());
    let parent = path.parent().ok_or_else(|| {
        CoreError::Io(format!("AI config path has no parent: {}", path.display()))
    })?;
    let seq = AI_CONFIG_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{file_name}.{}.{seq}.nn-tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(CoreError::Io(format!("could not write AI config: {e}")));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(CoreError::Io(format!("could not replace AI config: {e}")));
    }
    Ok(())
}

/// What the frontend can know without touching the keychain: whether a key was
/// configured and the model preference. The key itself is never returned.
pub fn api_key_status(config_dir: &Path) -> Result<ApiKeyStatus, CoreError> {
    let config = read_config_fallible(config_dir)?;
    Ok(ApiKeyStatus {
        has_key: config.key_configured,
        model: config.model,
    })
}

/// The configured model id, falling back to the default when config is absent or
/// unreadable. Older builds stored this non-secret value in the keychain under
/// `openrouter-model`; that orphaned item is intentionally never read because a
/// read can trigger a macOS Keychain prompt.
pub fn read_model(config_dir: &Path) -> Result<String, CoreError> {
    Ok(read_config_lenient(config_dir).model)
}

/// Store the API key in the keychain and the non-secret model preference in app
/// config. A failure on either write surfaces.
pub fn save_api_key(config_dir: &Path, key: &str, model: &str) -> Result<(), CoreError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::InvalidName("API key cannot be empty".into()));
    }
    entry(KEY_ACCOUNT)?
        .set_password(key)
        .map_err(|e| CoreError::Io(format!("could not store API key in the keychain: {e}")))?;
    set_api_key_cache(Some(key.to_string()));
    write_config(
        config_dir,
        &StoredAiConfig {
            model: model.to_string(),
            key_configured: true,
        },
    )
    .map_err(|e| {
        CoreError::Io(format!(
            "API key was stored in the keychain, but the AI preference file could not be updated: {}",
            error_detail(e)
        ))
    })?;
    Ok(())
}

/// Remove the stored key. Idempotent: deleting an already-absent entry is success,
/// not an error (so a double-clear, or clearing before anything was ever set, is
/// fine). The model id is left as a harmless non-secret preference.
pub fn clear_api_key(config_dir: &Path) -> Result<(), CoreError> {
    clear_api_key_cache();
    match entry(KEY_ACCOUNT)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            return Err(CoreError::Io(format!(
                "could not remove API key from the keychain: {e}"
            )))
        }
    }
    let mut config = read_config_fallible(config_dir).map_err(|e| {
        CoreError::Io(format!(
            "The keychain was cleared, but the AI preference file could not be updated: {}",
            error_detail(e)
        ))
    })?;
    config.key_configured = false;
    write_config(config_dir, &config).map_err(|e| {
        CoreError::Io(format!(
            "The keychain was cleared, but the AI preference file could not be updated: {}",
            error_detail(e)
        ))
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
}

impl TauriChannelSink {
    pub fn new(channel: tauri::ipc::Channel<ChatEvent>) -> Self {
        Self {
            channel,
            closed: false,
        }
    }
}

impl EventSink for TauriChannelSink {
    fn send(&mut self, event: ChatEvent) {
        if self.closed {
            return;
        }
        if let Err(e) = self.channel.send(event) {
            // TODO(chat-cancellation): the core's EventSink is infallible, so we
            // can't abort run_chat from here — a closed channel still lets the
            // current run finish (bounded by the guards) before it stops. A future
            // cancellation token checked in the loop would end token spend sooner.
            log::warn!("chat event channel closed; dropping further events: {e}");
            self.closed = true;
        }
    }
}

/* ─────────────────────────────  LLM client  ────────────────────────────── */

/// OpenRouter-backed [`LlmClient`]. Holds one reusable HTTP client and the API key;
/// the model id travels per-request in [`LlmRequest::model`].
pub struct OpenRouterClient {
    http: reqwest::Client,
    api_key: String,
}

impl OpenRouterClient {
    pub fn new(api_key: String) -> Self {
        // Timeouts so a stalled/half-open endpoint can't hang `chat` forever with no
        // event (the "failures are never silent" contract). `connect_timeout` guards
        // connection setup; `read_timeout` is the per-read idle timeout — it aborts a
        // stream that goes quiet without capping a legitimately long one (a blanket
        // `.timeout()` would kill long streams, so it is deliberately omitted).
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|e| {
                log::warn!("failed to build the HTTP client with timeouts ({e}); using default");
                reqwest::Client::new()
            });
        Self { http, api_key }
    }

    /// POST a request body to OpenRouter with auth + attribution headers. `stream`
    /// selects SSE vs a single JSON response. Returns the raw response for the
    /// caller to parse (buffered JSON or streamed SSE).
    async fn post(&self, body: &WireRequest<'_>) -> Result<reqwest::Response, CoreError> {
        let resp = self
            .http
            .post(OPENROUTER_URL)
            .bearer_auth(&self.api_key)
            // OpenRouter attribution (optional, but polite + helps rate limits).
            .header("X-Title", "NeuralNote")
            .json(body)
            .send()
            .await
            .map_err(|e| CoreError::Llm(format!("request to OpenRouter failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            // Prefer the provider's error body (it explains bad-key / rate-limit /
            // bad-model); fall back to the status line so the error is never blank.
            let body = resp.text().await.unwrap_or_default();
            // Redact the key before it can reach a user-facing error or a log: a
            // provider/proxy error body could echo the Authorization header, and a
            // leaked key is catastrophic. Defence in depth on the secret boundary.
            let detail = redact(body.trim(), &self.api_key);
            let detail = detail.trim();
            return Err(CoreError::Llm(if detail.is_empty() {
                format!("OpenRouter returned {status}")
            } else {
                format!("OpenRouter returned {status}: {detail}")
            }));
        }
        Ok(resp)
    }
}

/// Redact the API key from provider/proxy error text before it reaches the user or
/// a log. OpenRouter shouldn't echo the Authorization header, but a proxy or a
/// verbose gateway error might — and a leaked key is catastrophic.
fn redact(text: &str, key: &str) -> String {
    if key.is_empty() {
        text.to_string()
    } else {
        text.replace(key, "***")
    }
}

/// Process one SSE line into the sink + accumulator. `Ok(Some(answer))` means a
/// terminal `[DONE]` was seen (stop reading); `Ok(None)` means keep reading; `Err`
/// surfaces a mid-stream error frame. Shared by the newline loop and the EOF flush
/// so the returned string stays byte-equal to the streamed deltas.
fn consume_sse_line(
    line_bytes: &[u8],
    sink: &mut dyn EventSink,
    full: &mut String,
) -> Result<Option<String>, CoreError> {
    match parse_sse_line(&String::from_utf8_lossy(line_bytes)) {
        SseEvent::Delta(delta) => {
            sink.send(ChatEvent::Answer {
                delta: delta.clone(),
            });
            full.push_str(&delta);
            Ok(None)
        }
        SseEvent::Done => Ok(Some(full.clone())),
        SseEvent::Error(msg) => Err(CoreError::Llm(msg)),
        SseEvent::Other => Ok(None),
    }
}

/// Final guard on a streamed answer: an empty answer on the (no-tools) answer turn
/// is always a failure — whether the stream ended via `[DONE]` (loop early-return)
/// or plain EOF, a blank result must surface as an error, never be returned as a
/// successful empty answer the UI would mark `Done`. Both return sites route here.
fn finish_answer(full: String) -> Result<String, CoreError> {
    if full.is_empty() {
        Err(CoreError::Llm(
            "the model returned an empty answer (the stream ended without content)".into(),
        ))
    } else {
        Ok(full)
    }
}

#[async_trait]
impl LlmClient for OpenRouterClient {
    async fn complete(&self, req: &LlmRequest) -> Result<Completion, CoreError> {
        let body = WireRequest::from_core(req, false);
        let resp = self.post(&body).await?;
        let parsed: WireResponse = resp
            .json()
            .await
            .map_err(|e| CoreError::Llm(format!("could not parse OpenRouter response: {e}")))?;
        let msg = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message)
            .ok_or_else(|| CoreError::Llm("OpenRouter returned no choices".into()))?;
        Ok(Completion {
            content: msg.content,
            tool_calls: msg
                .tool_calls
                .into_iter()
                .map(|t| ToolCall {
                    id: t.id,
                    name: t.function.name,
                    arguments: t.function.arguments,
                })
                .collect(),
        })
    }

    async fn complete_streaming(
        &self,
        req: &LlmRequest,
        sink: &mut dyn EventSink,
    ) -> Result<String, CoreError> {
        let body = WireRequest::from_core(req, true);
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
                if let Some(answer) = consume_sse_line(&line_bytes, sink, &mut full)? {
                    return finish_answer(answer);
                }
            }
        }
        // Flush a final line the stream left without a trailing newline — otherwise a
        // last delta, or a terminal error frame, in the tail would be silently lost
        // (and a cited id in that tail would go missing, corrupting verification).
        if !buf.is_empty() {
            consume_sse_line(&buf, sink, &mut full)?;
        }
        finish_answer(full)
    }
}

/// One parsed SSE line's meaning.
enum SseEvent {
    /// A content chunk to stream to the UI.
    Delta(String),
    /// The `data: [DONE]` terminator.
    Done,
    /// A mid-stream OpenRouter `error` frame (HTTP was already 200) — fatal, must
    /// surface as a `ChatEvent::Error`, never be swallowed into an empty answer.
    Error(String),
    /// A heartbeat comment, blank line, non-`data:` field, empty delta, or a
    /// malformed chunk — all skipped, none fatal.
    Other,
}

/// Parse one line of the OpenRouter SSE stream. Pure (no I/O) so it is unit-tested
/// directly. A malformed `data:` payload is skipped, not surfaced — mid-stream JSON
/// noise (e.g. keep-alive artifacts) must not sink an otherwise-good answer.
fn parse_sse_line(line: &str) -> SseEvent {
    let line = line.trim_end_matches(['\r', '\n']).trim();
    // `:`-prefixed lines are SSE comments (OpenRouter sends `: OPENROUTER PROCESSING`).
    if line.is_empty() || line.starts_with(':') {
        return SseEvent::Other;
    }
    let Some(data) = line.strip_prefix("data:") else {
        return SseEvent::Other;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseEvent::Done;
    }
    match serde_json::from_str::<StreamChunk>(data) {
        Ok(chunk) => {
            // Check the error frame BEFORE the empty-delta filter: the failure frame
            // carries an empty `delta.content`, so filtering first would drop it.
            if let Some(err) = chunk.error {
                let msg = err.message.unwrap_or_else(|| "unknown error".into());
                return match err.code {
                    Some(code) => {
                        // Render a string code without JSON quotes (`rate_limited`,
                        // not `"rate_limited"`); numbers/other Values use Display.
                        let code = code
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| code.to_string());
                        SseEvent::Error(format!("OpenRouter stream error {code}: {msg}"))
                    }
                    None => SseEvent::Error(format!("OpenRouter stream error: {msg}")),
                };
            }
            chunk
                .choices
                .into_iter()
                .next()
                .and_then(|c| c.delta.content)
                .filter(|s| !s.is_empty())
                .map(SseEvent::Delta)
                .unwrap_or(SseEvent::Other)
        }
        Err(_) => SseEvent::Other,
    }
}

/* ───────────────────────────  Wire (OpenAI) shape  ─────────────────────── */
// The core's LlmMessage serialises camelCase (the IPC/UI contract). The OpenRouter
// wire is snake_case, so we map explicitly here rather than reuse the core's serde.

#[derive(Serialize)]
struct WireRequest<'a> {
    model: &'a str,
    messages: Vec<WireMessage>,
    /// Omitted entirely when empty — that is how the orchestrator's final answer
    /// turn (no tools) tells the model to prose, not tool-call.
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    tools: &'a [serde_json::Value],
    stream: bool,
}

impl<'a> WireRequest<'a> {
    fn from_core(req: &'a LlmRequest, stream: bool) -> Self {
        Self {
            model: &req.model,
            messages: req.messages.iter().map(WireMessage::from_core).collect(),
            tools: &req.tools,
            stream,
        }
    }
}

#[derive(Serialize)]
struct WireMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<WireToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl WireMessage {
    fn from_core(m: &LlmMessage) -> Self {
        Self {
            role: role_str(m.role),
            content: m.content.clone(),
            tool_calls: m
                .tool_calls
                .iter()
                .map(|t| WireToolCall {
                    id: t.id.clone(),
                    kind: "function",
                    function: WireFn {
                        name: t.name.clone(),
                        arguments: t.arguments.clone(),
                    },
                })
                .collect(),
            tool_call_id: m.tool_call_id.clone(),
            name: m.name.clone(),
        }
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

#[derive(Serialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: WireFn,
}

#[derive(Serialize)]
struct WireFn {
    name: String,
    arguments: String,
}

// ── Response (non-streamed) ──
#[derive(Deserialize)]
struct WireResponse {
    choices: Vec<WireChoice>,
}
#[derive(Deserialize)]
struct WireChoice {
    message: WireRespMessage,
}
#[derive(Deserialize)]
struct WireRespMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<WireRespToolCall>,
}
#[derive(Deserialize)]
struct WireRespToolCall {
    id: String,
    function: WireRespFn,
}
#[derive(Deserialize)]
struct WireRespFn {
    name: String,
    arguments: String,
}

// ── Response (streamed delta) ──
#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    /// Present on a mid-stream failure frame. OpenRouter commits HTTP 200 on the
    /// first token, so a later failure (rate-limit, out-of-credits, provider 5xx,
    /// content filter) arrives in-band here — it MUST be surfaced, not ignored.
    #[serde(default)]
    error: Option<StreamError>,
}
#[derive(Deserialize)]
struct StreamError {
    #[serde(default)]
    code: Option<serde_json::Value>,
    #[serde(default)]
    message: Option<String>,
}
#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
}
#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
    use keyring::{Error as KeyringError, Result as KeyringResult};
    use neuralnote_core::ai::DEFAULT_MODEL;
    use std::any::Any;
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex, OnceLock};

    #[test]
    fn sse_content_line_yields_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Delta(d) if d == "Hello"));
    }

    #[test]
    fn sse_done_terminates() {
        assert!(matches!(parse_sse_line("data: [DONE]"), SseEvent::Done));
    }

    #[test]
    fn sse_heartbeat_and_blank_are_ignored() {
        assert!(matches!(
            parse_sse_line(": OPENROUTER PROCESSING"),
            SseEvent::Other
        ));
        assert!(matches!(parse_sse_line(""), SseEvent::Other));
    }

    #[test]
    fn sse_empty_delta_is_ignored() {
        // The final usage chunk carries an empty content delta — not a token.
        let line = r#"data: {"choices":[{"delta":{"content":""}}],"usage":{}}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Other));
    }

    #[test]
    fn sse_toolcall_only_delta_is_ignored_on_answer_stream() {
        // A delta with no `content` field (e.g. a tool_calls fragment) is not text.
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert!(matches!(parse_sse_line(line), SseEvent::Other));
    }

    #[test]
    fn sse_malformed_json_is_skipped_not_fatal() {
        assert!(matches!(parse_sse_line("data: {not json"), SseEvent::Other));
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

    #[test]
    fn wire_request_omits_empty_tools_and_maps_snake_case() {
        let req = LlmRequest {
            model: "anthropic/claude-sonnet-4.5".into(),
            messages: vec![LlmMessage::user("q")],
            tools: Vec::new(),
        };
        let v = serde_json::to_value(WireRequest::from_core(&req, true)).unwrap();
        assert_eq!(v["model"], "anthropic/claude-sonnet-4.5");
        assert_eq!(v["stream"], true);
        assert!(
            v.get("tools").is_none(),
            "empty tools must be omitted (answer turn)"
        );
        assert_eq!(v["messages"][0]["role"], "user");
    }

    #[test]
    fn wire_message_maps_tool_call_to_snake_case_function_shape() {
        let m = LlmMessage::assistant_tool_calls(vec![ToolCall {
            id: "c1".into(),
            name: "search_notes".into(),
            arguments: r#"{"query":"x"}"#.into(),
        }]);
        let v = serde_json::to_value(WireMessage::from_core(&m)).unwrap();
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["tool_calls"][0]["id"], "c1");
        assert_eq!(v["tool_calls"][0]["type"], "function");
        assert_eq!(v["tool_calls"][0]["function"]["name"], "search_notes");
    }

    // A sink that records events, to exercise consume_sse_line without a network.
    #[derive(Default)]
    struct VecSink(Vec<ChatEvent>);
    impl EventSink for VecSink {
        fn send(&mut self, event: ChatEvent) {
            self.0.push(event);
        }
    }

    #[test]
    fn redact_removes_the_key_everywhere_it_appears() {
        let key = "sk-or-secret-123";
        let body = format!("401: bad key 'Bearer {key}' (also {key})");
        let out = redact(&body, key);
        assert!(!out.contains(key), "the key must never survive redaction");
        assert!(out.contains("***"));
    }

    #[test]
    fn redact_is_a_noop_for_an_empty_key() {
        assert_eq!(redact("some error", ""), "some error");
    }

    #[test]
    fn sse_error_frame_surfaces_even_with_empty_delta() {
        // The exact mid-stream shape: HTTP was 200, then a failure frame carrying an
        // error object and an empty content delta. It must NOT be filtered to Other.
        let line = r#"data: {"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}"#;
        match parse_sse_line(line) {
            SseEvent::Error(msg) => {
                assert!(msg.contains("429") && msg.contains("Rate limit exceeded"));
            }
            _ => panic!("expected SseEvent::Error for a mid-stream error frame"),
        }
    }

    #[test]
    fn sse_error_frame_without_code_still_surfaces() {
        match parse_sse_line(r#"data: {"error":{"message":"Provider disconnected"}}"#) {
            SseEvent::Error(msg) => assert!(msg.contains("Provider disconnected")),
            _ => panic!("expected SseEvent::Error"),
        }
    }

    #[test]
    fn consume_sse_line_streams_delta_and_accumulates() {
        let mut sink = VecSink::default();
        let mut full = String::new();
        let stop = consume_sse_line(
            br#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#,
            &mut sink,
            &mut full,
        )
        .unwrap();
        assert!(stop.is_none());
        assert_eq!(full, "Hi");
        assert_eq!(sink.0.len(), 1);
        match &sink.0[0] {
            ChatEvent::Answer { delta } => assert_eq!(delta.as_str(), "Hi"),
            _ => panic!("expected an Answer event"),
        }
    }

    #[test]
    fn consume_sse_line_error_frame_returns_err() {
        let mut sink = VecSink::default();
        let mut full = String::from("partial");
        assert!(
            consume_sse_line(
                br#"data: {"error":{"message":"boom"}}"#,
                &mut sink,
                &mut full
            )
            .is_err(),
            "a mid-stream error frame must surface as Err, not be swallowed"
        );
    }

    #[test]
    fn consume_sse_line_done_returns_the_accumulated_answer() {
        let mut sink = VecSink::default();
        let mut full = String::from("done text");
        let stop = consume_sse_line(b"data: [DONE]", &mut sink, &mut full).unwrap();
        assert_eq!(stop.as_deref(), Some("done text"));
    }

    #[test]
    fn finish_answer_rejects_an_empty_stream_including_the_done_path() {
        // A `[DONE]`-terminated stream that produced zero content is still a failure —
        // the loop's early return routes through the same guard as plain EOF, so the
        // silent-empty-answer class can't leak through `[DONE]`.
        assert!(finish_answer(String::new()).is_err());
        assert_eq!(finish_answer("answer".into()).unwrap(), "answer");
    }

    #[test]
    fn sse_error_frame_string_code_renders_without_quotes() {
        let line = r#"data: {"error":{"code":"rate_limited","message":"slow down"}}"#;
        match parse_sse_line(line) {
            SseEvent::Error(msg) => {
                assert!(msg.contains("rate_limited") && !msg.contains("\"rate_limited\""));
            }
            _ => panic!("expected SseEvent::Error"),
        }
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

        fn contains(&self, service: &str, user: &str) -> bool {
            self.secrets
                .lock()
                .unwrap()
                .contains_key(&(service.to_string(), user.to_string()))
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
            Ok(())
        }

        fn get_secret(&self) -> KeyringResult<Vec<u8>> {
            self.store.reads.fetch_add(1, Ordering::SeqCst);
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
    fn api_key_status_returns_no_key_when_config_is_absent_without_touching_keychain() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-absent-config");

        let status = api_key_status(&config_dir).unwrap();

        assert!(!status.has_key);
        assert_eq!(status.model, DEFAULT_MODEL);
        assert!(!config_file(&config_dir).exists());
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "status must not perform a keychain read on first run"
        );
    }

    #[test]
    fn api_key_status_reads_config_without_touching_keychain() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("status-no-keychain");
        write_config(
            &config_dir,
            &StoredAiConfig {
                model: "openai/gpt-4.1".into(),
                key_configured: true,
            },
        )
        .unwrap();

        let status = api_key_status(&config_dir).unwrap();

        assert!(status.has_key);
        assert_eq!(status.model, "openai/gpt-4.1");
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "status must not perform a keychain read"
        );
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

        save_api_key(&config_dir, key, "anthropic/claude-opus-4.1").unwrap();

        assert_eq!(
            keychain.get(KEYCHAIN_SERVICE, KEY_ACCOUNT).as_deref(),
            Some(key)
        );
        let raw = read_config_text(&config_dir);
        assert!(raw.contains(r#""model""#));
        assert!(raw.contains(r#""keyConfigured": true"#));
        assert!(raw.contains("anthropic/claude-opus-4.1"));
        assert!(!raw.contains(key), "the API key must never be serialized");
    }

    #[test]
    fn save_api_key_rejects_empty_and_whitespace_keys_without_writing() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("reject-empty-key");
        save_api_key(&config_dir, "sk-or-original", "openai/gpt-4.1").unwrap();
        let original_config = read_config_text(&config_dir);
        let original_writes = keychain.writes.load(Ordering::SeqCst);
        let original_reads = keychain.reads.load(Ordering::SeqCst);

        for blank in ["", "   "] {
            let err = save_api_key(&config_dir, blank, "anthropic/claude-opus-4.1").unwrap_err();

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
    fn save_api_key_caches_written_key_when_config_write_fails() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let parent = temp_config_dir("save-config-write-fails");
        let blocked_config_dir = parent.join("not-a-dir");
        fs::write(&blocked_config_dir, "blocks create_dir_all").unwrap();

        let err = save_api_key(&blocked_config_dir, "sk-or-session", "openai/gpt-4.1")
            .expect_err("config write should fail after the keychain write succeeds");

        match err {
            CoreError::Io(msg) => {
                assert!(msg.starts_with(
                    "API key was stored in the keychain, but the AI preference file could not be updated: "
                ));
                assert!(msg.contains("could not create AI config dir"));
            }
            other => {
                panic!("expected config write failure to surface as CoreError::Io, got {other:?}")
            }
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

    #[cfg(unix)]
    #[test]
    fn write_config_replaces_config_file_instead_of_writing_through_symlink() {
        let config_dir = temp_config_dir("atomic-config-replace");
        let external = config_dir.join("external-target.json");
        fs::write(&external, "do-not-change").unwrap();
        std::os::unix::fs::symlink(&external, config_file(&config_dir)).unwrap();

        write_config(
            &config_dir,
            &StoredAiConfig {
                model: "openai/gpt-4.1".into(),
                key_configured: true,
            },
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&external).unwrap(),
            "do-not-change",
            "atomic replacement must not write through the old target path"
        );
        assert!(
            !fs::symlink_metadata(config_file(&config_dir))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the config path should be replaced by the new file"
        );
        let raw = read_config_text(&config_dir);
        assert!(raw.contains("openai/gpt-4.1"));
        assert!(raw.contains(r#""keyConfigured": true"#));
    }

    #[test]
    fn clear_api_key_deletes_key_sets_flag_false_and_empties_cache() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("clear-cache");
        save_api_key(&config_dir, "sk-or-clear-me", "openai/gpt-4.1").unwrap();

        clear_api_key(&config_dir).unwrap();

        assert!(!keychain.contains(KEYCHAIN_SERVICE, KEY_ACCOUNT));
        let status = api_key_status(&config_dir).unwrap();
        assert!(!status.has_key);
        assert_eq!(status.model, "openai/gpt-4.1");
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
        let config_dir = temp_config_dir("clear-corrupt-config");
        save_api_key(&config_dir, "sk-or-clear-corrupt", "openai/gpt-4.1").unwrap();
        let corrupt_config = "{not json";
        fs::write(config_file(&config_dir), corrupt_config).unwrap();

        let err = clear_api_key(&config_dir)
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
        write_config(
            &config_dir,
            &StoredAiConfig {
                model: "openai/gpt-4.1".into(),
                key_configured: true,
            },
        )
        .unwrap();
        keychain.set(KEYCHAIN_SERVICE, KEY_ACCOUNT, "sk-or-old");
        let clear_config_dir = config_dir.clone();
        keychain.after_next_read(move || {
            clear_api_key(&clear_config_dir).unwrap();
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
    fn read_model_falls_back_to_default_when_config_is_absent() {
        let config_dir = temp_config_dir("default-model");

        assert_eq!(read_model(&config_dir).unwrap(), DEFAULT_MODEL);
    }

    #[test]
    fn read_model_falls_back_to_default_when_config_is_corrupt() {
        let _guard = KEYCHAIN_TEST_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap();
        let keychain = TestKeychain::install();
        let config_dir = temp_config_dir("default-model-corrupt");
        fs::write(config_file(&config_dir), "{not json").unwrap();

        assert_eq!(read_model(&config_dir).unwrap(), DEFAULT_MODEL);
        assert_eq!(
            keychain.reads.load(Ordering::SeqCst),
            0,
            "read_model must not touch the keychain while falling back"
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
