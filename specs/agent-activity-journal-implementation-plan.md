# NeuralNote agent activity journal implementation plan

> Status: approved implementation plan; implementation in progress.
>
> This plan implements the approved design in
> [agent-activity-journal.md](agent-activity-journal.md). It does not reopen the product or visual
> decisions in that specification.
>
> Tom approved this plan on 2026-08-24. No commit, push, release, licence change, or
> repository-visibility change is part of this work unless Tom asks separately.

## 1. Outcome

Replace the chronology-free collections used by the current agentic chat pane with one
backend-sequenced activity journal. Every agentic turn should then render Thinking, its short
plain-language summary, and the work it initiated in causal order.

The implementation applies to all agentic turns. YouTube distillation is the first proving journey,
not a special branch in either Rust or React.

The completed implementation must provide:

- one strictly increasing backend sequence per turn;
- hidden cycle identity and stable activity identity;
- a globally available, non-authorizing skill_step summary tool;
- one accepted or fallback summary before each work-producing batch;
- one replace-in-place live action with an accurate +N running count;
- collapsed per-cycle action audits after settlement;
- a fixed-height inline note viewport with tail follow, pause, and Jump to latest;
- a complete sticky plan while active and a collapsed plan after settlement;
- visible failure, cancellation, partial-run, and incomplete-history accounts;
- the approved quiet transcript, balanced density, expressive motion, and reduced-motion path;
- no visible round or cycle numbers;
- no change to citation authority, tool approval, write confinement, write budgets, Undo, or vault
  compatibility.

## 2. Implementation rules

1. Use test-driven development for every phase. Add the smallest failing test first, run it red,
   implement the smallest coherent change, then run it green.
2. Keep the Rust core authoritative for ordering, cycle ownership, activity ownership, summary
   acceptance, and terminal state. React projects state; it does not reconstruct authority.
3. Keep current ChatEvent producers as an internal transition seam until the envelope cutover is
   complete. Do not force provider clients and every tool to manufacture wire envelopes directly.
4. Assign sequence and deliver the envelope in the same final sink operation. Never reserve a
   number before an asynchronous send.
5. Correlate by typed ids only. Never match a tool, preview, approval, outcome, plan step, or
   transcript source by display copy, tool name, array position, or arrival proximity.
6. Treat model summaries, plan labels, note previews, reasoning, tool arguments, and provider
   errors as untrusted. Summary validity is presentation policy, never authorization.
7. Keep every new frontend source file below the 500-line limit. Split by responsibility before
   approaching the guardrail.
8. Do not hand-edit generated TypeScript bindings.
9. Preserve unrelated working-tree changes and stage only named files if Tom later requests a
   commit.
10. An intermediate phase may keep a compatibility projection for the existing UI, but the final
    v1 live and settled activity surfaces must derive from the journal.

## 3. Current seams

The implementation should work with the repository rather than around it:

- crates/neuralnote-core/src/ai/events.rs contains the current typed ChatEvent payloads and
  EventSink contract.
- crates/neuralnote-core/src/ai/orchestrator/collect.rs opens each PlanningRound, performs the
  tool-deciding request, and hands the completed batch to tool dispatch.
- crates/neuralnote-core/src/ai/orchestrator/tool_batch.rs announces and settles every tool call.
- crates/neuralnote-core/src/ai/skill_tools.rs owns the current skill_step schema and dispatcher.
- crates/neuralnote-core/src/ai/tools.rs builds the advertised schema set and freezes the authorized
  tool names for each model request.
- crates/neuralnote-core/src/ai/tool_registry.rs owns host-authored tool titles.
- app/desktop/src-tauri/src/ai.rs owns the Tauri channel sink and closed-webview lifecycle signal.
- app/desktop/src-tauri/src/commands/ai.rs owns the chat command, turn id, cancellation filter, and
  early error paths.
- app/desktop/src/workspace/chatTurnStream.ts routes one event to its assistant turn.
- app/desktop/src/workspace/chatMessageReducer.ts folds the bare ChatEvent union into independent
  arrays.
- app/desktop/src/workspace/chatTimelineRows.ts reconstructs display rows after chronology has
  already been lost.
- app/desktop/src/workspace/ChatSkillChrome.tsx appends skill narration outside the timeline.
- app/desktop/src/workspace/ChatNoteEditCard.tsx renders note previews outside their initiating
  cycle and limits logical lines without owning a fixed scroll-following viewport.
- app/desktop/src/workspace/ChatPlanNode.tsx renders plan steps inside the current process rail.
- app/desktop/src/workspace/ChatMessages.tsx composes these separate surfaces.

