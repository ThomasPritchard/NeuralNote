# NeuralNote — AI Slice 3: Conversational chat & the reasoning toggle

> Status: design draft (2026-07-10, revised same day). Builds on
> [`ai-cited-chat-slice.md`](ai-cited-chat-slice.md) and
> [`ai-providers-slice.md`](ai-providers-slice.md), and is a **hard prerequisite** for the
> skills bank ([`ai-skills-bank-slice.md`](ai-skills-bank-slice.md)) and the YouTube distil skill
> ([`youtube-distil-skill.md`](youtube-distil-skill.md)). Read `specs/neural-note.md` and
> `docs/definition-of-done.md` before implementing.

---

## 1. What this slice is — honestly sized

This slice is **a system-prompt rewrite, a reasoning-capability probe, two UI affordances, and a
behavioural eval**. It is deliberately small, and inflating it would mislead the implementer.
What it changes:

1. The chat learns to **converse**: greetings, small talk, meta-questions ("what can you do?"),
   and follow-ups about its own prior answer are answered directly, with **zero tool calls**.
   Every *factual* question still requires vault evidence — outside knowledge stays forbidden.
2. The **empty-vault result becomes an on-ramp, not a dead end**: when searches find nothing, the
   answer says what was searched and invites the user to add a source. The prompt offers only what
   this build can actually do (§3) — Slice 5 upgrades the nudge to offer distillation once the
   skill exists to honour it.
3. The **reasoning toggle** surfaces in the chat pane, and — the piece that makes it honest — the
   app **detects whether the selected model supports reasoning at all** (§4). Today's toggle can
   lie: flipped on against a non-reasoning model, the request parameter is silently dropped
   upstream and nothing arrives. That is a silent failure, which this project forbids.

Why this must land **before** the skills bank: `SYSTEM_PROMPT` (`orchestrator.rs:48-65`) currently
orders the model to "issue 3 to 8 varied searches" before *every* answer. Asked to distil a video,
the model would dutifully search the vault first. Conversation and skill invocation both need a
prompt that permits a non-research turn — so this slice ships first, alone.

Nothing structural blocks any of this: `run_chat` → `collect_evidence`
(`crates/neuralnote-core/src/ai/orchestrator.rs:77`, `:169`) already permits a turn with zero tool
calls (`orchestrator.rs:183-184`). The retrieval mandate lives entirely in the prompt.

## 2. Locked decisions (and why)

