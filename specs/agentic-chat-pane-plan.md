# NeuralNote — Agentic chat pane (Variant A) — implementation plan

> Status: **draft plan, not approved.** Nothing here is built. Prototype verdict, Tom's locked
> decisions, and his **2026-08-10 rulings** on the plan's open questions are all folded in; the
> phases below are proposals for approval.
>
> Rulings folded in: the "approve for me" judge is an **LLM classifier that enforces** (§9.4,
> §9.5); approval scope is a **global mode (`AlwaysAsk` / `ApproveForMe` / `Yolo`) with per-tool
> overrides** (§9.6); **expand-to-wide is in scope as Phase 6**; the 500-line guardrail becomes a
> **real enforced check in Phase 1**. All work happens on a branch in a worktree, never on
> `main` (§10).
>
> Read first: [`specs/neural-note.md`](neural-note.md),
> [`docs/definition-of-done.md`](../docs/definition-of-done.md),
> [`specs/ai-providers-slice.md`](ai-providers-slice.md). Design tokens are locked by the
> `neuralnote-design` skill; commands by `neuralnote-runbook`.
>
> Source of the verdict: `.prototype/chat-pane-agentic.feedback.json` (Variant A, rev 9).
> Throwaway prototype: `app/desktop/src/prototype-chat/` — **delete it in Phase 1**.

---

## 0. Read this before anything else — three corrections to the brief

Planning this work turned up three claims that do not survive contact with the source. The
first one changes the size of the job materially.

### 0.1 There are no discarded tool-call fragments, because none arrive

The premise behind decision 1 ("capture the discarded tool_call argument fragments") is that
`crates/neuralnote-core/src/ai/openai.rs:507` throws away streamed `tool_calls` fragments.
That line is a **test**, not production code:

```rust
// crates/neuralnote-core/src/ai/openai.rs:505-510
#[test]
fn sse_toolcall_only_delta_is_ignored_on_answer_stream() {
    // A delta with no `content` field (e.g. a tool_calls fragment) is not text.
    let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
    assert!(matches!(parse_sse_line(line), SseEvent::Other));
}
```

The real situation is worse, and it is verified:

- **`StreamDelta` has no `tool_calls` field at all** (`openai.rs:447-460` — only `content`,
  `reasoning_details`, `reasoning`). Serde silently drops unknown fields, so a tool-call
  fragment would parse and evaporate.
- **The only streamed turn is the final answer turn, and it is sent with no tools.**
  `stream_final_answer` (`orchestrator.rs:688-694`) calls `self.request(messages, &[])`, and
  `WireRequest.tools` carries `#[serde(skip_serializing_if = "<[_]>::is_empty")]`
  (`openai.rs:295-296`) — its own comment says *"Omitted entirely when empty — that is how the
  orchestrator's final answer turn (no tools) tells the model to prose, not tool-call."*
- **Tool calls are produced exclusively by the non-streaming path.** `complete_tool_turn`
  (`orchestrator.rs:704`) calls `LlmClient::complete`, whose doc comment states plainly:
  *"A tool-deciding turn... **Not streamed, so `tool_calls` parse cleanly**"*
  (`ai/llm.rs:143-145`).

**Consequence.** Live preview is not "stop discarding fragments." It is **a new streaming
tool-turn transport**: a new `LlmClient` trait method that every implementer must satisfy (the
OpenRouter client, the local Ollama client, and the orchestrator's two test doubles at
`orchestrator.rs:1730` and `:1756`), plus tool-call accumulation in the SSE parser, plus new
retry semantics — a retried streamed turn would replay a partial preview, which the current
non-streamed retry is explicitly safe from. This is the difference between a small change and
the largest phase in this plan. Phase 3 is scoped accordingly, and opens with a spike.

The good news: the disk write itself was never the streaming target. `note_writer.rs:954-959`
is one `write_all` + `sync_all` — atomic, nothing to stream. What we are previewing is the
**model composing the note**, not the file being written. Decision 1 survives intact; only its
cost estimate moves.

### 0.2 What Context7 could and could not confirm

Verified, with receipts:

- The chat-completions streaming chunk's `delta` object **does** carry a `tool_calls` array
  alongside `content` and `role`
  (developers.openai.com, *Streaming events → `chat.completion.chunk`*).
- The tool-call object is `{ id, type: "function", function: { name, arguments } }`, and
  `arguments` is a JSON **string**, with this warning in the spec itself: *"Note that the model
  does not always generate valid JSON, and may hallucinate parameters not defined by your
  function schema. **Validate the arguments in your code before calling your function.**"*
  (`openai/openai-openapi`, `openapi.yaml` → `ChatCompletionMessageToolCall`). That is a
  documented receipt for the malformed-fragment risk in §7.
- OpenRouter's chat-completions SSE frames are `object: chat.completion.chunk` with
  `choices[].delta` (openrouter.ai `openapi.yaml`, streaming response example).

**Not verified — say so out loud.** I could not source, for the **chat-completions** API:

- the `index` field inside a streaming `delta.tool_calls[]` element, or
- a normative statement of how fragments are keyed and reassembled, or
- any guidance at all on parsing incomplete/partial JSON for streamed structured output.

Context7 repeatedly returned the **Responses API** instead — `response.function_call_arguments.delta`
with `item_id` / `output_index` / `sequence_number` / `delta` (both OpenAI's OpenAPI spec and
OpenRouter's agent SDK docs). That is a *different API surface* from the one NeuralNote speaks.
The docs do not contradict the brief's `index`-keyed model; they simply do not cover it.

**So the accumulation contract is an unverified assumption, and Phase 3 must not be planned as
if it were settled.** Phase 3.0 is a spike that captures a real OpenRouter SSE transcript of a
multi-tool-call turn and writes the observed shape down as a fixture. Everything downstream is
derived from that fixture, not from this document.

There is a second option worth putting in front of Tom, because it might make the whole risk
go away — see open question **Q1** (§8): OpenRouter also exposes the Responses API at
`/api/v1/responses`, whose streaming contract for function-call argument deltas **is**
documented and typed. Moving the tool turn to that surface would trade "reverse-engineer an
undocumented accumulation rule" for "adopt a second, documented wire protocol."

### 0.3 Smaller corrections, all verified

| Claim | Verdict |
|---|---|
| `ToolOutcome` at `ai/tools.rs:53-79`, 5 variants | **Confirmed.** `Listed \| Action \| Rejected` explicitly no-op at `orchestrator.rs:814-816`. |
| 13 tools at `ai/tools.rs:27-39`; only four silent | **Confirmed.** `list_notes`, `list_folders`, `fetch_video_info`, `fetch_captions`. |
| `WriteOutcome::Existing` emits nothing | **Confirmed** — `skill_tools.rs:254-260` records the playlist write and returns, with no `ChatEvent`. An atomic-note collision is invisible to the UI. Fixed in Phase 2. |
| `reduceAssistant` totality enforced by return type + `strict`, not `assertNever` | **Confirmed** (`chatMessage.ts:227-232`). |
| No scroll management anywhere in the pane | **Confirmed.** `ChatPane.tsx:171` is a bare `<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">` with no ref. |
| **The 500-line guardrail** | **Not enforced anywhere.** No `max-lines` in `app/desktop/.oxlintrc.json`; nothing in `AGENTS.md`, `docs/`, or `sonar-project.properties`. `orchestrator.rs` is 4169 lines and `ChatPane.test.tsx` is 1595. It is a convention with no failing check — so it is a note, not a gate. §6 proposes making it real. |

---

## 1. The design

### 1.1 Target information architecture

Variant A's thesis: **chronology lives in the transcript.** One assistant turn renders, top to
bottom, in the 440px pane:

```
┌─ user bubble (right-aligned) ────────────────────────────────┐
│                                                              │
├─ PROCESS SECTION ────────────────────────────────────────────┤
│  ▸ [fold head, sits ON the rail]                             │
│      live:    ⟳ Searching your vault · 4 steps               │
│      settled: 8 tools · 2 searches · 3 read · 2 written +39   │
│               · 1 failed · 1 dropped                         │
│                                                              │
│  │  ⌁ Thought for 18.4s                    (collapsed)       │
│  │  ⌕ Searched notes  "spaced repetition" · 12 spans          │
│  │  ▤ Read  Zettelkasten/Retrieval.md:12–28                   │
│  │  ⚿ Permission to write to your vault    [Approve] [Deny]   │
│  │  ✎ Zettelkasten/Spaced repetition.md  create  +38          │
│  │     ┌── live diff, tailing, top-faded ──┐                  │
│  │  ⛨ Verifying citations                                    │
│  │  ⚠ Dropped a citation — quote not found in source          │
│  (one hairline rail runs the whole column)                   │
├─ ANSWER (prose + [e1] cite chips) ───────────────────────────┤
├─ SOURCES (dropped-citation banner never folds) ──────────────┤
├─ usage footer: 24.1s · 8,412 in / 611 out · claude-sonnet-4-5 │
└──────────────────────────────────────────────────────────────┘
```

Three behaviours carry it, all taken from the prototype and all worth preserving:

1. **One rail, not a list.** Node state (running / awaiting you / done / failed / denied) reads
   from the glyph alone, before any text.
2. **The whole process folds the moment the answer starts.** `processOpen = override ?? !answering`.
   A 24-second trace must never push the answer off screen.
3. **A write tool and its note edit are one act.** The `write_note` tool node stands down once
   its edit card exists; rendering both is debug output.

**Annotation 1 (keep — "I like the preview that it shows when making the changes")** is the
note-edit card with a live, tailing diff. That is Phase 3.

**Annotation 2 (idea — "we want the pane to scroll with the process")** is scroll-follow. That
is Phase 1, and it needs no backend at all.

### 1.2 What each new `ChatEvent` carries

Today: 17 variants (`ai/events.rs:51-114`), serde `tag = "type"`, `rename_all = "camelCase"`,
`rename_all_fields = "camelCase"`, `#[ts(export)]`. Every proposal below keeps that convention
and lands in `events.rs`. Adding a variant is a compile error in `reduceAssistant` until
handled, so nothing can be silently dropped — that property is the reason to add variants
rather than widen existing ones.

**Phase 2 — tool identity and honest structure (no transport change).**

```rust
/// How a dispatched tool call settled. Mirrors `ToolOutcome`'s discriminant but is
/// the UI-facing vocabulary: `Rejected` (bad args/path, the orchestrator refused)
/// and `Denied` (the user refused) are different stories and must render differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolStatus { Ok, Error, Denied, Rejected }

pub enum ChatEvent {
    // … the existing 17 …

    /// The model requested a tool call. Emitted BEFORE dispatch, so a call that is
    /// rejected, denied, or fails still appears on the timeline rather than vanishing.
    ToolCall {
        /// The provider's call id — the correlation key for every later event.
        id: String,
        /// The registered tool name (one of the `TOOL_*` constants in `ai/tools.rs`).
        name: String,
        /// A human label from a Rust-side table keyed on `name`. NEVER model prose —
        /// that is the coupling this whole event exists to kill.
        title: String,
        /// The raw arguments JSON exactly as the model emitted it. The UI parses it
        /// defensively for the detail line; it is never trusted to be valid JSON.
        arguments: String,
    },

    /// The call settled. Exactly one per `ToolCall`, always emitted — including on
    /// cancel, so no node is left spinning forever.
    ToolResult {
        id: String,
        status: ToolStatus,
        /// A Rust-composed one-liner ("12 spans", "3 folders"), never model prose.
        summary: Option<String>,
        /// Bounded result or error text for the disclosure. Truncated Rust-side.
        detail: Option<String>,
    },

    /// A skill the user asked for could not be activated. Replaces the exact-string
    /// match at `ChatSkillChrome.tsx:16-29`. `missing_binary` is the ONLY structured
    /// remedy the UI offers, so it is the only structured field (YAGNI).
    SkillActivationFailed {
        id: String,
        name: String,
        /// The human sentence, for display only — no longer load-bearing.
        message: String,
        missing_binary: Option<String>,
    },

    /// How a transcript was actually obtained, reported by the tool that obtained it.
    /// Replaces the `captions:|whisper:` regex over model prose at `chatMessage.ts:113-122`.
    TranscriptSource { label: String, rel_path: Option<String> },

    /// The run ended having completed only part of its work. Replaces the
    /// `cancelled|stopped|partial` regex over model prose at `chatMessage.ts:124-137`.
    /// The orchestrator knows this authoritatively (`run_cancelled()`, budget guards).
    PartialRun { reason: String },

    /// A create-only write hit an existing note and wrote nothing. Today this is
    /// invisible (`skill_tools.rs:254-260` emits nothing) — a silent no-op, which the
    /// project's "failures are never silent" invariant forbids.
    NoteExists { rel_path: String, kind: NoteKind },
}
```

**Phase 3 — live write preview.**

```rust
    /// A best-effort, partially-parsed view of an in-flight write. Rust owns the
    /// partial-JSON parse and emits a SEMANTIC preview; the UI never sees half a
    /// JSON blob and never has to know the body arrived inside an escaped string.
    NoteEditPreview {
        /// The `ToolCall` id, so the card upgrades in place into `NoteWritten`.
        id: String,
        rel_path: Option<String>,
        kind: Option<NoteKind>,
        /// The note body composed SO FAR, already un-escaped.
        body: String,
        /// The arguments JSON has closed and parses. The write has NOT happened yet.
        complete: bool,
    },

    /// The preview is abandoned: the model never finished the call, the run was
    /// cancelled, or the arguments never became valid JSON. The UI must clear the
    /// preview and say so — a half-written diff must never be left looking committed.
    NoteEditAbandoned { id: String, reason: String },
```

**Deliberately rejected:** a raw `ToolArgsDelta { id, delta }` event. Raw fragments have no
consumer — the UI cannot render half a JSON escape sequence, and shipping them would put a
second JSON parser in TypeScript. One parser, in Rust, tested in Rust.

**Phase 4 — approval gate.** Variants are the `system-architect`'s deliverable (§9). The
baseline shape this plan assumes, pending that design:

```rust
    /// A gated tool call is paused, awaiting the user. `subject` is the STRUCTURED
    /// approval subject — never free prose, never ingested content.
    ToolApprovalRequested { id: String, subject: ApprovalSubject, auto_eligible: bool },
    /// Resolved, by whom, and why. `Classifier` verdicts are labelled as such so the
    /// user can always see when a machine decided on their behalf.
    ToolApprovalResolved { id: String, decision: ApprovalDecision, by: ApprovalActor },
```

**Phase 5 — plan declaration and usage.**

```rust
    /// The model declared its intended steps before acting.
    Plan { steps: Vec<PlanStep> },                     // PlanStep { id, label }
    PlanStepStatus { id: String, status: StepStatus }, // Pending|Running|Done|Skipped|Failed

    /// What the turn cost. Emitted once, immediately before `Done`. Token counts are
    /// optional because the local (Ollama) path may not report them — an absent count
    /// renders as absent, never as zero.
    Usage { elapsed_ms: u64, tokens_in: Option<u32>, tokens_out: Option<u32>, model: String },
```

Note that `openai.rs:498-503` shows the provider's usage frame already arriving and being
skipped as an empty-content delta. Whether OpenRouter needs `usage: { include: true }` in the
request body to populate it on the streaming path is **unverified** — Phase 5 spikes it.

### 1.3 Design tokens

`neuralnote-design` locks the palette: no new colours, no raw hex, no ad-hoc oklch. The rail,
glyph tones, and diff card must resolve to existing tokens.

**Verified against `app/desktop/src/styles.css` and `components/ui/badge.tsx`** — every token
the prototype leaned on already exists, so the rail needs no new palette entry:

| Prototype used | Exists as |
|---|---|
| `text-warning` (awaiting-you glyph, approval card) | `--warning` `styles.css:84`, exposed `styles.css:33` |
| `text-healthy` (added diff lines, "Written") | `--healthy` `styles.css:75`, exposed `styles.css:24` |
| `bg-surface-sunken` (diff body, code blocks) | `--surface-sunken` `styles.css:97` |
| `bg-surface-raised` (status pill) | `--surface-raised` `styles.css:98` |
| `.nn-compact-label` (section labels) | `styles.css:1155` |
| `Badge tone="ai\|warning\|danger\|neutral"` | all four, `badge.tsx:10-15` (plus `healthy`) |

The one genuinely new visual is the **rail hairline**. The prototype found that `--border`
(low white-opacity) disappears at 1px on this ground and borrowed `bg-muted-foreground/25`
instead. That is still a theme token, so it is in bounds — but it is a deliberate exception to
the "hairlines are `--border`" convention and should be reviewed as such, not copied silently.

---

## 2. Phases

Each phase is independently shippable and clears the
[Definition of Done](../docs/definition-of-done.md) baseline on its own. Phases 3 and 4 are
**independent of each other** — both depend only on Phase 2. If Phase 3's spike goes badly,
Phase 4 still delivers most of the safety value, and they can swap. Phase 6 depends on the
timeline existing (Phase 2) but on nothing after it, so it can slot anywhere from Phase 3
onwards if the layout work becomes more valuable than the next backend phase.

### Phase 1 — Scroll-follow and jump-to-latest (frontend only, no backend)

**Why first.** It fixes a live defect in the shipping app, it needs nothing from Rust, it
answers annotation 2 directly, and it is the one piece of this work that can land tomorrow.

**Scope.**

- A `useStickyScroll` hook on the transcript container (`ChatPane.tsx:171`, which gets a ref).
  Behaviour: pinned to the bottom while the user has not scrolled away; **released the moment
  the user scrolls up**; re-pinned on "jump to latest", on send, and on a new turn.
- A jump-to-latest affordance that appears only when released and content has grown below the
  fold — quiet, bottom-right, inside the transcript, on theme tokens.
- Correct behaviour under three things the pane does today and will do more of: content
  appended *above* the viewport (a tool node opening mid-scroll), a `<details>` the user
  expands (must not yank the view), and `prefers-reduced-motion` (no smooth scroll).
- Delete `app/desktop/src/prototype-chat/`, `app/desktop/public/prototype-shell.js`, the
  `?proto=chat` guard in `App.tsx`, and `.prototype/` — the verdict is now folded in here.
  (Note: `sonar.exclusions` has `prototype/**`, which does **not** match
  `app/desktop/src/prototype-chat/**`, so the prototype is currently inside Sonar's scope.
  Deleting it resolves that; no config change needed.)
- Split `ChatPane.test.tsx` (1595 lines) by concern while it is still cheap — see §6.
- **Make the 500-line guardrail a real check** — add `eslint/max-lines` to `.oxlintrc.json` and
  bring the offenders under it. My call, per §6. It has to happen in Phase 1 or not at all:
  every later phase adds to exactly the files that are already over.

**Ownership.** `ui-designer`, end to end, briefed "presentation only — no backend, no IPC, no
Rust." Scroll-follow is *geometric* behaviour, verifiable only in a real layout engine, which
puts it squarely in the presentational lane even though `useStickyScroll.ts` is a `.ts` file.
No `coder` dispatch in this phase.

**Definition of done (Phase 1).** Baseline, plus one clause that is not optional here:

- **Browser-tier test is MANDATORY.** jsdom has no layout engine — `scrollHeight`,
  `scrollTop`, and `getBoundingClientRect()` are all meaningless there, so a jsdom suite can be
  fully green while the pane never scrolls. New `ChatPaneScroll.browser.test.tsx`; run
  `npm --prefix app/desktop run test:browser` **and** `npm --prefix app/desktop run typecheck:browser`.
- The remaining baseline: `lint`, `typecheck`, `test:run`, ≥90% coverage on changed lines, and
  hand-verification in `npm --prefix app/desktop run tauri dev` against a long transcript.
- The DoD's WKWebView caveat applies and must be honoured: Chromium is not WKWebView. Scroll
  anchoring behaviour differs between engines, so this phase also needs a **hands-on check in a
  real build** (`target/dev-builds/NeuralNote-Dev.app`), not just a green browser suite.

### Phase 2 — Tool-call fidelity on the wire (Rust + frontend)

**Why second.** It gives the rail something real to render with **zero transport risk**, and it
kills three prose-scraping couplings that are latent bugs today.

**Scope.**

- Emit `ToolCall` before dispatch and `ToolResult` after, from `handle_tool_call`
  (`orchestrator.rs:745-818`). The four currently-silent tools (`list_notes`, `list_folders`,
  `fetch_video_info`, `fetch_captions`) stop being invisible; so do `Rejected` calls.
- A Rust-side `name → title` table so the UI never composes a tool label and never matches one.
- `SkillActivationFailed`, `TranscriptSource`, `PartialRun`, `NoteExists` — the four structural
  replacements from §1.2. Delete `ACTIVATION_FAILURE_MARK` / `MISSING_YTDLP_STEP`
  (`ChatSkillChrome.tsx:16-29`), `modelReportedProvenance`'s regex (`chatMessage.ts:113-122`),
  and `isPartialSkillRun`'s regex (`chatMessage.ts:124-137`).
- Frontend: the timeline rail, fold-head with live-phase and settled-summary lines, tool nodes
  with status glyph / detail line / disclosure, and the existing thinking, verify, and
  citation-dropped nodes rehoused onto the rail. **Thinking renders as markdown** in this phase
  (today it is one flat string in a closed `<details>`, `ChatTurnNotices.tsx:22-35`).

**Ownership — this phase crosses both lanes.** See §3 for the freeze rule.

| Owner | Files |
|---|---|
| `coder` | `ai/events.rs`, `ai/orchestrator.rs`, `ai/tools.rs`, `ai/skill_tools.rs`, regenerated `src/lib/bindings/`, `workspace/chatMessage.ts` + the new reducer module, `workspace/chatDiff.ts` |
| `ui-designer` | `ChatTimeline.tsx`, `ChatTimelineNodes.tsx`, `ChatSkillChrome.tsx`, `ChatTurnNotices.tsx`, `ChatMessages.tsx` |

**Definition of done (Phase 2).** Baseline, plus:

- Rust wire-shape contract tests in `events.rs`'s `mod tests` for every new variant (the
  existing `tags_events_by_type_in_camel_case` / `renames_fields_to_camel_case` pattern).
