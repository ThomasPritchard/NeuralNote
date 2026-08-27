# NeuralNote agent activity journal

> Status: approved design; not implemented.
>
> This specification refines the agentic chat experience described by
> [`ai-cited-chat-slice.md`](ai-cited-chat-slice.md),
> [`ai-skills-bank-slice.md`](ai-skills-bank-slice.md),
> [`agentic-chat-pane-plan.md`](agentic-chat-pane-plan.md), and
> [`agent-feedback-refinement-plan.md`](agent-feedback-refinement-plan.md). It follows the product
> contract in [`neural-note.md`](neural-note.md) and the acceptance bar in
> [`docs/definition-of-done.md`](../docs/definition-of-done.md).
>
> The design applies to **every agentic chat turn**. YouTube distillation is the first proving
> case because it combines several tool-deciding cycles, long-running tools, parallel calls, plan
> updates, and streamed note composition. Nothing in the journal, reducer, or presentation may be
> keyed to the YouTube skill, a YouTube tool name, or a YouTube payload shape.

## 1. Outcome

An agentic turn should feel active without becoming noisy. While work is running, NeuralNote shows
what is happening now. When the run finishes, it keeps enough detail to explain what happened and
why, without leaving a long wall of transient updates in the transcript.

The approved experience has these properties:

- Model reasoning is labelled **Thinking**, never Reasoning. Each completed tool-deciding cycle
  keeps a collapsed Thinking disclosure followed by a visible one- or two-sentence summary.
- Cycle numbers are internal correlation data. The user never sees “round 2”, “cycle 3”, or a
  maximum-round counter in this experience.
- The summary is model-authored through the existing `skill_step` tool. It is produced once for
  each cycle that is about to perform work, with no extra model request.
- The current action occupies one replace-in-place line. Parallel work is represented as
  `+N running`, not as an expanding list of progress messages.
- A note being composed streams inside a fixed-height, internally scrollable viewport. It follows
  the newest content until the user scrolls upward, then pauses and offers Jump to latest.
- Tool outcomes remain available after settlement in collapsed action audits grouped with the
  Thinking and summary that initiated them.
- A declared plan remains fully visible and status-updated while the run is active. It is sticky
  below the active turn, uses an internal scrollbar if it becomes long, and becomes a collapsed
  transcript disclosure when the run settles.
- The chosen presentation is a quiet transcript at balanced density, with expressive but brief
  motion and a complete reduced-motion path.

The selected layout is wireframe A: the live action and note viewport sit inline with the summary
that initiated them. There is no separate work dock, status inspector, or second activity surface.

## 2. What this design does not change

This is a presentation and event-ordering contract. It does not change:

- tool authorization, approval modes, path confinement, write budgets, cancellation, citation
  verification, or any other security control;
- the create-only and atomic nature of note writes. The stream is still a preview of model
  composition, not a stream of bytes being committed to disk;
- provider reasoning settings or token budgets;
- which tools a skill may use, apart from making `skill_step` available to every agentic turn;
- the rule that reasoning is excluded from model history and final-answer content;
- the vault format or any Obsidian-compatible markdown;
- chat persistence. “Retained in the transcript” means retained for the same lifetime as the
  existing chat transcript. This design does not add a vault file, database table, telemetry
  upload, or other durable store for reasoning or activity events.

The final-answer request remains distinct from tool-deciding cycles. Reasoning streamed while the
model composes the final answer gets a Thinking disclosure, but it does **not** require an extra
`skill_step` summary. The answer itself is the plain-language account.

## 3. Why the current shape cannot produce the intended order

`ChatEvent` is emitted in causal order, but the frontend folds different event families into
separate collections. `thinking` is one aggregate with boundaries, `skillSteps` is an append-only
list outside `ChatTimeline`, tool calls live in another list, and activity cues live in another.
`chatTimelineRows` then groups those collections by phase because there is no chronology field it
can use. The result is deterministic but false to the run: all Thinking disclosures appear before
all tools even when the backend actually alternated between them.

Several existing contracts are useful and should be preserved:

- `PlanningRound` already marks the start of each tool-deciding cycle.
- `ToolProgress` already carries a stable tool-call id and last-writer-wins progress text.
- `ToolCall` is emitted before dispatch and `ToolResult` settles it exactly once.
- `NoteEditPreview` may arrive before the corresponding `ToolCall`, and already carries the call id
  needed to reconcile the two.
