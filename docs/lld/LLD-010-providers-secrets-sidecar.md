# LLD-010 — AI Providers, Secrets & the Local Model Sidecar

**Status:** as-built · **Sources of truth:** `crates/neuralnote-core/src/ai/provider_config.rs`,
`crates/neuralnote-core/src/ai/local/{mod,pull,tags,hf}.rs`, `app/desktop/src-tauri/src/ai.rs`,
`app/desktop/src-tauri/src/local.rs`, `app/desktop/src-tauri/src/commands/ai.rs`,
`scripts/fetch-ollama-sidecar.sh`, `app/desktop/src-tauri/tauri.conf.json`,
`app/desktop/src-tauri/capabilities/default.json`
**Every claim carries a `file:line` anchor. Claims marked "inferred:" are reasoning, not citation.**

This subsystem is security-adjacent three times over: it holds the one secret in the product (the
OpenRouter API key), it spawns a subprocess (the bundled Ollama sidecar), and it owns every byte of
network egress the app performs. The security sections here are the primary content, not an
appendix.

> **Spec drift, recorded up front:** `specs/ai-providers-slice.md:108-110` still lists
> `TODO(startup-orphan)` — an app quit during the ≤30 s sidecar health poll orphaning `ollama
> serve` — as a live deferral. The code has since implemented the fix (the `starting` slot,
> `local.rs:59-79`, drained by `shutdown_ollama`, `local.rs:301-322`) and no such TODO marker
> exists anywhere in the Rust source (verified by grep). The code is **ahead of** the spec on this
> point. The residual orphan cases (SIGKILL, panic-abort, power loss) are covered in §17
> (GAP-010-1).

---

## 1. Purpose & scope

This LLD documents, as built:

- **Provider configuration** — the persisted, non-secret choice between OpenRouter (BYO key) and
  a bundled local Ollama model, including the migration bridge for pre-provider installs
  (`provider_config.rs`).
- **Secrets** — the OpenRouter API key's storage in the OS keychain, its process-wide cache, and
  the redaction discipline that keeps it out of the webview (`app/desktop/src-tauri/src/ai.rs`).
- **The sidecar** — build-time acquisition (`scripts/fetch-ollama-sidecar.sh`), runtime lifecycle
  (spawn / health-poll / crash-recovery / shutdown) and its isolation properties (`local.rs`).
- **Model pull, hardware detection, and the curated allowlist** — the local-model install flow
  and the recommendation algorithm (`crates/neuralnote-core/src/ai/local/`).
- **The security boundary** — the CSP, the Tauri capability set, and the complete network
  surface (`tauri.conf.json`, `capabilities/default.json`).

**Explicitly not owned here:** the chat orchestration loop, retrieval, citation verification, and
the SSE wire protocol itself — those are LLD-009's subject (`crates/neuralnote-core/src/ai/{orchestrator,retrieval,verify,openai}.rs`). `openai.rs` appears here only where its `redact`
function participates in the secret boundary (§6).

## 2. Position in the architecture

See [`../architecture/system-overview.md`](../architecture/system-overview.md) for the layered
picture. This subsystem sits entirely in the two lower layers:

- **Core (`neuralnote-core::ai`)** — pure, unit-tested logic: config serialisation and migration
  (`provider_config.rs`), the curated allowlist and recommender (`local/mod.rs`), and the parsers
  for the three untrusted response shapes: Ollama pull NDJSON (`local/pull.rs`), Ollama `/api/tags`
  (`local/tags.rs`), and HuggingFace metadata (`local/hf.rs`). No Tauri dependency, no I/O.
- **Shell (`app/desktop/src-tauri`)** — the "thin I/O husk" (`local.rs:1-7`): keychain access and
  the OpenRouter HTTP client (`ai.rs:1-9`), sidecar process lifecycle and loopback HTTP
  (`local.rs`), and the 15-command Tauri surface over both (`commands/ai.rs:1-7`), each command
  delegating rather than re-implementing.

The webview never touches any of this directly: it has no outbound HTTP (§12) and no spawn
primitive (§12); everything crosses the IPC boundary as a typed command or channel event.

## 3. Provider model

### 3.1 The types

```rust
pub enum ProviderKind { OpenRouter, Local }          // provider_config.rs:20-23

pub struct ProviderConfig {                          // provider_config.rs:27-41
    pub active_provider: Option<ProviderKind>,       //   #[serde(default)]
    pub model: String,                               //   OpenRouter model id
    pub key_configured: bool,                        //   flag only — never the key (§5, §7)
    pub local_model_tag: Option<String>,             //   #[serde(default)]
    pub reasoning: bool,                             //   #[serde(default)] — §4
}
```

Persisted as pretty-printed JSON in `ai-config.json` inside the OS app config dir
(`provider_config.rs:14`, `provider_config.rs:68-70`); the shell resolves that dir via Tauri's
`app_config_dir()` (`lib.rs:94-98`). The module doc states the ownership split plainly: *"The key
itself remains shell-owned in the OS keychain; this core file stores only non-secret
routing/model preferences"* (`provider_config.rs:1-5`).

### 3.2 The migration bridge

`effective_provider()` (`provider_config.rs:57-65`) resolves the active provider without ever
rewriting the file on read:

1. An explicit `active_provider` wins.
2. Otherwise `key_configured == true` implies `OpenRouter` — the bridge for installs written by
   the OpenRouter-only slice, whose config had only `{model, keyConfigured}`
   (test: `provider_config.rs:265-280`).
3. Otherwise `None` — nothing configured yet; `chat` surfaces "No AI provider is set up yet"
   (`commands/ai.rs:329-332`).

An explicit `Local` choice beats a configured key (test: `provider_config.rs:332-341`), so adding
a key never silently reroutes a Local user.

### 3.3 Atomic write, symlink-replacing

`write_provider_config` writes to a temp file in the same directory — named with the PID plus a
process-wide atomic sequence counter (`provider_config.rs:15`, `provider_config.rs:124-125`) —
then `rename`s it over the target (`provider_config.rs:127-134`). Two properties follow:

- **No torn config**: a crash mid-write leaves the old file intact (inferred: standard
  same-directory rename semantics).
