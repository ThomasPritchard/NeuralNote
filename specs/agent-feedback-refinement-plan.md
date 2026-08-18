# NeuralNote — Agent feedback refinement — implementation plan

> Status: **draft plan, not approved.** Nothing here is built. Tom's six locked decisions are
> folded in verbatim and are not re-opened; §0 flags four places where the *source* contradicts
> the brief or a locked decision needs one ruling before a phase can start.
>
> Read first: [`specs/neural-note.md`](neural-note.md),
> [`docs/definition-of-done.md`](../docs/definition-of-done.md),
> [`specs/ai-providers-slice.md`](ai-providers-slice.md),
> [`specs/agentic-chat-pane-plan.md`](agentic-chat-pane-plan.md) (the rail, plan steps and
> approval gate this plan builds on). Design tokens are locked by the `neuralnote-design`
> skill; commands by `neuralnote-runbook`.
>
> Lanes: `coder` owns Rust, the Tauri shell, and TS **logic** (reducer, selectors, hooks,
> `api.ts`). `ui-designer` owns presentational `.tsx` and Tailwind. Mixed phases are split
> explicitly in §2.
>
> **Intended destination: `specs/agent-feedback-refinement-plan.md`.** This file is the plan-mode
> scratch copy; the orchestrator should write the same content to the spec path.

---

## 0. Read this before anything else

Five findings. The first is a live defect in code already on disk; the second and third change
the shape of phases the brief describes as UI-only; the fourth is a ruling I need; the fifth is
the sharpest cost risk in the whole plan.

### 0.1 `RawReasoningCapability` will deserialize to all-`None`, silently

`crates/neuralnote-core/src/ai/capabilities.rs:206-207` carries
`#[serde(rename_all = "camelCase")]`. OpenRouter's `/models` payload is **snake_case**. Two
in-repo receipts:

- The sibling struct `RawOpenRouterModel` (`capabilities.rs:30-42`) has **no** `rename_all` and
  names its fields `supported_parameters` / `context_length` — matching the API verbatim.
- `openai.rs:503-504` states it outright: *"The OpenRouter wire is snake_case, so we map
  explicitly here rather than reuse the core's serde."*

So `RawReasoningCapability` currently looks for `defaultEnabled`, `supportedEfforts`,
`defaultEffort`, `supportsMaxTokens` and will find none of them. Every field is `Option`, so
this does not error — a model record carrying a full effort menu deserializes to
`RawReasoningCapability::default()`, and `reasoning_control()` is handed `Some(all-None)`. That
is indistinguishable from a genuine `{}` record, so the failure is **silent**, which the project
forbids outright.

`mandatory` survives by luck (one word, no case boundary), which makes the bug worse: the
`Locked` branch will look like it works while `Efforts` never fires.

**Fix in Phase 1** (drop the `rename_all`), and pin it with a test that parses a *captured
fixture* of a real `/models` record — not a hand-written JSON literal. A hand-written literal
tests my model of the payload, not the payload. This is `capabilities.rs`, which Tom is
currently editing; the Phase 1 agent must take the file only after his `reasoning_control()`
body lands (§3, dependency D1).

### 0.2 Decision 6 is not a UI-only change — the wire carries no correlation key

`Searching { query }`, `Retrieved { query, hit_count }` and
`Reading { rel_path, start_line, end_line }` (`events.rs:322-337`) carry **no tool-call id**.
`ToolCall` / `ToolResult` correlate on `id` and nothing else.

Decision 6 says to enrich *the existing rail rows in place*. The existing rail rows are the
**tool nodes** — `chatTimelineRows.ts:45-51` says so explicitly, and gives the reason: the
searching/reading events are emitted *by the very tool calls above them*, so rendering both
would show one act twice. To attach a query string to the node that ran it, the reducer needs to
know which node that is, and today it can only guess from arrival order.

**Therefore decision 6 requires a wire change and belongs in the Phase 1 freeze**, not in the
later UI phase. The addition is one optional field on three variants (§1.4). Ordering by arrival
was considered and rejected: parallel tool calls are supported (`skill_orchestrator.rs:90`
`parallel(calls)`), so arrival order is not a correlation key, and a wrong attribution here puts
the wrong query on the wrong node — a provenance lie in the one surface whose job is provenance.

### 0.3 "Round N of max_iterations" has a moving denominator

`ActiveSkills::max_iterations(consumed)` (`skills.rs:500-505`) folds the base ceiling against
every active skill's declared cap (`skills.rs:527` declares 12, `skills.rs:567` declares 16) and
takes the max, recomputed per round at `collect.rs:507`. A skill activating mid-run **raises the
ceiling**.

Decision 4 stands; the plan just has to carry the consequence. The round event sends both
numbers on every emission (§1.2), and the UI is forbidden from caching the denominator — it
renders whatever the latest event said. A test must assert the head never renders a round
greater than its ceiling while the ceiling grows underneath it.

### 0.4 One ruling needed: does decision 3 retire the settled `ThinkingNode`?

Decision 3 says tool-turn reasoning is "never persisted to the turn transcript". Two readings:

- **(a) Narrow** — "transcript" means the conversation content: `AssistantMessage.answer`, the
  `full` string, and `toHistory`. Reasoning still shows on the rail after the run, as it does
  today (`ChatTimeline.tsx` → `ThinkingNode`).
- **(b) Wide** — reasoning is visible only while deltas are arriving and disappears from the
  rail when the turn settles.

**I have planned for (a)**, because chat is not persisted to disk at all (`useChatPaneChat.ts`
holds `messages` in `useState` and writes nothing), so under reading (b) "persisted" would have
no referent, and because (b) would delete a surface that exists and works today. If Tom means
(b), Phase 3 gets one extra reducer rule and Phase 5 loses a row — cheap either way, but it must
be settled **before Phase 3**, not after.

Related and non-optional under either reading: today all reasoning lands in one flat
`turn.thinking` string (`chatMessageReducer.ts:359`). Once every planning round reasons, that
becomes several rounds' reasoning concatenated with no separator. §3 Phase 3 buffers reasoning
**per round** using the round number the reducer already has from `PlanningRound` — no extra
wire field needed.

### 0.5 The tool-deciding turn has no output ceiling

`tool_wire_body` sends `max_tokens: None` **deliberately** — "uncapped, so long tool-call JSON is
never truncated mid-note" (`ai.rs:894-896`, and `openai.rs:163` on `ANSWER_MAX_TOKENS`). The
answer turn caps at 4096; the tool turn caps at nothing.