- Orchestrator integration tests in `crates/neuralnote-core/tests/skill_orchestrator.rs` and
  `tool_skills.rs` asserting one `ToolResult` per `ToolCall` **on every path** — success,
  error, rejection, and cancellation. A spinning node is a silent failure.
- `bash scripts/rust-quality-gate.sh` prints **GREEN**; bindings drift is a hard gate
  (`rust-quality-gate.sh:52-67`), so regenerate with
  `npm --prefix app/desktop run gen:bindings` in the same commit as the Rust change.
- An **e2e journey** in `src/e2e/chat.e2e.test.tsx` driving a turn that runs a tool, has one
  rejected, and one failing — asserting all three appear. Component tests `vi.mock` the whole
  api module, so only the `src/e2e` mockVault seam proves the events actually cross IPC.
- Coverage ≥90% on changed lines, both languages.

### Phase 3 — Streaming tool turn + live write preview (Rust-heavy)

**Why third, and why it opens with a spike.** §0.1 and §0.2. The transport does not exist and
the accumulation contract is unsourced. Everything here is derived from a real transcript, not
from a doc I could not find.

**Phase 3.0 — the spike (throwaway, half a day, gate on it).**

One question: *what exactly does OpenRouter emit, frame by frame, when a model issues one or
more tool calls on a streamed chat-completions request?* Capture the raw SSE bytes of a real
turn (two concurrent tool calls, one with a large `content` argument) to a fixture file, and
answer: is there an `index`? Is `id` sent once or repeated? Is `function.name` sent once? Do
`arguments` fragments ever split a `\uXXXX` escape or a surrogate pair? Does the local Ollama
endpoint stream tool calls at all?

**If the answer is "no usable accumulation key," stop and escalate** — do not guess. The
fallback is Q1 (§8): the Responses API, whose contract is documented.

**Phase 3.1-3.3 — the build, gated on the spike.**

- New `LlmClient::complete_tool_streaming(&self, req, sink) -> CoreResult<Completion>`, with a
  **default implementation that delegates to `complete`** so the local client, the shell
  client, and both test doubles keep compiling and simply have no preview. Honest degradation,
  and the UI must say "no live preview on this provider" rather than sit blank.
- `tool_calls` added to `StreamDelta`; an accumulator in a new `ai/tool_stream.rs`.
- Partial-JSON parsing in Rust: incrementally extract `rel_path`, `kind`, and the in-progress
  `content` string from an unterminated arguments blob, un-escaping as it goes. Emits
  `NoteEditPreview` only for tools on a **previewable allowlist** (today: `write_note`) — never
  for arbitrary tools, because arbitrary arguments are not safe to render.
- Retry semantics, stated explicitly: **a streamed tool turn is never retried after its first
  emitted event.** The existing single-retry safety argument (`orchestrator.rs:696-703`) rests
  on nothing having been emitted; that no longer holds. Retry only pre-first-byte.
- Frontend: the note-edit card — tailing diff, top-fade mask, `+N` running count, `Undo` on
  settle. **Throttle the diff recompute** (see risk R7).

**Ownership.** `coder` owns everything Rust and `chatDiff.ts`; `ui-designer` owns
`ChatNoteEditCard.tsx`. Crosses both lanes.

**Definition of done (Phase 3).** Baseline, plus:

- Unit tests over the accumulator driven by the **captured fixture**, plus an adversarial
  corpus: fragment boundaries inside a string, inside an escape, inside a surrogate pair; a
  call abandoned mid-arguments; arguments arriving in one chunk; two interleaved calls;
  arguments that never become valid JSON.
- A test that `NoteEditAbandoned` fires on cancel mid-preview and the card clears.
- A test that the preview `body` and the eventual written file **agree** — a preview that
  diverges from what landed on disk is the same class of failure as a wrong citation.
- An e2e journey covering write-with-preview end to end.
- Hands-on run against a disposable copy of the note test vault
  (`node scripts/prepare-note-test-vault.mjs`), per the DoD's note-facing clause.

### Phase 4 — Tool approval gate with modes (Rust-heavy, **security-adjacent**)

**Scope.** "Ask me" (explicit approval per gated call) and "Approve for me" (anything the judge
does not clear falls through to "ask me"). A Settings toggle following the existing `reasoning`
precedent exactly: a field on `ProviderConfig` (`ai/provider_config.rs:49`) using its
`#[serde(default)]` tolerant-read pattern, a `set_*` Tauri command alongside `set_reasoning`
(`commands/ai.rs:362`), and surfacing on `aiStatus`.

The full design is in **§9**. Three things it changes about this phase's size before anyone is
dispatched:

- **The pause machine already exists** (`UserPrompt::ask` → `PendingElicitations`). Reuse the
  mechanics, separate the types. Do not build a second one — and mind the polarity inversion at
  §9.1.5, which is a real bug if the elicitation resolver is copy-pasted.
- **The gated set is seven tools, not "write_note and friends"** (§9.1.2). Two of the three
  additions do not look dangerous, which is the point.
- **`create/append/overwrite/delete` models a surface that does not exist.** `write_note` is
  create-only (§9.1.1). Ship one operation and make adding another a compile error.

**Unblocked.** Q6 is ruled: **the LLM classifier enforces** (§9.4). That adds three pieces of
work this phase must carry, none of which the shadow-mode design would have needed:

- The `checking` timeline node and its resolution states, with a 3s budget that fails closed to
  asking (§9.5.1). This is the one part of Phase 4 that lands in `ui-designer`'s lane.
- The local-lane guard, enforced in **Rust** and surfaced visibly in Settings (§9.5.2).
- The within-run verdict cache, with the denial-invalidates rule (§9.5.3).

Plus the global mode and per-tool overrides from §9.6, and the audit log from Q8.

**Non-negotiables, restated here so they cannot be lost in a handoff:**

1. Classify on the **structured** tool call only — name, canonicalised vault-relative path,
   operation kind, byte count, target existence, vault-escape check. Never on free prose, model
   rationale, or ingested source content.
2. **Within `ApproveForMe`**, irreversible operations stay on an **unconditional-approval list**
   the classifier cannot override. This is a hard floor *inside that mode*, not a global
   invariant — `Yolo` deliberately has no such floor (§9.6.1). What `Yolo` does **not** remove
   is validation, path confinement, or budgets (§9.6.2).
3. **Fail closed.** Classifier error, timeout, unparseable verdict, or provider unavailability
   all mean "ask the user."
