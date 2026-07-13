# NeuralNote — AI Slice 4: The skills bank

> Status: design draft (2026-07-10). Builds on [`ai-cited-chat-slice.md`](ai-cited-chat-slice.md),
> [`ai-providers-slice.md`](ai-providers-slice.md), and requires
> [`conversational-chat-slice.md`](conversational-chat-slice.md) (the prompt must permit
> non-research turns before a skill turn can exist). Its first consumer is
> [`youtube-distil-skill.md`](youtube-distil-skill.md). Read `specs/neural-note.md` and
> `docs/definition-of-done.md` before implementing.

---

## 1. What this slice is — and the load-bearing idea

The skills bank turns the chat from an answerer into a doer: the user can ask NeuralNote to *do*
something ("distil this video into my vault") and the model executes a multi-step workflow that
ends in notes written to the vault.

The load-bearing idea, stated plainly: **a skill is instructions + tools + prerequisites, not a
Rust function.** The judgement — distilling, routing, writing in the user's voice — belongs to the
model, driven by instruction markdown. Rust supplies the primitives (fetch a transcript, write a
note, ask the user a question) and the guardrails. This is the reason the reference skill port
(Slice 5) works at all: the SKILL.md prose *is* most of the skill, and the framework's job is to
deliver it to the model with the right tools attached.

Structurally this extends the existing agentic loop (`run_chat` → `collect_evidence`,
`crates/neuralnote-core/src/ai/orchestrator.rs:77`, `:169`) — same loop, more tools, plus the
first tools that *write*.

## 2. Locked decisions (and why)

- **Built-in skills only in v1**, compiled in via `include_str!` of a `SKILL.md`. The manifest is
  shaped so a future `<vault>/.neuralnote/skills/` loader is a source change, not a redesign —
  but user-authored skills are explicitly deferred (untrusted instruction markdown is a prompt-
  injection surface that deserves its own slice).