Two current payloads need stronger correlation during this work:

- NoteWritten and NoteExists need the originating call id so the resolved write outcome can settle
  the previewed activity without a path guess.
- TranscriptSource and any other tool-owned outcome that still drops its call id need to retain the
  id already available at the CallChannel or dispatch boundary.

## 4. Target boundaries

### 4.1 Core journal boundary

Add a core-owned SequencedActivitySink between the current internal EventSink producers and the
host transport:

    providers, orchestrator, and tools
        -> internal typed ChatEvent
        -> SequencedActivitySink
        -> AgentActivityEnvelope
        -> host ActivityEnvelopeSink

SequencedActivitySink owns:

- turn id;
- next sequence;
- current cycle id;
- whether Thinking belongs to a tool-deciding cycle or the final answer;
- typed payload conversion;
- activity-id extraction;
- host-status classification;
- terminal bookkeeping needed to prevent live entries surviving settlement.

The Tauri shell supplies the channel and lifecycle cancellation. It does not assign sequence or
infer cycle ownership.

### 4.2 Frontend journal boundary

Add a frontend journal reducer that accepts either:

- an envelope-v1 event from the real IPC channel; or
- a bare legacy ChatEvent through a migration adapter.

The first event locks the turn to one protocol. Mixing legacy and v1 produces a visible incomplete
history warning.

The reducer owns compact semantic state. Selectors produce:

- live cycle projection;
- settled cycle projection;
- current activity and +N running;
- one selected live note preview;
- full plan state;
- protocol warning and terminal state.

The v1 UI consumes these selectors. Existing answer, citations, coverage, usage, report cards, and
Undo consumers can continue using their established view fields while the journal migration is
completed.

### 4.3 Tool-turn presentation buffer

NoteEditPreview can stream before the model has completed the tool-call batch. The summary cannot
be accepted until that batch is complete. To preserve the approved order:

1. Thinking and keepalive events continue to the journal immediately.
2. Note previews are held in a bounded per-call presentation buffer during the tool-decision turn.
3. Repeated preview fragments coalesce to the latest semantic preview per call id.
4. When the completed batch arrives, the host validates skill_step in provider order.
5. The accepted or fallback CycleSummary is emitted.
6. The latest buffered preview for each real call is flushed in provider-call order.
7. Tool calls are announced and dispatched.

If the model turn fails, buffered previews that were never visible are discarded. If a preview was
already flushed, cancellation or failure must emit its terminal abandonment.

This buffer is presentation ordering, not model-history rewriting. The original assistant tool
calls and exactly one tool result per declared call remain in provider protocol order.

## 5. File ownership

### New Rust modules

- crates/neuralnote-core/src/ai/activity_journal.rs
  - envelope and payload types;
  - summary source, phase source, protocol issue, and lifecycle enums;
  - ActivityEnvelopeSink and SequencedActivitySink;
  - total internal-event classification;
  - sequence, cycle, activity, and terminal invariants.
- crates/neuralnote-core/src/ai/cycle_summary.rs
  - skill_step argument parsing and normalization;
  - 320-scalar validation;
  - first-valid selection;
  - duplicate, malformed, late, omitted, and summary-only outcomes;
  - host-authored fallback selection.
- crates/neuralnote-core/src/ai/tool_turn_presentation.rs
  - bounded preview buffering and coalescing;
  - flush and discard rules;
  - retry-visible-emission accounting.

### Existing Rust modules

- crates/neuralnote-core/src/ai/mod.rs
- crates/neuralnote-core/src/ai/events.rs
- crates/neuralnote-core/src/ai/tool_registry.rs
- crates/neuralnote-core/src/ai/tools.rs
- crates/neuralnote-core/src/ai/skill_tools.rs
- crates/neuralnote-core/src/ai/skills.rs
- crates/neuralnote-core/src/ai/call_channel.rs
- crates/neuralnote-core/src/ai/orchestrator/prompt.rs
- crates/neuralnote-core/src/ai/orchestrator/collect.rs
- crates/neuralnote-core/src/ai/orchestrator/tool_batch.rs
- crates/neuralnote-core/src/ai/orchestrator/session.rs
- crates/neuralnote-core/src/ai/orchestrator/playlist.rs
- app/desktop/src-tauri/src/ai.rs
- app/desktop/src-tauri/src/commands/ai.rs
- app/desktop/src-tauri/src/requirement_download.rs

### New frontend modules