- tool calls may run in parallel, so arrival order is chronology but is never a correlation key.
- `Plan` declares a stable ordered step set once and `PlanStepStatus` updates status in place.

The fix is to preserve causal order as first-class data before the frontend separates events into
views.

## 4. Terms and invariants

### 4.1 Terms

- **Turn**: one user prompt and the assistant run it starts. The existing caller-generated turn id
  remains its identity.
- **Tool-deciding cycle**: one model request that reasons about and returns a batch containing at
  least one non-administrative action. `PlanningRound` is the existing start beacon. The journal
  assigns the cycle an opaque id.
- **Final-answer phase**: the separate model request that produces the answer after tool work. It
  can stream Thinking, but is not a tool-deciding cycle and has no cycle summary.
- **Activity**: one logical unit of work, such as a tool call, approval, note composition, or
  verification task. Its stable id joins its start, progress, preview, and outcome.
- **Journal event**: one typed event in the turn's backend-sequenced activity stream.
- **Live projection**: the compact, changing representation shown while a turn is active.
- **Settled projection**: the retained transcript representation after the turn ends.

`cycleId` and `activityId` are implementation identities, not user copy. A cycle id is never
rendered. An activity id can be used for React keys and accessibility relationships but is never
presented as meaningful text.

### 4.2 Invariants

1. Every journal event has a strictly increasing sequence within its turn.
2. Sequence records emission order. It does not pretend that parallel work happened serially.
3. Every cycle-scoped event carries the opaque id of the cycle that owns it.
4. Every activity-scoped event carries one stable activity id from first preview or announcement
   through terminal outcome.
5. A progress or outcome event is correlated by activity id, never by display text, tool name, or
   proximity to another event.
6. Every announced or provisional activity reaches a terminal state. Run termination must not
   leave a spinner or composing card active.
7. A tool-deciding cycle that dispatches work has at most one accepted summary and exactly one
   visible summary, using a neutral fallback when the model does not provide a valid one.
8. Final-answer reasoning has no cycle summary.
9. The live and settled representations are projections of the same journal state. Settlement
   does not rebuild a different story from independent arrays.
10. Progress text is transient and replaceable. Tool outcomes, failures, abandoned previews,
    Thinking content, accepted summaries, and final plan state remain inspectable.
11. No model-authored string is used for authorization, activity correlation, tool selection, or
    state transition decisions.
12. A malformed or incomplete event sequence is surfaced. The UI may degrade, but it may not
    silently invent ordering or completion.

## 5. Architecture

The reusable Rust core owns the ordered journal because it owns the agentic loop and already emits
the causal `ChatEvent` stream. The Tauri shell transports typed envelopes and continues to own
native I/O. React folds the envelopes into a compact turn projection and renders it. The webview
does not assign authoritative sequence numbers for the new protocol.

```text
model and tools
      |
      v
Rust orchestrator and tool dispatch
      |
      | typed payloads through one per-turn sequencer
      v
AgentActivityEnvelope { turn, sequence, cycle, activity, payload }
      |
      v
Tauri channel, unchanged trust direction
      |
      v
frontend journal reducer
      |----------------------|
      v                      v
live projection       settled transcript projection
```

The sequencer sits at the final shared emission boundary. Parallel producers submit typed payloads
to that boundary; the boundary assigns a sequence and sends the envelope as one operation. Assigning
numbers earlier and sending later would permit two parallel tasks to arrive in the opposite order
to their numbers.

### 5.1 Structured envelope

The implementation may use Rust names that match repository conventions, but the wire contract is
fixed conceptually as follows:

```rust
struct AgentActivityEnvelope {
    schema_version: u16,       // 1 for this contract
    turn_id: String,
    sequence: u64,             // strictly increasing within turn_id
    cycle_id: Option<String>,  // opaque and never rendered
    activity_id: Option<String>,
    payload: AgentActivityPayload,
}
```

`payload` is a serde-tagged enum with generated TypeScript bindings. It is not an untyped JSON
object and it does not use a generic `message` field to smuggle state. Payload families cover:

- run and cycle lifecycle;
- Thinking deltas and accepted cycle summaries;
- activity start, progress, approval, settlement, and abandonment;
- semantic note preview fields (`relPath`, `kind`, `body`, `complete`), never partial tool JSON;
- transcript provenance and other typed tool outcomes;
- plan declaration and step status transitions;
- verification, citation, coverage, usage, partial-run, error, cancellation, and completion events.

Existing typed fields remain typed. Examples include `ToolStatus`, `NoteKind`, `StepStatus`, line
ranges, duration, playlist position, approval decisions, and missing-binary remedies. The new
envelope adds order and ownership; it does not flatten those contracts into prose.

Run-level events such as usage and terminal settlement have no cycle or activity id. Cycle
lifecycle, Thinking, and the cycle summary have a cycle id and no activity id. Tool progress and
note previews have both. Final-answer Thinking has no cycle id and carries a structured source of
`finalAnswer`, so the renderer can place it without fabricating a cycle.

The opaque cycle id is allocated when the orchestrator emits the existing `PlanningRound` beacon.
Its numeric `round` and `maxRounds` fields may continue to serve loop guards and legacy clients,
but the new UI does not render them. A stable activity id normally reuses the provider tool-call id.
Host-created activities use a collision-resistant id scoped to the turn. These ids are correlation
keys, not secrets or authorization capabilities.

### 5.2 Journal reduction and compaction

The frontend reducer processes envelopes in sequence order and maintains semantic entries rather
than one React node per event:

- consecutive Thinking deltas for one source append to one text buffer;
- repeated progress events replace the activity's current progress string;
- note previews replace the activity's current semantic preview body;
- plan statuses replace the status for an existing declared step;
- an activity settlement fills the terminal fields on the existing activity;
- the first sequence and last sequence remain available for stable ordering and diagnostics.

This keeps transcript growth proportional to cycles, activities, note bodies, and reasoning text,
not to token or progress-event count. Raw streamed deltas do not remain as individual DOM nodes.
Collapsed audit bodies may be lazy-mounted from compact state so a long transcript does not carry
every hidden detail in the active render tree.

### 5.3 Legacy fallback

The current bare `ChatEvent` stream remains readable during migration. A frontend ingestion adapter
may wrap a legacy run with a local synthetic sequence in channel-arrival order, derive cycle
boundaries from `PlanningRound`, and reuse existing call ids for activity ids.

This is a compatibility path, not an equal contract:

- it can preserve the order of events received during the current live run;
- it cannot recover chronology that was already lost in a previously folded or restored turn;
- preview-before-call reconciliation is allowed only when the preview carries the same id;
- it must not use FIFO matching for uncorrelated parallel work;
- the first event locks a turn to either envelope v1 or legacy mode. A mixed stream is a visible
  protocol error, not permission to merge two clocks.

The fallback can be removed only after every producer and fixture emits envelope v1. Generated
bindings are regenerated from Rust. `app/desktop/src/lib/bindings/` is never edited by hand.

## 6. Tool-deciding cycles and summaries

### 6.1 `skill_step` becomes global agent infrastructure

`skill_step` is advertised on every agentic tool-deciding request, whether or not a named skill is
active. It remains an administrative, non-authorizing tool. Skill instructions can still give it
more specific copy guidance, but its availability and summary semantics are part of the global
agent contract.

The existing bare `ChatEvent::SkillStep` is overloaded: model calls, requirement downloads,
activation failures, and playlist orchestration can all emit it today. Envelope v1 must remove that
ambiguity rather than infer authorship from message text. An accepted model tool call becomes a
typed `CycleSummary` with source `model`; a runtime fallback becomes the same payload with source
`fallback`; host-authored download, playlist, activation, and recovery updates become typed
activity progress or run-status payloads. Only the migration adapter handles a bare legacy
`SkillStep`, and it keeps that event as legacy narration rather than upgrading it to a trusted cycle
summary.

The system instruction asks the model to include exactly one `skill_step` alongside every batch of
real work. Its message should be one or two short sentences that explain what the model learned from
its Thinking and what it is about to do. It should use ordinary user language, not tool names, JSON,
or hidden chain-of-thought detail.

This creates no extra model request. Reasoning and tool calls arrive from the existing
tool-deciding request. The backend examines that completed call batch before dispatching its work.
The administrative call itself is not a visible activity, does not contribute to `+N running` or
the Actions count, and cannot affect approval, write, citation, or evidence budgets. A malformed or
duplicate call may still appear under the audit's protocol details.