4. State the residual risk honestly in the spec and in the UI copy. The fields being classified
   are themselves partly model-authored; this design **bounds** prompt injection, it does not
   eliminate it.

**Definition of done (Phase 4).** Baseline, plus **DoD §2 in full**:

- **Independent adversarial review is required** by a reviewer who did not implement the
  control. Green tests and a green Sonar gate are explicitly not sign-off here. The DoD cites
  the precedent: a YAML alias-bomb guard in this repo passed its full suite and a green gate,
  then was bypassed twice in review.
- An adversarial corpus checked into the repo, in six groups: **(A)** injection through ingested
  content — the assertion in every case is that **the judge's input JSON is byte-identical** to
  the same call built from a benign transcript, *not* "the classifier said ask", which is a
  model-dependent flake dressed as a security test; **(B)** subject-construction bypasses,
  including a parent folder symlinked outside the vault and swapped between probe and write, to
  prove the gate did not quietly become the confinement layer; **(C)** verdict parsing (fenced
  JSON, prose preamble, `"ALLOW"`, two objects, extra fields, empty body, a stream that never
  terminates); **(D)** state-machine races, including the §9.1.5 polarity test and a decision
  belonging to a different run; **(E)** policy erosion (adding a `GatedTool` variant must fail
  to compile; a legacy config must read as `AlwaysAsk`; retry-after-denial must hard-reject);
  **(F)** wire-contract integrity (`ask_user` emits `elicit`, never `toolApprovalRequested`).
- A test that a judge timeout results in a **user prompt**, not an allow.
- A spy judge with a call counter asserting `calls() == 0` for every ineligible subject — the
  claim is that it is unreachable, not that its answer got overridden.
- **The migration test**, named and non-negotiable: a pre-feature `ai-config.json` loads as
  `AlwaysAsk` with no overrides. Getting this backwards silently grants unattended vault writes
  to every existing install, which is the single worst outcome available in this phase.
- A test that the local-lane guard lives in **Rust** and refuses to reach the classifier, not
  just that the Settings radio renders disabled.
- A test that a **denial invalidates a cached allow** for the same subject within a run.
- A test that a **per-tool override cannot be more permissive** than the global mode, across all
  nine global-by-override combinations.
- **YOLO tested where it matters most**, or the mode is untested exactly where it counts:
  - an irreversible operation under `Yolo` **does not prompt and does run**;
  - the same operation **still renders a node and still offers Undo** (§9.6.3) — this is the
    compensating control, so it needs a test, not a comment;
  - confinement, hard-deny, and the write budget **still reject** under `Yolo` (§9.6.2), which
    is the clause most likely to be "simplified" away later;
  - `Yolo` is **not** downgraded on the local lane.
- **The reversibility classification is enforced, not documented** (§9.3, §9.6.6):
  - `Reversibility` has **no `Default` impl** and `reversibility()` has **no wildcard arm**, so
    adding a `GatedTool` variant fails to compile until someone classifies it. Verify by adding
    a throwaway variant locally and confirming E0004 — a compile-time guard nobody has watched
    fail is a guard nobody knows works.
  - The `ALL_GATED_TOOLS` const assertion holds, so the array cannot drift from the enum and
    quietly drop a tool out of the generated warning.
  - **The golden test on the generated irreversible-tools sentence**, which is the check that
    converts a silent safety regression into a red suite. Its brittleness is the feature. Do not
    "fix" it by asserting the sentence is non-empty, and do not assert it equals the derived
    list — both pass forever and prove nothing (§9.6.5).
  - The four proposed `Irreversible` classifications confirmed against real call sites,
    `resolve_distil_route`'s persistence path especially (§9.7).
- An e2e journey for all three modes, including deny → the write does not happen.
- UI copy reviewed: the user must always be able to see when a machine approved on their behalf,
  and the YOLO entry confirmation must name what it disables in plain language (§9.6.5).

### Phase 5 — Plan declaration and usage stats (smallest, deliberately last)

**Scope.** `Plan` / `PlanStepStatus` (the model declares intended steps before acting; nodes
gain a step affiliation) and `Usage` (elapsed, tokens, model — the footer the prototype shows).

Last on purpose: it is the only part of Variant A that **degrades gracefully to nothing**. A
model that declines to declare a plan just produces a rail without step grouping. Nothing else
depends on it, so if appetite runs out here, the feature is still whole.

**Spike inside the phase:** confirm whether OpenRouter populates usage on the streaming path
without `usage: { include: true }`. Unverified (§1.2).

**Definition of done (Phase 5).** Baseline. Usage numbers must render as *absent* when the
provider does not report them — never as `0`, which would read as a real measurement.
This matters beyond cosmetics: spec §4 makes token cost a first-class v1 concern.

### Phase 6 — Expand-to-wide (workspace layout, not just the pane)

**Ruled in scope 2026-08-10**, after the timeline lands. The prototype's `Maximize2` toggle
widens the pane and lays tool arguments and results side by side, which is where a 440px trace
stops being cramped. It is last because it is the only phase whose blast radius leaves the chat
pane.

**Scope.** A toggle in the pane header that widens the chat slot to an expanded width, persisted
across sessions, with the tool disclosure switching to a two-column layout at that width
(arguments left, result right).

> **Correction, 2026-08-11.** This bullet originally also required the **note-edit diff** to go
> two-column. It cannot, and the reason is upstream: `write_note` is **create-only**
> (`ai/write_policy.rs:72,307`; a collision returns `Existing` or writes to a suffixed name,
> `ai/events.rs:184`). There is no baseline on the wire, so there is no diff — the card's own
> comment already says the body is "a tail, not a diff". Its only genuine pair is
> body-beside-refusal-reason, and in the refused state the body is folded shut by default, so that
> column would appear only after a user expanded a settled failure. Building it would have meant
> fabricating a baseline the backend does not produce. The two-column layout went where there are
> genuinely two things.

**The three things it collides with, all verified.**

1. **The layout hook's measurement loop** (`useWorkspaceLayout.ts:96-133`). A `ResizeObserver`
   measures `.nn-chat-slot` and `.nn-chat-pane`, feeds `reservedChatWidth`, and that drives
   **navigation compaction** through `deriveEffectiveWorkspaceLayout`. So expanding the chat
   pane will collapse the left ribbon. That is probably the behaviour you want, but it is a
   consequence, not a coincidence, and it must be an explicit decision with a test rather than
   something discovered on the first run. The hook already reads intermediate animation frames
   deliberately (`useWorkspaceLayout.ts:110-113`), so the expand transition feeds compaction
   frame by frame and must not fight it.
2. **The width token** (`styles.css:111`): `--chat-width: clamp(26.25rem, 28vw, 30rem)`, with
   **three responsive overrides** at `styles.css:1145`, `:1151`, and `:1162` narrowing it to
   `25.5rem`, `20.5rem`, and `18rem`. An expanded width must be defined as a second token that
   respects those same breakpoints, or a narrow window gets a chat pane wider than the editor.
   Add `--chat-width-expanded` beside them and override it at every breakpoint that overrides
   the base. Missing one breakpoint is the likely bug here.
3. **Persisted layout state** (`workspaceLayout.ts`). `WorkspaceLayoutState` is
   `{ navigationExpanded, sidebarWidth, sidebarPanel }`, stored under
   `nn:workspace-layout:v2` with a `v1` legacy migration already in place. **Add
   `chatExpanded: boolean` to that object; do not invent a second persistence mechanism.**
   Follow the existing tolerant-read path so a `v2` payload without the field loads as `false`
   rather than resetting the whole object to `DEFAULT_WORKSPACE_LAYOUT` — the loader currently
   falls back wholesale on a shape mismatch (`workspaceLayout.ts:89-114`), so a careless read
   would silently wipe the user's sidebar width. **No `v3` bump needed** if the read is
   tolerant, and not bumping is the better outcome.

**What it does not collide with:** `PaneSplitter.tsx` drives `sidebarWidth` only. The chat pane
is not drag-resizable today, so the toggle has no interaction with a dragged width. Worth
re-checking before dispatch rather than trusting this line.

**Ownership.** `ui-designer` owns the header toggle, the two-column layouts, and the CSS tokens.
The layout-hook and persistence changes are logic and belong to `coder`. This phase crosses both
lanes, and C3 (accessible names) applies to the toggle.

**Definition of done (Phase 6).** Baseline, plus:

- **Browser-tier test required** — this is geometric by definition. Assert the pane reaches the
  expanded width, that the navigation compacts, and that the transition settles rather than
  oscillating (an expand that changes the measurement that drives compaction that changes the
  available width is a feedback loop, and a loop is exactly what the browser tier can catch and
  jsdom cannot).
- A test at the narrowest breakpoint asserting the expanded pane still leaves the editor usable.
- A persistence test: expand, reload, still expanded; and a `v2` payload with no `chatExpanded`
  loads with the user's `sidebarWidth` **intact**.
- Hands-on check in a real build, since this is WKWebView-sensitive layout.

---

## 3. Ownership, and the contracts that must be frozen before any parallel dispatch

Agents editing **disjoint files** can still collide on the same **contract**. Every phase that
crosses lanes has at least one. These must be written into the briefs verbatim and, where
noted, landed as their own commit before the second agent starts.

| # | Contract | Who shares it | Freeze rule |
|---|---|---|---|
| C1 | **The `ChatEvent` wire shape** — exact variant names and field names | `coder` (Rust + generated bindings) ↔ `ui-designer` (renderers) | **Sequential, not parallel.** `coder` lands the Rust variants **plus** regenerated `src/lib/bindings/` as its own commit; `ui-designer` starts only against the committed bindings. Both would compile in isolation against different field names and only break on integration. |
| C2 | **The `AssistantMessage` view-model shape** (`chatMessage.ts`) | `coder` owns the reducer; `ui-designer` consumes | The added field names and types go in **both** briefs, verbatim. |
| C3 | **Accessible names and roles** the tests select on | Phase 1's browser test, Phase 2's e2e journey, and both agents' component tests | Freeze the `aria-label` strings (`"What the assistant did"`, `"Cited sources"`, the jump-to-latest label) in the brief. A positional selector re-anchors onto the wrong element when a sibling is added — select on role + accessible name, never `nth-child`. |
| C4 | **Tauri command names and payloads** (Phase 4's approval resolve) | `coder` (Rust command) ↔ `coder`/`ui-designer` (the `api.ts` wrapper and its callers) | Component tests `vi.mock` the whole api module, so a **wrong command name passes them**. The command's exchange (`{ command, arguments, result }`) goes into `src/e2e/fixtures/mock-ipc-contract-v1.json` — typed by `MockIpcExchangeV1` in `src/e2e/mockIpcContract.ts` — in the **same commit** as the Rust command, and every new command needs an e2e journey. |
| C5 | **Design tokens** | `ui-designer` only, but `coder` must not invent status strings that imply a colour | Verify the tokens in §1.3 against `styles.css` **before** the phase starts. Missing token ⇒ discuss adding one, never inline a colour. |
| C6 | **The captured SSE fixture** (Phase 3) | the spike ↔ every downstream accumulator test | The fixture file is the single source of truth for the wire shape. No test may hand-write its own idea of a tool-call frame — a hand-written predicate tests your mental model, not the wire. |

**Where the work happens:** every phase runs on its own branch in a worktree, never on `main`.
Branch names, the worktree setup runbook (including the gitignored sidecars that a fresh
worktree silently lacks), the two parallel-dispatch hazards that a frozen contract does **not**
protect against, and the merge gate are all in **§10**. Read §10.6 before any wave below that
dispatches two agents at once — this section freezes the shared *contracts*, §10.6 freezes the
shared *working tree*, and they fail in different ways.

**Practical dispatch shape per phase:**

- Phase 1 — one `ui-designer`. No parallelism, no contract risk.
- Phase 2 — `coder` first (C1, one commit), then `coder` and `ui-designer` in parallel.
- Phase 3 — spike (`coder`), gate, then `coder` on the transport with `ui-designer` on the card
  in parallel once C6 and C1 are frozen.
- Phase 4 — `coder` only, then a **separate** reviewer for the adversarial pass. The reviewer
  must not be the implementer.
- Phase 5 — `coder` first (C1), then `ui-designer`.
- Phase 6 — `coder` on the layout hook and persistence first (the `chatExpanded` field and the
  compaction behaviour are the contract), then `ui-designer` on the toggle, the width tokens, and
  the two-column layouts.

**Routing-guard note.** The `ui-routing-guard.py` PreToolUse hook reads the whole brief and
matches on nouns, including inside negations. A `coder` brief that names a `.tsx` file — even
as "do not touch" — trips it. Every `coder` brief here must scope itself "logic only — no
markup or CSS; presentational work belongs to `ui-designer`," and every `ui-designer` brief the
mirror image.

---

## 4. Test strategy

The repo has one trap that governs everything below: **component tests `vi.mock` the whole api
module.** A wrong Tauri command name, a renamed event field, a payload shape that Rust never
sends — all of it passes a component test. Only the `src/e2e` mockVault seam
(`mockVaultChatRuntime.ts`, `mockIpcContract.ts`) drives the app through its real IPC boundary.
So: **every new command and every new event needs an e2e journey**, not just a component test.

| Phase | Rust | Component (jsdom) | Browser tier | e2e (mockVault) |
|---|---|---|---|---|
| 1 | — | Jump-to-latest visibility state | **Required.** `ChatPaneScroll.browser.test.tsx`: pinned on new content; released on user scroll-up; re-pinned on jump; not yanked by expanding a `<details>`. jsdom cannot test any of this. | Existing chat journeys must stay green |
| 2 | `events.rs` wire-shape tests per variant; orchestrator integration asserting one `ToolResult` per `ToolCall` on **every** path | Rail node rendering per `ToolStatus`; reducer totality | Only if the rail's geometry is load-bearing (the spine's continuity across nodes probably is) | **New journey**: a turn with a successful, a rejected, and a failing tool call — all three visible |
| 3 | Accumulator over the **captured fixture** + adversarial fragment corpus; preview-body ≡ written-file agreement | Card states: writing / settled / abandoned / undone | Diff card at 440px: tailing, top-fade, no horizontal overflow | **New journey**: write-with-preview end to end, plus cancel-mid-preview |
| 4 | Fail-closed on error/timeout/malformed; **within `ApproveForMe`** the unconditional list cannot be overridden; **under `Yolo` an irreversible call does NOT prompt and DOES run**; under `Yolo` confinement/validation/budgets still reject; local-lane guard refuses to reach the classifier; `Yolo` unaffected on the local lane; cache invalidated by denial; `AlwaysAsk < ApproveForMe < Yolo` and `default() == AlwaysAsk`; `effective_mode` clamps across all nine combinations; `transcribe_audio` pinned even under `Yolo`; a pre-feature config loads as `AlwaysAsk`; **the golden test on the generated YOLO irreversible-tools sentence** (§9.6.5); the adversarial corpus | Approval card states; the `checking` node and its five resolutions; the `autoApproved` node rendering under `Yolo`; the standing YOLO indicator; **a snapshot of the assembled entry-confirmation paragraph**; Settings radios and the disabled-with-reason local state | — | **New journeys** for all three modes: deny ⇒ no write; `Yolo` ⇒ an irreversible write runs unprompted **and still appears on the timeline with Undo**; a per-tool `AlwaysAsk` override clawing back one tool under a `Yolo` global |
| 5 | `Usage` emitted exactly once before `Done`; absent tokens stay absent | Footer renders absent-vs-zero correctly | — | Existing journeys assert the footer |
| 6 | — | Toggle state and persistence round-trip | **Required.** Expanded width reached; navigation compacts; the transition settles rather than oscillating; the narrowest breakpoint still leaves the editor usable | Existing journeys stay green with the pane expanded |