- **Conversational, vault-only facts.** Two modes, described in the rewritten prompt: *converse*
  (greetings, meta, follow-ups about the assistant's own prior answer → answer directly, no tools)
  and *research* (any question about facts or the user's material → MUST search; never answer from
  the model's own knowledge). Tom, verbatim: *"we still shouldn't use outside knowledge. If the
  vault doesn't contain anything about what the user is asking, return back with an honest answer
  and suggest to the user to research and give it the notes."*
- **No structural enforcement — an eval carries the moat.** There is no code path that can decide
  "was this question factual?"; only the prompt does, and a weak local model (`granite4.1:3b`) may
  skip searching on a genuine factual question or chat its way through one. The honest answer to
  "how do you know the moat still holds" is the **behavioural eval fixture set** in §7, run against
  both providers and treated as a regression gate. This residual risk is accepted, named, and
  measured — not hidden.
- **Reasoning capability is probed, not assumed.** Probe at model-select time, cache the result
  (§4). An unsupported model renders both toggles **disabled with the model named** in a tooltip
  ("granite4.1:3b has no thinking capability") — not hidden, because hiding teaches the user the
  app lacks the feature. **Probe failure fails OPEN**: offline, a hand-typed model id, a 500 from
  the models endpoint → the toggle shows enabled. Silently disabling a paid-for capability because
  a metadata call failed is worse than a no-op.
- **The reasoning flag stays global.** Chat is not persisted (`ChatPane.tsx:88` is `useState`
  only), so the global `ProviderConfig.reasoning` flag (`ai/provider_config.rs:39-40`) already
  behaves per-session. No per-conversation state is added.
- **Both toggles call the same command and render the returned state.** The Settings toggle
  (`app/desktop/src/workspace/OpenRouterCard.tsx:78`) already calls `api.setReasoning` →
  `set_reasoning` (`src-tauri/src/commands/ai.rs:133`), which **returns the freshly-persisted
  `AiStatus`** so the UI never renders un-persisted state. The chat-pane toggle reuses this exact
  pattern — one source of truth, two doors.

## 3. Architecture — what actually changes

```
SYSTEM_PROMPT rewrite (orchestrator.rs:48-65)        ← the substance of the slice
        │
run_chat / collect_evidence                          ← UNCHANGED (zero-search turns already legal)
        │
supports_reasoning / supports_thinking (core, pure)  ← §4; the HTTP probes live in the shell
        │
ChatEvent stream                                     ← no new variants
        │
ChatPane.tsx / ChatMessages.tsx                      ← two affordances (§3.2, §3.3)
```

### 3.1 The prompt rewrite

Replace the current single-mode prompt ("You answer questions strictly from the user's own notes",
"Before answering, issue 3 to 8 varied searches") with a two-mode prompt:

- **Converse** — greeting / small talk / capability question / follow-up about its own prior
  answer in this conversation: answer directly, call no tools, keep it short.
- **Research** — anything asking for facts, or about the user's notes or material: issue 3–8
  varied searches (unchanged), answer only from retrieved evidence, cite with `[eN]`, never guess.
- **Empty result** — state plainly what was searched, say the vault has nothing on it, and invite
  the user to add a source. No fabricated citation, ever (spec §6).

**The nudge must only offer what actually exists.** In this slice there is no capture skill, so the
prompt says *"nothing in your notes covers this — add a note on it and I'll be able to answer"*. It
must **not** say "send me a YouTube link and I'll distil it": promising a capability the build does
not have is a fabrication, and this project treats fabrication as the worst failure mode. When Slice
5 lands, the nudge is upgraded in lockstep with the skill that makes it true, and the eval fixture
for "factual, not in vault" is updated with it. Tom's own words set the v1 bar: *"return back with
an honest answer and suggest to the user to research and give it the notes."*

`Guards` (`orchestrator.rs:26-46`) are untouched: `max_iterations: 8`, `max_spans: 60`,
`max_context_chars: 60_000` still bound a research turn.

### 3.2 Coverage suppression and the "nothing found" card

- **Suppress the coverage footer on zero-search turns — in the CORE, not the frontend.**
  *(Corrected during implementation; the original text below was wrong and would have caused a
  silent failure.)* `emit_coverage` (`orchestrator.rs`) now declines to emit a `Coverage` event at
  all when it would carry no information. Crucially it **still emits** when `truncated` is true or
  `skipped_files > 0`, even with no searched terms and no notes read: a listing-only run
  (`list_notes`/`list_folders`) can trip `max_iterations`, and dropping that footer would hide the
  truncation. The frontend must therefore **not** add a `searchedTerms`-based suppression of its
  own — `CoverageFooter` (`ChatMessages.tsx:418`) already renders only on `truncated ||
  skippedFiles > 0`, which is correct and must be left alone. Two layers independently deciding to
  suppress is how a signal goes missing.
- **The on-ramp card needs no new event.** When a finished assistant turn ran ≥1 search
  (`Coverage.searchedTerms` non-empty) and has zero surviving citations **and dropped none**,
  `ChatMessages.tsx` renders a "nothing in your vault covers this" card listing the searched terms.
  The data already arrives in `Coverage` + an empty `citations[]`; this is a render rule, not a
  protocol change.

  The dropped-citation exclusion is load-bearing. Zero surviving citations has two causes: the
  vault held nothing, or it held the note and the verifier rejected the quote (see
  `a_citation_whose_note_changed_mid_answer_is_dropped`). Announcing "nothing in your vault covers
  this" in the second case is a false claim about the user's own notes. A turn with any
  `{kind: "dropped"}` activity step suppresses the card and lets the dropped rows — which already
  auto-expand the activity disclosure — give the honest account.

  **No capture CTA ships in this slice.** There is no capture pipeline until Slice 5, and a button
  offering to distil a link would promise a capability the build does not have. The card is copy
  only, with a `TODO(slice-5)` marker at the render site.

### 3.3 The reasoning toggle in the chat pane

A small toggle in the composer header of `ChatPane.tsx` (composer is the bare `<textarea>` at
`ChatPane.tsx:297-306`). It reads the current value from `AiStatus`, calls `api.setReasoning`, and
re-renders from the **returned** `AiStatus` — the same never-render-unpersisted-state pattern as
`OpenRouterCard.tsx:78`. When the cached capability probe (§4) says the selected model has no
reasoning, both this toggle and the Settings one render disabled with the model named. Reasoning
display is already fully plumbed: `ReasoningRequest` (`ai/openai.rs:240`, emitted only on opt-in
at `:294`) → `extract_reasoning` (`ai/openai.rs:219`, handles both typed
`delta.reasoning_details[]` and legacy plain-string `delta.reasoning`) → `ChatEvent::Thinking` →
the `Reasoning` disclosure (`ChatMessages.tsx:349`). Nothing new there.

## 4. Reasoning capability detection

**The problem.** OpenRouter's documented behaviour is that a request parameter the chosen model
does not support "is ignored, and the rest are forwarded to the underlying model API" — no error.
So a user can enable reasoning, `ReasoningRequest` is sent (`ai/openai.rs:294`), OpenRouter drops
it silently, and no `Thinking` deltas ever arrive. The toggle lies. Detection is therefore not
optional; it is the fix for a silent failure this project's own rules forbid (DoD §1).

**Detection, both verified against live sources (2026-07-10):**

- **OpenRouter:** `GET https://openrouter.ai/api/v1/models` (public, no key) returns each model
  with a `supported_parameters` array. Live examples, to be checked in as test fixtures:
  `anthropic/claude-sonnet-5` → `["include_reasoning", "max_completion_tokens", "max_tokens",
  "reasoning", "reasoning_effort", "response_format", "stop", "structured_outputs", "tool_choice",
  "tools", "verbosity"]`; `openai/gpt-chat-latest` → no `reasoning`, no `include_reasoning`.
  **Supported iff `supported_parameters` contains `"reasoning"`.** The same payload carries a
  `pricing` object per model — Slice 5's playlist cost estimate reuses this one fetch
  ([`youtube-distil-skill.md`](youtube-distil-skill.md) §7), so parse both from it.
- **Ollama:** `POST /api/show` returns a `capabilities` array with values such as `completion`,
  `tools`, `vision`, `thinking`. **Supported iff it contains `"thinking"`.** Sources:
  https://docs.ollama.com/capabilities/thinking and
  https://github.com/ollama/ollama/issues/10966.

**Where the code lives.** Pure predicates in the core, HTTP in the shell — the same split as
everything else: `supports_reasoning(&[String]) -> bool` over `supported_parameters`,
`supports_thinking(&[String]) -> bool` over `capabilities`, both unit-tested against the fixture
payloads above.

**Caching and invalidation.** The probe result lives alongside the model selection in
`ProviderConfig` (a `#[serde(default)]` field, so existing configs still load — the Slice-2
migration-is-free pattern). Re-probed on model change and on app start; a stale "unsupported"
that outlives a model upgrade is a bug. For Ollama, probe at **pull time and at chat time** — the
curated allowlist (`ai/local/mod.rs:97`) must **not** hardcode a `supports_thinking` flag, because
the allowlist would drift from what the installed Ollama actually reports for the tag.

**Runtime backstop.** Capability metadata can still be wrong (fail-open cases, stale caches,
upstream drift). If reasoning is on and a finished turn streamed **zero `Thinking` deltas**,
surface a one-time inline notice on that turn ("this model returned no reasoning"). **No new
`ChatEvent` is needed**: the condition is derivable in the frontend from state the reducer already
holds, and every new variant is a compile-time obligation on the exhaustive reducer; spend that
budget only when the frontend genuinely lacks the data.

Two corrections made during implementation, both of which the original wording got wrong:

- **Judge the turn against a per-turn `reasoningRequested`, not the live `AiStatus.reasoning`.**
  The user can toggle reasoning off while a turn is streaming; the finished turn would then be
  judged against a flag it never ran under. `emptyAssistant(reasoningRequested)` pins the opt-in at
  turn creation, so the turn stays self-describing.
- **Test `thinking.trim() === ""`, not `thinking === ""`.** The `Reasoning` disclosure
  (`ChatMessages.tsx:349`) hides itself on whitespace. A lone `"\n"` delta would otherwise render no
  trace *and* suppress the notice explaining its absence — a check and its renderer must agree on
  what "empty" means. Both live behind `showsReasoningBackstop(turn)`; never re-derive the condition
  at a render site.

This section **supersedes** the earlier open question about whether `reasoning: false` suffices to
suppress Ollama's auto-thinking: probe the capability rather than guess at suppression.

## 5. The Ollama empty-content problem — spike + guard

Capability detection does **not** solve this one. Ollama's OpenAI-compatibility layer maps its
`thinking` output onto the `reasoning` field and auto-enables thinking for capable models when no
`reasoning_effort` is provided (https://docs.ollama.com/api/openai-compatibility). There is a live
failure class — Ollama issue [#15288](https://github.com/ollama/ollama/issues/15288) — where a
model returns **empty `content` with the entire answer in `reasoning`**.

That interacts badly with a deliberate invariant of ours: reasoning is **never folded into the
answer string** (`ai/openai.rs:42-61`), so citation verification stays byte-exact. If Ollama puts
the whole answer in `reasoning`, our answer is an empty bubble — a silent failure, which this
project forbids (DoD §1).

- **Spike (narrowed; before build):** can `qwen3.5` via the bundled Ollama return empty `content`
  with the answer in `reasoning` (`src-tauri/src/local.rs:361` sends `reasoning: false` today)?
- **Guard (required regardless of spike outcome):** a turn that streams **zero content tokens
  while reasoning tokens flowed** must surface as `ChatEvent::Error` with an actionable message
  ("the local model returned only reasoning and no answer — try again or switch model"), never a
  blank bubble. Pure detection logic lives in the core with tests. (Distinct from §4's backstop,
  which is the opposite case: reasoning expected, none arrived.)

## 6. Failure modes — all surfaced

- Model answers a factual question without searching → not detectable at runtime; caught by the §7
  eval, which is a release gate, not a dashboard.
- Zero searches on a turn → coverage footer suppressed (an empty footer is a lie of precision).
- Searches ran, nothing survived verification → the on-ramp card + the model's honest "nothing in
  your vault covers this" answer; never a fabricated citation.
- Selected model has no reasoning capability → toggles disabled with the model named, never a
  toggle that silently does nothing.
- Capability probe fails (offline, unknown model, upstream 500) → **fail open**: toggle enabled;
  the runtime backstop catches the no-op case.
- Reasoning on, zero `Thinking` deltas on a turn → one-time inline notice (§4), derived in the
  frontend, no new event.
- Ollama empty-content/full-reasoning turn → explicit `Error` event (§5), never a blank bubble.
- `set_reasoning` persistence failure → already surfaced by the existing command (it returns the
  persisted `AiStatus` or an error); the chat toggle inherits that behaviour.

## 7. The behavioural eval — the regression gate

A fixture set of five conversation cases, asserted per case on **search count** and **citation
count**, run against **both providers** (OpenRouter with the default model; bundled Ollama with the
curated default):

| Case | Expected searches | Expected citations |
|---|---|---|
| Greeting ("hey") | 0 | 0 |
| Meta ("what can you do?") | 0 | 0 |
| Factual, in vault | ≥1 | ≥1 |
| Factual, not in vault | ≥1 | 0, + an honest "nothing covers this" answer |
| Follow-up about its own prior answer | 0 | 0 |

*(Row 4 corrected: the answer must **not** offer capture. No capture pipeline exists until Slice 5,
and promising one is fabrication. It says nothing covers this and suggests adding a note.)*

**Mechanics.** Two tiers, and they prove different things — do not let the cheap one stand in for
the expensive one.

- **Unit tier (core).** The five cases against a scripted mock `LlmClient`
  (`orchestrator.rs:664`). Because the script decides whether a search happens, this tier proves
  *plumbing*, not behaviour: that the orchestrator injects no mandatory retrieval before the model's
  first turn, that a zero-search turn emits no `Coverage`, that citation/coverage counts flow
  intact. Necessary, and nowhere near sufficient.
- **Real-model tier (shell).** `crates/neuralnote-core` is deliberately **network-free**, so this
  cannot live there — it belongs in `app/desktop/src-tauri/tests/`, which owns the HTTP clients.

  *(Correction: an earlier draft said this matched "the Slice-1 pattern." No such pattern exists —
  the workspace has no `tests/` directory, no `#[ignore]`, and no env-gated test. It is designed
  here, not copied.)*

  Gate it on provider availability and **skip loudly**: `#[ignore]` is the wrong tool, since an
  ignored test does not skip, it silently never runs. The test must run, detect the missing
  provider, print an unmissable notice, and — critically — a skipped run must never read as a pass.
  Set `NEURALNOTE_REQUIRE_EVAL=1` (release/CI) to turn a skip into a hard failure.

Any regression on the real-model tier blocks ship — this eval *is* the moat check for this slice.

## 8. Testing (Definition of Done)

- **Rust unit** — prompt content assertions (both modes present, search mandate scoped to
  research mode); `supports_reasoning` / `supports_thinking` against the two real OpenRouter
  fixture arrays (§4) and Ollama capability fixtures (present, absent, empty, malformed);
  probe-cache behaviour (re-probe on model change, fail-open on probe error); the
  zero-content-with-reasoning guard (content-only, reasoning-only, mixed, empty streams); eval
  cases against the mock `LlmClient`.
- **TS unit/component** — coverage footer suppressed when `searchedTerms` is empty; on-ramp card
  renders on searches-but-no-citations and not otherwise; toggle states (enabled / disabled with
  model named / fail-open) in both the composer and Settings; the zero-`Thinking` inline notice
  renders once and only when the flag was on; chat-pane toggle renders from returned `AiStatus`
  (success and error paths).
- **e2e (jsdom + mockIPC, `src/e2e/`)** — greeting turn (no tool steps, no footer); factual turn
  (steps + citations, unchanged journey); not-in-vault turn (on-ramp card + CTA); toggling
  reasoning from the composer round-trips through the mocked `set_reasoning`; a reasoning-on turn
  with no `Thinking` events shows the backstop notice.
- **Integration (real)** — the §7 eval against both providers, gated on availability; one live
  probe of the OpenRouter models endpoint asserting the two fixture models still report as the
  fixtures say (a drift detector; skips loudly offline).
- ≥90 % coverage on changed code; both quality gates green; run it in the app by hand (a greeting,
  a real question, a miss, the toggle against a non-reasoning model). Not security-adjacent (the
  probe is a public unauthenticated GET, parsed defensively like the existing HF metadata fetch) —
  the §1 baseline applies, not §2.

## 9. Deferred

- Persisted chat history (would make a per-conversation reasoning flag meaningful — revisit then).
- Any structural (non-prompt) enforcement of research mode, e.g. a classifier turn. YAGNI until
  the eval shows prompt-only failing on models we actually ship.
- Wiring the on-ramp CTA to *launch* a capture — that button becomes real in Slice 4/5; here it
  can only point the user at what to paste.
- Reasoning *effort* levels (low/medium/high) — the probe payload exposes `reasoning_effort`; the
  toggle stays boolean until someone asks.

## 10. Resolved decisions (were open questions)

All settled 2026-07-10. Recorded rather than deleted, so the reasoning survives.

1. **Eval assertions.** The real-model eval asserts on **search counts, citation counts, and a
   keyword match** ("vault"), never on exact answer text. Exact-phrase assertions rot the first
   time a prompt is retuned, and a rotting eval gets deleted rather than fixed.
2. **The zero-`Thinking` backstop notice is informational.** No one-click "turn reasoning off"
   action: the fail-open case is often transient (a metadata call failed, not the model), and a
   transient notice that silently flips persisted global state is exactly the
   [[write-then-read]] class of surprise this project has already been bitten by.
3. **No TTL on the OpenRouter probe in v1.** Re-probe on model change and on app start. Models do
   *gain* reasoning support over time, so a never-restarted session would miss it — this is the
   first thing to revisit if "the toggle is greyed out but the model supports it" is ever
   reported. Cheap to add later; not worth a background timer now.