### 6.2 Acceptance and fallback

Calls are considered in provider order. The first structurally valid `skill_step` is accepted as
the cycle summary. A valid message:

- has valid tool arguments;
- is non-empty after trimming and whitespace normalization;
- is a single visual paragraph with no control characters;
- contains no more than 320 Unicode scalar values after normalization.

The model is instructed to use one or two sentences. The host does not implement a home-grown
natural-language sentence parser because abbreviations and punctuation make it an unreliable
control. Summary text is always rendered as plain text, never interpreted as Markdown or HTML.

Malformed calls do not become transcript summaries. Additional valid calls after the first are
duplicate administrative calls: they receive a deterministic tool result but do not produce more
visible summaries. If no valid call exists when the first real action is ready to be announced, the
backend builds one neutral summary from the next host-authored activity title, using bounded
application copy such as `Next, I’ll fetch the captions.` If no safe activity title is available,
it emits the generic fallback `Continuing with the next step.`

The structured summary payload records whether its source is `model` or `fallback`. The fallback is
not attributed to the model. A malformed, missing, late, or duplicate call remains visible under
protocol details in that cycle's collapsed Actions audit without turning into another summary
block. The run continues; progress narration must never become a new availability dependency for
the work itself.

The accepted summary is sequenced after the cycle's Thinking and before any activity-start payload
from the same completed batch. This remains true when the batch contains parallel calls. The summary
tool's own administrative success is not rendered as a user action; the summary is its user-facing
result.

A tool-deciding request that returns no real work and hands control to the final answer does not
need a `skill_step`. It is treated as the transition to the final-answer phase, not as an empty
work cycle with a fabricated update.

If the model returns `skill_step` without any real work in the same batch, the host returns the
administrative tool result as required by the provider protocol but does not publish its message as
a cycle summary. The following request is a recovery from malformed model behaviour, not an extra
request introduced by this design.

### 6.3 Thinking presentation

Each tool-deciding cycle owns one Thinking buffer. Its disclosure label is exactly **Thinking**.
There is no visible cycle or round suffix. Multiple disclosures remain understandable through their
position beside the summaries and actions they led to.

Thinking remains collapsed by default in both live and settled views. The user can expand it at any
time. New deltas update the same disclosure without opening it or moving focus. Provider models that
stream no reasoning produce no disclosure; the existing missing-reasoning account can remain where
the product already uses it.

Final-answer Thinking is placed immediately before the final answer. It uses the same label and
collapsed treatment, but has no summary block.

## 7. Live representation

### 7.1 State transitions

A normal cycle follows this state model:

```text
cycle started
    -> thinking (zero or more deltas)
    -> summary accepted or fallback inserted
    -> acting (one or more activities, possibly parallel)
    -> settled
```

An activity follows:

```text
announced -> active -> succeeded | failed | denied | cancelled | timed out
       \-> provisional preview -> active when its call arrives
                               \-> abandoned if it never does
```

The turn follows:

```text
preparing -> active cycle(s) -> final answer -> succeeded
                         |-> awaiting user -> active or terminal
                         |-> failed | cancelled | incomplete
```

`awaiting user` is not presented as working. An elicitation or approval prompt owns the active
surface until it resolves. Timers, cancellation, and existing security prompt semantics remain
authoritative.

From the cycle-start beacon until the summary or first action replaces it, the turn's live status
reads **Thinking**. This is the user-facing name of the tool-decision phase, not a claim that the
provider exposes reasoning tokens. When reasoning deltas do arrive, they populate the cycle's
collapsed Thinking disclosure. A provider that exposes none can still show the live Thinking phase
without fabricating disclosure content.

### 7.2 Inline live surface

The active turn is one transcript block. A cycle appears in this order:

```text
[Thinking disclosure]
Plain-language cycle summary
  Current action                                   +2 running
  [fixed-height note viewport, when this activity composes a note]
  [Jump to latest, only while follow is paused]
```

The current action line is derived, not appended. It uses the latest host-authored progress message
for the selected activity, falling back to the host-authored activity title. `ToolProgress` updates
that line in place and refreshes liveness. It replaces the live Thinking label in the same polite
status region, so assistive technology hears a phase change rather than two competing live regions.