Decision 3 turns reasoning on for that turn. So the change removes the last thing bounding a
reasoning-heavy model's output on a turn that can repeat up to 16 times. Full cost analysis and
the three mitigations that do **not** re-open decision 3 are in §5.2.

### 0.6 Two stale comments, resolved

`openai.rs:174-176` and `openai.rs:599-600` both say the reasoning field is "set only by the
OpenRouter client… the local (Ollama) endpoint would ignore or reject the field."
`local.rs:459-471` passes `reasoning` straight into `ollama_chat_client`, with its own comment
saying Ollama's OpenAI-compatible endpoint *does* map thinking onto `reasoning`.

The **code is right and the comments are stale.** `local.rs`'s comment is the newer and more
specific claim, and `commands/ai.rs:1123` computes `effective_reasoning` for both providers.
Phase 1 corrects the two `openai.rs` comments. No behaviour changes. Recorded here because a
future reader will otherwise "fix" the code to match the comment and silently kill local
thinking.

---

## 1. Phase 1 contract freeze — the shared surface, settled before anything else

Everything in §1 lands in **one commit, by one agent, before any other phase starts.** Two
distinct contracts freeze here, and both are shared seams that would otherwise have several
agents editing different files while colliding on the same interface.

### 1.1 Contract A — the `ChatEvent` wire enum

Full delta against `crates/neuralnote-core/src/ai/events.rs`. Field naming follows the file's
frozen convention: `#[serde(tag = "type", rename_all = "camelCase", rename_all_fields =
"camelCase")]`.

**CHANGED — `Processing` narrows to its original meaning**

```rust
/// The run has been accepted and is preparing its first model request.
/// Emitted EXACTLY ONCE per run, at the top of the orchestrator. The
/// per-round beacon is now `PlanningRound`, which carries a round number
/// and therefore cannot reset the phase backwards the way a repeated
/// `Processing` did (#-defect-1).
Processing,
```

The emission at `orchestrator/mod.rs:123` stays. The emission at `orchestrator/collect.rs:367`
is **replaced** by `PlanningRound`. This alone fixes defect 1 by construction: the event that
repeats is no longer the event that sets the opening phase.

**NEW — `PlanningRound`**

```rust
/// A tool-deciding round-trip is starting. Emitted once per round, before
/// the model request goes out, through the raw sink and before the retry
/// EmissionGuard wraps it (see `collect.rs:363-366` — counting it would
/// disable the one bounded retry).
///
/// `max_rounds` is re-read every emission and CAN GROW mid-run: a skill
/// activating raises the ceiling (`skills.rs:500-505`). The UI must render
/// the latest pair and never cache the denominator.
PlanningRound {
    /// 1-based. The first tool-deciding turn is round 1.
    round: u32,
    /// The ceiling as computed for THIS round.
    max_rounds: u32,
},
```

**NEW — `Keepalive`**

```rust
/// The provider is alive and has sent nothing else. Forwarded from an SSE
/// comment line (OpenRouter sends `: OPENROUTER PROCESSING`), which
/// `classify_sse_line` previously resolved to `Ignorable` (#-defect-3).
///
/// Carries no payload on purpose: it says "the socket is alive", not
/// "progress happened". It resets the transport-liveness signal and MUST
/// NOT reset the stall detector, which watches for progress (see §3 P2).
Keepalive,
```

**NEW — `ToolProgress`**

```rust
/// A long-running tool reporting from inside itself, keyed to the
/// `ToolCall` it belongs to so it renders on that node rather than on a
/// separate surface (decision 6).
///
/// `message` is Rust-composed, never model prose — the same rule
/// `ToolCall::title` follows. Repeatable; the UI shows the latest.
ToolProgress {
    /// The `ChatEvent::ToolCall` id.
    id: String,
    message: String,
},
```

**CHANGED — `ToolResult` gains a duration**

```rust
ToolResult {
    id: String,
    status: ToolStatus,
    summary: Option<String>,
    detail: Option<String>,
    /// Wall-clock time from dispatch to settlement. Measured with
    /// `Instant`, which the core already treats as a measurement rather
    /// than a timer (`orchestrator/mod.rs:104-107`). Never optional: the
    /// orchestrator always knows how long it waited.
    duration_ms: u64,
},
```

**CHANGED — the three retrieval cues gain a correlation key (see §0.2)**

```rust
Searching  { query: String,                                    call_id: Option<String> },
Retrieved  { query: String, hit_count: u32,                    call_id: Option<String> },
Reading    { rel_path: String, start_line: u32, end_line: u32, call_id: Option<String> },
```

`Option`, not `String`: these cues are emitted from the retrieval layer and at least one path may
have no dispatched call behind it. `None` means "no node to attach to" and renders exactly as
today — that is the degradation guarantee, and it must have its own named test.

**UNCHANGED and deliberately reused** — `Thinking { delta }` (`events.rs:341`) carries tool-turn
reasoning too. No new variant. Its live-only guarantee already exists in prose at
`openai.rs:109-113`; Phase 3 turns that prose into a check on the tool path.