- app/desktop/src/workspace/activityJournal.ts
- app/desktop/src/workspace/activityJournalReducer.ts
- app/desktop/src/workspace/activityJournalSelectors.ts
- app/desktop/src/workspace/ChatActivityJournal.tsx
- app/desktop/src/workspace/ChatThinkingDisclosure.tsx
- app/desktop/src/workspace/ChatActionsAudit.tsx
- app/desktop/src/workspace/ChatCurrentAction.tsx
- app/desktop/src/workspace/ChatNoteViewport.tsx
- app/desktop/src/workspace/useNoteTailFollow.ts
- app/desktop/src/workspace/ChatTurnPlan.tsx

The exact split may combine a very small purely presentational component with its parent. It must
not merge state reduction, projection, scroll control, and rendering into one large file.

### Existing frontend modules

- app/desktop/src/lib/api.ts
- app/desktop/src/lib/types.ts
- app/desktop/src/workspace/chatMessage.ts
- app/desktop/src/workspace/chatTurnStream.ts
- app/desktop/src/workspace/useChatPaneChat.ts
- app/desktop/src/workspace/ChatMessages.tsx
- app/desktop/src/workspace/ChatNoteEditCard.tsx
- app/desktop/src/workspace/ChatPlanNode.tsx
- app/desktop/src/workspace/ChatTimeline.tsx
- app/desktop/src/workspace/chatTimelineRows.ts

ChatTimeline and chatTimelineRows remain the legacy renderer while the compatibility path exists.
The v1 renderer must not call them to reconstruct chronology.

### Generated bindings

- app/desktop/src/lib/bindings/AgentActivityEnvelope.ts
- app/desktop/src/lib/bindings/AgentActivityPayload.ts
- bindings for the new supporting enums and any strengthened existing payloads.

These names are conceptual until generated from Rust. Use the generator's actual names and casing.

### Tests and journeys

- unit tests beside each new Rust and TypeScript module;
- focused additions to crates/neuralnote-core/tests/tool_skills.rs;
- focused additions to crates/neuralnote-core/tests/skills_bank.rs;
- focused additions to crates/neuralnote-core/tests/skill_orchestrator.rs;
- focused additions to crates/neuralnote-core/src/ai/orchestrator/tests.rs;
- Tauri sink and command tests in the existing Rust test modules;
- app/desktop/src/workspace/ChatActivityJournal.test.tsx;
- app/desktop/src/workspace/ChatNoteViewport.browser.test.tsx;
- app/desktop/src/workspace/ChatTurnPlan.browser.test.tsx;
- app/desktop/src/e2e/chat-agent-activity-journal.e2e.test.tsx;
- updates to app/desktop/src/e2e/mockVaultChatRuntime.ts.

## 6. Delivery sequence

### Phase 0: baseline and characterization

Objective: establish a clean starting point and pin the current contracts that the migration must
preserve.

Before editing production files:

1. Record git status, HEAD, and origin/main without modifying the worktree.
2. Confirm Node.js 24 LTS or the supported Node 22 line, npm, Rust 1.96, Cargo, and required quality
   tools.
3. Install locked frontend dependencies only if absent, using npm --prefix app/desktop ci.
4. Run the repository fast baseline:

       npm --prefix app/desktop run lint
       npm --prefix app/desktop run typecheck
       npm --prefix app/desktop run test:unit
       cargo test --workspace --locked

5. Record every pre-existing failure exactly. Do not work around a missing prerequisite or modify a
   lockfile.
6. Add characterization assertions before changing behaviour:
   - PlanningRound opens each current reasoning segment;
   - NoteEditPreview may precede ToolCall for the same id;
   - every announced ToolCall settles exactly once;
   - tool schemas freeze authorization per request;
   - a user stop still accepts only the current post-stop settlement set;
   - report cards, citations, usage, coverage, approvals, and Undo remain independent of timeline
     layout.

Exit gate:

- the baseline is recorded;
- characterization tests pass on current behaviour;
- any baseline failure is clearly separated from feature work.

### Phase 1: core envelope and sequencer

Objective: add the ordered journal contract without changing the visible UI.

Red tests:

- envelope v1 serializes with schemaVersion, turnId, sequence, optional cycleId, optional
  activityId, and a typed payload;
- sequences start at one and strictly increase within one sink;
- separate turns restart at one;
- sequence assignment and forwarding happen in one synchronous sink call;
- PlanningRound allocates a new opaque cycle id;
- tool-deciding Thinking carries that cycle id;
- final-answer Thinking carries final-answer source and no cycle id;
- ToolProgress, preview, approval, result, and strengthened note outcomes carry their activity id;
- run-level usage, error, cancellation, and completion carry no activity id;
- a terminal run closes all still-live activities through explicit terminal payloads;
- host-authored legacy SkillStep producers classify as run status or activity progress, never as a
  model CycleSummary.