When several activities are active, the activity with the most recent progress or start sequence is
current. `+N running` counts the other non-terminal activities in that cycle. When the current
activity settles, the most recently updated remaining activity becomes current. Activities never
reorder in the settled audit; this selection rule changes only the live focus.

Only one live note viewport is shown at a time. If parallel activities stream more than one note,
the viewport follows the selected current activity and preserves the other buffers. Switching live
focus never discards or combines note content.

Once a cycle settles, its replace-in-place line disappears. Its Thinking disclosure, summary, and
collapsed action audit remain in that position while the next cycle starts below them. The final
answer follows the last cycle. This preserves chronology without maintaining a growing visible list
of transient statuses.

### 7.3 Note composition viewport

The live note body has a fixed block size at every supported pane width. Long lines and Markdown
wrapping must not expand the card. The body scrolls internally with ordinary text selection and
keyboard scrolling.

Follow behaviour is explicit:

1. On first content, the viewport follows the tail.
2. While the user remains at the bottom, each update keeps the newest text visible.
3. Scrolling upward beyond a small bottom tolerance pauses follow immediately.
4. New content never pulls a paused user away from what they are reading.
5. A visible Jump to latest control appears while paused. Activating it moves to the bottom and
   resumes follow.
6. Manually returning to the bottom also resumes follow and removes the control.
7. Follow state is per activity. Switching between parallel note previews does not transfer a
   paused state to another note.

A `NoteEditPreview` that arrives before `ToolCall` creates a provisional activity keyed by its
stable activity id. The later call enriches the same activity in place. It must not remount the
viewport, reset scroll position, or create a second audit row. If the call never arrives, a terminal
abandonment records the reason and stops all live treatment.

Successful settlement replaces the live preview with the normal written-note outcome and open-note
affordance. Failure, denial, cancellation, invalid arguments, or a truncated tool turn retains an
abandoned-preview account in the collapsed audit so partial composition never looks committed.

### 7.4 Sticky plan

If the model declares a plan, the complete plan appears beneath the active turn's live activity
region and stays sticky above the composer while the turn remains active. It is part of the turn,
not a separate dock.

- Every declared item remains visible in declaration order.
- Status changes update the existing item; items never move as work completes.
- The plan has a bounded maximum block size. When it exceeds that size, the plan itself scrolls;
  the transcript does not grow indefinitely to keep every plan item on screen at once.
- “All items visible” means no item is omitted, summarized away, or hidden behind progressive
  disclosure. A long plan may require scrolling within its bounded viewport.
- The currently running item has the existing semantic status treatment. Motion is not the only
  status channel.
- If no plan is declared, no placeholder or synthetic plan appears.

On turn settlement, the sticky behaviour ends and the same plan becomes a collapsed disclosure in
the transcript. It retains every item and the last authoritative status. If the run ended early,
pending or running labels remain static rather than spinning, and a visible “Run ended early”
account explains why the plan is unfinished. The renderer does not invent success, failure, or
skipped statuses the backend did not emit.

## 8. Settled transcript

The settled representation is intentionally quiet. For each tool-deciding cycle it retains, in
sequence:

1. the collapsed Thinking disclosure, when reasoning exists;
2. the visible one- or two-sentence summary, including the neutral fallback when needed;
3. one collapsed Actions disclosure containing the cycle's activities and outcomes.

The Actions label may include an action count and a failure indicator, but not a cycle number.
Inside, activities stay ordered by first sequence. Parallel completion never reorders them. Each
entry can expose its host-authored title, terminal status, summary, duration, bounded detail,
approval account, and written or abandoned note outcome as applicable.

Transient progress messages do not become permanent rows. The final progress string may be kept as
diagnostic detail only when it explains an interruption and no better terminal summary exists.
Run-level cancellation, failure, partial completion, truncation, and citation problems remain
visible outside a collapsed audit. A user must not have to open a disclosure to learn that the turn
failed or ended incomplete.

The settled plan follows the cycle history as one collapsed Plan disclosure. The final answer,
citations, coverage, usage, skill report, and Undo semantics retain their existing roles. The journal
changes ordering and density; it does not demote citation or write outcomes.

## 9. Visual direction and motion