- **A symlink at `ai-config.json` is replaced, not written through.** Because the content lands in
  a fresh temp file and rename swaps the directory entry, a symlink planted at the config path
  cannot redirect the write to an arbitrary target. This is pinned by a dedicated test:
  `write_provider_config_replaces_config_file_instead_of_writing_through_symlink`
  (`provider_config.rs:192-217`) asserts the symlink's external target is untouched and the
  resulting path is no longer a symlink.

Reads are tolerant of absence (missing file ⇒ `Ok(default)`, no file created,
`provider_config.rs:88-92`, test `provider_config.rs:219-225`) but strict on corruption: a parse
failure surfaces as `CoreError::Io` naming the path (`provider_config.rs:101-108`) — it is never
silently replaced with defaults (see §15 for why that matters).

## 4. The `reasoning` opt-in — a deliberate, hard-won pattern

`reasoning` opts the user into OpenRouter's **billed** reasoning tokens on the answer turn. Two
design decisions here are load-bearing and each closes a real bug class:

**(a) `#[serde(default)]` as the migration guarantee.** The field's own doc comment says it:
*"`#[serde(default)]` is load-bearing: an existing `ai-config.json` written before this field
existed reads back as `bool::default()` = `false`, so old installs migrate to 'off' for free"*
(`provider_config.rs:34-40`). Nobody is silently opted into billed tokens by upgrading. Pinned by
`reasoning_defaults_to_false_when_absent_from_file` (`provider_config.rs:365-378`).

**(b) `set_reasoning` returns the freshly persisted `AiStatus`** (`commands/ai.rs:133-139`),
built from the exact `cfg` value that was just written — not from a follow-up read. The command
doc explains the class of bug this closes (`commands/ai.rs:127-131`): the common UI idiom
`await write(); await refresh();` has a failure mode where the write lands but the refresh —
which often never rejects — renders the **old** value with no error. For an ordinary setting
that's a cosmetic staleness bug; for a **billed** setting it silently opts the user into spend
they can't see: the toggle shows "off" while the config says "on". Returning the persisted state
from the write *removes the window rather than detecting it*. (This mirrors `write_note` returning
the saved `NoteDoc`, `commands/ai.rs:127-128`.) Persistence round-trip pinned by
`reasoning_flag_round_trips_true_then_false` (`provider_config.rs:380-394`); the flag's surfacing
on the OpenRouter arm of `AiStatus` pinned by `commands/ai.rs:479-497`.

Downstream, the flag threads to the wire only on the OpenRouter answer turn: `chat` passes
`cfg.reasoning` into `chat_via_openrouter` (`commands/ai.rs:334-336`), which builds
`OpenAiChatClient::new(key, reasoning)` (`commands/ai.rs:383`); the Local client hardcodes
`false` because Ollama's OpenAI-compatible endpoint has no reasoning concept
(`local.rs:359-361`); tool-deciding turns always send `reasoning: false` because their tokens
would be invisible cost (`ai.rs:414-422`). Wire behaviour pinned by
`openai_client_requests_reasoning_only_when_enabled` (`ai.rs:666-685`).

## 5. Secrets — the keychain and its cache

### 5.1 Storage

The OpenRouter API key lives in the OS keychain via the `keyring` crate, under service
`com.neuralnote.desktop`, account `openrouter-api-key` (`ai.rs:29-31`). It is written by
`save_api_key` (`ai.rs:150-182`), read Rust-side at chat time by `read_api_key`
(`ai.rs:103-120`), and deleted idempotently by `clear_api_key` (`ai.rs:187-210` — `NoEntry` on
delete is success, so double-clear is fine).

The key is **never** written to `ai-config.json`: the config carries only the boolean
`key_configured` (`provider_config.rs:31`). This is pinned by a test that saves a key and then
asserts the raw serialised config text does not contain it:
`save_api_key_writes_secret_to_keychain_and_only_model_flag_to_config`, ending in
`assert!(!raw.contains(key), "the API key must never be serialized")` (`ai.rs:756-776`).

Empty/whitespace keys are rejected before any write (`ai.rs:151-154`), and a stored blank value is
normalised to "unset" on read — defence in depth so a blank key can never read as present
(`ai.rs:65-67`, `ai.rs:100-103`).

### 5.2 The process-wide cache and the generation counter

Keychain reads can prompt the user on macOS, so the key is cached process-wide after the first
read (`ai.rs:41-46`). The cache is a `Mutex<CacheState { generation: u64, value: Option<Option<String>> }>`.
Every mutation — set on save (`ai.rs:73-77`), clear on delete (`ai.rs:79-83`) — bumps the
generation.

The generation exists to close a specific race: **a `clear_api_key` landing during a cache-miss
window must not let the stale read repopulate the cache.** `read_api_key` snapshots the
generation, drops the lock, performs the (slow, possibly prompting) keychain read, then
re-acquires the lock and stores the result **only if the generation is unchanged and the slot is
still empty** (`ai.rs:104-119`). If a clear interleaved, the generation differs and the stale key
is discarded. Pinned by
`read_api_key_does_not_cache_stale_key_when_clear_happens_during_cache_miss` (`ai.rs:921-944`),
which uses an after-read hook to fire `clear_api_key` exactly inside the window and asserts the
next read re-checks the keychain rather than returning the stale value.

A subtle companion behaviour: if `save_api_key` stores the key in the keychain but the config
write then fails, the cache retains the successfully-written key so chat still works this session,
while the error surfaces (`ai.rs:158`, test `ai.rs:813-859`). See §7 for the flag desync this
implies.

## 6. Tracing the key — every place it could leak, and the defence

The invariant claimed in the code: *"the key is read in Rust at call time and NEVER returned to
the webview"* (`ai.rs:4-6`). Traced exhaustively:

| Surface | Can the key reach it? | Defence (anchor) |
|---|---|---|
| **The webview (command return values)** | No | No command returns the key. `api_key_status` returns `{has_key, model}` only (`ai.rs:36-39`, `ai.rs:140-146`); `save_api_key`/`clear_api_key` return `()` (`commands/ai.rs:23-36`); `ai_status` is a pure config read (`commands/ai.rs:71-94`). `read_api_key` is `pub` Rust, not a command (`ai.rs:103`). |
| **A Tauri event payload** | No | The only named Rust→webview events in the entire shell are `vault://tree-changed` and `menu://action` (`event_names.rs:14,17`); neither carries AI data. Chat/pull traffic travels over `ipc::Channel` payloads typed `ChatEvent`/`PullEvent`, whose variants carry deltas, citations, progress, and error strings — never a key field (`crates/neuralnote-core/src/ai/local/pull.rs:16-28`; inferred for `ChatEvent` from its use at `ai.rs:266-280`). Error strings are the residual risk — see the last two rows. |
| **`AiStatus` / `ApiKeyStatus` DTOs** | No | Both are booleans-plus-preferences by construction: `ApiKeyStatus { has_key, model }` (`ai.rs:36-39`), `AiStatus { active_provider, openrouter: {has_key, model, reasoning}, local: {active_model_tag} }` (`commands/ai.rs:46-69`). |
| **`ai-config.json`** | No | Only `key_configured: bool` is persisted (`provider_config.rs:31`); test asserts the serialised text never contains the key (`ai.rs:775`). |
| **A log line** | No proven path | The shell never logs the key value. Logged strings in this subsystem are channel-close errors (`ai.rs:277`, `local.rs:152`), sidecar stderr/stdout (`local.rs:239-249` — a loopback Ollama process that never sees the key; inferred), and HTTP error details that pass through `redact` first (next row). |
| **An HTTP error body (non-2xx response)** | No | `OpenAiChatClient::post` explicitly redacts the bearer from the provider's error body before building the error string: *"a provider/proxy error body could echo the Authorization header, and a leaked key is catastrophic"* (`ai.rs:394-405`); `redact` replaces every occurrence with `***` (`openai.rs:17-23`, test `openai.rs:575-580`). |
| **A mid-stream SSE error frame (HTTP 200 already committed)** | **Gap — un-redacted** | An in-band `error` frame inside the SSE stream becomes `SseEvent::Error(msg)` → `Err(CoreError::Llm(msg))` (`openai.rs:63`, construction `openai.rs:172-187`) **without passing through `redact`**; the error then reaches the webview as `ChatEvent::Error { message: "Chat failed: {e}" }` (`commands/ai.rs:384-399`). If a proxy or gateway echoed the Authorization header inside a mid-stream error frame, it would surface verbatim. See LLD-009 for the SSE parsing itself; recorded here as GAP-010-6. |

**Verdict: no proven leak to the webview.** Every command return, DTO, config file, and buffered
HTTP error path is defended by construction or by redaction, with tests pinning the config and
redaction paths. The one gap is the mid-stream SSE error frame, which bypasses `redact`; exploiting
it requires a provider/proxy that echoes the bearer into an in-band stream error, which OpenRouter
is not known to do (inferred) — but the buffered-path comment (`ai.rs:395-397`) concedes exactly
this threat model, and the streaming path doesn't apply the same defence.

## 7. `key_configured` is a persisted flag, not derived state

The flag is written in a separate step *after* the keychain write (`ai.rs:155-180`). A crash
between the two leaves them disagreeing: keychain has a key, config says `key_configured: false`
(or, on the clear path, the inverse — keychain empty, flag still true if the config write fails
after the delete, `ai.rs:187-210`). The consequence is a status UI that misreports until the user
saves or clears again; chat itself reads the keychain directly, so it keeps working (inferred from
`chat_via_openrouter` calling `read_api_key`, `commands/ai.rs:368`).

The code owns this as a known deferral, quoted verbatim (`ai.rs:172-174`):

```
// TODO(key-configured-derive): derive key_configured from keychain presence on
// read (single source of truth), not a persisted flag; closes the crash window
// between keychain write and config write (PA-023).
```

Why it's persisted at all: `api_key_status`/`ai_status` are deliberately pure config reads that
never touch the keychain (`commands/ai.rs:40-42`), so the UI can poll them cheaply and without
triggering a macOS keychain prompt — pinned by three tests asserting zero keychain reads
(`ai.rs:688-753`). Deriving the flag on read would trade that property for consistency; the TODO
records the intended resolution. Recorded as GAP-010-5.

## 8. The sidecar — acquisition, lifecycle, isolation

### 8.1 Build-time acquisition (`scripts/fetch-ollama-sidecar.sh`)

The Ollama runtime is fetched **at build time**, never at app runtime — nothing is downloaded on
a user's machine. The script:

- Pins `OLLAMA_VERSION="v0.31.1"` and a hardcoded archive checksum
  `OLLAMA_DARWIN_TGZ_SHA256="0c4f92389fcc..."` (`fetch-ollama-sidecar.sh:29-30`), downloaded from
  the GitHub release URL (overridable via `OLLAMA_DARWIN_TGZ_URL`, but *"the checksum is verified
  regardless — an override that doesn't match the pinned archive fails closed"*,
  `fetch-ollama-sidecar.sh:31-33`).
- Verifies the SHA-256 **before extracting**, and fails closed if the hashes mismatch **or if
  either side is empty** — the empty check exists so a future empty pin can't compare equal to an
  empty tool result and install an unverified archive (`fetch-ollama-sidecar.sh:76-103`). The
  script cites OWASP A08 supply-chain risk as the rationale (`fetch-ollama-sidecar.sh:23-28`).
- Ships **three** artefacts, because Ollama's macOS runtime is split
  (`fetch-ollama-sidecar.sh:6-17`): `ollama` and `llama-server` as Tauri `externalBin`
  (co-located by requirement — ollama finds the runner beside its own binary), and ~35
  ggml/Metal libraries as `bundle.resources` under `ollama-libs/`, located at runtime via
  `OLLAMA_LIBRARY_PATH` (`tauri.conf.json:33-34`, `local.rs:27-35`).
- Installs binaries atomically (temp + rename, `fetch-ollama-sidecar.sh:119-127`) and rebuilds the
  libs dir from scratch so a version bump can't leave a stale lib (`fetch-ollama-sidecar.sh:130-136`).

**Noted limitation:** verification is a checksum only — there is **no code-signature
verification** of the archive or the binaries within it. The pinned hash proves "the bytes the
pinner saw", not "bytes Ollama signed"; a compromised release asset that existed *before* pinning
would pass. Recorded as GAP-010-8.

### 8.2 Runtime lifecycle

The sidecar is spawned from **Rust only**, via `app.shell().sidecar("ollama")` with the static
argument list `["serve"]` (`local.rs:223-232`) — the webview has no spawn primitive at all (§12).
Model names travel in HTTP bodies, never as CLI args (`local.rs:380-385`).