Implementation:

1. Add activity_journal.rs and export its public contract from ai/mod.rs.
2. Keep internal ChatEvent producers intact initially.
3. Add a total ChatEvent-to-AgentActivityPayload conversion. Every current variant must choose a
   run, cycle, or activity scope explicitly.
4. Add an explicit final-answer lifecycle marker before stream_final_answer so final Thinking does
   not inherit the last tool cycle.
5. Add call correlation to NoteWritten, NoteExists, TranscriptSource, and other tool-owned payloads
   that currently discard an available id.
6. Add host-created activity ids only where no provider call id exists. Keep them scoped to one turn
   and never use them as authority.
7. Preserve UsageMeter and cancellation filtering by placing them before the final sequencer in the
   delivery chain.

Green checks:

    cargo test -p neuralnote-core --locked activity_journal
    cargo test -p neuralnote-core --locked events
    cargo test -p neuralnote-core --locked orchestrator

Exit gate:

- the core can produce a complete ordered envelope stream in tests;
- no shell or webview cutover has occurred;
- existing ChatEvent behaviour remains green.

### Phase 2: envelope transport and compatibility ingestion

Objective: carry envelope v1 through Tauri and into React while preserving the current visible
presentation.

Red tests:

- TauriChannelSink sends AgentActivityEnvelope and closes the matching run on delivery failure;
- early command errors are sequenced and terminal;
- cancellation filtering occurs before sequence assignment so the UI never receives a sequence
  gap for a deliberately suppressed stop error;
- the API channel accepts only the generated envelope type;
- the frontend rejects a wrong turn id, duplicate sequence, regressing sequence, gap, unsupported
  schema version, and mixed legacy/v1 stream with a visible incomplete-history state;
- a valid envelope can still update the existing answer, citation, coverage, usage, approval, and
  report-card fields during migration;
- a bare legacy stream remains readable in arrival order and cannot be mixed into an envelope turn.

Implementation:

1. Change the chat command channel to the generated AgentActivityEnvelope type.
2. Construct the core SequencedActivitySink as soon as the caller turn id is available, including
   early error paths.
3. Keep ChatRunCloseSignal and CausalRunEventSink semantics unchanged around the new transport.
4. Regenerate bindings with npm --prefix app/desktop run gen:bindings.
5. Export the generated types through app/desktop/src/lib/types.ts.
6. Update app/desktop/src/lib/api.ts and useChatPaneChat.ts to receive envelopes.
7. Add protocol mode and journal state to AssistantMessage.
8. Add a migration adapter in chatTurnStream.ts. Envelope payloads may continue to feed established
   non-chronological view fields temporarily, but the raw envelope is also retained in compact
   journal state.
9. When the channel or command closes without a terminal payload, settle the live projection and
   show Activity history is incomplete.

Green checks:

    npm --prefix app/desktop run gen:bindings
    npm --prefix app/desktop run check:bindings
    npm --prefix app/desktop run typecheck
    npm --prefix app/desktop run test:unit
    cargo test --workspace --locked

Exit gate:

- a real chat run uses envelope v1 end to end;
- the current UI remains behaviourally unchanged;
- malformed stream states fail visibly;
- generated bindings have no drift.

### Phase 3: global cycle summaries and preview ordering

Objective: produce exactly one visible plain-language summary for every work-producing tool batch,
without an extra model request.

Red tests:

- skill_step is advertised in every agentic tool-decision request;
- activating a skill does not advertise a duplicate skill_step schema;
- globally advertising skill_step does not grant ask_user, write_note, YouTube tools, or any other
  capability;
- the system prompt requests one skill_step alongside each batch of real work;
- normalization trims outer whitespace and canonicalizes line endings;
- empty, malformed, multi-paragraph, control-character, and over-320-scalar messages are invalid;
- provider order selects the first valid call;
- later valid calls are duplicates and do not create another summary;
- a missing or invalid summary uses the first real tool's host-owned fallback copy;
- an unknown first tool uses the generic fallback;
- a batch containing only skill_step publishes no summary but still returns the required provider
  tool result;
- skill_step never becomes ToolCall, current action, +N running, or a settled Actions row;
- malformed, missing, duplicate, and late calls produce bounded protocol details;
- model summaries render as plain text, not Markdown or HTML;
- the model request count is unchanged from an equivalent run without the feature;
- Thinking streams immediately while note previews remain buffered;
- the accepted or fallback summary precedes the first flushed preview and every real ToolCall;
- repeated buffered previews coalesce per call id;
- a failed unexposed preview buffer is discarded without an abandoned card;
- a flushed preview still receives an explicit abandonment on cancellation or failure.