The transcript should be quiet, with balanced density. The active turn gets slightly more breathing
room than it has now: increase relative inset and the summary/body type scale by one existing design
token step. Reuse the current colour, border, radius, typography, and spacing tokens. Do not add a
new palette or hard-coded one-off dimensions to make this feature look distinct.

The hierarchy is:

- summary and final answer at the strongest text contrast;
- current action and active plan at the next level;
- Thinking and action-audit labels as restrained controls;
- raw arguments, diagnostic details, and usage as secondary information.

Motion can be expressive while remaining brief:

- replacement status text uses a short opacity and small vertical transition;
- a new summary and its live activity region settle into place without moving earlier transcript
  content unnecessarily;
- Thinking and genuinely active progress may use a restrained shimmer and a faster activity
  indicator;
- the active note tail may use typing-cursor energy while content is arriving;
- completion uses one restrained state transition, not a celebratory sequence;
- automatic note following is immediate or minimally eased so streaming text remains readable.

Animated elements occupy reserved space. Motion must never change layout, obscure status text, or
shift earlier transcript content.

Under `prefers-reduced-motion`, transforms, animated scrolling, pulses, and decorative transitions
are removed. Status text, glyphs, labels, and terminal outcomes still carry the full meaning. No
information depends on motion.

## 10. Accessibility

- The replace-in-place action line is the turn's single `role="status"` / polite live region.
  Updating it must not re-announce the summary, audit, plan, elapsed clock, or whole turn.
- Rapid progress updates are coalesced before announcement. Repeated text is not announced again.
- Thinking and Actions use native disclosure semantics or equivalent buttons with accurate
  `aria-expanded` and controlled-region relationships. Their accessible names do not expose hidden
  cycle numbers.
- The note viewport is keyboard focusable only when needed for scrolling or selection, has a clear
  label, and never steals focus when content updates.
- The note body is not a token-level live region. The action line announces meaningful changes;
  note completion or abandonment receives a concise status announcement.
- Jump to latest is a real button with a stable accessible name. Focus remains on the button after
  activation unless the user explicitly moves it.
- The plan is a labelled ordered list. Status text is available to assistive technology before each
  model-authored label, and colour or animation is never the sole status channel.
- Sticky and internally scrolling regions preserve visible focus indicators and do not trap Tab,
  arrow, Page Up, Page Down, Home, or End behaviour.
- Model-authored summary and plan text is rendered as text. Raw HTML is never introduced through
  this feature.
- Narrow, wide, high zoom, increased text size, keyboard-only, VoiceOver, and reduced-motion paths
  are part of acceptance, not follow-up polish.

## 11. Cancellation, failure, and incomplete sequences

### 11.1 User cancellation

Cancellation stops new dispatch, emits terminal outcomes for announced activities, abandons every
provisional note preview, and settles the turn as cancelled or partial according to the existing
orchestrator truth. Completed writes and tool outcomes remain in their cycle audits. The current
action line stops immediately. The transcript shows the cancellation account outside the collapsed
audit.

### 11.2 Tool or provider failure

A tool failure settles only that activity unless the orchestrator ends the turn. Sibling parallel
activities retain their own outcomes. A provider or fatal orchestrator error settles the turn,
marks any still-active activities interrupted, and preserves already received Thinking, summaries,
previews, outcomes, and plan state.

The runtime-authored summary fallback is allowed when summary generation failed, but it must not
mask the actual provider or tool error. The visible error remains the authoritative account.

### 11.3 Partial completion

`PartialRun` remains authoritative. The settled transcript keeps completed activities, clearly
marks interrupted or abandoned ones, and leaves the plan at its last reported statuses with a
visible early-end explanation. It does not infer that pending work was completed.

### 11.4 Protocol break or transport loss

The reducer detects duplicate or regressing sequence numbers, mixed legacy and v1 events, outcomes
for unknown activity ids, conflicting cycle ownership, and channel closure without a terminal run
event. It keeps the safely correlated content already received, stops live animation for affected
entries, and surfaces a visible “Activity history is incomplete” warning.

The UI must not guess that an uncorrelated preview belongs to the next tool call. It must not hide
the warning because the final answer happened to arrive. Diagnostics may contain bounded ids and
event kinds, but never provider secrets, vault content beyond what the transcript already displays,
or unrestricted raw tool payloads.