**Not added, and why:** no elapsed-tick event. The core owns no clock
(`orchestrator/mod.rs:104-107`: *"the core still owns no waiting; that stays behind
`RetryDelay`"*), and one IPC message per second per run is the wrong shape for a wall clock. The
live timer is client-side (§3 P2). `Usage.elapsed_ms` remains the authoritative settled number.

### 1.2 Contract B — the internal reasoning ask

This is not on the wire and is therefore easy to miss, but it is edited by Phase 3 **and** Phase
6 and is the single most likely place for two agents to collide.

`to_wire_request(req, stream, num_ctx, max_tokens, reasoning: bool)` (`openai.rs:176-186`)
becomes:

```rust
/// What to ask the provider for on this turn. `None` = send no `reasoning`
/// object at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningAsk {
    /// `{"enabled": true}` and nothing else — the fail-OPEN send used when
    /// the capability probe has not answered (see §4.2).
    Enabled,
    /// `{"effort": "<verbatim>"}`. The string is passed through EXACTLY as
    /// the model's own menu named it (decision 1). Never normalised, never
    /// validated against a compiled-in list — 21 distinct menus exist.
    Effort(String),
}
```

`ReasoningRequest` (`openai.rs:510-513`) gains `#[serde(skip_serializing_if = "Option::is_none")]
effort: Option<String>`, and its "no effort/max_tokens knobs (YAGNI)" comment is deleted.

**Doc receipt (verified 2026-08-18, Context7 → `/websites/openrouter_ai`, *Reasoning tokens*):**
the request object is `{"effort": …, "max_tokens": …, "exclude": bool, "enabled": bool}`; the
documented `effort` values are exactly `max | xhigh | high | medium | low | minimal | none` —
the same seven the catalogue measurement saw; and **`effort` and `max_tokens` are mutually
exclusive** ("One of the following (not both)"). `supports_max_tokens` is therefore out of scope
for this plan; `ReasoningAsk` has no `MaxTokens` arm and the 10 models carrying that flag simply
use their effort menu or their toggle.

`exclude` stays `false` (absent). Decision 3 requires the reasoning stream, so suppressing it is
not available as a cost lever.

### 1.3 Also in Phase 1

- Drop `#[serde(rename_all = "camelCase")]` from `RawReasoningCapability` (§0.1) and add the
  captured-fixture parse test.
- Correct the two stale `openai.rs` comments (§0.6).
- `SseLine` gains a `Keepalive` variant so the comment line survives classification; both
  `sse_event` and `tool_sse_event` (`openai.rs:277-296`, `openai.rs:386-393`) map it, and
  `ToolSseEvent` gains `Keepalive`. Only `consume_sse_line` — the one with a sink — emits.
- **Regenerate bindings**: `npm --prefix app/desktop run gen:bindings`.

### 1.4 Phase 1 definition of done

- `cargo test --workspace --locked` green; every `ChatEvent` construction site updated (16
  `ChatEvent::ToolResult` constructions across `crates/` and `app/desktop/src-tauri/src`, plus 4
  `emit_tool_result` call sites — enumerate, do not trust this count).
- `reduceAssistant` (`chatMessageReducer.ts:156`) handles `planningRound`, `keepalive` and
  `toolProgress`. It is exhaustive over the union, so omitting one is a **compile error** — that
  is the mechanism keeping the UI honest and it must not be defeated with a `default:` arm.
  Phase 1 may fold them into no-op / minimal state; the behaviour lands in later phases.
- `app/desktop/src/lib/bindings/ChatEvent.ts` regenerated and **committed**. Note the gate reads
  the index, not the tree: if `rust-quality-gate.sh` still says bindings are stale after a
  regeneration, commit and re-run rather than regenerating again.
- `./scripts/rust-quality-gate.sh` prints GREEN, exit 0. `npm run lint` / `typecheck` clean.
- No behaviour change is observable in the app. That is the acceptance test: a Phase 1 that
  changes what the user sees has done a later phase's work.

---

## 2. File and lane ownership

Two agents must never hold the same file in the same wave. This table is the freeze list.

| File | P1 | P2 | P3 | P4 | P5 | P6 | P7 |
|---|---|---|---|---|---|---|---|
| `crates/…/ai/events.rs` | **coder** | | | | | | |
| `crates/…/ai/capabilities.rs` | **coder** | | | | | coder | |
| `crates/…/ai/provider_config.rs` | | | | | | **coder** | |
| `crates/…/ai/openai.rs` | **coder** | coder | coder | | | coder | |
| `crates/…/ai/orchestrator/mod.rs`,`collect.rs` | coder | **coder** | | | | | |
| `crates/…/ai/orchestrator/settlement.rs` | coder | | | **coder** | | | |
| `crates/…/ai/youtube_tools.rs` | | | | **coder** | | | |
| `app/desktop/src-tauri/src/ai.rs` | coder | | **coder** | | | coder | |
| `app/desktop/src-tauri/src/commands/ai.rs` | | | | | | **coder** | |
| `src/workspace/chatMessage.ts` | coder | coder | coder | | **coder** | | |
| `src/workspace/chatMessageReducer.ts` | coder | **coder** | coder | coder | coder | | |
| `src/workspace/chatTimelineRows.ts` | | | | | **coder** | | |
| `src/workspace/ChatTimeline.tsx` | | **ui-designer** | | | ui-designer | | |
| `src/workspace/ChatTimelineNodes.tsx` | | | | | **ui-designer** | | |
| `src/workspace/playfulProgressCopy.ts` | | **delete** | | | | | |
| `src/workspace/OpenRouterCard.tsx` | | | | | | | **ui-designer** |
| `src/workspace/AiSettingsPage.tsx` | | | | | | coder | **ui-designer** |

`openai.rs`, `chatMessageReducer.ts` and `ChatTimeline.tsx` each appear in four phases. **They
are the reason this plan is a spine, not a fan-out.** Phases 2–5 may not run concurrently as
written; §6 gives the one safe parallel pair.

---

## 3. The phases

### Phase 2 — An honest live head: real phase, ticking elapsed, keepalive, stall

**Goal.** The head says what the run is actually doing, for as long as it is doing it, and never
goes quiet without saying why. Defects 1, 3 and 4 (partly), plus decisions 4 and 5.

**Lane split.** `coder` owns the emission, the reducer and the clock hook; `ui-designer` owns
the head's markup and copy. The `ui-designer` brief is **presentation only, no logic** — the
elapsed value and the phase string arrive as props already computed.

**coder — Rust**
- `orchestrator/collect.rs:367`: replace `sink.send(ChatEvent::Processing)` with
  `PlanningRound { round, max_rounds }`. The round counter is the loop's existing `consumed`
  count (`collect.rs:507` already reads it); `max_rounds` is
  `active_skills.max_iterations(consumed)`, re-read per round.
- `openai.rs`: `consume_sse_line` emits `ChatEvent::Keepalive` on the new `SseLine::Keepalive`.
  Both turns forward it — a keepalive swallowed on the tool path and surfaced on the answer path
  is exactly the drift `classify_sse_line`'s own comment (`openai.rs:262-268`) exists to prevent.

**coder — TS logic**
- `AssistantMessage.phase` gains `"planning"`, and the turn gains
  `round: { current: number; max: number } | null`, `lastEventAt: number`,
  `startedAt: number`, `reasoningStreaming: boolean`.
- `chatMessageReducer.ts:161-162`: `processing` sets `phase: "sending"`, **not** `"thinking"`.
  `planningRound` sets `phase: "planning"` and stores the pair. `thinking` sets
  `reasoningStreaming: true` (decision 4: the word "Thinking" appears only while deltas arrive).
  Every event stamps `lastEventAt`.
- A `useElapsed` hook: one `setInterval` per live turn, cleared on `done`. On settle, the head
  switches to `usage.elapsedMs` (`ChatTurnNotices.tsx:80-88` `formatElapsed`) — the Rust number
  is authoritative and the display must not jump backwards; if the client clock is ahead, clamp
  rather than rewind.
- Stall rule: `now - lastEventAt > STALL_MS` while live. `Keepalive` refreshes a separate
  `lastAliveAt`, so the warning can distinguish **"still working, nothing new for 45s"** from
  **"nothing at all from the provider for 45s"**. `STALL_MS` is one named constant, not a magic
  number, and its test asserts the *state transition*, not a wall-clock duration (fake timers).

**ui-designer — presentation**
- `ChatTimeline.tsx:52-66` `livePhase`: replace the playful map with honest labels including a
  planning label that carries "round N of M". `LiveHead` (`ChatTimeline.tsx:193-212`) renders
  the elapsed readout beside the phase.
- **a11y**: `ChatTimeline.tsx:187-190` documents that only the phase word is a live region
  because the tally would announce 15–20 times. A **ticking clock inside that live region would
  announce every second.** The elapsed readout must be `aria-hidden`; the stall warning is the
  thing that gets announced.
- **DELETE `playfulProgressCopy.ts`**, its re-export at `ChatMessages.tsx:37-39`, and its import
  at `ChatTimeline.tsx:25`.

**Tests that break — named, not estimated**
| Test | What breaks | Action |
|---|---|---|
| `playfulProgressCopy.test.ts` (whole file) | module deleted | delete |
| `ChatMessagesSkills.test.tsx:47-51` `PLAYFUL_PROGRESS_PAIRS` | copy deleted | delete const |
| `ChatMessagesSkills.test.tsx:~465-494` | asserts a playful label is chosen per prompt | delete |
| `ChatMessagesSkills.test.tsx:496-512` "shows thinking only after Processing…" | `processing` no longer means "thinking" | rewrite: `processing` → sending, `planningRound` → "round 1 of N" |
| `orchestrator/tests.rs:2447,2461,2490` | `Processing` position/count assertions | rewrite against `PlanningRound` |
| `orchestrator/tests.rs:3852,4062` | expect `vec![ChatEvent::Processing]` | rewrite |
| `orchestrator/tests.rs:3953` | expects `Some(&ChatEvent::Processing)` | rewrite |
| `ChatTimeline.test.tsx`, `ChatTurnNotices.test.tsx` | head shape | extend |

**New tests.** Round counter advances and never resets backwards across 3 rounds; the head shows
a growing denominator without ever rendering `round 5 of 4` (§0.3); a keepalive alone does not
clear the stall warning; the stall warning fires and then clears on the next real event; the
settled elapsed replaces the ticking one without going backwards.

**Definition of done.** Baseline DoD §1. Plus: run a real multi-round turn in the app
(`npm run tauri dev`) and watch the head advance through rounds with a ticking clock — this is a
timing behaviour and a green jsdom suite is not evidence of it. Re-run 3–5× before claiming it.

---

### Phase 3 — Reasoning on tool-deciding turns, live-only

**Goal.** Defect 2 and decision 3. All-`coder`, Rust only — no UI file is touched.

**Depends on:** §0.4 ruling; Phase 1 (`ReasoningAsk`).

- `ai.rs:898-906` `tool_wire_body`: stop passing `false`. Pass the client's own ask, the same
  value `answer_wire_body` uses. Rewrite the comment that currently justifies `false` ("the tool
  turn drops reasoning frames on the floor, so requesting them here is pure cost") — after this
  phase that sentence is false, and leaving it is how the change gets reverted in six months.
- `openai.rs:395-423` `tool_event`: call `extract_reasoning(&choice.delta)`
  (`openai.rs:489-500`, already written and already skipping `reasoning.summary` /
  `reasoning.encrypted`). Add `ToolSseEvent::Reasoning(String)`. Note the ordering trap in the
  existing code: the `content.is_none() && fragments.is_empty() → Other` early return at
  `openai.rs:419-421` will swallow a reasoning-only frame unless the reasoning check precedes it.
- The tool-turn reader emits `ChatEvent::Thinking` for that variant and **appends nothing to the
  accumulated content**. That is the whole live-only mechanism on this path.

**The live-only invariant — three checks, because prose is not a check**

`openai.rs:109-113` already documents the invariant for the answer turn. It documents; nothing
fails if it stops being true. This phase adds the checks:

1. **Rust, answer turn** — a stream of reasoning-only frames leaves `full` empty and still
   surfaces as `Err` from `finish_answer`. (Asserts the existing guarantee; likely already
   covered — verify rather than duplicate.)
2. **Rust, tool turn** — a tool turn whose frames carry reasoning *and* tool-call fragments
   returns a `Completion` whose `content` contains none of the reasoning text, and a `VecSink`
   that saw the `Thinking` events. One test, both halves, so it cannot pass by neither happening.
3. **TS, history** — `toHistory` (`chatMessage.ts:644-653`) over a turn with
   `thinking: "…"` and `answer: ""` yields **no assistant turn**; over a turn with both, yields
   only the answer. Today this holds *by omission* — `assistantHistoryContent`
   (`chatMessage.ts:631-636`) simply never reads `thinking`. Nothing goes red if someone adds
   that read, which is the definition of an unguarded invariant.

**Reducer.** Buffer reasoning **per round** (§0.4), keyed on the round number the reducer already
holds from `PlanningRound`. Do not concatenate rounds into one string.

**Definition of done.** Baseline DoD §1, plus: run a real turn against a reasoning-capable
OpenRouter model with tools in play and confirm reasoning streams during planning and the answer
is byte-identical to what the citation verifier sees. Confirm the token counts in the footer went
up (they should — see §5.2) and that the change is therefore visible, not hidden.

---

### Phase 4 — Long tools stop going silent

**Goal.** Defect 5 and the third of decision 5's four signals. All-`coder`, Rust only.

`ToolContext` already has an event path out of a running tool — `report_transcript_source`
(`youtube_tools.rs:293`) emits `TranscriptSource` from inside `dispatch_transcribe_audio`. Use
that same seam; no new plumbing is needed.

**Emission sites** (each gets a Rust-composed message, never model prose):
- `youtube_tools.rs:222-301` `dispatch_transcribe_audio` — before the whisper-availability check,
  and before `transcription_with_retry`.
- `captions_with_retry` (`youtube_tools.rs:531-552`) — on each loop iteration and on the
  `ContinueWithoutPot` fallback, which today only annotates.
- `inspect_with_retry` (`youtube_tools.rs:514-529`) and `transcription_with_retry`
  (`youtube_tools.rs:554-585`) — on the `UpdateExtractorAndRetry` branch, so a retry is visible
  as a retry rather than as a longer silence.
- `update_extractor` (`youtube_tools.rs:606-613`) — on entry ("updating yt-dlp"), not only on
  failure as today.

**Per-tool duration.** `settlement.rs:197` `emit_tool_call` stamps an `Instant`;
`settlement.rs:207` `emit_tool_result` reads it into `duration_ms`. The map from call id to start
instant lives beside the dispatch loop, not in a global. A call that settles without ever having
been announced is a contract break and must be loud, not defaulted to `0`.

**Tests.** A fake `YoutubeIo` that fails once with a retryable error asserts a `ToolProgress`
appears **between** the `ToolCall` and the `ToolResult` for that id — the interleaving is the
property, not the presence. A tool whose settlement carries `duration_ms == 0` on a call that
demonstrably took time is a failure, not a pass.

**Definition of done.** Baseline DoD §1, plus a real `transcribe_audio` run on a several-minute
video with the rail open: no gap longer than the stall threshold between events.

---

### Phase 5 — The rail shows what it already receives

**Goal.** Decision 6. Split: `coder` owns the reducer and the row model; `ui-designer` owns the
node markup and the container-query fix.

**coder — TS logic**
- Reducer: attach `searching.query`, `retrieved.hitCount` (per query, not summed) and
  `reading.relPath` + line range to the `ToolCallView` of the matching `callId` (§0.2). Keep the
  existing `activity` array untouched — `summarizeActivity` and `searchOutcome`
  (`ChatTimeline.tsx:121-122`) still consume it, and two independently-computed provenance lines
  in one turn eventually disagree. The enrichment is a *view onto the node*, not a second ledger.
- `coverage.notesRead[]` is held in state and rendered nowhere. Route it to the settled coverage
  footer, which is where the "what did this run actually see" account already lives.
- **`groupActivity()` and `GroupedStep` (`chatMessage.ts:441-465`) are DELETED**, with their
  tests (`chatMessage.test.ts:10, 1102-1133`) and the export. This is the explicit ruling the
  brief asks for. The reasoning: `groupActivity` collapses consecutive `ActivityStep`s into rows
  — the exact shape a standalone activity-log surface would need, and decision 6 forbids building
  one. With the data attached to tool nodes instead, it has no possible consumer. It is imported
  by nothing today; a tested export with no caller is a maintenance liability that reads as
  supported API. If a grouped view is ever wanted, `git log` has it.

**ui-designer — presentation only, no logic**
- Enrich the existing `ToolNode` (`ChatTimelineNodes.tsx:~240-310`) with the query string, the
  note path and line range, and the per-query hit count. Respect the existing restraint rules:
  `MAX_HINT_CHARS` bounds the argument hint (`ChatTimeline.tsx:14-17`), and the hint stands down
  when the summary already opens with it (`ChatTimelineNodes.tsx:244`) — the same non-duplication
  rule applies to the new fields.
- **Fix the `@[30rem]` hiding**: `ChatTimelineNodes.tsx:297-301` puts Arguments behind
  `@[30rem]:flex` on a container that is the whole turn (`ChatMessages.tsx:115`). In a
  default-width pane the turn never reaches 30rem, so the raw arguments are **unreachable**, not
  merely deprioritised. Below the breakpoint, Arguments must **stack above** Result rather than
  disappear. The two-column layout above the breakpoint stays.
- Render `toolCall.name` alongside the human `title`, in the mono register the file already uses.

**Tests.** `chatTimelineRows.test.ts` extends. **This is a geometric change and needs the browser
tier** — `*.browser.test.tsx` via `npm run test:browser`, plus `npm run typecheck:browser` (DoD
§1: jsdom's `getBoundingClientRect()` returns all-zeros, so a jsdom suite can be fully green
while the arguments column is still invisible). `ChatPaneExpand.browser.test.tsx:463` already
queries the `.@container` element and is the natural home. The assertion must be that the
Arguments text is **visible at the narrow width**, not that a class name is present.

**Definition of done.** Baseline DoD §1 + the browser tier + a hands-on pass in a
default-width pane confirming the arguments are readable without widening the window.

---

### Phase 6 — Native effort: capability → config → request

**Goal.** Decisions 1 and 2, backend half. All-`coder` (Rust + TS logic; no presentational file).

**Depends on: D1 — Tom's `reasoning_control()` body (`capabilities.rs:270-272`) must have landed.**
The phase may be *written* against the signature (it is stable and `#[ts(export)]`-ed), but it
cannot be *verified* until the `todo!()` is gone. Do not assign anyone to write that body.

**The second `provider_config` migration.** `ProviderConfig.reasoning: bool`
(`provider_config.rs:62`) becomes effort-bearing:

```rust
/// The user's reasoning preference. `effort` is a value the model's own
/// menu offered — never normalised, never invented (decision 1).
pub struct ReasoningPreference { pub enabled: bool, pub effort: Option<String> }
```

**Use a NEW key and fold the legacy one.** The new field serialises as `reasoningPreference`;
`reasoning: bool` stays on `RawProviderConfig` as a legacy field and is folded exactly the way
`fold_reasoning_probe` (`provider_config.rs:141-178`) folds the pre-#15 pair. Add
`fold_reasoning_preference(new, legacy_bool)` beside it, with the same "current shape wins"
precedence.

**Do not reuse the `reasoning` key with a changed type.** `RawProviderConfig.reasoning` is
`bool`, not `Option<bool>`; an object arriving there is a hard deserialize error, which fails the
**whole** `ProviderConfig` parse. An older build reading a newer config would then lose the
user's provider, model and approval-mode preferences in one go. The file's own comment
(`provider_config.rs:174-176`) says unknown keys are dropped rather than erroring *precisely* so
a newer config still loads in an older build — reusing the key would throw that property away for
one saved key name. Test both directions: legacy → new folds correctly, and new → older-shape
parse still yields a usable config.

**Effort menu → request.**
- `ai.rs:725-746` `probe_openrouter_reasoning` already fetches and caches from the one
  `/models` body. Extend the same fetch to parse the per-model `reasoning` object into
  `RawReasoningCapability` and cache it alongside pricing and context windows. **One fetch, not
  two** — a second call would be a second cache with its own staleness.
- `commands/ai.rs`: `AiStatus` gains `reasoning_control: ReasoningControl`. `ReasoningSupport`
  stays — it drives `effective_reasoning`, which is a different question (can it reason at all)
  from what control to render.
- `commands/ai.rs:419-447` `set_reasoning` gains an effort-setting sibling. It must **reject an
  effort that is not in the currently probed menu**, and reject with a surfaced error rather than
  silently coercing. The user never types an effort; a value not from the menu means the menu
  moved underneath the UI, and that is a real condition worth seeing.
- `commands/ai.rs:1123` builds the `ReasoningAsk` (§1.2) instead of a bool.

**Bindings regen** — `ReasoningControl.ts`, `AiStatus.ts`, `OpenRouterStatus.ts`.

**Tests that break.** `AiSettingsPage.test.tsx:604-710` (the whole reasoning-toggle describe);
`e2e/reasoning-optin.e2e.test.tsx`; `e2e/chat-reasoning-affordances.e2e.test.tsx`;
`ChatPaneReasoning.test.tsx`; any `provider_config` golden-file test. The five
`effective_reasoning` tests (`capabilities.rs:574-596`) **must survive unchanged** — see §4.2.

**Definition of done.** Baseline DoD §1. Plus, and this is the one that matters: the migration
test corpus includes a **real `ai-config.json` written by the current shipped build**, not a
hand-authored fixture. A hand-authored one inherits whatever the *first* migration assumed the
file looks like, so it can only prove the two migrations agree with each other.

---

### Phase 7 — The effort control

**Goal.** Decisions 1 and 2, UI half. `ui-designer`, **presentation only — no logic**; every
value arrives as a prop from the `ReasoningControl` the backend computed.

Five states, one per `ReasoningControl` variant, and the frontend renders **nothing that is not
in that value** (`capabilities.rs:222-224` states this as the guarantee):

| Variant | Render |
|---|---|
| `Hidden` | nothing at all |
| `Pending` | a "checking model capabilities" state — **never a guessed menu** (decision 2) |
| `Toggle { default_on }` | an on/off switch |
| `Locked` | a locked-on indicator, not an interactive control |
| `Efforts { options, default_effort, can_disable }` | the values **verbatim, in the given order, under the model's own names** (decision 1). No tier scale, no re-labelling, no sorting. |

Files: `OpenRouterCard.tsx` (the current toggle lives there — grep confirms it, not
`AiSettingsPage.tsx`), and `ChatComposer.tsx` where the composer-side affordance sits. Tokens per
the `neuralnote-design` skill; **invoke it before touching markup.**

**Traps for the brief.**
- The 21 distinct menus mean the control must survive a 2-item menu and a 7-item menu without
  a layout choice that only works for one. `deepseek/deepseek-v4-flash` = `["xhigh","high"]`;
  `deepseek/deepseek-v4-flash-0731` = `["max","high","low"]`. Test with both.
- `Pending` is a **state, not a spinner over a disabled menu**. A greyed-out menu showing
  yesterday's options is exactly the guess decision 2 forbids.
- `none` may appear inside `options` (38 of 134 effort-capable models). Whether it is stripped
  into `can_disable` or left as a menu item is decided by `reasoning_control()` — Tom's function.
  The UI renders whatever it gets and must handle both.

**Definition of done.** Baseline DoD §1 + `ux-audit` (a user-facing flow shipped) + a hands-on
pass switching between a `Locked` model, an `Efforts` model and a `Hidden` model and confirming
the control changes shape without a stale menu ever appearing.

---

## 4. Cross-cutting decisions the brief asked to be stated

### 4.1 Where "live-only" is enforced — §3 Phase 3, three named checks.

### 4.2 What happens to `effective_reasoning`'s fail-open send path

**It does not change.** Decision 2 makes the **menu** fail closed; the **send path** stays fail
open. Concretely:

- `effective_reasoning(opt_in, support)` (`capabilities.rs:195-197`) keeps sending when
  `support == Unknown`. Its five tests survive Phase 6 unchanged, and that is the acceptance
  signal that this was not quietly changed.
- When the control is `Pending`, an opted-in user's turn sends `ReasoningAsk::Enabled` —
  `{"enabled": true}`, no `effort`.
- **An effort value is only ever sent when it was read off a probed menu.** There is no
  fallback effort, no remembered effort from a previous model, no compiled-in default.

The asymmetry is deliberate and worth stating in the code: guessing a *menu* invents user-facing
options that may not exist, while omitting an *effort* just takes the provider's own default.

### 4.3 Cost of decision 3

Reasoning moves from **once per run** (the answer turn) to **once per planning round plus the
answer turn**. Rounds are capped at `max_iterations`, which a skill can raise to 16
(`skills.rs:567`). Worst case is a ~17× increase in reasoning-token volume for a
reasoning-heavy run; typical multi-tool runs are 3–5 rounds.

Reasoning tokens bill as output. Three consequences:

1. **§0.5 is the sharp one:** the tool turn sends `max_tokens: None`. On the answer turn
   `ANSWER_MAX_TOKENS = 4096` bounds the damage; on the tool turn nothing does.
2. `UsageMeter` (`orchestrator/usage.rs`) already meters every model call, so reasoning tokens
   land in `tokens_out` and the footer number rises. The cost is **visible**, which satisfies
   "failures are never silent" in spirit — but only after the money is spent.
3. `reasoning.exclude: true` would suppress the stream and is therefore unavailable: decision 3
   requires the deltas.

**Three mitigations that do not re-open decision 3**, for Tom to pick from (all are behaviour
choices, so none are taken unilaterally here):

- **(a)** Apply the user's chosen effort to tool turns as well as the answer turn. The user's own
  control then bounds the spend, and a user who picks `minimal` gets planning reasoning at
  `minimal`. This is the default I would recommend and it is what §1.2's single `ReasoningAsk`
  per client already implies.
- **(b)** Give the tool turn a `max_tokens` after all. This directly contradicts
  `ai.rs:894-896`'s stated reason for `None` (truncating tool-call JSON mid-note), so it would
  need a ceiling generous enough to never clip arguments — a number nobody can pick safely. **Not
  recommended.**
- **(c)** Ship it uncapped and let the footer report it. Honest, and the most likely source of a
  bill-shock issue.

### 4.4 Orderings that are expensive to unwind

1. **Contract before anything.** If Phase 5 lands before the correlation ids (§0.2), it ships
   arrival-order attribution, and a later correction is not a refactor — it is discovering that
   shipped provenance was wrong. Provenance is the moat.
2. **`ReasoningAsk` before Phase 3 and Phase 6.** These two phases both rewrite the reasoning
   call chain. Changing `to_wire_request`'s signature once, in Phase 1, costs one commit; changing
   it after Phase 3 has landed means rewriting Phase 3's call sites and its tests.
3. **The config migration before the effort UI.** A control that can set an effort with nowhere
   to persist it either drops the user's choice on restart or forces a hurried schema.
4. **Delete `playfulProgressCopy` in the same commit as the honest head.** Two commits leaves a
   window where the head has no copy source, and a bisect lands in it.
5. **Do not let Phase 2 and Phase 5 run concurrently.** They collide on
   `chatMessageReducer.ts` and `ChatTimeline.tsx` (§2). Disjoint *files* would not have saved
   them anyway — both change `AssistantMessage`, a shared contract.

---

## 5. Verification and sequencing

**Safe parallel pair:** Phase 3 (Rust: `openai.rs`, `ai.rs`) and Phase 4 (Rust:
`youtube_tools.rs`, `settlement.rs`) touch disjoint files *and* disjoint contracts once Phase 1
has frozen `ChatEvent`. Everything else runs on the spine.

**Recommended sequence:** P1 → P2 → (P3 ∥ P4) → P5 → P6 → P7.

**Review cadence.** `code-reviewer` after P2, after P4, and after P6 — every 2–3 phases, fixing
severity-first and re-reviewing the delta. Phase 6 touches the IPC boundary and persisted config,
which puts it in DoD §2 (security-adjacent): it needs an **independent adversarial reviewer who
did not implement it**, specifically against the migration — a config that fails to parse is a
silent preference wipe.

**Gates.** Every phase: `./scripts/rust-quality-gate.sh` GREEN (exit 0 — `2` INCOMPLETE is not
green), PR CI green, lint/typecheck clean. Phase 5 additionally: `npm run test:browser` +
`npm run typecheck:browser`. Milestone gates (SonarQube, `/production-audit`) after P7, not
per-phase.

**Bindings regeneration points:** end of Phase 1, end of Phase 6. Commit the regenerated files;
if the gate still reports stale afterwards, commit and re-run rather than regenerating again.

**Do not trust a subagent's "all green".** Re-run the gates independently, and re-run the timing
tests in Phase 2 and Phase 4 three to five times — a timing behaviour that passes once has not
been measured.

---

## 6. Open questions for Tom

1. **§0.4** — Does decision 3's "never persisted to the turn transcript" mean (a) never in
   `answer` / `full` / history, with the settled `ThinkingNode` staying as it is today, or
   (b) reasoning also disappears from the rail once the turn settles? Planned for (a). Needed
   before Phase 3.
2. **§4.3** — Which cost mitigation: (a) apply the chosen effort to tool turns too
   (recommended), (b) cap the tool turn's `max_tokens` (not recommended), or (c) uncapped and
   report it in the footer? Needed before Phase 3.
3. **§0.1** — Confirm the `rename_all = "camelCase"` on `RawReasoningCapability` is an oversight
   rather than a deliberate pre-normalisation step, since it sits in the file you are editing.

---

# Amendment A — playlist progress and the video preview card

Agreed with Tom after Phase 1 committed. Phase 1 froze the contract, so this lands as its own
**contract-amendment commit before Phase 2 begins**, not folded silently into a later phase.

## Why

Phase 1 found `PlanningRound` emitting `round 17 of 16` during a playlist, because the iteration
guard deliberately does not stop the loop while a playlist is active (base 8, skill cap 16, three
videos reaches ~24 rounds). The clamp shipped in `6361041` makes the pair always valid but pins
it at the ceiling every round, which reads as "perpetually one round from done".

Separately, Tom asked for a preview of the video currently being processed (scoped as a
nice-to-have). Both need the SAME thing on the wire: which playlist item is in flight. They are
one change.

## Decisions

1. **During a playlist the head shows per-item progress, not rounds.** `Video 2 of 3 · round 4`.
   The denominator becomes the playlist length — known up front, and unlike `max_iterations` it
   never moves. This dissolves the moving-denominator problem rather than clamping around it.
   Outside a playlist, `PlanningRound` behaves exactly as Phase 1 shipped it.
2. **A preview card renders beside the head**: title, duration, channel, position in the playlist,
   and a thumbnail.
3. **The thumbnail is fetched by the Rust core and passed to the webview as a data URI.** The
   webview never talks to Google. No CSP change, no new egress from the renderer, and the
   local-first posture is preserved.

## Constraints

- **Follow the existing precedent**: `ElicitOption.image_data_uri` (`events.rs:26-32`) already
  carries an image as a data URI over this same channel. Match that pattern; do not invent a new
  transport.
- The thumbnail is a **nice-to-have**. A failed or slow thumbnail fetch must never delay, degrade,
  or fail the distil run — it degrades to the text-only card. This is the one place where a silent
  fallback is correct, and it must still be visible in logs.
- Bound the fetch: a size cap and a timeout, so a hostile or huge image cannot wedge a run or
  bloat the channel payload.
- The card must render usefully with **no** image, because that is the degraded path and, on the
  evidence of this codebase, the path least likely to be exercised by hand.

## Split across phases

| Work | Phase |
|---|---|
| Event shapes for playlist position + preview payload; bindings regenerated; inert | **Amendment commit, before Phase 2** |
| Head renders per-item progress; preview card component | Phase 2 |
| Rust-side thumbnail fetch, cap, timeout, degraded path | Phase 4 (owns `youtube_tools.rs`) |

Phase 4 already owns `youtube_tools.rs` for long-tool progress, so the fetch belongs there and
introduces no new file contention. The amendment commit must land before P3 ∥ P4 start.

---

# Amendment B — per-round reasoning boundaries belong to Phase 5

Recorded after Phase 3 (`8027481`) landed.

## The consequence Phase 3 created

Reasoning now streams on every planning round (typically 3-5, up to 16 when a skill raises the
ceiling) as well as the answer turn. All of it concatenates into a single
`AssistantMessage.thinking` string with **no round boundary**, so the disclosure shows several
distinct trains of thought as one undifferentiated blob. This is a real, visible consequence of
the feature, not a cosmetic nicety.

## The wire already carries both boundaries — no amendment needed

Phase 3's report claimed there is no wire event marking the answer turn's start. **That is wrong**,
and it was the stated reason for deferring the work as expensive. Checked against source:

- `ChatEvent::PlanningRound` marks the start of each planning round.
- `ChatEvent::Verifying` is emitted at `orchestrator/session.rs:139`, between `collect_evidence`
  (`session.rs:110`) and `stream_final_answer` (`session.rs:163`). The comment at `session.rs:137`
  describes it as exactly this cue.
- `chatMessageReducer.ts` already folds both (`:198` and `:422`).

So the boundaries are derivable from the FROZEN wire. No new event, no contract change, no
bindings regeneration.

## Why it lands in Phase 5 and not earlier

The remaining cost is real but purely local: `AssistantMessage.thinking` changes from `string` to a
per-round structure, which touches `chatTimelineRows.ts:105-106` and the rail nodes. Phase 5
already owns `chatMessage.ts`, `chatTimelineRows.ts` and `ChatTimelineNodes.tsx` and is already
restructuring those rows. Doing it in Phase 5 is one restructure; doing it in Phase 3 would have
been two, with a freeze-list collision in between.

**Phase 5 must therefore also:** segment `thinking` per round, label each segment with its round
(and the answer turn as its own final segment), and keep the disclosure collapsed by default as it
is today. Do not concatenate rounds into one string.

---

# Amendment C — two defects Phase 4 surfaced, both owned by Phase 5

## C1. `ToolProgress` is emitted but inert, and that FIRES A FALSE STALL NOTICE

Phase 4 emits `ToolProgress` from the long YouTube tools. The reducer folds it to identity
(`chatMessageReducer.ts:233`, `return turn`) and nothing renders it. Verified: no `.tsx` file
references `toolProgress`.

The consequence is not merely "a feature is missing". `foldWithLiveness` short-circuits on an
identity fold, so `lastEventAt` never advances while a long tool is running. `turnLiveness.ts:70`
raises the stall notice at `now - lastEventAt >= STALL_AFTER_MS` (45s). **A healthy 4-minute
Whisper transcription therefore shows the user "the model has been quiet for a while" — a false
alarm, during precisely the operation this workstream exists to make legible.**

The three reducer comments reading "Nothing emits it yet" are now false and must be corrected.

**Phase 5 must:** fold `ToolProgress` so it stamps `lastEventAt`, and render it. No phase in the
original plan claimed `ToolProgress` rendering — this is a genuine gap in the plan, not a
rescoping.

## C2. The thumbnail fetch is awaited inline behind a 30-second timeout

Amendment A says a thumbnail fetch must NEVER delay the distil run. Phase 4 inherited the existing
seam's bounds (256 KiB cap, 5s connect / 30s total, `service.rs:76-77`) rather than inventing new
numbers, which was the right instinct — but the fetch is `await`ed inline, so a black-holed CDN
costs up to 30 seconds per video. That violates the locked constraint.

Phase 4's own recommendation, which stands: **a 3-second per-request timeout in `thumbnail.rs`.**
It also strictly improves the already-shipped playlist-selection path, which today can spend 30s
per thumbnail across up to 50 thumbnails a page.

Routes considered and rejected by Phase 4, recorded so they are not re-litigated: `tokio::time::
timeout` in the core breaks the "core owns no clock" rule (`services.rs:17-21`) and panics under
the `futures::executor::block_on` test harness; tightening the shell client changes the shipped
selection path more broadly than intended.

This is Rust, not presentation — it belongs with Phase 5's logic lane, not its rendering lane.

---

# Amendment D — rulings for Phases 6 and 7, and Phase 5 cleanup

Agreed with Tom 2026-08-18, after Phase 5 landed.

## D1. `reasoning_control()` precedence — NORMALISE

Off gets exactly ONE representation, so two models with identical behaviour render an identical
control:

- `supported_efforts` present -> `Efforts`. **Strip `"none"` from `options`**; its presence sets
  `can_disable: true`. `can_disable` is false when `mandatory` is true. 38 of the 134
  effort-capable models list `"none"` inside the array; the rest express off via
  `mandatory: false`. Both now converge.
- `supported_efforts` absent, `mandatory: true` -> `Locked`.
- `supported_efforts` absent otherwise -> `Toggle { default_on }`. `default_on` follows
  `default_enabled` where present, and defaults to **false** when absent (84 records carry only
  `{"mandatory": false}`). Off is safer on cost and matches today's opt-in, which starts false.
- Capability object absent entirely -> `Hidden`. Probe not yet answered -> `Pending` (decided by
  the caller, not this function).

Note this is a deliberate, bounded departure from decision 1's "native values verbatim": the
VALUES stay verbatim, only the off-sentinel is normalised out of the list.

## D2. Remove the unrendered `searches` / `reads` state

Phase 5's logic lane added per-call `searches` / `reads` to `ToolCallView`; the design lane then
declined to render either, because the query is already the argument hint and the counts are
already the Rust-composed summary, so rendering them would show one act on one node twice. The
reasoning holds, and the truncated-query case it was meant to cover is solved by the
container-query fix instead.

**Delete the state, its selectors and its tests.** Leaving it is the exact pattern
`groupActivity()` was deleted for in the same phase.

## D3. `coverage.notesRead` — KEEP. The premise for deleting it was wrong.

Ruled "delete the state entirely" on the understanding it was unconsumed. **It is not.**
`chatMessage.ts:487` reads `turn.coverage.notesRead.length === 0` as a load-bearing clause of
`showsNothingFoundCard()`. It is *unrendered*, not *unused*, and deleting it would silently change
when the "nothing found" card appears.

Distinguish the two same-named things, which is what made this confusing:

- `turn.coverage.notesRead: string[]` — from the `Coverage` wire event. Gates the card. **Keep.**
- `summarizeActivity().notesRead: number` — a count derived from `turn.activity`. Rendered at
  `ChatTimeline.tsx:154`. Always was. **Keep.**

No change. The design lane's refusal to render a run-level list stands.

## D4. The Phase 3 retry trade — KEEP as shipped

Reasoning latches `EmissionGuard`, so a reasoning-enabled planning turn spends its one bounded
retry at the first reasoning token. A replayed retry would append a second, different monologue
into the same round's buffer with nothing marking the boundary, showing a train of thought the
model never had. Failures before any frame (429/5xx/408, connect drops) still retry, and those are
the failures the retry was written for. No change.