Implementation:

1. Move skill_step_schema into the always-advertised schema list.
2. Remove skill_step from progressive skill grants and update built-in manifest tests. Skill
   instructions may still offer more specific narration guidance.
3. Update the schema and system prompt to request one or two ordinary-language sentences describing
   what was learned and what comes next.
4. Add cycle_summary.rs. It validates completed arguments, chooses the first valid call, records
   bounded protocol issues, and creates a typed CycleSummary.
5. Add an exhaustive fallback_summary method to RegisteredTool. Do not create grammar by lowercasing
   a display title in React.
6. Pre-scan each completed tool batch before announcing real calls.
7. Return deterministic administrative tool results for every skill_step call without routing it
   through the visible tool lifecycle.
8. Add tool_turn_presentation.rs and coalesce NoteEditPreview by call id until summary selection is
   complete.
9. Reclassify current host SkillStep producers in preload activation, requirement download,
   activation recovery, and playlist orchestration as typed host status or progress.
10. Preserve the provider's assistant tool-call message and exactly one role:tool result for every
    declared call.

Green checks:

    cargo test -p neuralnote-core --locked cycle_summary
    cargo test -p neuralnote-core --locked tool_turn_presentation
    cargo test -p neuralnote-core --locked --test tool_skills
    cargo test -p neuralnote-core --locked --test skills_bank
    cargo test -p neuralnote-core --locked --test skill_orchestrator
    cargo test --workspace --locked

Exit gate:

- every work-producing cycle emits exactly one accepted or fallback summary;
- no extra model request is introduced;
- note composition cannot appear before its summary;
- skill_step remains non-authorizing and invisible as an action.

### Phase 4: compact frontend journal and projections

Objective: make the journal the only chronology source for the v1 activity surface.

Red tests:

- alternating cycle start, Thinking, summary, preview, tool call, progress, and result remain in
  sequence;
- Thinking deltas coalesce into one buffer per cycle or final-answer phase;
- progress replaces one activity field rather than appending a row;
- previews replace one semantic buffer per activity;
- a preview before ToolCall creates one provisional activity and upgrades without changing its
  identity;
- outcomes settle only the matching activity id;
- an unknown outcome, conflicting cycle owner, or reused live activity id surfaces incomplete
  history;
- plan declarations preserve order and status updates replace in place;
- current activity is the latest started or progressed activity in a genuinely working state;
- approval requests and elicitations park their activity on the user and do not count as running;
- +N running counts genuinely active siblings only;
- settled actions remain ordered by first sequence, never completion order;
- final-answer Thinking has no summary;
- cancellation, error, partial run, or stream closure stops all live animation;
- closed audit bodies can be lazy-mounted without losing their accessible open state.

Implementation:

1. Add activityJournal.ts with small semantic types for turn, cycle, activity, Thinking, summary,
   plan, terminal state, and protocol warning.
2. Add activityJournalReducer.ts with an exhaustive switch over AgentActivityPayload.
3. Add activityJournalSelectors.ts for live and settled projections.
4. Keep sequence validation in chatTurnStream.ts, outside the pure reducer.
5. Store first and last sequence for cycles and activities. Use ids for correlation and sequence
   only for order.
6. Coalesce streamed text and progress before React rendering.
7. Preserve the legacy reducer only for legacy-mode turns and established non-activity consumers.
8. Do not expose cycle ids or numeric PlanningRound fields through user copy.

Green checks:

    npm --prefix app/desktop run test:unit
    npm --prefix app/desktop run typecheck
    npm --prefix app/desktop run lint

Exit gate:

- v1 chronology can be projected without chatTimelineRows;
- no transient token or progress event creates an independent DOM row;
- protocol failures are explicit and terminal-safe.

### Phase 5: chronological cycles, live action, and settled audits

Objective: replace the v1 process rail and append-only skill narration with the approved quiet
transcript.

Red tests:

- the live status reads Thinking from cycle start until summary or action;
- the disclosure label is Thinking and contains no visible round or cycle number;
- one summary remains visible after settlement;
- the current action replaces in one role=status region;
- two parallel siblings render +1 running, not another progress row;
- settling the current activity promotes the most recently updated remaining sibling;
- an approval request or elicitation replaces working copy with its prompt and leaves no spinner or
  running count for the parked activity;