## 12. Security, privacy, and trust boundaries

This work crosses the Rust-to-webview IPC boundary, changes a model-tool contract, and renders
model-authored content, so its implementation is security-sensitive under the repository contract.
It requires an independent adversarial review.

- Reasoning, `skill_step` summaries, plan labels, tool arguments, note previews, and provider error
  text are untrusted. They are bounded at their existing source boundaries and rendered through
  safe text or existing Markdown paths as appropriate.
- Summary validity is a presentation rule, not an authorization control. Omitting, duplicating, or
  manipulating a summary cannot add a tool, approve a call, change a path, or bypass a budget.
- Plan status and visible action state are observational. They never grant authority or prove that
  a write occurred. Only host-side tool settlement and `NoteWritten` do that.
- A note preview remains restricted to the existing previewable-tool allowlist and Rust semantic
  parser. The webview never receives arbitrary half-JSON and never treats preview content as a disk
  write.
- Sequence and correlation ids are generated or accepted only in their scoped backend contracts.
  They are not trusted across turns and are not reusable as IPC authorization tokens.
- Tool details remain bounded and secrets remain redacted. The journal must not create a new log of
  API keys, full provider request bodies, hidden system prompts, or unrestricted tool arguments.
- This design adds no third-party request, CSP origin, analytics event, or durable reasoning store.
  Any later decision to persist or export the journal needs a separate privacy and retention design.
- Citation events and verification keep their existing deterministic authority. Reordering the UI
  must not reorder evidence, reattach a citation, or allow model prose to manufacture provenance.

## 13. Compatibility and delivery boundaries

Implementation should land in reviewable layers, but this specification does not prescribe branch
or worktree ceremony:

1. Add the typed envelope, per-turn sequencer, opaque cycle identity, stable activity identity, and
   legacy ingestion contract without changing visible behaviour.
2. Make `skill_step` globally available, enforce one accepted summary per work cycle, and emit the
   fallback without adding a model call.
3. Move the frontend from independent chronology-free collections to the compact journal reducer,
   preserving existing report cards, approvals, citations, and Undo behaviour.
4. Add the selected inline live and settled projections, note follow controller, and sticky plan.
5. Remove the legacy fallback only after fixtures, providers, and restored-turn assumptions have
   been audited and no supported producer emits bare events.

No phase may hard-code YouTube names to make the proving journey pass. Generic tests must use at
least one non-YouTube multi-tool turn, and the journal reducer must have no dependency on the skills
registry.

## 14. Verification strategy

### 14.1 Rust unit and integration coverage

Cover:

- per-turn sequences under sequential and parallel emitters;
- cycle allocation from each tool-deciding start and final-answer Thinking without a cycle;
- stable activity identity from preview-before-call through settlement;
- progress and outcome correlation with parallel calls completing out of order;
- first-valid `skill_step`, malformed, empty, oversized, control-character, duplicate, late, and
  omitted cases;
- host-authored legacy `SkillStep` sources cannot be mistaken for model cycle summaries;
- `skill_step` does not become a live activity, parallel count, or settled action row;
- neutral fallback sequencing before the first real activity;
- a call batch that has no real action and proceeds to the final answer without a summary;
- cancellation, partial completion, fatal error, approval timeout, abandoned preview, and exact
  terminal settlement for every announced activity;
- serialization golden tests for envelope v1 and tolerant legacy reads;
- generated TypeScript binding drift.

### 14.2 Frontend unit and component coverage

Cover:

- alternating Thinking, summary, and tool events remain alternating in the transcript;
- sequence is the ordering source and ids are the only correlation source;
- no visible round or cycle number appears;
- one current action replaces in place and `+N running` tracks parallel activity accurately;
- progress coalesces instead of adding transcript rows;
- every cycle keeps its Thinking disclosure, visible summary, and collapsed Actions audit;
- final-answer Thinking appears without a summary;
- a provisional note activity upgrades without remounting or losing follow state;
- first valid summary and runtime fallback source are represented honestly;
- the full active plan updates in declaration order and settles into one collapsed disclosure;
- run failure, cancellation, partial completion, and incomplete protocol warnings remain visible;
- legacy and v1 runs degrade independently, while a mixed stream is rejected visibly;
- old collapsed audit bodies are lazy-mounted without losing accessible state.