```mermaid
sequenceDiagram
    participant W as Webview
    participant C as commands/ai.rs
    participant L as local.rs
    participant O as ollama serve (child)

    W->>C: pull_local_model(tag, Channel<PullEvent>)
    C->>C: is_curated_model(tag)? — reject non-curated before spawning anything
    C->>L: install_pull_cancel() — fresh Arc<AtomicBool> on app state
    C->>L: ensure_ollama_started()
    L->>L: bind 127.0.0.1:0 → read port → drop listener
    L->>O: spawn sidecar ["serve"], OLLAMA_HOST=127.0.0.1:port,<br/>private OLLAMA_MODELS, OLLAMA_LIBRARY_PATH
    L->>L: register_starting(child) — parked where shutdown can reap it
    loop every 300 ms, ≤30 s
        L->>O: GET /api/tags (health)
        Note over L: if `terminated` flag set → fail fast<br/>(our child died; whoever answers now is an impostor)
    end
    L->>L: take_starting(id) → promote to state.sidecar
    C->>O: POST /api/pull {model, stream:true}
    loop NDJSON frames
        O-->>C: {"status", "completed", "total", ...}
        C->>C: cancel.load()? checked at each line boundary
        C-->>W: Channel.send(PullEvent::Progress)
    end
    W->>C: cancel_pull()
    C->>C: cancel token → true
    C->>C: next line boundary → Err("Download cancelled.")<br/>stream dropped → TCP closed → Ollama aborts server-side
    C-->>W: Channel.send(PullEvent::Error) — exactly one terminal event
```

**Port selection and its TOCTOU.** `pick_loopback_port` binds `127.0.0.1:0`, reads the
OS-assigned port, and drops the listener (`local.rs:434-443`); the sidecar is then told to bind
that port via `OLLAMA_HOST` (`local.rs:228`). Because the app's own Ollama runs on an ephemeral
port with a **private `OLLAMA_MODELS` directory** under the app data dir (`local.rs:229`,
`local.rs:445-450`), a user's own Ollama on `:11434` is untouched and unused. There is a small
TOCTOU window between dropping the listener and the sidecar binding; if another process grabs the
port, the child exits and startup fails — there is **no automatic retry on a new port**
(GAP-010-2). The failure is at least honest and fast, thanks to:

**The impostor defence.** A `terminated: Arc<AtomicBool>` is set when our child's
`CommandEvent::Terminated` arrives (`local.rs:220-222`, `local.rs:248-252`). The health poll
checks it before every probe (`local.rs:472-480`): *"If OUR child already exited … stop polling: a
success now would be an impostor on that port, not our sidecar."* Without this, a lost port race
could health-check *someone else's* process into the `sidecar` slot and route chat traffic to it.
This is a genuinely well-considered piece of design — it converts a rare race into a fast,
truthful error instead of a silent misconnection, and it doubles as fail-fast on crash-at-start.

**Crash recovery mid-session.** A cached port is trusted only after a live probe; a dead sidecar
is dropped and respawned cleanly (`local.rs:191-205`).

**Concurrent starters.** Each spawned-but-unpromoted child is parked in `starting` with a
monotonic id so two concurrent starters never reclaim each other's child (`local.rs:57-99`); if a
concurrent starter won the promotion race, the duplicate is killed and the winner's port reused
(`local.rs:287-295`).

**Shutdown.** On `RunEvent::ExitRequested | Exit` (`lib.rs:181-187`), `shutdown_ollama` sets the
pull-cancel flag, takes the running sidecar **and drains every still-starting child** under one
short lock, then kills them all outside it (`local.rs:301-322`) — closing the quit-during-health-
poll orphan window the spec still lists as open (§ preamble). What remains: **a SIGKILL,
panic-abort, or power loss never runs this handler, so `ollama serve` is orphaned**
(inferred: no supervision mechanism exists outside the Tauri run loop). The next launch picks a
fresh ephemeral port, so nothing conflicts — but the orphan lingers until manually killed
(GAP-010-1).

**Output capture.** stderr is appended into a bounded tail buffer capped at ~16 KiB
(`MAX_STDERR_BYTES`, `local.rs:45-49`, eviction logic `local.rs:599-616`, test
`local.rs:630-647`), surfaced **only** in startup-failure diagnostics (`local.rs:463-470`);
stdout goes to `log::debug` (`local.rs:240-243`).

## 9. Model pull

The pull is a stream of NDJSON frames from `POST /api/pull` on the loopback sidecar
(`local.rs:370-411`), parsed by the **pure** `parse_pull_line` in core (`pull.rs:53-80`): in-band
`error` fields surface as `PullEvent::Error` even though HTTP already committed 200
(`pull.rs:1-4`, `pull.rs:60-62`), `"success"` is terminal, byte counts become a clamped percent,
and malformed/noise lines are skipped (`pull.rs:59`, tests `pull.rs:189-193`).

**Transport, not events.** Progress reaches the UI over a **Tauri `ipc::Channel<PullEvent>`**
passed as the `on_event` command argument (`commands/ai.rs:191-196`), forwarded by
`TauriPullSink` (`local.rs:129-156`). This is a common misreading worth pinning: pull progress is
**not** a named Tauri event — the only named Rust→webview events in the shell are
`vault://tree-changed` and `menu://action` (`event_names.rs:14,17`).

**Exactly one terminal event.** The command owns emitting Success xor Error
(`commands/ai.rs:237-243`); the line handler surfaces terminal states through the `Result` and
never through the sink (`local.rs:581-590`, tests `local.rs:703-713`), so the UI always resolves
and a transport failure is never silent (`commands/ai.rs:187-189`).

**Cancellation** is a cooperative `Arc<AtomicBool>` living on **app state, deliberately not on
the sidecar** (`local.rs:73-79`): a fresh token is installed *before* sidecar startup
(`commands/ai.rs:212-216`), so a Cancel arriving while the sidecar is still starting still
targets this pull — the old sidecar-scoped flag lost exactly that cancel
(`commands/ai.rs:212-215`). Each new pull installs a fresh token so a stale cancel can't abort a
later download (`local.rs:117-121`). The flag is checked at each NDJSON line boundary
(`local.rs:573-576`); on trip, the function returns `Err("Download cancelled.")`, the response
stream is dropped, and dropping it closes the TCP connection so Ollama aborts the transfer
server-side (inferred: reqwest drops the connection with the stream; the code comment at
`local.rs:508-517` confirms cancel is *"observed at the next read boundary"*). An **idle** socket
(no frames arriving) only notices a cancel at the 60 s per-read timeout (`local.rs:511-517`).

