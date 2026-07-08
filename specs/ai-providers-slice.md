# NeuralNote — AI Slice 2: Provider configuration (OpenRouter + local Ollama) & Settings

> Status: built (2026-07-08), on branch `feature/ai-providers`. Builds directly on
> [`ai-cited-chat-slice.md`](ai-cited-chat-slice.md). Read `specs/neural-note.md` and
> `docs/definition-of-done.md` before changing this.

---

## 1. What this slice is

Slice 1 wired **one** provider (OpenRouter, BYO key) into cited chat, with key setup wedged inline
into the chat pane. This slice makes the provider a **user choice** and gives the app a **real
settings surface**:

- **Two providers.** Bring-your-own OpenRouter key *(exists)*, **or** download a model that runs
  **entirely locally**.
- **Local AI via a bundled Ollama sidecar.** The app ships the `ollama` binary as a Tauri
  `externalBin`, spawns it on a private loopback port, analyses the host hardware, recommends the
  largest curated model the machine can *safely* run, downloads it with live progress, and chats
  against it through the **same** OpenAI-compatible wire the OpenRouter path uses. If the machine
  is too weak it says, verbatim: **"Local AI is unsupported due to your computer specs."**
- **A Settings modal** (left-nav: General · Configure the AI · About) wiring the previously-inert
  cog at `Ribbon.tsx`, with a "Configure the AI" page to (re)configure either provider any time.
- **A first-run provider picker** in the chat pane when nothing is configured yet.

## 2. Locked decisions (and why)

- **Engine = bundled Ollama sidecar** (not embedded llama.cpp/mistral.rs). It speaks the same
  OpenAI-compatible `/v1/chat/completions` wire, so a local provider is "another `LlmClient` with a
  different base URL" — reusing the Slice-1 seam — and its **library model tags ship tool-calling
  templates**. Cited chat's citations depend on reliable tool-calling; arbitrary HF GGUF pulls get
  a generic template **without** tool support and silently break the moat.
- **Recommendation = hybrid.** A **curated allowlist** of tool-calling-capable Ollama tags
  (`llama3.1/3.2`, `qwen2.5`, several sizes) is the **source of truth** for what may be installed;
  the UI *also* shows live Hugging Face metadata (downloads / licence / updated) for transparency.
- **macOS-first.** Hardware sizing targets Apple-Silicon unified memory (70% usable, conservative);
  other platforms return "not supported on this platform yet" rather than mis-sizing.
- **Settings = modal + left-sidebar nav** (VS Code / Obsidian idiom).

## 3. Architecture — provider selection is the only new decision

```
Settings modal / first-run picker (React, presentational)
        │  api.ts (single TS↔Rust seam)
        ▼
Tauri shell (src-tauri) — THIN I/O husk: syscalls, HTTP, subprocess only
  · detect_hardware()  · Ollama sidecar lifecycle (spawn/health/shutdown/cancel/crash-recovery)
  · OpenAiChatClient (ONE client, config-driven: OpenRouter | Ollama base URL)
  · HF/Ollama fetch (fetch only — parsing lives in core)
        │  chat reads the active provider, builds the matching client, then calls…
        ▼
neuralnote-core::ai — ALL logic, unit-tested, coverage-counted
  · openai.rs (wire + SSE, shared by both providers)   · provider_config.rs (active provider + tag)
  · local/{mod,pull,hf,tags}.rs (HardwareSpec, curated allowlist, recommend_model,
    is_curated_model, PullEvent/PullSink/parse_pull_line, parse_hf_metadata, parse_installed_models)
  · run_chat / KeywordRetriever / CitationVerifier  ← UNCHANGED
```

**Governing constraint:** coverage is measured from `neuralnote-core` **only** (the Rust gate +
Sonar), so *all logic lives in the testable core and the Tauri shell stays a thin husk*. `chat`'s
only new decision is `effective_provider()`; both arms converge on the **same** `run_chat(...)`.

### Command surface (`src-tauri/src/lib.rs`)
`ai_status` · `set_active_provider` · `detect_hardware` · `local_candidates` ·
`recommend_local_model` · `hf_model_metadata` · `list_local_models` ·
`pull_local_model` (streams `PullEvent` via a Channel) · `cancel_pull` · `delete_local_model`,
plus the generalised provider-aware `chat`. On-disk config stays `ai-config.json`; old
`{model, keyConfigured}` files still load (migration is free).

## 4. Security posture (this slice is security-adjacent — DoD §2)

New subprocess-spawn surface + a secret + untrusted network JSON. Reviewed by three independent
adversarial passes (code-reviewer, silent-failure-hunter, frontier-GPT advisor); all findings fixed:

- **Bundled sidecar only** — spawned via `app.shell().sidecar("ollama")` with the static arg
  `["serve"]`; model names travel in HTTP **bodies**, never as CLI args; never a PATH `ollama`.
- **Loopback-only** — `OLLAMA_HOST=127.0.0.1:<OS-assigned free port>` (never clashes with a user's
  own Ollama on 11434). Models live in an app-owned dir (reclaimable on uninstall).
- **`shell:allow-execute` capability deliberately OMITTED** — the Rust `spawn()` path does not
  consult it (verified against `tauri-plugin-shell` 2.3.5 source); granting it would hand a
  compromised webview a spawn primitive with unvalidated env (e.g. rebinding Ollama to `0.0.0.0`).
- **Curated allowlist enforced in Rust** (`is_curated_model`) at pull, provider-selection, and
  chat pre-flight — a non-UI caller or hand-edited config can't make a non-tool-calling model the
  cited-chat model.
- **The key never crosses to the webview**; keychain errors surface (never swallowed). All Ollama
  and HF JSON is parsed defensively (typed `CoreError::LocalAi`, no panics on attacker data).

## 5. Failure modes — all surfaced ("failures are never silent")

Sidecar won't start (health-poll timeout includes captured stderr) · sidecar crashes mid-session
(cached port is health-probed → clean restart) · pull error / cancel (exactly one terminal
`PullEvent`, success xor error; a stalled download read-times-out instead of hanging) · model
deleted or non-curated mid-chat (pre-flight → "reinstall / pick one in Settings") · HF unreachable
(non-fatal — the metadata line is omitted, never an error) · corrupt config (surfaced, never a
silently-clobbered/flipped provider).

## 6. Deferred (greppable `TODO(...)` at the code site)

- `TODO(startup-orphan)` — an app quit during the ≤30s sidecar health-poll can orphan one `ollama
  serve` (child not yet parked in state). Narrow window; next launch picks a fresh port. Below the
  review bar (2 of 3 reviewers); proper fix = a "starting" state slot shutdown can reach.
- `TODO(local-gpu-detection)` — GPU/unified-memory detail for the hardware readout (RAM/OS/arch
  gates suffice for v1).
- `TODO(pull-disk-precheck)` — free-disk check before a multi-GB pull.
- **Pre-existing (not this slice):** `cargo-audit` RED via Tauri core (`plist → quick-xml`
  RUSTSEC-2026-0194/0195) + Linux GTK3 bindings — a periodic dependency bump (DoD §3), fails on
  `main` too.