- settling a cycle removes its live action and retains one collapsed Actions disclosure;
- Actions count excludes skill_step and includes real terminal activities;
- failures and incomplete-run notices remain visible outside the collapsed audit;
- final-answer Thinking appears immediately before the final answer with no summary;
- legacy turns continue to use the existing ChatTimeline and SkillSteps presentation;
- v1 turns do not render SkillSteps, ChatTimeline, or a separate work dock.

Implementation:

1. Add ChatActivityJournal.tsx as the v1 activity surface.
2. Add a native Thinking disclosure component with stable aria-expanded relationships.
3. Add ChatCurrentAction.tsx as the turn's only polite live region. Reuse the same region for the
   live Thinking-to-action phase transition.
4. Add ChatActionsAudit.tsx. Mount detailed children only when opened, while preserving the button
   and failure count in the closed state.
5. Reuse or extract existing host-owned tool outcome presentation from ChatTimelineNodes.tsx rather
   than copying settlement language.
6. Update ChatMessages.tsx to choose the v1 journal renderer or legacy renderer by the locked
   protocol mode.
7. Stop rendering append-only SkillSteps for v1 turns. CycleSummary is the only model narration
   between Thinking and work.
8. Keep skill activation failure remedies, approvals, report cards, citations, usage, coverage,
   final answer, and Undo in their established authoritative surfaces.

Green checks:

    npm --prefix app/desktop run test:unit
    npm --prefix app/desktop run typecheck
    npm --prefix app/desktop run lint

Exit gate:

- v1 turns read chronologically;
- only one transient action line is visible;
- settled tool detail remains inspectable without dominating the transcript.

### Phase 6: inline fixed note viewport and tail follow

Objective: render active note composition beside its initiating summary without allowing it to
expand the AI pane.

Red unit tests:

- only the selected current note activity renders a live viewport;
- parallel note buffers remain intact when focus changes;
- a preview upgrading to ToolCall keeps the same React key and state owner;
- success, refusal, failure, cancellation, timeout, and abandonment choose the correct settled
  audit outcome;
- note tokens are not placed in a live region;
- Jump to latest appears only while follow is paused.

Red browser tests:

- wrapped content cannot change the viewport's fixed block size;
- while at the bottom, a content update keeps the bottom visible;
- scrolling above the bottom tolerance pauses follow immediately;
- new content does not move a paused viewport;
- Jump to latest scrolls to the bottom and resumes follow;
- manually reaching the bottom resumes follow;
- preview-to-call upgrade preserves scrollTop, focus, and text selection where the platform permits;
- switching note activities preserves each activity's follow state;
- narrow, default, expanded, zoomed, and increased-text layouts do not overflow horizontally.

Implementation:

1. Extract the reusable note outcome and body presentation needed by both legacy and v1 paths.
2. Add useNoteTailFollow.ts. Keep DOM measurement and event listeners inside the hook; keep journal
   state pure.
3. Add ChatNoteViewport.tsx with a fixed token-based block size and internal overflow.
4. Mount it inline beneath the initiating summary and current action, matching selected wireframe A.
5. Reserve space for status and cursor motion so animation cannot change layout.
6. Remove the standalone ChatNoteEdits surface for v1 turns. Keep it for legacy turns.
7. On settlement, move the note outcome into the cycle audit and preserve the authoritative resolved
   path from the correlated note outcome.

Green checks:

    npm --prefix app/desktop run test:unit
    npm --prefix app/desktop run test:browser
    npm --prefix app/desktop run typecheck:browser
    npm --prefix app/desktop run typecheck
    npm --prefix app/desktop run lint

Exit gate:

- an arbitrarily long streamed note cannot grow the live viewport;
- user reading position is respected;
- no preview can be mistaken for a committed note.

### Phase 7: sticky full plan, motion, accessibility, and performance

Objective: finish the selected visual direction and interaction contract.

Red tests:

- every declared plan item renders in declaration order while active;
- done, running, pending, skipped, and failed remain textually and semantically distinct;
- status updates do not reorder or relabel steps;
- a long plan uses its own bounded scroll region and omits no item;
- the active plan remains below the active turn and above the composer;
- settlement turns the same plan into one collapsed transcript disclosure;
- early termination preserves last authoritative statuses and shows Run ended early;
- no plan produces no placeholder;
- the action line is the only polite live region;
- rapid duplicate progress copy is not announced twice;
- Thinking, Actions, Plan, and Jump to latest controls have stable accessible names and focus;
- keyboard scrolling works in both note and plan viewports without a focus trap;
- default motion uses the approved shimmer, faster activity indicator, and note-tail cursor energy;
- prefers-reduced-motion removes continuous animation, transforms, and animated scrolling while
  preserving every state in text;