**Not cleaned up:** partial downloads. A cancelled or failed pull leaves whatever blobs Ollama
staged in the private models dir; the app does no app-side cleanup (verified: no removal code
exists in `local.rs`/`commands/ai.rs`; Ollama may resume or GC its own blobs — inferred, not
verified). With no free-disk precheck either (`local.rs:376-378`, §17), a doomed multi-GB pull can
both fail late and leave debris. GAP-010-3/GAP-010-4.

## 10. Hardware detection & model recommendation

`detect_hardware` (`local.rs:158-185`) uses `sysinfo` with memory+CPU refresh only: it reports
`total_memory`, `physical_core_count`, the first CPU's brand string, `std::env::consts::ARCH`,
and `::OS`. **`gpu_label` is always `None`** — GPU/VRAM is never detected. Quoted verbatim
(`local.rs:179-180`):

```
// TODO(local-gpu-detection): wire macOS GPU/unified-memory detail once
// the recommendation UI needs it; RAM/OS/arch gates are enough for v1.
```

On Apple Silicon unified memory there is no separate VRAM figure to read anyway; the single
approximation of the GPU-addressable share is `USABLE_MEM_FRACTION = 0.70`
(`local/mod.rs:15-20`): conservative for Apple-Silicon unified memory and safe headroom on
Intel/CPU Macs.

**The algorithm** (`recommend_model`, `local/mod.rs:198-235`), in order:

1. **macOS only** — any other OS returns `"Local AI isn't supported on this platform yet."`
   (`local/mod.rs:199-203`).
2. **`total_ram_bytes == 0` is a detection failure, not weak specs** — it returns *"Couldn't read
   your computer's memory to size a local model. Please try again."* (`local/mod.rs:206-210`).
   This distinction deserves credit: sysinfo reports zero on unusual hosts, and telling that user
   "your computer is too weak" would be a confident lie. The honest split is pinned by
   `zero_ram_is_a_detection_failure_not_weak_specs` (`local/mod.rs:359-369`).
3. `usable = total_ram × 0.70`; filter candidates by `min_ram_bytes <= usable`; select
   `max_by((generation, params_b))` — newest family first, then largest fitting size
   (`local/mod.rs:212-222`).
4. Nothing fits ⇒ `"Local AI is unsupported due to your computer specs."` (`local/mod.rs:22`,
   `local/mod.rs:232-234`).

The three unsupported-reason strings, verbatim (`local/mod.rs:22-25`):

- `"Local AI is unsupported due to your computer specs."`
- `"Local AI isn't supported on this platform yet."`
- `"Couldn't read your computer's memory to size a local model. Please try again."`

**The curated allowlist**, verbatim from `curated_candidates()` (`local/mod.rs:97-162`):

| tag | params | params_b | generation | download_bytes | min_ram_bytes | license | hf_repo |
|---|---|---|---|---|---|---|---|
| `qwen3.5:4b` | 4B | 4.0 | 40 | 3_400_000_000 | 7_000_000_000 | Apache-2.0 | `Qwen/Qwen3.5-4B` |
| `qwen3.5:9b` | 9B | 9.0 | 40 | 6_600_000_000 | 11_000_000_000 | Apache-2.0 | `Qwen/Qwen3.5-9B` |
| `qwen3.5:27b` | 27B | 27.0 | 40 | 17_000_000_000 | 26_000_000_000 | Apache-2.0 | `Qwen/Qwen3.5-27B` |
| `granite4.1:3b` | 3B | 3.0 | 30 | 2_100_000_000 | 5_000_000_000 | Apache-2.0 | `ibm-granite/granite-4.1-3b` |
| `granite4.1:8b` | 8B | 8.0 | 30 | 5_300_000_000 | 10_000_000_000 | Apache-2.0 | `ibm-granite/granite-4.1-8b` |
| `granite4.1:30b` | 30B | 30.0 | 30 | 17_000_000_000 | 28_000_000_000 | Apache-2.0 | `ibm-granite/granite-4.1-30b` |

(`params_b`/`generation` are `#[serde(skip)]` — recommender-internal, not part of the JS
contract, `local/mod.rs:50-60`, test `local/mod.rs:489-491`.) `DEFAULT_LOCAL_MODEL` is
`qwen3.5:9b` (`local/mod.rs:13`). Property tests pin the ladder: more RAM never yields a smaller
model, every pick fits usable memory (`local/mod.rs:328-357`), and a newer smaller model beats an
older bigger one (`local/mod.rs:289-325`).

## 11. The curated allowlist as a moat guardrail

Cited chat — the product's moat — depends on the model driving an agentic retrieval loop through
tool calls. An arbitrary Ollama tag can resolve to a model with no tool-calling template, which
*silently* breaks citations: the model just answers from nothing, un-grounded
(`local/mod.rs:164-171`, `specs/ai-providers-slice.md:28-32`). Hence `is_curated_model` is
enforced **in Rust, at three sites**, so no non-UI caller and no hand-edited config can bypass it:

1. **`set_active_provider`** — a Local selection naming a non-curated tag is rejected before the
   config write (`commands/ai.rs:104-113`).
2. **`pull_local_model`** — rejected before anything is spawned (`commands/ai.rs:202-210`).
3. **`chat_via_local`** — re-checked against the *persisted* tag at chat time, so a config file
   hand-edited after selection still can't make a non-tool-calling model the cited-chat model
   (`commands/ai.rs:413-419`).