**Scroll-follow currently has zero coverage anywhere** — no test in the repo asserts scroll
position. Phase 1's browser test is therefore net-new coverage of a live defect, which is
exactly the kind of test that is worth writing first.

**Coverage.** ≥90% on changed lines is the project target, enforced by
`bash scripts/rust-quality-gate.sh` (`cargo llvm-cov --fail-under-lines 90`, scoped to
`neuralnote-core`) and `npm --prefix app/desktop run coverage`.

---

## 5. What the backend cannot support, stated plainly

Three things the prototype shows that need saying out loud rather than planning around:

1. **"Watch it write the file" is not what happens.** The disk write is one `write_all` +
   `sync_all` (`note_writer.rs:954-959`) and is deliberately atomic. What streams is the
   **model composing the note**, before any write. The card must not imply a file is being
   progressively written; the prototype's copy ("Writing to your vault…") is misleading and
   should become something like "Composing…". This matters because a user who believes a
   partial file exists on disk will reason wrongly about cancelling.
2. **Undo is a whole-file operation, not a rollback of a stream.** There is no journal. Keep
   the prototype's Undo semantics (revert the note) and do not let the streaming preview imply
   finer granularity than exists.
3. **The local (Ollama) provider may not stream tool calls at all** — unverified, spiked in
   Phase 3.0. If it does not, the local path has no live preview, and the pane must say so
   rather than showing an empty card. The provider spec already treats local as a first-class
   path ([`ai-providers-slice.md`](ai-providers-slice.md)), so a silent capability gap is not
   acceptable.

---

## 6. The 500-line guardrail

**First, honestly: it is not enforced.** No `max-lines` rule in `app/desktop/.oxlintrc.json`,
nothing in `AGENTS.md`, `docs/`, or `sonar-project.properties`. `orchestrator.rs` is 4169 lines
and `ChatPane.test.tsx` is 1595. A convention with no failing check is a note, not a gate.