### 14.3 Browser-tier geometric coverage

The following cannot be proven in jsdom and require `test:browser` plus
`typecheck:browser`:

- wrapped note content cannot increase the fixed viewport height;
- bottom-follow, manual upward scroll, pause tolerance, Jump to latest, and resume-at-bottom;
- no focus jump or scroll jump when preview becomes a full tool activity;
- the sticky plan remains below the active turn and above the composer;
- a long plan scrolls internally without hiding an item or expanding the transcript indefinitely;
- default, narrow, expanded, zoomed, and increased-text layouts use the selected inline wireframe
  and never create a separate dock;
- the roomier token-relative spacing and type scale do not cause clipping or horizontal overflow;
- reduced-motion CSS removes transforms and animated scrolling while preserving state changes.

### 14.4 Journey and native coverage

The mock-IPC journey suite needs:

- a generic agentic turn with two tool-deciding cycles;
- the YouTube distil proving journey with captions, note composition, plan updates, and final answer;
- a long wrapped note, a preview before its call, and two parallel activities;
- a model that supplies no reasoning;
- missing, malformed, and duplicate summaries;
- cancellation during note composition, a tool failure beside a successful sibling, a partial run,
  and transport termination without a terminal event.

The real-app walkthrough must use the shipped WKWebView path, not logs or a green test as UI proof.
Exercise a reasoning-capable model and a non-reasoning model, a long YouTube note, upward scrolling
while tokens continue, Jump to latest, a long plan, cancellation, and a failure. Confirm that the
exact bundle under test is the development identity required by the Definition of Done. Check the
same journey with keyboard-only navigation, VoiceOver, reduced motion, default width, and expanded
width.

### 14.5 Applicable gates before implementation handoff

The completed implementation must run and report the exact results of:

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:unit
npm --prefix app/desktop run test:run
npm --prefix app/desktop run test:browser
npm --prefix app/desktop run typecheck:browser
cargo test --workspace --locked
npm --prefix app/desktop run check:bindings
```

Because this changes IPC and user-facing behaviour, it also requires the Definition of Done's
coverage, build, Rust quality, dependency, secret-scan, focused review, independent adversarial
review, and real-app gates before merge. SonarQube remains a maintainer milestone gate and must be
reported as Passed, Failed, or Unavailable rather than silently omitted when it is requested.

## 15. Acceptance criteria

The design is implemented only when all of the following are true:

1. Every new-protocol event in an agentic turn has a typed envelope and strictly increasing backend
   sequence.
2. A multi-cycle transcript renders Thinking, summary, and work in causal order rather than grouping
   all Thinking at the top.
3. The user sees Thinking and never Reasoning, round numbers, cycle numbers, or maximum-round copy.
4. Each work-producing tool-deciding cycle shows exactly one visible one- or two-sentence summary;
   first valid model copy wins and a missing or malformed summary produces one neutral fallback
   without another model request.
5. Final-answer reasoning creates a Thinking disclosure and no extra summary.
6. Live progress occupies one replace-in-place line. Parallel work is represented accurately as
   `+N running`, and all outcomes remain in the cycle's settled audit.
7. Long and wrapped note composition remains inside a fixed-height viewport. Tail follow pauses on
   upward user scroll and resumes through Jump to latest or returning to the bottom.
8. A note preview arriving before its tool call upgrades the same activity without duplicate UI,
   content loss, focus loss, or scroll reset.
9. A declared plan is complete, sticky, status-updated, and internally scrollable while active, then
   retained as a collapsed disclosure after settlement.
10. Cancellation, failure, partial completion, abandonment, and broken event sequences leave no
    live spinner and no silent disappearance of received work.
11. The settled transcript remains compact: transient progress does not become permanent rows,
    streaming deltas are coalesced, and old collapsed bodies do not impose an unbounded DOM cost.
12. Status, disclosures, note scrolling, plan updates, motion, focus, and announcements meet the
    accessibility contract in section 10.
13. Existing approvals, write controls, Undo, citation verification, coverage, usage, vault
    compatibility, and provider privacy boundaries remain intact.
14. Both a generic multi-tool journey and the YouTube distil proving journey pass. No production
    branch of the implementation special-cases YouTube to satisfy this design.