- **Progressive disclosure.** The system prompt carries only a compact catalogue
  (`id: one-line description`). The model calls a new `use_skill(id)` tool; the tool result **is**
  the full instruction markdown, and the orchestrator adds that skill's tools to the advertised
  set for subsequent iterations. The base prompt stays small; instructions arrive only when
  needed. (This mirrors how Claude Code's own skills load.)
- **Explicit activation short-circuits discovery.** The frontend passes
  `active_skills: Vec<String>` on the `chat` invoke; the orchestrator pre-loads those skills'
  instructions and tools before turn one. The `@` picker and the chip row both feed this one
  field — both doors converge on the same code path as `use_skill`.
- **Vault writes: auto-route and announce, no confirm gate.** Full reference-workflow parity: the model
  picks the folder, writes immediately, then reports where and why with an invitation to move it.
  This is the highest-blast-radius option, chosen deliberately — so the **engineering guardrails
  carry the weight** (§4): create-only, vault-confined, bounded, undoable.
- **Elicitation is a tool, not a new IPC channel.** The Tauri `Channel<ChatEvent>` is one-way
  (Rust → JS, `lib/api.ts:212` → `src-tauri/src/commands/ai.rs:274`), so "ask the user" is
  modelled as a tool call the shell resolves (§3.4). It supports single- and multi-select over
  structured options, and — the property that keeps it affordable — options may be authored by
  the **tool's own implementation**, not only by the model. This primitive is exactly MCP's
  *elicitation*; built once, it serves every future skill.
- **Skill binaries live in app-data, never the bundle.** Downloaded on first use behind an
  in-chat consent prompt, into the app-data dir (macOS:
  `~/Library/Application Support/com.neuralnote.desktop/bin/`). Rationale in Slice 5 §3 (staleness
  + the notarisation/self-update constraint); the framework-level rule here is that a
  `Requirement` names a binary and the download reuses the cancellable progress pattern of
  `ai/local/pull.rs` (`PullEvent`s, driven like `src-tauri/src/local.rs:370`).

## 3. Architecture

```
@ picker / chip row (React) ──▶ chat(prompt, history, active_skills, Channel) ──▶ orchestrator
   (feeds active_skills)              (Tauri shell)                                 (Rust core)
                                                                                        │
        SkillRegistry (core) ── catalogue → SYSTEM_PROMPT                               │
        SkillManifest[] ────── use_skill(id) → instructions + tool grant ───────────────┤
                                                                                        │
        tools.rs: existing read-only four + use_skill + ask_user + write_note           │
                                    │                     │                             │
                            UserPrompt trait      vault-confined create-only writes     │
                            (shell: Elicit event  (core policy, shell I/O)              │
                             + parked oneshot)                                          │
                                                                                        ▼
        ChatEvent: + SkillActivated · SkillStep · Elicit · NoteWritten ──▶ reduceAssistant (TS)
```

### 3.1 The manifest and registry (core, pure, tested)

```rust
SkillManifest { id, name, version, description, icon, instructions /* markdown */,
                tools: Vec<String>, requirements: Vec<Requirement> }
```

`id` is a **stable primary key** from day one, and `version` is reserved now even though built-in
skills version with the app — both are one-field costs today that a future marketplace (§7) cannot
retrofit cheaply once ids are in user configs and vault profiles.

`Requirement` covers at least: a named binary (present in the app-data bin dir?), free disk space,
and platform (arch/OS). Eligibility policy is pure core logic with tests, exactly as
`recommend_model()` is (`crates/neuralnote-core/src/ai/local/mod.rs:198`) — but note that
eligibility here is **not** `recommend_model` (that is a RAM policy for LLMs); Whisper-class gates
are architecture, OS, and free disk. Extend the existing `HardwareSpec` probe with free-disk;
keep the policy in the core.

### 3.2 Orchestrator changes

- Base `SYSTEM_PROMPT` gains the compact skill catalogue only.
- `use_skill(id)` is dispatched by `tools.rs::dispatch()` (`tools.rs:164`), which stays **total**:
  an unknown id or an unmet requirement becomes an error *tool result* the model recovers from
  (for a missing binary, the orchestrator first emits the tiered download offer via `ask_user`).
- Once a skill is active, its tools join the advertised `tool_schemas()` set for subsequent
  iterations. A skill may raise `Guards.max_iterations` via a per-skill override in its manifest,
  defaulting to the global 8 (§8.2).
- New `ChatEvent` variants — `SkillActivated { id, name }`, `SkillStep { message }` (for
  "Fetching captions…", "Transcribing locally — this takes a few minutes"),
  `Elicit { id, question, options: Vec<ElicitOption>, multi_select }`,
  `NoteWritten { rel_path, kind }`. `reduceAssistant`
  (`workspace/chatMessage.ts:98`) is exhaustive over the `ChatEvent` union, so each variant is a
  compile-time obligation on the frontend, and the TS types regenerate from ts-rs
  (`npm --prefix app/desktop run gen:bindings`) — never hand-edited.

### 3.3 `write_note` — the first write primitive

Signature (shape, not final): `write_note(rel_path, content, kind)` where `kind` is
`literature | atomic | transcript` — it drives the report card *and* the collision policy below.
Behaviour is pure policy in the core, I/O in the shell:

- **Create-only, with a `kind`-dependent collision policy.** No write ever overwrites an existing
  file. What a collision *means*, though, depends on what is being written:
  - `literature` / `transcript` → **suffix**. These are dated captures of one specific source, and
    two can legitimately share a title (`Name.md` → `Name 2.md`). The path actually written comes
    back in the tool result and the `NoteWritten` event.
  - `atomic` → **skip, and return the existing path.** An atomic note names a *concept*, and a
    concept has exactly one note. A collision here is not an obstacle to route around; it is the
    answer. The note already exists, so the model wikilinks it from the literature note instead of
    creating `Markov chains 2.md`. The tool result carries `{ existed: true, rel_path }`.

  This distinction is what makes concept-scoped atomic notes possible
  ([`youtube-distil-skill.md`](youtube-distil-skill.md) §6). One uniform collision rule would
  either duplicate every recurring concept or refuse legitimate same-day captures.
- **Vault-confined.** The path is canonicalised and must resolve inside the vault root — no `..`
  traversal, no absolute paths, no symlink escape (canonicalise the *parent* and verify the prefix
  before writing).
- **Bounded — per work item, not per run.** The cap is a **budget per work item** (recommend 8 —
  a single-video distil writes ≤5 files), with the **run total derived from the number of items
  in the run**: a single video gets 8; a playlist run of *n* selected videos gets *n* × 8
  ([`youtube-distil-skill.md`](youtube-distil-skill.md) §7). A flat per-run cap would trip on a
  three-video playlist while being meant to catch a runaway loop. Exceeding the budget is an
  error tool result, not a silent stop — the project forbids silent caps.
- **Undoable.** The orchestrator records every path a run created; the report card's Undo deletes
  exactly those files — and only if their content still matches what was written (hash check), so
  Undo can never destroy a user edit.

### 3.4 Elicitation — clickable questions over a one-way channel

The contract, structured from day one so the playlist picker (Slice 5 §7) is not a redesign:

```rust
Elicitation  { id, question, options: Vec<ElicitOption>, multi_select: bool }
ElicitOption { id, label, description: Option<String>, image_data_uri: Option<String> }
```

Core defines the seam alongside `LlmClient` (`ai/llm.rs:127`), `RetrievalProvider`
(`ai/retrieval.rs:85`), and `EventSink` (`ai/events.rs:68`). Like `LlmClient` (`ai/llm.rs:126`) it
is held as `&dyn`, so it needs `#[async_trait]` — async-fn-in-trait cannot be made into a trait
object, because the returned future's type is unnameable and per-impl, leaving no uniform vtable:

```rust
#[async_trait]
pub trait UserPrompt: Send + Sync {
    async fn ask(&self, e: Elicitation) -> CoreResult<Option<Vec<String>>>;
}
```

The answer is the chosen option ids — a `Vec` because of `multi_select`; a single-select answer is
validated to exactly one. `None` still means "the user did not respond".

**Options come through two doors, over this one seam:**

- **Model-authored** — the `ask_user(question, options)` tool, for yes/no and short choices (the
  binary-download consent). The model writes the options into the tool-call JSON; fine when there
  are two or five of them.
- **Implementation-authored** — a skill-specific tool such as `select_playlist_videos(playlist_url)`
  whose **Rust body** fetches the entries, builds the options (with thumbnails), emits
  `ChatEvent::Elicit`, awaits `UserPrompt`, and returns **only the chosen ids** to the model as
  the tool result. The model never sees the list. This matters: a 200-entry playlist picker cannot
  be model-authored — the model would burn thousands of tokens enumerating data it does not even
  have. This property is what keeps elicitation affordable, and it applies to every future skill
  that picks from a fetched set.

**Thumbnails, and a security win worth naming.** `image_data_uri` images are fetched **in Rust**
and returned as base64 `data:` URIs. `tauri.conf.json`'s CSP is already
`img-src 'self' data: blob:`, so **no CSP change is required and the webview makes zero outbound
requests** — no beaconing, no third-party host allowlisted. The alternative — relaxing `img-src`
to `https://i.ytimg.com` — would open a standing outbound channel from the webview for one
feature's convenience; we did not. Large option sets are paged or lazy-loaded rather than shipped
as one giant event (~10 KB per thumbnail × 200 entries is not a payload for a single `Elicit`).

The model calls the eliciting tool and the dispatcher awaits the answer. **This forces a signature
change the implementer will hit immediately:** `dispatch` is synchronous today (`ai/tools.rs:164`,
called at `orchestrator.rs:283`), so it becomes `pub async fn dispatch(…)` and takes
`&dyn UserPrompt` alongside its existing collaborators. The ripple is the orchestrator's tool
loop and every `dispatch` test. That cost is real and belongs to this slice — it is the price of
elicitation, and it is paid once for every skill that will ever ask the user anything.

The shell implements the trait by emitting `ChatEvent::Elicit`, parking a
`tokio::sync::oneshot::Sender` in `AppState` keyed by elicitation id, and resolving it from a new
`answer_elicitation(id, choices)` Tauri command that the rendered controls invoke. Tests implement
`UserPrompt` with a scripted prompt — no UI needed. `dispatch` stays **total**, as it is today: a
timeout or a closed channel becomes an error *tool result* the model reads and recovers from.

**Hang guard, and why it costs the user nothing.** A 5-minute timeout resolves to `None`, which
becomes the tool result "the user did not respond". The model stops politely, the parked
`oneshot::Sender` is dropped, and no Rust task outlives the turn. Cancelling or closing the chat
resolves outstanding elicitations to `None` the same way. A skill run is never parked indefinitely
and a crashed webview leaks nothing.

**The timeout ends the run, not the question.** The rendered buttons stay live after it fires, and
this needs no resume machinery at all: chat history is already in the pane, and `toHistory`
(`workspace/chatMessage.ts:267`) replays the last 20 turns on the next send. So clicking `Yes` an
hour later simply issues an ordinary user turn — the model re-reads the history, finds the YouTube
URL still sitting there, and carries on. Nothing to re-paste, no serialised continuation, no
resume token.

Two consequences for the implementer. The model's closing line on timeout must invite return
rather than dismiss ("no rush — hit Yes whenever you're ready"), not "send me the link again".
And a timed-out prompt renders as *dormant, still clickable* rather than disabled — disabling it
would throw away the one affordance that makes this work.

### 3.5 Frontend

- **`@` picker** in the composer (`ChatPane.tsx:297-306`), modelled on the existing
  `wikilinkAutocomplete.ts` pattern (`app/desktop/src/workspace/wikilinkAutocomplete.ts` — used by the
  note Editor today). Picking a skill adds it to a chip row above the composer; chips and picker
  both feed `active_skills`.
- **Skill turn rendering** — `SkillActivated` renders a labelled header, `SkillStep` a live
  progress line (the "harness feel" from Slice 1, extended), `Elicit` renders per `multi_select`:
  a button group (single) or a tick-list with a confirm button (multi, with thumbnails when
  `image_data_uri` is present) — either way it calls `answer_elicitation` once and then disables
  itself. `NoteWritten` accumulates into the report card
  (what was created, where, why, Undo). The report card's copy comes from the model's announced
  routing rationale; the file list and Undo come from `NoteWritten` events.
- **Settings › Skills page** in `SettingsModal.tsx`: each built-in skill with description,
  requirement status (installed / missing / downloading with progress), and an enable toggle.
  Creating or importing skills is deferred and the page says nothing about it.

## 4. Security posture (this slice is security-adjacent — DoD §2)

This slice adds the app's first AI-driven **write** primitive, a **user-consented binary
download**, and a new **IPC command** (`answer_elicitation`). Independent adversarial review is
required, per DoD §2 — a green suite is not sign-off.

- **`write_note` guardrails** (§3.3) are the control surface for a hostile or confused model:
  create-only + canonicalised vault confinement + bounded count + content-hash-checked Undo. The
  adversarial pass must attack the path canonicalisation specifically (traversal, symlinked vault
  subdirectories, case-insensitive-filesystem collisions, Unicode normalisation collisions).
- **All process spawning stays in Rust.** `capabilities/default.json` deliberately withholds
  `shell:allow-execute` — its own description explains that granting it would hand a compromised
  webview a spawn primitive. That capability stays withheld; skill binaries are spawned only from
  the shell via Rust, with static argument shapes (the Slice-2 sidecar discipline,
  `local.rs:223-232`, applies to downloaded binaries too).
- **Downloaded binaries are consented, pinned to app-data, and never in `$PATH` resolution** —
  spawned by absolute path only. Download integrity expectations are per-binary and specced in
  Slice 5.
- **`answer_elicitation` validates** that the id names a live parked elicitation, that every
  choice is one of the offered option ids, and that the arity matches (`multi_select: false` →
  exactly one); anything else is a rejected command, not a resolved prompt.
- **Thumbnail fetching stays in Rust** and reaches the webview only as `data:` URIs (§3.4) — the
  CSP's `img-src` allowlist gains no third-party host, and the webview gains no outbound request
  path.
- **Instruction markdown is trusted in v1** because it is compiled in. That trust boundary is
  exactly why user-authored skills are deferred.

## 5. Failure modes — all surfaced

Unknown skill id / unmet requirement → error tool result, model explains and offers the download ·
download declined → skill answers honestly that it can't proceed and what would unlock it ·
download fails / cancelled → terminal `PullEvent`-style error, surfaced in chat, retryable ·
elicitation timeout → `None` → "the user did not respond" tool result, run ends politely ·
`write_note` collision → suffixed, and the *actual* path reported · write cap exceeded → error
tool result naming the cap · Undo on an edited file → that file is skipped and the card says so ·
skill run aborted mid-way → files already written stay, report card shows the partial list with
Undo (never a silent half-state).

## 6. Testing (Definition of Done)

- **Rust unit (core)** — manifest/registry (catalogue rendering, unknown ids); requirement policy
  (per arch/OS/disk matrix, detection-failure distinct from unmet); `use_skill` grant flow against
  a mock `LlmClient` (tools advertised only after activation; explicit `active_skills` pre-load
  equivalence); `write_note` policy (traversal, symlink escape, absolute path, collision suffix,
  per-item budget arithmetic, Undo hash mismatch); elicitation via a scripted `UserPrompt`
  (answered single, answered multi, wrong arity, unknown option id, timeout, cancel;
  implementation-authored options never reach the model's context).
- **TS unit/component** — `@` picker (filter, select, chip add/remove); each new `ChatEvent`
  variant renders (the exhaustive reducer forces this); Elicit single-select buttons and
  multi-select tick-list (with and without thumbnails) call `answer_elicitation` once and
  disable; report card lists `NoteWritten` files and wires Undo; Skills settings page
  states (installed / missing / downloading / disabled).
- **e2e (jsdom + mockIPC, `src/e2e/`)** — activate a skill via `@`, drive a scripted run through
  `emitToChannel` (SkillActivated → SkillStep → Elicit → answer → NoteWritten → report card →
  Undo); the declined-consent journey.
- **Integration (real)** — one real skill run end-to-end lands in Slice 5 (this slice ships a
  minimal built-in fixture skill, which ships with this slice so 4 and 5 stay independently
  verifiable — §8.1).
- ≥90 % coverage on changed code; both gates green; adversarial review of `write_note` +
  `answer_elicitation` per §4; run it in the app by hand.

## 7. Deferred

- User-authored skills (`<vault>/.neuralnote/skills/` loader) — the manifest shape anticipates it;
  the prompt-injection review it needs does not exist yet.
- **A skills marketplace.** The manifest is already shaped for it (`id` stable, `version`
  reserved — §3.1), so the deferral costs nothing structural. The reason it is deferred is not
  time but **trust**: a skill is instruction markdown injected into the system prompt plus the
  tools it unlocks — one of which is now `write_note`. A third-party marketplace skill is
  therefore an unsandboxed prompt-injection vector with write access to the user's vault. A
  marketplace cannot ship without a trust model — signing, review, a capability manifest the user
  approves, or all three — which is a security slice of its own (cf. §4: v1's instruction
  markdown is trusted precisely *because* it is compiled in).
- Per-skill model preferences, scheduled or background skill runs.
- Non-binary requirement kinds (e.g. network reachability probes) until a skill needs one.

## 8. Resolved decisions (were open questions)

All settled 2026-07-10.

1. **This slice ships a minimal built-in fixture skill.** It keeps Slices 4 and 5 independently
   verifiable — the framework is demonstrable and e2e-testable before the YouTube skill lands, and
   the fixture is the natural home for the elicitation and `write_note` journeys.
2. **`max_iterations` is a per-skill override in the manifest**, defaulting to the global `Guards`
   value of 8 (`ai/orchestrator.rs:26-46`). A distil pipeline is ~6 tool calls before retries; 8 is
   too tight to be safe and too arbitrary to hard-code per skill.
3. **Elicitation timeout: 5 minutes**, resolving to `None`. The timeout ends the *run*, not the
   *question* — see §3.4: the buttons stay live and chat history carries the context, so a late
   answer costs the user nothing. This is what makes the short timeout safe; without it, 5 minutes
   would be user-hostile.
4. **Skill enable state lives in `ai-config.json`**, alongside the provider config. One config
   file, one existing atomic-write and `#[serde(default)]` migration pattern
   (`ai/provider_config.rs`). A second `skills-config.json` would double the migration surface to
   save nothing.