**Decision (mine, per Tom's 2026-08-10 instruction to settle it): make it real in Phase 1.**

Add to `app/desktop/.oxlintrc.json`:

```jsonc
"eslint/max-lines": ["error", { "max": 500, "skipBlankLines": true, "skipComments": true }],
```

Two carve-outs, both deliberate:

1. **Test files are exempt**, via an override on `**/*.test.ts` / `**/*.test.tsx`. This is the
   pragmatic call and it is worth defending rather than apologising for. A 500-line cap on
   production code forces *decomposition*, which is the thing worth having. The same cap on a
   test file forces *splitting a suite by line count*, which pushes related cases into
   arbitrarily-divided files and makes coverage of one unit harder to find, not easier. Test
   files should be split by **concern** when they get unwieldy — which Phase 1 does to
   `ChatPane.test.tsx` anyway — and that is a review judgment, not a line count.
2. **Rust is out of scope.** Oxlint does not lint Rust and this repo has no equivalent Rust
   check. `orchestrator.rs` at 4169 lines is a real problem, but a cap it violates by 8× is a
   permanently-red gate, and a permanently-red gate teaches everyone to ignore gates. The
   mitigation is the targeted extraction in the table below (`ai/approval.rs`,
   `ai/tool_stream.rs`), not a rule nothing can pass.

**Bringing the offenders under it is part of Phase 1.** Under the exemptions, the production
files currently over 500 lines are the ones the table below already splits, so the rule goes in
green rather than with a suppression list. If the sweep turns up a production file outside this
work that also breaches, split it or record a per-file `oxlint-disable` carrying a reason, in
the same documented style as the other disabled rules in that config. **A blanket ignore list
is not acceptable** — that just recreates the unenforced convention with extra steps.

The point of doing it now: every phase after this one adds to exactly the files that are already
near the limit. Retrofit later and the rule can never go in green.

**Files that must be split, and how:**

| File | Now | Projected | Split |
|---|---|---|---|
| `chatMessage.ts` | 453 | ~575 | `chatMessage.ts` (types + factory + selectors) / **`chatMessageReducer.ts`** (the switch). **Carry the `: AssistantMessage` return annotation with the function** — totality is enforced by that annotation plus `strict: true` (TS2366), not by an `assertNever`. Lose the annotation in the move and the safety net silently disappears. |
| `ChatActivityTrace.tsx` | 367 | ~620 | **`ChatTimeline.tsx`** (rail + fold head + summary line) / **`ChatTimelineNodes.tsx`** (thinking, tool, activity nodes) / **`ChatNoteEditCard.tsx`** (the diff card) / **`chatDiff.ts`** (the diff algorithm — logic, so `coder` owns it) |
| `ChatPane.test.tsx` | **1595** | ~1900 | Split in Phase 1: `ChatPane.test.tsx` (shell + provider states) / `ChatPaneTurn.test.tsx` (turn loop) / `ChatPaneScroll.browser.test.tsx` (new) |
| `ChatPane.tsx` | 234 | ~265 | Fine — extract `useStickyScroll.ts` and it stays comfortable |
| `useChatPaneChat.ts` | 146 | ~270 | Fine |
| `orchestrator.rs` | **4169** | ~4600 | The guardrail does not reach Rust here, but adding an approval state machine to a 4169-line file is bad regardless. Extract **`ai/approval.rs`** (gate + classifier, Phase 4) and **`ai/tool_stream.rs`** (streaming tool turn + accumulator, Phase 3) as new modules from the start. |
| `events.rs` | 299 | ~430 | Fine |

---

## 7. Risks, ranked

**R1 — The streaming tool-turn transport does not exist (verified, §0.1).** Phase 3 is a new
`LlmClient` method, a trait change across four implementers, new SSE parsing, and new retry
semantics. *Mitigation:* default trait implementation delegating to `complete`, so nothing
breaks and the feature degrades to today's behaviour. Spike first, gate on it.

**R2 — The accumulation contract is unsourced (verified, §0.2).** The `index`-keyed reassembly
rule for chat-completions streaming tool calls is not in any doc I could find. *Mitigation:*
Phase 3.0 captures a real transcript and makes it the fixture (C6). Escalate rather than guess.
Fallback: the Responses API (Q1).

**R3 — Malformed and pathological fragments.** Four concrete shapes, all of which must be in
the corpus:
- *Invalid JSON.* Doc-confirmed: *"the model does not always generate valid JSON, and may
  hallucinate parameters."* The preview must simply not render; the existing tool-error path
  already handles the dispatch side.
- *A fragment boundary inside an escape.* `"line one\` + `n line two"` — a naive accumulator
  emits a literal backslash. Worse: a `\uD83D` / `\uDE00` surrogate pair split across frames
  produces a lone surrogate, which is not valid UTF-8 and would panic or corrupt in Rust.
  Buffer at the escape boundary; never emit a partial escape sequence.
- *An abandoned call.* The model starts `write_note`, then the run is cancelled or the model
  changes course. `NoteEditAbandoned` exists precisely for this; without it a half-diff sits
  there looking committed.
- *Arguments in one chunk.* The preview flashes once and immediately settles. Must look
  intentional, not broken — likely a minimum-visible-duration on the card.

**R4 — Prompt injection into the approval judge.** Direct injection is *unreachable* once the
subject has no free-text field (§9.2) — but **shaping is not**. Whoever controls a transcript
controls what the model proposes, so the attack degrades to "shape a request the honest rules
approve," which defeats any auto-approval policy, LLM or table. *Mitigation:* the safety comes
from blast radius, not judgment — the worst allowed outcome is an undoable junk note (§9.3). If
a tool ever gains overwrite or delete, the eligible set goes to empty, enforced by a
no-wildcard match. DoD §2 adversarial review by a non-implementer is mandatory.

**R5 — Retry semantics change under streaming.** The current single retry is safe *because*
nothing has been emitted (`orchestrator.rs:696-703` says so explicitly). A streamed tool turn
breaks that argument. *Mitigation:* retry only before the first emitted event; document it at
the call site.

**R6 — Provider capability split.** Two code paths (streamed and non-streamed tool turns) is a
maintenance cost and a place for behaviour to diverge silently. *Mitigation:* one orchestrator
loop, one seam, capability detected once per run and surfaced in the UI.

**R7 — Diff recompute cost.** The prototype recomputes the whole diff in a `useMemo` keyed on
the full body — O(n) per fragment, O(n²) per write. Fine for a 40-line note, not for a 2000-line
transcript note, and this app writes transcript notes. *Mitigation:* coalesce fragments to an
animation frame and cap the rendered window (the card is already a fixed-height tailing view,
so only the tail needs rendering).

**R8 — Classifier cost and latency, now on the critical path.** Ruled in (§9.4), so these are
accepted costs rather than open risks — but two of them can still bite. **Cost:** every gated
call is an extra round-trip on the user's own key, and it scales with agent chattiness rather
than user actions, so a playlist distillation is the shape to watch. Spec §4: *"Never surprise
the user with a bill."* *Mitigation:* small model, capped output, within-run cache, measured
figure in the Settings copy (§9.5.3). **Latency:** with fail-closed and a flaky provider,
"approve for me" degrades into "ask me, 3 seconds later", which is *worse* than always-ask.
*Mitigation:* the two-failure circuit breaker downgrades the run and says so, rather than
repeating the pause on every call (§9.2).

**R11 — Non-reproducible security decisions.** A permanent property of the ruled design, not a
defect (§9.3). *Mitigation:* tests assert only the deterministic properties; the audit log (Q8)
becomes the sole way to reconstruct a past decision. The trap to avoid is a test that asserts
the model's verdict, which is a flake dressed as a security test.

**R9 — Scroll-follow behaves differently in WKWebView.** The browser tier runs Chromium; the
app ships WKWebView, and scroll anchoring is exactly the kind of thing that differs.
*Mitigation:* the DoD already requires a hands-on run; Phase 1 makes it explicit.

**R10 — Wire growth.** 17 variants becomes ~29. `reduceAssistant` grows by roughly the same
amount, which is why it splits (§6). The totality property is what keeps this safe, so
protecting the return-type annotation through the split is load-bearing, not cosmetic.

---

## 8. Open questions

**Q1 (blocking Phase 3 if the spike fails) — Responses API instead of chat completions?**
OpenRouter exposes `/api/v1/responses` with a *documented, typed* streaming contract for
function-call argument deltas (`response.function_call_arguments.delta`, carrying `item_id`,
`output_index`, `sequence_number`, `delta`). That is precisely the contract §0.2 could not find
for chat completions. Adopting it would trade "reverse-engineer an undocumented rule" for
"speak a second wire protocol" — and the local Ollama path speaks OpenAI-compatible chat
completions only, so it would mean two protocols, not one. **Decide only if the spike fails.**

**Q2 — Expand-to-wide mode?** ~~Open.~~ **Ruled: in scope, as its own Phase 6**, after the
timeline lands. Deliberately not folded into Phase 1, because it touches workspace layout rather
than the pane alone. Scope and the three things it collides with are in Phase 6.

**Q3 — Does the model reliably declare a plan?** Phase 5's `Plan` event requires the model to
declare intent before acting. Prompt-only; models vary. Worth a cheap probe before committing
to the UI, because a plan board that is usually empty is worse than no plan board.

**Q4 — What is a "gated" tool?** ~~Open.~~ **Answered by §9.1.2:** seven tools, and the
partition is not "mutating plus network." It also has to catch `use_skill` (widens the grant
set), `select_playlist_videos` (widens the write budget), and `resolve_distil_route` (persists
routing state) — the three that do not look dangerous. `transcribe_audio` gets its own bucket
because it spawns a host process.

**Q6 — should the "approve for me" judge be an LLM classifier or a deterministic rule table?**
~~Open.~~ **Ruled 2026-08-10: the LLM classifier enforces**, as originally specified in decision
2. Tom was shown the sub-design's table-enforces-plus-shadow-mode recommendation with the
latency, token-cost, reproducibility and local-lane arguments spelled out, and reaffirmed the
classifier. Built properly, with no hidden table fallback. See §9.4 for what that keeps and what
it changes, and §9.5 for the three consequences of putting it on the critical path.

**Q7 — one global approval mode, or per-capability?** ~~Open.~~ **Ruled: a global mode plus an
advanced per-tool override list**, covering all seven gated tools. Persisted shape, Settings
location, and migration are in §9.6. Two things worth reading there rather than assuming:
overrides can only be **more restrictive** than the global mode (§9.6.4), and the third mode is
**`Yolo`**, which approves everything including irreversible operations — deliberately, with the
name carrying the warning (§9.6.1). What YOLO does *not* disable is in §9.6.2, and it is the
clause most at risk of being refactored away.

**Q8 — audit trail?** Still open, and the classifier ruling makes it materially more valuable
than when I first raised it. A bounded append-only local log of
`(timestamp, tool, operation, rel_path, decision, rule, mode)`, never containing note content.
With a non-reproducible judge (§9.3), the log is **the only way to answer "why did it do
that?"** — the decision cannot be re-derived from its inputs. Recommend building it inside Phase
4 rather than deferring; it is small, and it is what makes the mode auditable at all.

**Q5 — Does the `TranscriptSource` replacement actually exist upstream?** `chatMessage.ts:113`
scrapes `captions:xx` / `whisper:...` labels out of **model prose**, and its own comment admits
they are "presentation hints, not verified source metadata." The structured replacement must
come from the *tool* — `fetch_captions` and `transcribe_audio` know what they actually did.
Phase 2 should confirm that seam exists before committing to the event; if the label is
genuinely only ever model-authored, the honest move is to delete the feature rather than dress
up a guess as structure.

---

## 9. Commissioned sub-design — the approval gate

`system-architect` delivered the full design (trust boundary, `ToolApprovalSubject`, the
unconditional list and its generating rule, classifier contract, paused-run state machine, wire
events, edge cases, adversarial corpus). Distilled here; the parts that change *this* plan are
first.

### 9.1 Five findings from source that change Phase 4's shape

1. **`write_note` is create-only.** No overwrite, no append, no delete, no rename, no move
   anywhere in the registry (`ai/tools.rs:351-368`). Collisions get a numeric suffix
   (`write_policy.rs:344-348`); the host primitive is `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`
   (`note_writer.rs:436`). **The worst outcome an approved write can produce today is an
   undoable junk note.** The brief's `create/append/overwrite/delete` vocabulary models a threat
   surface that does not exist, and shipping the enum would quietly invite someone to fill it in.
   Ship only the operation that exists; make adding one a compile error.
2. **The gated set is wider than "mutating plus network."** `use_skill` widens the tool grant
   set (`skill_tools.rs:113-145`), `select_playlist_videos` widens the write budget
   (`write_policy.rs:289`), and `resolve_distil_route` persists a vault profile that steers
   *future* routing. None of those look dangerous, which is exactly why they would be attacked
   first. This answers Q4.
3. **`transcribe_audio` spawns a host process** and can trigger a binary bundle install. That is
   categorically not "a network fetch" and needs its own bucket.
4. **A complete pause/resume machine already exists** — `UserPrompt::ask` (`ai/llm.rs:167-170`)
   → `elicit_user` (`ai/elicitation.rs:28`) → `ShellUserPrompt` + `PendingElicitations`
   (`src-tauri/src/skills/elicitation.rs:429-519`), with timeout, close signal, per-run cancel,
   composite `(run_id, id)` key, and a registration counter. **Reuse the mechanics, separate the
   types.** This meaningfully shrinks Phase 4.
5. **One polarity inversion, and it is a real bug waiting to be copy-pasted.**
   `resolve_interrupted_registration` (`elicitation.rs:475-492`) honours a committed answer that
   races teardown. For an *approval* the safe resolution is the opposite: discard the answer and
   honour the teardown, because honouring it means writing into a vault that may already be
   unmounted. Named test required.

### 9.2 The design, in short

**Trust boundary.** The classifier never receives free text of any kind. Not the note content,
not the model's prose, not ingested source, not even the path string. It receives app-computed
*facts about* the request: a closed `GatedTool` enum, an `OperationKind`, a `TargetLocation`,
clamped integers (`path_depth`, `leaf_len`, `payload_bytes`), booleans from filesystem probes,
and a salted `blake3` path digest for correlation. **Its input has no field an instruction could
live in.** Injection is unreachable by construction, not by filtering.

Three enforcement mechanisms, strongest first:
- `fn classifier_prompt(subject: &ToolApprovalSubject) -> String` cannot name `ToolCall`,
  `LlmMessage`, or `&str`. The signature *is* the boundary. Test the signature, not the model.
- `dispatch` takes an `ApprovedCall` newtype whose only constructor is `approval::decide()`.
  "No call reaches execution without a decision" becomes a compile error.
- A serialisation test asserting every string in the serialised subject matches
  `^[a-z][A-Za-z0-9]*$|^[0-9a-f]{32}$` and is ≤64 bytes.

> **NOT YET SPECIFIED — define these in the Phase 4 brief, before dispatch.**
>
> This section gives complete, verbatim definitions for `Reversibility`, `ApprovalMode`,
> `reversibility()`, `effective_mode()` and the const-assertion block. It gives **prose only** for
> **`GatedTool`**, **`ToolApprovalSubject`**, **`OperationKind`** and **`TargetLocation`**.
>
> That gap matters more here than it would elsewhere: the entire security argument is that the
> classifier's input is ~15 scalars with no field an instruction could live in. If an implementer
> infers these four types, nobody can check that claim — the property is only as real as the
> struct. Each must satisfy:
>
> - `GatedTool` — a **closed** enum, exactly the seven tools in §9.6.6, no `Other(String)` escape
>   hatch. A string variant reopens the injection channel this design closes.
> - `OperationKind` — only operations that **actually exist today**. §9.1.1 rejects
>   `create/append/overwrite/delete` precisely because that vocabulary models a surface the code
>   does not have. Adding one later must be a compile error, not a new enum value with a default.
> - `TargetLocation` — must be derived from the **canonicalised** path, never the requested one.
>   *(This bullet originally also required an `OutsideVault` variant. The implementation dropped
>   it, and the reason is in `subject.rs`: hard-deny runs first and in every mode, so a target
>   resolving outside the vault becomes a `HardDeny::VaultEscape` before a subject exists. The
>   variant shipped, was constructed by no code path, and fed a permanently-`false`
>   `crosses_vault_boundary` field — an eligibility clause that could not fire. Deleting the
>   clause reddened nothing across 105 approval tests; the positive `matches!(location,
>   InsideVault)` test is what actually holds the line, and it fails closed for anything else.)*
> - `ToolApprovalSubject` — every field either a closed enum, a clamped integer, a bool, or the
>   salted digest. **If a field's type is `String`, the design is broken.** The serialisation test
>   above is what proves it, so write the struct so that test can pass.
>
> Do not derive these from this paragraph alone. Confirm the operation set and the four proposed
> `Irreversible` classifications against the real call sites first (§9.7) — `resolve_distil_route`'s
> persistence path especially, which is flagged there as unverified.

**The human sees the path; the classifier sees the digest.** Two audiences, two trust profiles.
A person can read a deceptive filename and is the right party to judge it. A classifier cannot.

**The eligibility rule** (failing any one clause means unconditional ask): the call cannot
destroy or modify existing data; its effect is undoable through the `UndoLedger`; it crosses no
new trust boundary; its blast radius is inside an already-enforced budget; and it does not
change the policy, the grant set, or the budget itself. The classifier's authority is **one bit,
one direction**: it may narrow `Ask → Allow`, only inside the set the deterministic rule already
blessed. It can never move an unconditional-ask call to allow.

**Checked, not claimed.** A spy classifier with a call counter: for every corpus subject where a
clause fails, assert `classifier.calls() == 0`. The claim is that it is *unreachable*, not that
its answer got overridden. `fn eligible(...)` matches exhaustively with **no wildcard arm**, so
adding an overwrite or delete tool fails to compile rather than defaulting to eligible.

**Fail closed, everywhere.** Separate cheap model, no conversation, `temperature: 0`,
`max_tokens: 32`, verdict `{ "verdict": "allow"|"ask", "rule": "<compiled-in id>" }` parsed with
`deny_unknown_fields`. Deliberately **no free-text `reason` field** — a rationale string is both
an injection carrier back into the app and a temptation to show the user model prose as a
security justification. 3s wall-clock, **no retries** (a retry on a security decision doubles the
exposure window for zero gain when the fallback is cheap and correct). Two consecutive failures
in a run downgrade it to Ask-me and emit `ToolApprovalDegraded`. **On the local/Ollama lane the
classifier does not run at all** and the mode falls back to always-ask, visibly (§9.5.2). The
persisted setting shape is §9.6.

**Hard-deny is not a user prompt.** A vault escape, a path failing `parse_note_rel_path`, or an
oversized payload becomes a `reject()` tool result the model reads and recovers from. Asking the
user to approve a footgun is offering them a footgun.

**The gate is authorisation, not confinement.** `write_note_policy` canonicalises *inside* the
write and re-checks confinement after opening the parent fd (`write_policy.rs:394-430`). The
subject's path fields come from an advisory pre-flight probe. Test it directly: hold a valid
approval, swap the parent for a symlink pointing outside the vault, assert the write still fails.

**Wire events** (following `events.rs:44-49`'s frozen convention): `ToolApprovalRequested`
(carrying `relPath` for the human, never for the classifier, plus a compiled-in `reason` and
`expiresInSecs`), `ToolAutoApproved` (so "approve for me" is never invisible — the user can
always see what ran unattended and under which rule), `ToolApprovalResolved`
(`approved|denied|timedOut|cancelled|unavailable`), and `ToolApprovalDegraded`.

`ToolApprovalResolved` is a deliberate departure from `Elicit`, which emits no follow-up because
presentation state is client-side (`events.rs:58-59`). For a security prompt that is wrong: a
timeout or a window close must be visible, or the UI leaves a security sheet on screen that
silently no-ops.

**A separate IPC command and registry**, not a reuse of `answer_elicitation`. `ask_user` lets the
*model* author the question text and option labels (`skill_tools.rs:56-84`); a security prompt
whose copy the model writes is a social-engineering surface. The type separation also means a
webview `answer_elicitation` call can never satisfy an approval. Reusing `Elicit` with a reserved
id namespace was considered and rejected: it rests a security boundary on a string convention.

**Cancel, timeout, and close all resolve to deny.** 120s (not the elicitation path's 300s — a
security sheet sitting for five minutes is stale consent). Rust is the only expiry authority. No
paused state is serialised; the run stays a live future parked on a `oneshot`, so an approval
cannot survive a restart, which is correct rather than a limitation.

**Denial is not run-cancellation.** One result per declared call must still be pushed
(`orchestrator.rs:540-541`); remaining calls stay gated. Ending the turn on denial is the
tempting shortcut and it breaks the protocol invariant.

**Consent fatigue is the attack to expect.** A per-run `DeniedSet` keyed on
`(tool, operation, path_digest)`; a repeat forces unconditional ask; two denials of the same
subject hard-reject. Injected content will certainly instruct the model to try again, reworded.
Two caveats the architect flags: macOS case-folding must collapse the digest the way the
filesystem does, or `Note.md`/`note.md` read as distinct subjects; and a *different* path each
retry defeats the counter entirely, which is why `WRITES_PER_WORK_ITEM = 8` remains the real
backstop.

### 9.3 The residual risk, stated honestly

Direct injection into the classifier is unreachable — there is no free-text field. **Shaping is
not.** Whoever controls a transcript controls what the model proposes, and therefore the size,
the folder, and the note kind. The attack degrades from "talk the classifier into yes" to
"**shape a request the honest rules approve**" — a small `.md` file, an existing folder, under
budget. That defeats *any* auto-approval policy, deterministic or otherwise.

So the safety of auto-approval here does not come from the classifier's judgment. It comes from
the fact that **the worst outcome it can allow is an undoable junk note** (§9.1.1). If a future
tool gains overwrite or delete, the eligible set must go to empty until the table is re-derived
— which the no-wildcard match makes a compile error rather than an oversight.

**Under `Yolo` the residual risk is total, and softening that would be dishonest.** There is no
eligibility filter, no classifier, and no unconditional list. Whoever controls an ingested
transcript controls what the agent proposes, and under YOLO whatever it proposes runs. The only
things standing between a hostile transcript and the vault are the layers in §9.6.2 —
confinement, validation, budgets — which bound *where* and *how much*, not *what*. That is the
trade the mode's name exists to communicate, and the compensating control is visibility and undo
(§9.6.3), not prevention.

**The safety case rests on a property nothing enforced, so Phase 4 makes something go red.**

The argument that makes YOLO defensible is §9.1.1: the worst outcome it can allow is an undoable
junk note. That argument is not a design decision — it is an *observation* about the current tool
registry (`write_note` is create-only; no destructive tool exists). Nothing held it in place.
`eligible()`'s exhaustive match forces the question for `ApproveForMe` and is **silent for
`Yolo`**, because YOLO never consults the eligibility table. So the day someone adds a
destructive tool, the safety case would degrade invisibly — at exactly the moment it needs to
hold.

The general rule, worth carrying beyond this feature: **a constraint is only real when something
goes RED without it.** An argument in a document is not a constraint. A comment naming the
invariant is not a constraint. Until a build fails or a test fails, the property is a hope.

So the classification is now part of the design, not a proposal (§9.6.6). Each `GatedTool`
declares a `Reversibility`, the YOLO confirmation copy is **generated from that classification**
rather than hand-written, and a golden test pins the rendered text. The chain that closes the
hole:

1. Adding a `GatedTool` variant fails to compile until its reversibility is declared —
   `reversibility()` is an exhaustive match with no wildcard arm, and `Reversibility` has no
   `Default`, so a new variant cannot inherit "reversible" by omission.
2. Classifying a tool `Irreversible` changes the generated confirmation text.
3. The golden test on that text goes red, so a human has to re-bless the security copy the user
   is shown before it can land.

A silent safety regression becomes a visible user-facing copy change. That is the whole point,
and it is why the mechanism is copy generation rather than a comment or a checklist.

One further honest note: in Ask-me the provider can only *propose*. In Approve-for-me a provider
response directly authorises a vault write. That is not prompt injection; it is a **new party in
the authorisation path**, and it belongs in the Settings copy, not a footnote.

**The security decision is not reproducible.** This is a real, permanent property of the ruled
design, not a defect to be fixed later, and it must be written down rather than discovered.
`temperature: 0` reduces variance; it does not eliminate it, and it does not survive a provider
silently changing a model behind a slug. The consequences, stated plainly:

- The same tool call, on two different days, may be auto-approved once and prompted once. That
  is confusing rather than dangerous (the fail-closed direction is the safe one), but users will
  notice it and it should not be explained away as a bug.
- **Security tests cannot assert the classifier's verdict.** They assert the things that *are*
  deterministic: that the subject JSON is byte-identical across benign and hostile transcripts,
  that the classifier is never reached for an ineligible subject, that every malformed verdict
  shape resolves to ask, and that a timeout resolves to ask. A test asserting "the model said
  ask" is a model-dependent flake wearing a security test's clothes.
- Reproducing a past decision after the fact requires the audit trail (Q8), because the decision
  cannot be re-derived from the inputs alone. That moves the audit log from "nice to have" to
  "the only way to answer *why did it do that?*".

The within-run verdict cache (§9.5.3) bounds the inconsistency to across-run rather than
within-run, which is the version users are most likely to notice.

### 9.4 The ruling: the classifier enforces

The sub-design argued that a deterministic rule table should enforce and the LLM classifier
should run in shadow mode. Tom was shown that argument in full, with the latency, token-cost,
reproducibility and local-lane trade-offs spelled out, and **reaffirmed the LLM classifier as
the enforcing decision-maker** (2026-08-10). Settled; not reopened here.

So build it properly rather than hedging. **No rule table sits behind the classifier as a
secret fallback** — a shadow enforcer nobody can see is the worst of both designs, because the
system's real behaviour stops matching the one the user was shown.

The distinction that survives, and it is not a fallback: **eligibility and judgment are
different jobs.**

- The **eligibility rule** (§9.2) is deterministic, exhaustive, and stays exactly as designed.
  It answers "is this call the *kind* of thing that may ever be auto-approved?" **Inside
  `ApproveForMe`** it is what makes irreversible operations unconditional regardless of verdict.
  It does not run at all under `Yolo`, by design (§9.6.1).
- The **classifier** answers "should this particular eligible call run unattended?" It is the
  enforcing decision-maker within that set.

The classifier's authority remains one bit in one direction: it may narrow `Ask → Allow`, only
inside the eligible set. It can never move an unconditional-ask call to allow. Every mechanism
from §9.2 stands — the no-free-text subject, the signature-as-boundary, the `ApprovedCall`
newtype, fail-closed, the no-wildcard match, the spy-classifier call-count test.

What changes is that the classifier is now **on the critical path in front of a waiting user**,
which the shadow-mode design would have hidden. §9.5 specifies the three consequences.

### 9.5 The classifier on the critical path

Three things the shadow-mode design deferred to the table and the ruling now puts in front of a
waiting user.

#### 9.5.1 Latency is a timeline state, not a frozen pane

The user is blocked while the classifier runs. Variant A already has the vocabulary for this:
it is a rail node, and the rail's whole thesis is that node state reads from the glyph before
any text. So the check gets its own node rather than a spinner over a dead pane.

**Node states**, in the order a gated call moves through them:

| State | Glyph | Line | Reached from |
|---|---|---|---|
| `checking` | pulsing shield, `text-muted-foreground` | "Checking this action…" plus the tool title | a gated call enters the gate in approve-for-me mode |
| `autoApproved` | shield-check, `text-muted-foreground/55` | "Approved automatically" plus the compiled-in rule id | classifier returned `allow` inside the budget |
| `awaitingYou` | key, `text-warning`, the pane's **only** pinging node | the existing approval card | classifier returned `ask`, or the call was never eligible, or **anything failed** |
| `denied` | ban, `text-muted-foreground/55` | "Denied. Nothing was written." | the user denied, or timeout/cancel/close |
| `degraded` | shield-off, `text-warning` | "Automatic checking is off for the rest of this turn" | two consecutive classifier failures in one run |

**Only `ApproveForMe` uses `checking`.** Under `AlwaysAsk` a gated call goes straight to
`awaitingYou`; under `Yolo` it goes straight to `autoApproved` with rule id `yolo` and the line
"Approved automatically (YOLO)". The node is **always rendered** in every mode — YOLO skips the
prompt, never the record (§9.6.3).

The `checking` state deliberately does **not** get the warning tone or the ping. It is not
asking the user for anything, and a pane that pings at you three times per turn for something
you cannot act on trains you to ignore the one ping that matters.

`checking` is also the state that must never be terminal. It resolves within the budget or it
resolves *because* of the budget.

**Budget: 3 seconds wall-clock, no retries.** A retry on a security decision doubles the
exposure window for zero gain when the fallback is cheap and correct. On expiry the node moves
to `awaitingYou` with the reason attached, and the run emits
`ToolApprovalResolved { decision: "unavailable" }` before the prompt. **Exceeding the budget
fails closed to asking. There is no path from a timeout to an allow.**

Two smaller behaviours worth pinning, because both are the kind of thing that gets improvised
badly under time pressure:

- **A minimum visible duration of about 250ms on `checking`.** A classifier that answers in 80ms
  otherwise produces a flash the user reads as a glitch. Same reasoning as the one-chunk
  arguments case in R3.
- **The composer stays enabled and Stop stays live throughout.** A gate that disables the user's
  escape hatch while it decides whether the agent may write to their vault has the priority
  exactly backwards.

The scroll-follow work from Phase 1 already handles keeping this on screen, which is one of the
reasons Phase 1 lands first.

#### 9.5.2 The local lane falls back to always-ask, visibly

`qwen3.5:9b` is the bundled default and is **already known-marginal for structured output in
this repo** — the citation eval passes roughly one run in three. A model that returns
well-formed JSON a third of the time is not a security control; under fail-closed it is a
3-second pause before the prompt the user was going to get anyway, on every single gated call.

So: **on the local provider the classifier does not run, and `ApproveForMe` resolves to
always-ask.**

**This applies only to `ApproveForMe`.** `Yolo` never calls the classifier in any configuration,
so it works identically on the local lane and must not be disabled there. Downgrading YOLO on
local would be a silent, unrequested restriction of a mode the user explicitly confirmed, which
is the same class of bug as silently reverting it (§9.6.5). The local-lane guard keys on
*whether the classifier would be called*, not on the mode name.

The part that matters is that this is **visible, not silent**. A silent fallback is the exact
failure this design exists to prevent, and it fails in the direction that looks fine: the user
picked "approve for me", sees prompts, and concludes the feature is broken rather than
understanding their provider cannot support it.

- **In Settings**, "Approve for me" renders **disabled with its reason inline** when the active
  provider is local: *"Needs a cloud provider. Local models can't yet judge this reliably, so
  NeuralNote will always ask."* The user's stored preference is **not overwritten** — switching
  back to OpenRouter restores it. Silently rewriting a stored choice because it is momentarily
  unusable is its own bug (a stored value that pins a default is exactly the trap this repo has
  been bitten by before).
- **At runtime**, the first gated call of a local-provider run emits `ToolApprovalDegraded` with
  reason `providerUnsupported`, so the timeline says it once per run rather than once per call.
- **Enforced in Rust, not in the UI.** The webview disabling a radio button is a presentation
  detail; `decide()` must refuse to reach the classifier when the effective provider is local,
  with its own test. A settings-layer-only guard is a guard that a stale config or a direct IPC
  call walks straight through.

**This is not a permanent verdict on local models.** It is keyed on measured structured-output
reliability, so it should be re-measured when the bundled model ladder moves, not treated as an
architectural law. Leave a `TODO(local-classifier)` at the guard naming the eval that would
overturn it.

#### 9.5.3 Cost, and the within-run verdict cache

Every gated call in approve-for-me mode spends the user's own tokens. Spec §4 is explicit:
*"Never surprise the user with a bill."*

**Expected per-call cost.** The subject is roughly fifteen scalars, so the request is a small
fixed system prompt plus a compact JSON object, and the response is capped at `max_tokens: 32`.
Order of magnitude: a few hundred input tokens and a few dozen output tokens per gated call. On
a cheap small model that is a fraction of a penny per call and genuinely negligible next to the
chat turn it rides along with. **Order of magnitude is the honest claim here** — the exact
figure depends on the classifier model chosen, which is not yet locked, and a made-up decimal
would be worse than a range. Phase 4 measures it against the real prompt and puts the measured
number in the Settings copy rather than an estimate.

The number that actually matters is not per-call, it is **per turn**. A YouTube distillation run
can issue many gated calls, so the cost scales with agent chattiness, not with user actions.
That is the shape to watch.

Cost applies to `ApproveForMe` alone. `AlwaysAsk` and `Yolo` never call the classifier, so both
are free — which makes YOLO the cheapest mode as well as the most permissive, and that is worth
stating in the Settings copy so nobody picks it for the wrong reason.

**Verdicts are cached within a run**, keyed on the **full serialised subject** (which already
includes the salted path digest). The cache exists only in `ApproveForMe`; the other two modes
have no verdict to cache. Rules:

- **Within-run only.** The cache dies with the run. Vault state changes between runs, and
  `target_exists` is one of the classified scalars, so a cross-run cache would serve a verdict
  derived from a world that no longer exists.
- **Allow-verdicts only are cached.** An `ask` outcome is not cached, because the user's answer
  to it is the thing that matters and that has its own state.
- **A denial invalidates the cache entry.** The `DeniedSet` (§9.2) takes precedence over a cached
  allow, always. Without this rule a cached allow could quietly survive the user saying no to
  the same subject, which would be a genuine bypass rather than an optimisation.
- **The cache never spans providers or models.** A model switch mid-run clears it.

The cache is a cost and consistency optimisation, not a security mechanism, and it must not
become load-bearing: every cache hit is a decision that already passed the eligibility rule, so
the worst a stale hit can do is bounded by the same blast radius as a fresh one.

### 9.6 Approval mode: global default with per-tool overrides

**Ruled 2026-08-10:** a global mode, plus an advanced per-tool override list for exceptions.

#### 9.6.1 The three modes

| Mode | Eligible calls | Ineligible / irreversible calls | Classifier runs? | Token cost |
|---|---|---|---|---|
| `AlwaysAsk` **(default)** | ask | ask | no | none |
| `ApproveForMe` | classifier decides | **ask** | yes | per gated call |
| `Yolo` | run without asking | **run without asking** | no | none |

**Ruled 2026-08-10.** I had proposed narrowing the third mode's *behaviour* to fit an honest
label ("Don't ask for routine actions"). Tom went the other way and named the *label* to fit the
behaviour. **YOLO approves everything, including irreversible operations, and that is the entire
point of the mode.**

This is the better resolution and it is worth saying why, so nobody later mistakes it for an
oversight. It is the established convention in real agent harnesses — Claude Code ships
`--dangerously-skip-permissions`, and several others use "YOLO mode" by that literal name — and
it works because **the name carries the warning that "never ask" concealed.** A user who selects
something called YOLO has been told what they are doing. A user who selects "never ask" has been
told something that a narrowed implementation would then quietly contradict. My version bought
its honesty by taking away the thing the user asked for; this one keeps both.

So: **the unconditional-approval list is a hard floor within `ApproveForMe`. It is not a global
invariant.** Anywhere this document previously stated it absolutely now says which mode it
applies to. A future reader who finds the YOLO path ungated should not "fix" it.

#### 9.6.2 What YOLO removes, and what it emphatically does not

YOLO removes the **approval gate**. It removes nothing else, and the distinction is the whole
reason the mode is survivable:

| Still fully enforced under YOLO | Why it is not an approval question |
|---|---|
| Path confinement — `write_note_policy` canonicalises inside the write and re-checks after opening the parent fd (`write_policy.rs:394-430`) | Confinement, not authorisation (§9.2). A vault escape is impossible, not merely unapproved. |
| Hard-deny — a path failing `parse_note_rel_path`, or an oversized payload | Input validation. It becomes a `reject()` tool result the model reads and recovers from, exactly as in every other mode. There is no prompt to skip. |
| Write budgets — `WRITES_PER_WORK_ITEM = 8` and the context guards | A resource bound, not a permission. YOLO does not buy unlimited writes. |
| `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW` on the host write (`note_writer.rs:436`) | A filesystem primitive. Nothing in the approval layer can reach it. |
| The `UndoLedger` | The compensating control (§9.6.3). Undo is *more* important under YOLO, not less. |

**Do not read "the unconditional list does not apply" as "validation does not apply."** They are
different layers that happen to protect against overlapping things. If a future change routes
confinement through the approval gate to simplify the code, YOLO silently becomes a vault escape.

The `ApprovedCall` newtype invariant survives intact: `dispatch` still takes a value only
`approval::decide()` can construct, so "no call reaches execution without a decision" is still a
compile error to violate. Under YOLO the decision is simply an immediate yes.

#### 9.6.3 Visibility is the compensating control

When the gate is removed the **record** must not be. This is what keeps YOLO defensible rather
than reckless, and it is a build requirement, not a nicety.

Under YOLO the timeline renders **every** tool call and **every** vault write as a first-class
node, exactly as in the other modes. Specifically:

- What would have been an approval node is rendered as **`autoApproved`**, never omitted. Rule
  id `yolo`. The user sees "Approved automatically (YOLO)" where another mode would have shown a
  prompt. A skipped prompt that leaves no trace is the failure this clause exists to prevent.
- **Nothing is collapsed away by default that the other modes would have shown.** The fold rules
  from §1.1 apply equally; YOLO does not get a quieter timeline because it asked fewer questions.
- **Undo stays on every note-edit card**, and the run summary keeps its `N written +M` count.
- The pane header carries a **standing YOLO indicator** for as long as the mode is active
  (§9.6.5).
- The audit log (Q8) records the same tuple it would in any other mode, with `mode: yolo` and
  `rule: yolo`.

The principle, stated so it survives a refactor: **a user who cannot intervene must still be able
to see what happened and undo it.** Remove the visibility and the mode stops being a considered
trade and becomes a blind spot.

#### 9.6.4 Restrictiveness is a total order, and it is enforced

The "overrides can only be more restrictive" rule from §9.6.6 now earns its keep: under a YOLO
global, a per-tool override back to `AlwaysAsk` is exactly how a user claws back one tool.

The ordering is total, most restrictive first:

```
AlwaysAsk  >  ApproveForMe  >  Yolo
```

Implemented by deriving `PartialOrd, Ord` with the variants **declared in that order**, so
`min(a, b)` is "the more restrictive of the two". The effective mode for a tool is:

```rust
fn effective_mode(&self, tool: &str) -> ApprovalMode {
    let global = self.approval_mode;
    // A tool with no STORED override falls back to its COMPILED default (§9.6.6):
    // `AlwaysAsk` for `transcribe_audio`, unconstrained for the rest. Storing an
    // override REPLACES the compiled default rather than being clamped by it, so a
    // user who deliberately wants `transcribe_audio` unattended can still get there —
    // they just cannot arrive by accident or by inheritance.
    let tool_pref = self
        .tool_approval_overrides
        .get(tool)
        .copied()
        .unwrap_or_else(|| compiled_default_override(tool));
    // `min` = more restrictive. Clamping at EVALUATION rather than at write time is
    // deliberate: the preference is judged against whatever the global mode is NOW,
    // so lowering the global can never leave a stale, more-permissive override behind.
    global.min(tool_pref)
}
```

Two properties, both tested:

1. **`ApprovalMode::default() == AlwaysAsk`** and **`AlwaysAsk < ApproveForMe < Yolo`.** Both
   depend on declaration order, so one ordering test guards both. Reorder the variants and it
   fails loudly rather than silently making YOLO the default.
2. **An override can never widen permission.** Property-tested across all nine
   global-by-override combinations, asserting `effective <= global` in restrictiveness terms
   every time. `transcribe_audio` stays pinned to `AlwaysAsk` regardless of global mode,
   including YOLO — it spawns a host process and may install a binary, which is categorically
   not what "approve my note writes" means.

A stored override that is *less* restrictive than the current global is inert rather than
rejected. The UI must show it as inactive with the reason, because an override that silently
does nothing is its own small lie.

#### 9.6.5 Getting into YOLO, and staying there

**Entry is a deliberate gesture, not an idle click.** Selecting YOLO in Settings opens a
confirmation that names what it turns off, in plain language and with no jargon:

> **Turn on YOLO mode?**
>
> NeuralNote will stop asking before it acts. It will create and change notes in your vault and
> run skills without checking with you first.
>
> That includes things it cannot take back: **saving how it files your notes, fetching pages and
> captions from the internet, and running audio transcription on your machine.**
>
> You will still see everything it did in the chat, and you can still undo any note it writes.
>
> You can turn this off at any time in Settings.
>
> [Turn on YOLO mode] [Cancel]

Cancel is the default focus. The confirm button is the destructive tone, not the primary one.

**The bolded sentence is generated, not written.** Its list comes from
`ALL_GATED_TOOLS.filter(reversibility == Irreversible)` mapped through a plain-language display
name, so the warning cannot rot into a stale list and cannot silently omit a newly-added
destructive tool. Rust owns the list and exposes it on the existing `aiStatus` payload; the UI
composes the surrounding sentence. One source of truth, and it is the same one the gate consults.

Two things about the copy itself, because the display names are user-facing and the tool
identifiers are not: no tool name, no `snake_case`, no insider shorthand. "Saving how it files
your notes" rather than `resolve_distil_route`. A user reading this warning has to understand
the consequence, not look up a symbol.

**One confirmation on entry, never a nag.** No per-run banner, no "are you sure?" before each
write. A mode that re-asks is a mode the user click-trains themselves out of reading, which
would defeat the one moment the warning actually lands.

**It persists across restarts.** Arguing the other side first, honestly: a mode this permissive
resetting to safe on launch would bound the blast radius of a user who turned it on for one task
and forgot. That is a real benefit and I do not want to wave it away.

It still loses, for three reasons:

1. **A setting that silently reverts is its own broken promise.** The user made a deliberate,
   confirmed choice. Undoing it behind their back teaches them the settings surface cannot be
   trusted, which is a worse long-term property than the risk it mitigates.
2. **It would break the exact workflow YOLO exists for.** The mode's value is long
   uninterrupted runs — a playlist distillation, a bulk import. Those span sessions. A mode that
   resets is a mode you have to re-arm every morning, and re-arming is precisely the click-through
   training §9.6.5 just avoided.
3. **The right mitigation is visibility, not amnesia.** Persist the *mode*; never persist the
   *silence*. The pane header carries a standing YOLO indicator the whole time the mode is
   active, so "I forgot it was on" is not reachable without also not looking at the pane you are
   reading answers from.

So: **the mode persists, the indicator is permanent while it is on.** If dogfooding shows the
indicator is too easy to stop seeing, the answer is a better indicator, not a silent reset.

**The test that has to fail, and the tautology to avoid.** Generating the copy from the
classification means the copy can never *disagree* with the classification — so a test asserting
"the rendered list equals the derived list" is a tautology. It compares a value against its own
source and passes forever. That is exactly the shape of test the ruling warns about, and it is
the one a reasonable person writes first.

The check that actually goes red is a **golden test on the rendered string**:

```rust
#[test]
fn yolo_confirmation_irreversible_sentence_matches_the_blessed_copy() {
    // GOLDEN. This string is user-facing security copy. If a change to
    // `reversibility()` moves a tool in or out of the irreversible set, this
    // assertion fails and a human must consciously re-bless what the user is shown
    // before it can ship. Do NOT update it to match a new output without reading it.
    assert_eq!(
        yolo_irreversible_sentence(),
        "saving how it files your notes, fetching pages and captions from the \
         internet, and running audio transcription on your machine",
    );
}
```

Its value is precisely that it is *brittle in the right direction*. Classify a new tool
`Irreversible` and it reddens; classify one `Reversible` and it reddens. Neither can land as a
silent diff in a match arm. A mirrored snapshot test on the frontend pins the assembled
paragraph the user actually reads, so a UI-side rewording is caught the same way.

For contrast, the two tests that would have looked reasonable and proved nothing: asserting the
sentence is non-empty (passes forever), and asserting it equals the derived list (compares a
value to itself). Users who want fewer prompts and
lower cost have a coherent option that does not weaken the invariant.

#### 9.6.6 The seven gated tools

Overrides cover all seven, grouped by what the user is actually deciding — the grouping is the
point, because "approve `resolve_distil_route`" means nothing to anyone.

| Tool | Group | Why it is gated | Reversibility | Default override |
|---|---|---|---|---|
| `write_note` | Writes to your vault | creates a note | Reversible (undo ledger) | inherit |
| `use_skill` | Changes what the agent may do | widens the tool grant set (`skill_tools.rs:113-145`) | Reversible (run-scoped) | inherit |
| `select_playlist_videos` | Changes what the agent may do | widens the write budget (`write_policy.rs:289`) | Reversible (run-scoped) | inherit |
| `resolve_distil_route` | Changes what the agent may do | persists a vault profile steering *future* routing | **Irreversible** (durable state outliving the run) | inherit |
| `fetch_video_info` | Reaches the internet | network fetch, user's own bandwidth and ToS exposure | **Irreversible** (a request cannot be unsent) | inherit |
| `fetch_captions` | Reaches the internet | network fetch, best-effort scraping (spec §6) | **Irreversible** (a request cannot be unsent) | inherit |
| `transcribe_audio` | Runs a program on your machine | spawns a host process, may trigger a binary install | **Irreversible** (process spawn, binary install) | **`AlwaysAsk`, pinned** |

The four `Irreversible` classifications above are the plan's **proposed** starting values and
should be confirmed during Phase 4 against the real call sites — `resolve_distil_route`'s
persistence path in particular is one the sub-design flagged as unverified (§9.7). Getting one
wrong is not catastrophic in either direction: too permissive weakens `ApproveForMe`'s floor,
too restrictive adds a prompt. Both are visible. Silence is the thing being engineered out.

**The construct that enforces declaration.** `Reversibility` deliberately has **no `Default`
impl** — there is no safe default here, and a derived one would let a new variant inherit
"reversible" by omission, which is precisely the failure being closed. The classification is an
exhaustive match with **no wildcard arm**, so adding a `GatedTool` variant fails with E0004
(non-exhaustive patterns) until someone declares it:

```rust
/// No `Default`, on purpose. A tool whose reversibility nobody decided must not
/// silently become the permissive one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reversibility {
    /// Undoable after the fact through the `UndoLedger`, or scoped to the run.
    Reversible,
    /// Cannot be taken back once it has run.
    Irreversible,
}

pub const ALL_GATED_TOOLS: [GatedTool; 7] = [ /* … */ ];

/// Exhaustive by construction — NO wildcard arm. Adding a `GatedTool` variant makes
/// this fail to compile until its reversibility is declared. This is the guard that
/// `eligible()` provides for `ApproveForMe` and that `Yolo` previously lacked (§9.3).
pub const fn reversibility(tool: GatedTool) -> Reversibility {
    match tool {
        GatedTool::WriteNote => Reversibility::Reversible,
        GatedTool::UseSkill => Reversibility::Reversible,
        GatedTool::SelectPlaylistVideos => Reversibility::Reversible,
        GatedTool::ResolveDistilRoute => Reversibility::Irreversible,
        GatedTool::FetchVideoInfo => Reversibility::Irreversible,
        GatedTool::FetchCaptions => Reversibility::Irreversible,
        GatedTool::TranscribeAudio => Reversibility::Irreversible,
    }
}

```

> **CORRECTED IN IMPLEMENTATION — the paragraph this replaces was wrong, and the way it was
> wrong is worth keeping on the record.**
>
> This section originally specified a hand-written `ALL_GATED_TOOLS` array tied to a `slot()`
> match by a const assertion, and claimed that adding a variant would fail with E0080 "because
> the new arm's slot indexes past a `[_; 7]` array". **It does not.** Nothing indexes the array
> *by* slot, so `slot(NewVariant)` is never const-evaluated. A variant declared in all six
> exhaustive matches but left out of the array compiled cleanly — and because `from_name`
> searched that array, it answered `None` for the tool, `ApprovedCall::ungated` accepted the
> call, and `decide` was never reached. **The tool ran with no approval decision in any mode,
> `AlwaysAsk` included.** Confirmed by adding a throwaway eighth variant: 45 gate tests passed
> while the tool was completely un-gated.
>
> The paragraph then declined `strum` on the grounds that "the const assertion is a dozen lines
> and buys the same guarantee". It bought a weaker one — ordering and uniqueness, not
> completeness — so the trade it described was not the trade on offer.
>
> **What ships instead:** a local `declare_gated_tools!` macro in `approval/gated.rs` that
> declares the enum, `ALL_GATED_TOOLS`, `name()` and `from_name()` from one variant list. Stable
> Rust cannot enumerate an enum's variants without a macro or a derive, so this is the
> dependency-free way to make the omission unrepresentable rather than merely tested for. The
> `strum` decision stands, and for a better reason than the original: `EnumIter` would solve the
> same problem, and the macro solves it without the supply-chain surface.

`transcribe_audio` ships pinned to always-ask and the override UI shows it as such with its
reason. Spawning a process and installing a binary is categorically not "a tool call", and it is
the one entry where an inherited permissive default would be a genuine surprise. **The pin holds
under `Yolo` too** — it is a per-tool override at the most restrictive setting, and §9.6.4's
clamp makes overrides win in the restrictive direction regardless of the global mode. A user who
genuinely wants it unattended can clear the pin themselves; they cannot get there by accident.

**An override can only be more restrictive than the global mode, never more permissive.** A
per-tool `ApproveForMe` on a global `AlwaysAsk` does nothing; a per-tool `AlwaysAsk` on a global
`ApproveForMe` works. This makes the global mode a true ceiling, so a user reasoning about their
own configuration only has to read one value to know the worst case. It also means a future tool
added to the gated set cannot inherit permission from an override written before it existed.

#### 9.6.7 Persisted shape

Rides `ProviderConfig` (`ai/provider_config.rs:49`) following the `reasoning` and
`disabled_skills` precedents exactly, including the tolerant-read discipline documented at
`provider_config.rs:52-56`.

```rust
/// Variant ORDER IS LOAD-BEARING TWICE: `Default` takes the first variant (the safe
/// one), and the derived `Ord` makes `min(a, b)` mean "the more restrictive of the
/// two", which is how a per-tool override clamps the global mode (§9.6.4). Reordering
/// these silently makes YOLO the default AND inverts the clamp — hence the ordering
/// test, which fails loudly if anyone does.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    #[default]
    AlwaysAsk,
    ApproveForMe,
    /// Approves everything, including irreversible operations. The
    /// unconditional-approval list does NOT apply here — that is deliberate (§9.6.1).
    /// Validation, confinement, and budgets still do (§9.6.2).
    Yolo,
}

// on ProviderConfig:
    /// The global approval default. `#[serde(default)]` is load-bearing exactly as it
    /// is for `reasoning`: an `ai-config.json` written before this field existed reads
    /// back as `ApprovalMode::default()` = `AlwaysAsk`, so every existing install
    /// migrates to the SAFE mode for free, with no migration code.
    #[serde(default)]
    pub approval_mode: ApprovalMode,

    /// Per-tool exceptions, keyed by the `TOOL_*` constants. Absent and empty both mean
    /// "every tool takes its COMPILED default" (§9.6.6) — which is inherit-the-global
    /// for six of the seven, and `AlwaysAsk` for `transcribe_audio`. So a legacy config
    /// and a deliberately-cleared list are the same thing, and neither one silently
    /// unpins the process-spawning tool. A stored entry REPLACES that compiled default.
    /// An UNKNOWN key is dropped on read rather than erroring, so a config written by a
    /// newer build still loads in an older one.
    #[serde(default)]
    pub tool_approval_overrides: BTreeMap<String, ApprovalMode>,
```

Four properties this shape buys, each of which is a bug if it is missing:

1. **`Default` derives to `AlwaysAsk`** because it is the first variant. The safe value is the
   default by construction, not by a comment asking someone to remember. A test asserts
   `ApprovalMode::default() == AlwaysAsk` so reordering the variants fails loudly.
2. **An empty `ai-config.json` and a pre-feature one both read as `AlwaysAsk`.** No migration
   code, matching the `reasoning` precedent verbatim.
3. **`BTreeMap`, not `HashMap`** — deterministic serialisation order, so the config file does
   not churn in diffs and a golden-file test is stable. (This repo has been bitten by JSON key
   reordering before.)
4. **Unknown keys drop rather than error**, so a downgrade after a future tool is added does not
   brick the config. The mirror of the `keyConfigured` migration already documented at
   `provider_config.rs:88-96`.

`RawProviderConfig` gains both fields with the same `#[serde(default)]`. No new storage
mechanism, no new file, no schema version bump.

**Settings location.** `AiSettingsPage.tsx` (177 lines, comfortable), under the existing
"Configure the AI" section, below the reasoning toggle. The global mode is three radio options
with one-line consequences. The per-tool overrides sit behind a collapsed **"Advanced"**
disclosure, grouped by the four groups in §9.6.2 — three of the seven tools are YouTube-pipeline
internals and putting them at the top level would make the page read like a debug panel.

**Migration and defaults for existing users.** Everyone lands on `AlwaysAsk` with no overrides,
which is today's behaviour plus a visible prompt. Nobody is opted into automation by an upgrade.
This is the one migration property worth a named test, because getting it backwards would
silently grant unattended vault writes to every existing install.

### 9.7 What the architect could not verify

- It read ~1,100 of `orchestrator.rs`'s 4,169 lines. The single `dispatch` site at
  `orchestrator.rs:770-779` is verified; that there is no *second* execution path is not proven.
  Confirm before relying on the single-gate claim.
- `resolve_distil_route`'s full persistence path — it writes durable state, but where on disk,
  and whether it touches the network, is unconfirmed.
- `PathDigest` case-folding on macOS is a stated requirement, not an observation. Needs a real
  test on a case-insensitive volume.
- Current OpenRouter support for `temperature: 0` and structured outputs on small models. Check
  against current docs before locking the classifier request shape.

---

## 10. Branch and worktree strategy

**No work happens on `main`.** Every phase gets a branch, a worktree, and a PR.

### 10.1 The trap that will cost an hour if it is not read first

**Three gitignored artifacts are a hard build dependency, and a fresh worktree has none of
them.** Two are declared as `externalBin`, the third as a resource glob one line below:

```jsonc
// app/desktop/src-tauri/tauri.conf.json
"externalBin": ["binaries/ollama", "binaries/llama-server"],   // :35
"resources": ["ollama-libs/**/*"],                             // :36  <- the easy one to miss
```

| Artifact | Size | Gitignored at |
|---|---|---|
| `app/desktop/src-tauri/binaries/ollama-aarch64-apple-darwin` | 67 MB | `.gitignore:13` |
| `app/desktop/src-tauri/binaries/llama-server-aarch64-apple-darwin` | 12.7 MB | `.gitignore:14` |
| `app/desktop/src-tauri/ollama-libs/` (~35 `.dylib`/`.so` + `mlx_metal_*`) | **354 MB** | `.gitignore:17` |

So `git worktree add` produces a checkout that **cannot build the `desktop` crate at all**. The
failure does not say "missing binary." It surfaces as a Tauri bundling error partway through a
Rust build, and `scripts/rust-quality-gate.sh` reports it in a shape that reads like a code error
in a crate nobody touched. Anyone who has not seen it before will go looking for a Rust bug that
does not exist.

**`ollama-libs/` fails differently and even more confusingly:** a glob resource that matches
nothing is a hard error (`glob pattern ollama-libs/**/* path not found or didn't match any
files`), not a warning. And because `binaries/` *will* look correctly populated by then, the
diagnostic above sends you to the wrong place.

`scripts/fetch-ollama-sidecar.sh:6-17` already documents this exact trap — *"a common trap is
grabbing only `ollama`"* — and lists all three artifacts and why each is needed. Read it before
inventing a setup step.

**Link all three, as an explicit named step in every worktree setup, before any code is written.**
Not a footnote. Not "npm install will sort it out." Symlinks rather than copies: `.gitignore:15-16`
sanctions them explicitly (*"temporary absolute symlinks used by isolated worktrees"*), the Tauri
build resolves through them, and it saves ~434 MB per worktree.

### 10.2 Convention: siblings outside the repo root

The repo currently has **nine worktrees in two conflicting conventions** — siblings
(`../NeuralNote-tables`, `-top3`, `-triage`, `-triage-b2`, `-e2e-hardening`,
`-architecture-docs`) and nested ones under `.claude/worktrees/`
(`editor-markdown-rendering`, `remove-prototype-site`).

**This work uses siblings.** The deciding argument is not taste, it is search pollution: a
nested worktree is inside the repo root, so every repo-wide `find`, `rg`, and agent file search
sweeps it. That includes its `target/debug/` build artifacts. A search of `main` returns hits
from another branch's compiled output, which corrupts every archaeology pass and every
subagent's file search for the whole project — and it does so silently, producing plausible
wrong answers rather than errors. This exact thing happened during the research for this plan.

The counter-argument, stated fairly: nested worktrees keep everything under one directory, which
is tidier and makes cleanup obvious. That is a real benefit and it loses to correctness of
search. If nested worktrees are ever wanted again, the fix is to add `.claude/worktrees/` to the
ignore files that agent search honours, not to accept the pollution.

**`.claude/worktrees/remove-prototype-site` is LOCKED and sits at `4d87df3`. Treat it as another
session's live work.** Nothing in this plan removes, prunes, or reuses it. This warning is here
because **Phase 1 deletes the prototype**, and the names are close enough that "clean up the
prototype worktree" is an easy and destructive misreading. Phase 1 deletes
`app/desktop/src/prototype-chat/` in *its own* worktree. It does not touch that worktree, and
`git worktree prune` must not be run as a convenience during this work.

### 10.3 Branch names

Matching the repo's actual history (`fix/release-manifest-probe-cwd`, `feat/table-in-place-editing`,
`test/e2e-hardening`, `docs/architecture-lld`, `chore/eval-model-override-issue-68`): a type
prefix, a slash, a kebab-case description.

| Phase | Branch | Worktree |
|---|---|---|
| 1 | `fix/chat-pane-scroll-follow` | `../NeuralNote-chat-scroll` |
| 2 | `feat/chat-tool-call-events` | `../NeuralNote-chat-tools` |
| 3 | `feat/chat-live-write-preview` | `../NeuralNote-chat-preview` |
| 4 | `feat/chat-tool-approval` | `../NeuralNote-chat-approval` |
| 5 | `feat/chat-plan-and-usage` | `../NeuralNote-chat-usage` |
| 6 | `feat/chat-expand-to-wide` | `../NeuralNote-chat-expand` |

Phase 1 is `fix/` rather than `feat/` on purpose: it repairs a live defect (there is no scroll
management in the shipping pane), and the branch prefix should say so.

**One branch per phase, one PR per phase.** Each phase is independently shippable and clears the
Definition of Done on its own, so bundling two into one PR would defeat the sequencing that
makes this plan reviewable.

### 10.4 One worktree or six?

**Recommendation: reuse a single worktree, `../NeuralNote-chat`, re-pointed per phase.**

```bash
git -C ../NeuralNote-chat fetch origin
git -C ../NeuralNote-chat checkout -B feat/chat-tool-call-events origin/main
```

The reason is the ~434 MB of sidecars and libs plus a full `node_modules` (`node_modules/` is gitignored at
`.gitignore:10`, and npm does **not** share it across worktrees, so **every worktree needs its
own `npm install`**). Six worktrees means six copies of both. Re-pointing one costs a checkout.

Use a **separate** worktree only when two phases genuinely need to be in flight at once — for
example if Phase 3's spike is parked awaiting a decision while Phase 4 proceeds. In that case
create the second one from the table above and pay the setup cost knowingly.

The table's per-phase worktree names stay in the plan so that a parallel phase has an obvious
name to use, not because six directories are expected to exist.

### 10.5 Setup runbook

Run once per worktree, **before any code is written**. Commands from
`.claude/skills/neuralnote-runbook`, paths verified.

```bash
# 1. Create the worktree from a fresh main.
git fetch origin
git worktree add -b fix/chat-pane-scroll-follow ../NeuralNote-chat origin/main

# 2. Link ALL THREE gitignored artifacts. NOT OPTIONAL — see §10.1. Miss the third
#    and the build dies on "glob pattern ollama-libs/**/* ... didn't match any files"
#    while binaries/ looks correctly populated, which sends you to the wrong place.
#    Symlinks, not copies: .gitignore:15-16 sanctions them, and it saves ~434 MB.
MAIN=/Users/thomaspritchard/Documents/projects/NeuralNote
WT=../NeuralNote-chat
ln -sf  "$MAIN"/app/desktop/src-tauri/binaries/ollama-aarch64-apple-darwin \
        "$WT"/app/desktop/src-tauri/binaries/
ln -sf  "$MAIN"/app/desktop/src-tauri/binaries/llama-server-aarch64-apple-darwin \
        "$WT"/app/desktop/src-tauri/binaries/
ln -sfn "$MAIN"/app/desktop/src-tauri/ollama-libs \
        "$WT"/app/desktop/src-tauri/ollama-libs

# 3. Per-worktree dependencies. node_modules is gitignored and is NOT shared.
#    Node must be 22 or 24 — app/desktop/package.json engines is
#    "^22.12.0 || ^24.0.0", and CI runs 24. Node 26 false-reds the frontend suite,
#    which looks like broken tests rather than a wrong runtime.
node --version
npm --prefix ../NeuralNote-chat/app/desktop install

# 4. PROVE the worktree builds BEFORE writing anything. If this is red now, it is
#    the environment, not your change — and finding that out after a day of work
#    is how a red suite gets blamed on a diff.
cd ../NeuralNote-chat
cargo test --workspace --locked
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:run
bash scripts/rust-quality-gate.sh          # must print GREEN
```

Step 4 is the whole point of the runbook. A worktree that is red before the first edit will be
blamed on the edit.

### 10.6 Parallel-dispatch hazards

This is why the section exists. §3 freezes the shared *contracts*; this freezes the shared
*working tree*. Both matter, and disjoint file lists protect neither on their own.

**Hazard 1 — the git index is worktree-global, so `git add -A` steals attribution.** When
`coder` and `ui-designer` run concurrently in one worktree, they edit different files but share
one index. Either agent running `git add -A`, `git add .`, or `git commit -a` stages the other's
in-progress work and commits it under its own message. Disjoint file lists protect the *edits*;
they do nothing for *staging*.

*Rule:* **no subagent commits.** Agents edit files and report; the orchestrator stages by
explicit path and commits. If an agent must commit, its brief names the exact paths and forbids
`-A`, `.`, and `-a`. Never a wildcard.

**Hazard 2 — an agent briefed into a worktree silently edits the main checkout.** The agent's
cwd resets between calls, a relative path resolves against the wrong root, and the edit lands in
`/Users/thomaspritchard/Documents/projects/NeuralNote` instead. **Every tool reports success and
the worktree diff stays empty**, so nothing looks wrong until review.

*Rule:* every dispatch brief uses **absolute paths rooted at the worktree**, states the worktree
root once at the top, and the orchestrator verifies afterwards rather than trusting the report.

**What the orchestrator checks after every dispatch wave**, before believing any agent's report:

```bash
# The work landed where it was supposed to.
git -C ../NeuralNote-chat status --short

# And NOTHING landed on main. This is the check that catches hazard 2.
git -C /Users/thomaspritchard/Documents/projects/NeuralNote status --short   # expect clean
```

A clean worktree diff plus a dirty `main` is hazard 2, caught. Two agents' files staged under
one commit is hazard 1, caught. Both are cheap to check and expensive to find later.

**Third, smaller hazard:** sibling subagents share a scratchpad directory and will collide on
ports and filenames. Give each a private subdirectory and its own port when a phase runs a dev
server (Phase 1 and Phase 6 both do, for browser-tier tests).

### 10.7 Merge gate

A phase's PR merges when the [Definition of Done](../docs/definition-of-done.md) baseline is met
for that phase:

- Pull-request CI green: Oxlint, TypeScript typecheck, frontend unit and component tests, Rust
  workspace tests, Clippy, rustfmt, **generated-binding drift**, full-history Gitleaks.
- `bash scripts/rust-quality-gate.sh` prints **GREEN (all categories enforced)** and exits `0`.
  Exit `2` is INCOMPLETE, which is **not** green — re-run with the tooling installed and network
  available rather than reading it as a pass.
- The phase's own definition of done from §2, including its browser-tier lane where §4 requires
  one (Phases 1 and 6 unconditionally).
- Hands-on verification in the running app. Green tests are necessary, not sufficient.
- Focused review complete, findings fixed severity-first, delta re-reviewed.

**Phase 4 additionally requires an independent adversarial reviewer who did not implement it**
(DoD §2). This is not a formality and it is not satisfied by a green suite or a green Sonar
gate: the DoD records that a YAML alias-bomb guard in this repo passed its full unit suite *and*
a green gate, then was bypassed twice in adversarial review. Phase 4 ships a security control
whose most dangerous mode approves everything by design, so it gets a reviewer whose job is to
break it.

### 10.8 Cleanup, and the check that silently lies

**`git branch --merged main` cannot detect merged branches in this repo, and it will confidently
tell you they are unmerged.** The repo squash-merges, which rewrites commits, so `--merged`
structurally cannot see the relationship. Verified against four branches whose PRs are merged
(`test/e2e-hardening` #96, `feat/table-in-place-editing` #99, `fix/top3-priority-issues` #91,
`docs/architecture-lld`) — all four report "not merged."

Use the PR state instead:

```bash
gh pr list --state merged --head fix/chat-pane-scroll-follow --json number,mergedAt
```

This is a false-negative that reads like a real answer, which is the worst shape a check can
have. Any cleanup step in this work uses `gh pr list`, never `--merged`.

Cleanup after a phase merges: delete the branch, and re-point the shared worktree at the next
phase rather than removing it. **Do not run `git worktree prune`** during this work — see
§10.2 on the locked worktree.

---

## 11. What this plan deliberately does not do

- **No Variant B or C.** No docked status instrument, no plan board as a separate surface, no
  persistent changes tray. The verdict was A; building the losing variants' affordances "just in
  case" is how a 440px pane becomes three panes. (Expand-to-wide is the one affordance promoted
  out of this list, by ruling, into Phase 6.)
- **No new dependency.** Not AI Elements, not the Vercel AI SDK, not Radix Collapsible. The
  prototype borrowed AI Elements' *anatomy and state vocabulary* only; those components bind to
  the Vercel AI SDK's `UIMessage`/`ToolUIPart`, and NeuralNote's chat is a Rust core over a
  Tauri channel with its own event union. The repo's existing `<details>` idiom carries the
  disclosures.
- **No streaming of the disk write.** There is nothing to stream (§5.1). Preview is of
  composition, not of I/O.
- **No per-line or partial undo.** Whole-note revert only, matching what the write layer can
  actually do.
- **No changes to retrieval, chunking, or citation verification.** The moat's hot path is
  untouched by all six phases. `emit_citations` (`orchestrator.rs:823-845`) and the verifier
  keep working exactly as they do; the rail only *renders* what they already emit.
- **No general-purpose tool-argument rendering.** `NoteEditPreview` fires only for tools on a
  previewable allowlist. Rendering arbitrary in-flight arguments is an injection surface with no
  product payoff.
- **No `ToolArgsDelta` on the wire.** Raw fragments have no consumer and would put a second
  JSON parser in TypeScript (§1.2).