**Why an allowlist rather than a capability probe:** a probe ("does this model emit a well-formed
tool call right now?") tests one sample of stochastic behaviour, after a multi-GB download, against
a template that varies per tag/quant. The allowlist front-loads that judgement — each family is
admitted only after a tool-calling smoke test against `search_notes`, with a policy that newer
generations get a higher rank and entry requires re-testing (`local/mod.rs:82-96`). It also
bounds the licence surface (all Apache-2.0, test `local/mod.rs:410-415`) and gives the
recommender honest RAM figures per entry — none of which a runtime probe provides. The trade-off
is maintenance (the list must be kept current, `local/mod.rs:94-96`) and user freedom (power users
can't point the app at their own model), both accepted deliberately. Near-miss rejection is
pinned by `is_curated_model_accepts_only_allowlisted_tags`, including `qwen3.5:9b-instruct-q2_K`
and `../etc/passwd` (`local/mod.rs:426-448`).

## 12. Security boundary — CSP and capabilities

**Production CSP** (`tauri.conf.json:26`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

`connect-src 'self' ipc: http://ipc.localhost` means the **webview cannot make outbound HTTP at
all** — not to OpenRouter, not to HuggingFace, not even to the loopback sidecar. Every byte of
network egress is Rust-side `reqwest`. A compromised webview (e.g. via a malicious note that found
an XSS hole) could invoke the Tauri commands the capability grants, but could not exfiltrate
directly over the network.

**The `devCsp` is much looser** (`tauri.conf.json:27`): it adds `'unsafe-inline' 'unsafe-eval'`
to scripts and `ws: http: https:` to `connect-src`. This is **dev-mode only** — Vite HMR needs
it. Nobody should read that line and conclude production allows `https:`; it does not.

**Capabilities** (`capabilities/default.json:6-10`): exactly three permissions —
`core:default`, `core:window:allow-destroy`, `core:window:allow-start-dragging`. The file's own
description is the authoritative rationale, quoted verbatim (`capabilities/default.json:4`):

> "Capability for the main window. Vault file operations are app-defined commands and need no
> capability; the dialog AND shell plugins are used only from Rust (the Ollama sidecar is spawned
> via app.shell().sidecar() in the backend, which does not consult this capability — it gates only
> the JS Command API, which the webview never imports). Granting shell:allow-execute would hand a
> compromised webview a spawn primitive with unvalidated env (e.g. rebinding Ollama to 0.0.0.0),
> so it is deliberately omitted per least-privilege. allow-destroy lets the unsaved-edit guard
> close the window via getCurrentWindow().destroy() after the user confirms discard
> (onCloseRequested is covered by core:default's event permissions). allow-start-dragging backs
> the custom titlebar's data-tauri-drag-region; it only lets the webview initiate an OS
> window-move and grants no new data-read or process-spawn primitive."

Two facts worth restating: **`shell:allow-execute` is deliberately withheld** — the webview has
no spawn primitive — and the Rust-side `app.shell().sidecar()` call does not consult this
capability at all (the spec records this was verified against `tauri-plugin-shell` 2.3.5 source,
`specs/ai-providers-slice.md:88-90`).

## 13. Network surface — every outbound call

| # | Host | Path | Trigger | Timeouts | Notes |
|---|---|---|---|---|---|
| 1 | `openrouter.ai` (HTTPS) | `/api/v1/chat/completions` (`ai.rs:27`) | User: each chat turn on the OpenRouter provider | connect 10 s, per-read idle 120 s, **no total timeout** (deliberate — long streams; `ai.rs:316-346`) | Bearer auth + `X-Title: NeuralNote` attribution header (`ai.rs:377-383`). Error bodies redacted (`ai.rs:394-405`). |
| 2 | `huggingface.co` (HTTPS) | `/api/models/{hf_repo}` (`local.rs:424-432`) | User: opening the local-model setup UI (per candidate; enrichment only, `commands/ai.rs:166-174`) | connect 5 s, total 15 s (`local.rs:498-504`) | **No cache, no custom User-Agent, no auth token, no rate limiting** — six near-simultaneous anonymous requests per settings visit (inferred from one call per candidate). `Err` is treated as "no metadata", never fatal (`commands/ai.rs:168-169`). |
| 3 | `127.0.0.1:<ephemeral>` (HTTP, loopback) | `/api/tags`, `/api/pull`, `/api/delete`, `/v1/chat/completions` (`local.rs:353-421`) | User: local chat, model list/pull/delete; automatic: health poll during startup (300 ms interval, ≤30 s, `local.rs:36-37`) and liveness probe of a cached port (`local.rs:519-529`) | management: connect 5 s / total 15 s (`local.rs:498-504`); pull: connect 10 s / per-read idle 60 s (`local.rs:511-517`); chat: connect 10 s / per-read idle 300 s (`local.rs:352-363`); health: connect 500 ms / total 2 s (`local.rs:457-460`) | App-private sidecar; plain HTTP is fine on loopback (inferred). |
| 4 | `registry.ollama.ai` (HTTPS) | blob/manifest fetches | User-initiated pull, but performed **by the sidecar process**, not the app (inferred: the app only POSTs `/api/pull` to loopback, `local.rs:380-385`; the registry host is Ollama's default) | Ollama's own — not controlled by app code | The app's checksum/allowlist controls do not extend here; integrity is Ollama's digest verification (inferred). |
| 5 | `github.com` releases (HTTPS) | `ollama-darwin.tgz` for `v0.31.1` (`fetch-ollama-sidecar.sh:29-33`) | **Build time only** — developer/CI machine, never a user's | curl defaults | SHA-256 pinned, fail-closed (§8.1). |

**Cross-cutting:** there is **no TLS pinning** anywhere (all HTTPS trust is the OS trust store —
verified: no certificate configuration exists on any `reqwest::Client::builder()` call), and
**no response size caps** — `resp.text()`, `resp.json()`, and the streamed accumulators are
bounded only by timeouts and, for chat, by the orchestrator's guards (inferred; see GAP-010-10).

## 14. Invariants & guarantees

| # | Invariant | Anchor |
|---|---|---|
| I-1 | The API key is never returned to the webview by any command, DTO, or named event | `ai.rs:4-6`, §6 table |
| I-2 | The API key is never serialised into `ai-config.json` | `ai.rs:775` (test), `provider_config.rs:31` |
| I-3 | Buffered HTTP error bodies are redacted before surfacing | `ai.rs:394-405`, `openai.rs:17-23` |
| I-4 | Config writes are atomic and replace (never write through) a symlink | `provider_config.rs:124-134`, test `provider_config.rs:192-217` |
| I-5 | A corrupt config is surfaced, never silently clobbered to defaults (which would flip the user's provider) | `ai.rs:160-169`, tests `ai.rs:886-919` |
| I-6 | Pre-`reasoning` configs read back `reasoning: false` — no silent opt-in to billed tokens | `provider_config.rs:34-40`, test `provider_config.rs:365-378` |
| I-7 | `set_reasoning` returns the persisted state; the UI never renders an un-persisted toggle | `commands/ai.rs:127-139` |
| I-8 | A cleared key cannot be resurrected into the cache by a concurrent cache-miss read | `ai.rs:104-119`, test `ai.rs:921-944` |
| I-9 | Only curated, tool-calling models can be selected, pulled, or chatted against — enforced Rust-side at three sites | `commands/ai.rs:107`, `commands/ai.rs:205`, `commands/ai.rs:415` |
| I-10 | The sidecar binds loopback only, on an app-chosen ephemeral port, with a private models dir; the user's own Ollama is never touched | `local.rs:228-229`, `local.rs:434-443` |
| I-11 | The webview has no spawn primitive and no outbound HTTP | `capabilities/default.json:4-10`, `tauri.conf.json:26` |
| I-12 | The health poll never blesses an impostor process on our port | `local.rs:472-480` |
| I-13 | A pull emits exactly one terminal event (Success xor Error); failures are never silent | `commands/ai.rs:237-243`, `local.rs:581-590` |
| I-14 | Sidecar acquisition is build-time, pinned, checksum-verified, fail-closed; no runtime downloads of the runtime itself | `fetch-ollama-sidecar.sh:29-30`, `76-103` |
| I-15 | Sidecar stderr retention is bounded (~16 KiB tail) | `local.rs:45-49`, `599-616` |
| I-16 | State locks are never held across an `.await` | `local.rs:196-198`, `local.rs:258-264`, `commands/ai.rs:216` |

## 15. Error handling & failure modes

The governing contract is the project invariant *"failures are never silent"*
(`docs/definition-of-done.md:55-57`). As built:

- **Chat never panics and never fails silently**: every failure — no vault, unreadable config, no
  key, keychain error, sidecar startup, missing model, transport — lands on the sink as a
  `ChatEvent::Error` (`commands/ai.rs:267-272`, all arms of `commands/ai.rs:286-346`,
  `365-472`).
- **Corrupt config is load-bearing, not cosmetic**: both `save_api_key` and `clear_api_key`
  refuse to clobber an unreadable config with `default()` — that would silently drop
  `active_provider`/`local_model_tag` and flip the user onto OpenRouter (`ai.rs:159-169`,
  `ai.rs:197-209`; tests `ai.rs:813-859`, `886-919`). The compound error messages state exactly
  what did and didn't happen ("API key was stored in the keychain, but…").
- **Startup failure carries evidence**: the health-poll timeout / early-exit error embeds the
  captured stderr tail (`local.rs:463-470`).
- **Stalls become errors, not hangs**: every client carries timeouts sized to its call class
  (§13); per-read idle timeouts are used where a total timeout would kill legitimately long
  streams (`ai.rs:316-322`, `local.rs:508-517`).
- **HF metadata is non-fatal enrichment**: an `Err` renders as "no metadata", never an error state
  (`commands/ai.rs:166-169`, `hf.rs:1-4`).
- **The one intentional silence**: a closed `PullSink`/`EventSink` channel (webview navigated
  away or closed) is logged once, then further events are dropped (`ai.rs:266-280`,
  `local.rs:146-156`). The sink contract is infallible by design, so the error cannot propagate;
  the alternative — retrying against a dead UI for the rest of the run — would be worse. The
  acknowledged cost is that a chat run continues spending tokens until its guards stop it
  (`TODO(chat-cancellation)`, `ai.rs:272-278`).

## 16. Testing — coverage and gaps

**What is tested (core, coverage-gated):** config round-trip, normalisation, migration bridge,
symlink replacement, corrupt-file surfacing, reasoning default+round-trip (`provider_config.rs`
tests, 13 cases); recommender policy including the zero-RAM/weak-specs distinction, monotonicity
across RAM tiers, allowlist near-miss rejection, serde shape (`local/mod.rs` tests, 12 cases);
pull NDJSON parsing incl. in-band errors and clamping (`pull.rs` tests); tags and HF parsing incl.
malformed input (`tags.rs`, `hf.rs` tests).

**What is tested (shell):** the keychain flows are tested against an in-memory
`keyring` credential builder — key-never-in-config, empty-key rejection, cache population/
invalidation, and the clear-during-cache-miss race via an after-read hook (`ai.rs:506-963`);
reasoning wire-body opt-in (`ai.rs:666-685`); stderr tail bounding, pull-line handling incl.
cancel/success/in-band error/non-UTF-8, and the loopback port reservation
(`local.rs:626-755`); `AiStatus` mapping (`commands/ai.rs:479-497`).

**The structural gap:** the Rust coverage gate runs `cargo llvm-cov -p neuralnote-core` **only**
(`scripts/rust-quality-gate.sh:64`) — the deliberate "all logic in the testable core" policy
(`specs/ai-providers-slice.md:68-70`). SonarQube *analyses* the shell's Rust
(`sonar-project.properties:13` includes `app/desktop/src-tauri/src`) but the shell contributes no
lcov, so the keychain, sidecar-lifecycle, and network paths report **0 % coverage** there despite
the unit tests above running under plain `cargo test` (inferred: `sonar.rust.lcov.reportPaths`
points only at the core-scoped `lcov-rust.info`, `sonar-project.properties:26-28`). Untested
end-to-end: real sidecar spawn/health/shutdown, real keychain, the pull against a live Ollama, and
the concurrent-starter races (exercised only by hand per DoD §1 "verified against ground truth").

## 17. Known gaps & edge cases

| ID | Description | Evidence | Impact | Suggested fix |
|---|---|---|---|---|
| GAP-010-1 | SIGKILL / panic-abort / power loss orphans `ollama serve`; the exit handler never runs. Next launch picks a fresh port so nothing conflicts, but the orphan lingers, holding RAM | `lib.rs:181-187` (only `RunEvent`-driven teardown); `local.rs:301-322` | Stray process until reboot/manual kill; user-visible in Activity Monitor | Write a PID file per spawn; on startup, kill any recorded PID whose process is still an `ollama serve` we own (verify via args/env) before spawning |
| GAP-010-2 | Port TOCTOU: between dropping the reservation listener and the sidecar binding, another process can take the port; startup then fails with **no automatic retry on a new port** | `local.rs:434-443` (reserve-then-drop); `local.rs:472-480` (fail-fast, no retry loop) | Rare startup failure requiring the user to retry manually; failure is at least honest (impostor defence) | Retry `ensure_ollama_started` once or twice with a fresh port when the child exits during startup |
| GAP-010-3 | No free-disk precheck before a multi-GB pull | `local.rs:376-378`: `TODO(pull-disk-precheck): thread the chosen CandidateModel or models dir through Phase 3 so this can compare available bytes on the exact volume before starting a multi-GB download.` | A doomed 17 GB download runs until the disk fills, then fails late with an Ollama-side error | Implement the TODO: compare `download_bytes` against available bytes on the models-dir volume before opening the stream |
| GAP-010-4 | Partial downloads are not cleaned up app-side after cancel/failure | No removal code in `local.rs:370-411` / `commands/ai.rs:191-244` | Orphaned blobs consume disk in the private models dir (Ollama may resume them — unverified) | After a cancelled/failed pull, list and prune incomplete blobs via the sidecar API, or surface reclaim in Settings |
| GAP-010-5 | `key_configured` can desync from keychain reality on a crash between the two writes | `ai.rs:172-174` (`TODO(key-configured-derive)`, quoted §7) | Status UI misreports; chat unaffected (reads keychain directly) | Implement the TODO: derive the flag from keychain presence on read, accepting the keychain-prompt cost or caching it |
| GAP-010-6 | Mid-stream SSE error frames surface without passing through `redact`; a proxy echoing the bearer into an in-band error would reach the webview verbatim | `openai.rs:63` (`SseEvent::Error(msg) => Err(CoreError::Llm(msg))`); contrast `ai.rs:398-399` (buffered path redacts) | Low-likelihood key exposure path; inconsistent with the threat model the buffered path defends against | Thread the bearer (or a redactor closure) into `consume_sse_line`/`complete_streaming`, or redact in `chat_via_openrouter`'s `Chat failed:` arm (cross-ref LLD-009) |
| GAP-010-7 | GPU/VRAM never detected; `gpu_label` is always `None`; 0.70 of total RAM is the only approximation of GPU-addressable memory | `local.rs:179-182` (`TODO(local-gpu-detection)`, quoted §10) | Fine on Apple-Silicon unified memory; mis-sizes any future discrete-GPU host (currently unreachable — macOS-only gate) | Implement the TODO when the platform gate widens; until then the OS gate makes this safe |
| GAP-010-8 | No code-signature verification of the sidecar archive — checksum pinning only | `fetch-ollama-sidecar.sh:76-104` (SHA-256 only) | A release asset compromised before pinning would pass; hash proves pinner's bytes, not publisher identity | Verify the binaries' Apple code signature (`codesign -v`) post-extract, and/or verify the release's signed provenance if Ollama publishes one |
| GAP-010-9 | HF metadata fetch: no cache, no custom User-Agent, no auth, no rate limiting — ~6 anonymous calls per settings visit | `local.rs:424-432` (bare GET); `local.rs:498-504` (client has timeouts only) | HF throttling/blocks degrade the (non-fatal) enrichment; impolite client behaviour | Add a UA header, an in-memory TTL cache keyed by repo, and fetch lazily per visible card |
| GAP-010-10 | No response size caps on any HTTP path — `text()`/`json()`/stream accumulators bounded only by timeouts (and chat by orchestrator guards) | `local.rs:540-553` (`resp.text()` unbounded); `ai.rs:394` (error body unbounded); no `Content-Length` checks anywhere | A hostile/compromised endpoint could balloon memory; loopback paths are app-controlled, but OpenRouter/HF are remote | Cap error-body and metadata reads (e.g. take the first 64 KiB); enforce a byte budget on streamed accumulators |
| GAP-010-11 | No TLS pinning on OpenRouter/HF; trust is the OS store | No cert config on any `reqwest::Client::builder()` (`ai.rs:319-322`, `local.rs:498-517`) | A trusted-root MITM (corp proxy, malware CA) can read the bearer in transit | Accept (defensible for v1 — corporate proxies are common) or pin OpenRouter's intermediate with a rotation story |

## 18. Suggested improvements

Ordered by leverage:

1. **Redact the streaming error path (GAP-010-6).** Small change, closes the one asymmetry in an
   otherwise well-defended secret boundary, and makes I-3 unconditional.
2. **Disk precheck + partial-pull cleanup (GAP-010-3/4).** The pull flow's terminal-event
   discipline is excellent; failing *before* 17 GB, and reclaiming debris, completes the story.
3. **Derive `key_configured` (GAP-010-5).** The TODO already names the design; a session-scoped
   cached derivation preserves the no-keychain-prompt polling property.
4. **PID-file orphan reaping + one port retry (GAP-010-1/2).** Cheap robustness for the two
   process-lifecycle residuals.
5. **HF client hygiene (GAP-010-9)** and **response size caps (GAP-010-10)** as a single
   "network hardening" pass.
6. **Update `specs/ai-providers-slice.md`** to drop the stale `TODO(startup-orphan)` deferral —
   the code fixed it; the spec should say so (DoD housekeeping, `docs/definition-of-done.md:64`).

## 19. References

- [`../architecture/system-overview.md`](../architecture/system-overview.md) — layered HLD; where this subsystem sits.
- [`../architecture/spec-vs-built.md`](../architecture/spec-vs-built.md) — the drift ledger (this LLD adds the `TODO(startup-orphan)` stale-deferral finding).
- `LLD-009` — chat orchestration, retrieval, citation verification, and the SSE wire (`openai.rs`); owns the streaming path referenced in §6/GAP-010-6.
- [`LLD-001-vault-and-path-safety.md`](LLD-001-vault-and-path-safety.md) — the vault-root authorisation gate the chat command sits behind (`root_of`, `lib.rs:86-92`).
- `specs/ai-providers-slice.md` — the slice spec (status: built 2026-07-08; §6 deferrals partially stale, see preamble).
- `docs/definition-of-done.md` — §2's security-adjacent bar, which this subsystem was reviewed under (`specs/ai-providers-slice.md:79-83`).
- Ollama release `v0.31.1` — the pinned sidecar (`fetch-ollama-sidecar.sh:29`).