- lazy audit mounting and coalesced updates keep DOM growth proportional to semantic entries.

Implementation:

1. Extract shared plan status presentation from ChatPlanNode.tsx without changing its legacy
   semantics.
2. Add ChatTurnPlan.tsx with active sticky and settled collapsed variants.
3. Use existing design tokens. Increase inset and summary/body type by one existing token step,
   reflecting the approved slightly roomier direction.
4. Add only short opacity and small vertical transitions. Keep all animated geometry reserved.
5. Apply motion-reduce variants to shimmer, spinner, cursor, transforms, and scroll behaviour.
6. Verify native disclosure semantics and explicit status text. Do not rely on colour, glyph, or
   motion alone.
7. Coalesce rapid progress announcements and do not re-announce unchanged copy.

Green checks:

    npm --prefix app/desktop run test:unit
    npm --prefix app/desktop run test:browser
    npm --prefix app/desktop run typecheck:browser
    npm --prefix app/desktop run lint
    npm --prefix app/desktop run typecheck

Exit gate:

- the selected quiet, balanced, inline design is complete;
- the plan remains accountable without taking over the pane;
- keyboard, screen-reader, zoom, and reduced-motion contracts are covered.

### Phase 8: journeys, adversarial review, native proof, and cleanup

Objective: prove the complete feature across generic and YouTube journeys, then remove migration-only
duplication that no supported v1 path needs.

Red journeys:

- a generic two-cycle turn alternates Thinking, summary, actions, and final answer;
- a generic batch runs two activities and reports +1 running;
- YouTube distillation fetches captions, inspects conventions, streams a long note, updates a plan,
  and reports final paths;
- NoteEditPreview precedes ToolCall on the wire but upgrades one activity in the UI;
- a provider emits no reasoning but the live phase still reads Thinking;
- missing, malformed, duplicate, oversized, and summary-only skill_step cases remain usable;
- cancellation during note composition preserves completed work and abandons the preview;
- one sibling tool fails while another succeeds;
- partial run, approval timeout, provider failure, and transport close remain explicit;
- no user-visible copy contains Reasoning, round numbers, cycle numbers, or a maximum-round counter;
- no production selector or renderer depends on YouTube skill ids, tool names, or payload shapes.

Implementation:

1. Update mockVaultChatRuntime.ts to emit envelope-v1 fixtures and retain an explicit legacy fixture
   helper.
2. Add chat-agent-activity-journal.e2e.test.tsx with generic and YouTube proving journeys.
3. Update existing reasoning, skill, note, plan, approval, cancellation, and report-card journeys
   only where the new contract intentionally changes presentation.
4. Remove migration-only duplicate state from the v1 path. Keep the legacy renderer and adapter
   until the design specification's removal condition is satisfied.
5. Update comments that still describe SkillSteps as the live narration surface.
6. Update NeuralNote-threat-model.md with the globally advertised non-authorizing summary tool,
   bounded plain-text rendering, ordered IPC envelope, and the fact that neither summary nor plan
   state grants authority.
7. Request an independent adversarial review focused on:
   - model-crafted summary and plan text;
   - malformed envelope and correlation ids;
   - preview-before-call and cross-call confusion;
   - sequence gaps, duplicates, mixed protocol, and premature terminal events;
   - cancellation and closed-webview races;
   - approval, path, write-budget, citation, and Undo invariants.
8. Fix every in-scope high-confidence finding and add regression coverage.

Green checks:

    npm --prefix app/desktop run test:run
    npm --prefix app/desktop run test:browser
    npm --prefix app/desktop run typecheck:browser
    cargo test --workspace --locked
    npm --prefix app/desktop run check:bindings

Exit gate:

- generic and YouTube journeys both pass;
- no security or citation authority moved into model prose or React;
- no v1 activity surface reconstructs chronology from independent arrays;
- legacy behaviour remains explicit and isolated.

## 7. Final automated verification

Run the complete applicable set in the final worktree and check every exit status:

    npm --prefix app/desktop run lint
    npm --prefix app/desktop run typecheck
    npm --prefix app/desktop run test:unit
    npm --prefix app/desktop run test:run
    npm --prefix app/desktop run test:browser
    npm --prefix app/desktop run typecheck:browser
    cargo test --workspace --locked
    npm --prefix app/desktop run check:bindings
    npm --prefix app/desktop run coverage
    npm --prefix app/desktop run build
    npm --prefix app/desktop audit --audit-level=high
    ./scripts/rust-quality-gate.sh
    gitleaks git . --log-opts=--all --redact

If SonarQube is requested for the milestone, follow docs/local-sonarqube.md and report it only as
Passed, Failed, or Unavailable.

Do not convert a blocked, unavailable, or pre-existing failure into a pass.

## 8. Real-app walkthrough

Run:

    npm --prefix app/desktop run tauri dev

Before interaction, prove the exact development bundle identity and fresh process. Then exercise:

1. Generic agentic turn with at least two work cycles.
2. Reasoning-capable provider:
   - live status says Thinking;
   - Thinking disclosures accumulate in causal position;
   - no round numbers appear.
3. Provider with no reasoning:
   - live status still says Thinking;
   - no fabricated reasoning disclosure appears.
4. YouTube distillation:
   - captions and convention inspection;
   - model summary after each Thinking phase;
   - long note composition in the fixed viewport;
   - upward scroll while content continues;
   - Jump to latest;
   - complete sticky plan;
   - final note paths and provenance.
5. Parallel activity fixture:
   - one current line;
   - accurate +N running;
   - stable settled audit order.
6. Cancellation during note composition:
   - current action stops;
   - partial preview is not presented as written;
   - completed work remains inspectable.
7. Tool or provider failure:
   - concise visible failure outside the collapsed audit;
   - technical detail available inside;
   - no spinner survives.
8. Keyboard-only navigation, VoiceOver, reduced motion, default width, expanded width, zoom, and
   increased text size.

Use screenshots and accessibility inspection as UI proof. Logs, process survival, and green tests
are supporting evidence, not substitutes for the walkthrough.

## 9. Compatibility and rollback

- The new protocol is envelope v1. The first event locks a turn to v1 or legacy mode.
- Existing in-memory or restored turns without envelopes continue through the legacy renderer. No
  persistent chat migration is introduced.
- Do not remove ChatTimeline, chatTimelineRows, SkillSteps, or legacy note rendering until every
  supported producer and fixture has been audited.
- If envelope transport must be disabled during development, fall back at the whole-turn boundary.
  Never mix bare and envelope events in one turn.
- A rollback may restore the legacy renderer and channel only if it also restores the matching Rust
  contract and generated bindings. Do not keep a half-migrated wire.
- The journal adds no durable reasoning store, analytics, external origin, helper binary, or new
  native authority.

## 10. Main risks and controls

### Preview arrives before summary validation

Control: bounded presentation buffering, coalescing, summary-first flush, and explicit tests around
retry and abandonment.

### skill_step changes authorization accidentally

Control: always advertise only that administrative schema, freeze the full advertised set per
request, and test that no gated or skill-specific tool becomes callable.

### Existing host SkillStep text is mistaken for model narration

Control: replace overloaded bare events with typed CycleSummary, ActivityProgress, or RunStatus.
Never infer source from text.

### Parallel work is shown as a false dependency chain

Control: use sequence for observation order and activity id for correlation. +N running reports
siblings without implying execution order.

### Note outcome attaches to the wrong preview

Control: carry the call id through preview, write outcome, tool settlement, and React key. Never
match paths.

### Long conversations create an unbounded DOM

Control: coalesce deltas and progress, keep one semantic note buffer, lazy-mount closed audit
details, and test representative long runs.

### Accessibility becomes noisy

Control: one polite status region, no token live regions, progress deduplication, native disclosure
semantics, stable focus, and reduced-motion coverage.

### Cancellation leaves false live state

Control: every announced or provisional activity receives a terminal state, and channel closure
forces an incomplete terminal projection.

### New UI undermines citation or write truth

Control: retain deterministic citation verification, NoteWritten authority, report cards, and Undo.
Summary, plan, preview, and current-action copy remain observational only.

## 11. Definition of done

Implementation is complete only when:

- every acceptance criterion in agent-activity-journal.md is met;
- all phase exit gates are satisfied;
- exact automated command results are recorded;
- the native walkthrough provides direct UI evidence;
- independent adversarial review has no unresolved in-scope high-confidence finding;
- the threat model reflects the changed model-tool and IPC contract;
- no frontend source breaches the 500-line rule;
- generated bindings match Rust;
- the working tree contains only intended files;
- security, privacy, compatibility, citation, and remaining risks are reported;
- nothing is committed, pushed, released, or published without Tom's explicit instruction.

## 12. Approval gate

Approval of this plan authorizes implementation within the file and behaviour boundaries above. It
does not authorize a commit, push, release, dependency update, credential change, external service,
or expansion beyond the approved activity-journal design.
