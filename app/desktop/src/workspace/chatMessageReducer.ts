// The pure `ChatEvent` → `AssistantMessage` fold, split out of `chatMessage.ts`
// when the approval-gate events pushed that file past the 500-line guardrail.
//
// **The `: AssistantMessage` return annotation on `foldEvent` — the function
// holding the switch — is the whole totality guarantee.** That annotation plus
// `strict` is what makes an unhandled `ChatEvent` variant a compile error
// (TS2366, "function lacks ending return statement"). There is no `assertNever`
// behind it; lose the annotation in a later move and the safety net disappears
// silently. It sits on `foldEvent` rather than on `reduceAssistant` because the
// switch is what has to be exhaustive; `reduceAssistant` wraps it.
//
// The import of `AssistantMessage` is type-only, so the apparent cycle with
// `chatMessage.ts` is erased at compile time and there is no runtime cycle.

import type { ChatEvent, PlaylistPosition } from "../lib/types";
import type {
  ActivityStep,
  AssistantMessage,
  NoteEditView,
  ToolApprovalView,
  ToolCallView,
} from "./chatMessage";

/** Fold a `retrieved` event into the matching `searching` row (→ "searching X →
 *  N notes"). Falls back to a standalone row if no pending search matches — a
 *  retrieval count is never dropped just because its search row went missing. */
function withHitCount(
  steps: ActivityStep[],
  query: string,
  hitCount: number,
): ActivityStep[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "search" && step.query === query && step.hitCount === undefined) {
      const next = steps.slice();
      next[i] = { ...step, hitCount };
      return next;
    }
  }
  return [...steps, { kind: "search", query, hitCount }];
}

/** Settle the in-flight call that owns this id.
 *
 *  Matches the newest still-unsettled node so a re-used id cannot re-open a node
 *  that already closed. A settlement whose call never arrived is appended as its
 *  own row with an empty identity rather than dropped: the backend emits exactly
 *  one settlement per announced call, so an unmatched one is a broken contract
 *  that has to be visible, not a stray event to swallow.
 *
 *  Correlation is on `id` **alone**. `stepId` is deliberately outside the `Pick`
 *  below, so a settlement can neither be matched by step affiliation nor blank
 *  the affiliation of the node it lands on. */
function withSettlement(
  calls: ToolCallView[],
  settlement: Pick<ToolCallView, "id" | "status" | "summary" | "detail">,
): ToolCallView[] {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call.id === settlement.id && call.status === null) {
      const next = calls.slice();
      next[i] = { ...call, ...settlement };
      return next;
    }
  }
  // A node for a call we never saw announced has no dispatch we could have read
  // a step off, so it is affiliated with nothing rather than with a guess.
  return [...calls, { name: "", title: "", arguments: "", stepId: null, ...settlement }];
}

/** Leave a running tool's latest line on the node that sent it.
 *
 *  Matches the newest still-unsettled node with this id, exactly as
 *  `withSettlement` does and for the same reason: a finished node must not be
 *  made to look like it is still working.
 *
 *  An id matching no live node changes nothing — and, unlike a settlement, is
 *  not appended as a row of its own. There is no anomaly to make visible: the
 *  id cannot be wrong. A tool emits through `CallChannel`, which carries the
 *  dispatched call's id and exposes no general `send`, so progress addressed to
 *  someone else's node is unwritable rather than merely unwritten
 *  (`crates/neuralnote-core/src/ai/call_channel.rs`). What appending WOULD
 *  produce is a rail node with no name, no title and no arguments — the three
 *  things a tool node consists of. */
function withProgress(
  calls: ToolCallView[],
  id: string,
  message: string,
): ToolCallView[] {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call.id === id && call.status === null) {
      const next = calls.slice();
      next[i] = { ...call, progress: message };
      return next;
    }
  }
  return calls;
}

/** Fold a live note preview into the edit that owns its id, or start one.
 *
 *  The body only ever grows and the backend re-sends the whole of it, so the
 *  entry is replaced rather than appended to. `abandoned` is carried across
 *  untouched: the backend never previews a call it has already abandoned, and
 *  quietly clearing the flag would revive a card that was explicitly retired. */
function withNoteEdit(
  edits: NoteEditView[],
  preview: Omit<NoteEditView, "abandoned">,
): NoteEditView[] {
  const index = edits.findIndex((edit) => edit.id === preview.id);
  if (index < 0) return [...edits, { ...preview, abandoned: null }];
  const next = edits.slice();
  next[index] = { ...preview, abandoned: edits[index].abandoned };
  return next;
}

/** Mark the edit that owns this id as abandoned.
 *
 *  An abandonment whose preview never arrived is appended as its own row rather
 *  than dropped — the backend abandons only what it previewed, so an unmatched
 *  one is a broken contract, and the same reasoning as `withSettlement` applies:
 *  it has to be visible, not swallowed. */
function withAbandonedNoteEdit(
  edits: NoteEditView[],
  id: string,
  reason: string,
): NoteEditView[] {
  const index = edits.findIndex((edit) => edit.id === id);
  if (index < 0) {
    return [
      ...edits,
      { id, relPath: null, kind: null, body: "", complete: false, abandoned: reason },
    ];
  }
  const next = edits.slice();
  next[index] = { ...edits[index], abandoned: reason };
  return next;
}

/** Fold one approval update into the entry that owns its id, or start one.
 *
 *  An update whose `toolApprovalRequested` never arrived is appended rather than
 *  dropped — the gate emits `unavailable` BEFORE the prompt, so an unmatched
 *  update is ordinary, and swallowing it would hide the one event that explains
 *  a three-second pause. */
function withApproval(
  approvals: ToolApprovalView[],
  id: string,
  patch: Partial<ToolApprovalView>,
): ToolApprovalView[] {
  const index = approvals.findIndex((approval) => approval.id === id);
  if (index < 0) {
    return [
      ...approvals,
      {
        id,
        tool: null,
        relPath: null,
        reason: null,
        expiresInSecs: null,
        checking: false,
        resolution: null,
        autoApprovedRule: null,
        ...patch,
      },
    ];
  }
  const next = approvals.slice();
  next[index] = { ...approvals[index], ...patch };
  return next;
}

/** The entry for `id` after `patch`, for the sheet the user is looking at. */
function approvalAfter(
  approvals: ToolApprovalView[],
  id: string,
  patch: Partial<ToolApprovalView>,
): ToolApprovalView {
  const updated = withApproval(approvals, id, patch);
  return updated[updated.findIndex((approval) => approval.id === id)];
}

/** Whether two beacons are talking about the same playlist item.
 *
 *  Both `null` counts as the same: a run with no playlist in flight does not
 *  change item from one round to the next, so a preview outside a playlist
 *  survives its rounds exactly as one inside a playlist does. */
function sameVideo(
  before: PlaylistPosition | null,
  after: PlaylistPosition | null,
): boolean {
  return before?.position === after?.position;
}

/** Immutably fold one streamed `ChatEvent` into the assistant turn's view
 *  state. Total over the `ChatEvent` union — a new variant is a compile error
 *  here, so the UI can never silently ignore a backend event.
 *
 *  Pure, and deliberately clock-free: the timestamps the live head runs on are
 *  stamped by `reduceAssistantForTurn`, which is the one caller that owns the
 *  outside world. */
export function reduceAssistant(
  turn: AssistantMessage,
  event: ChatEvent,
): AssistantMessage {
  const folded = foldEvent(turn, event);
  // "Thinking" is a claim about right now, so it is derived from the event that
  // just landed rather than latched by one and cleared by hand somewhere else.
  // An event that changed nothing cannot unsay it — nothing happened.
  if (folded === turn) return turn;
  const reasoningStreaming = event.type === "thinking";
  return folded.reasoningStreaming === reasoningStreaming
    ? folded
    : { ...folded, reasoningStreaming };
}

/** The event-by-event fold. **The `: AssistantMessage` return annotation is the
 *  totality guarantee** — with `strict`, an unhandled variant is a compile
 *  error (TS2366) rather than a silently ignored event. */
function foldEvent(turn: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case "processing":
      // The run was accepted and is preparing its first request. That is all it
      // says: it is emitted before a single token has been asked for, so it is
      // no evidence at all that the model is reasoning.
      return { ...turn, phase: "sending" };
    case "planningRound":
      return {
        ...turn,
        phase: "planning",
        round: { current: event.round, max: event.maxRounds },
        // Re-read, never merged: the beacon re-states the item every round, so
        // a finished playlist clears itself here instead of leaving "video 3 of
        // 3" standing over the answer turn.
        playlist: event.playlist,
        // The preview belongs to the item that was in flight when it arrived.
        // A beacon naming a different item retires it, so a video whose preview
        // never arrives shows no card rather than the previous video's.
        videoPreview: sameVideo(turn.playlist, event.playlist)
          ? turn.videoPreview
          : null,
      };
    case "videoPreview":
      return {
        ...turn,
        videoPreview: {
          videoId: event.videoId,
          title: event.title,
          durationSecs: event.durationSecs,
          channel: event.channel,
          // Carried through as absent, never coerced to "": the card's
          // text-only form is the degraded path, not a broken image.
          thumbnailDataUri: event.thumbnailDataUri,
        },
      };
    case "keepalive":
      // No view state: a keepalive says the socket is alive, not that anything
      // happened. It is consumed by the liveness stamp in
      // `reduceAssistantForTurn`, which is where "alive" and "progressed" are
      // deliberately kept apart.
      return turn;
    case "toolProgress": {
      // A tool reporting from inside itself is progress, and dating it as such
      // is not decoration: `foldWithLiveness` short-circuits on an identity
      // fold, so while this returned `turn` a four-minute transcription left
      // `lastEventAt` standing and the head raised its stall notice 45 seconds
      // into a perfectly healthy run.
      //
      // Never collapse this into a `default:` arm — the exhaustive switch is
      // what makes a new backend event a compile error here.
      const toolCalls = withProgress(turn.toolCalls, event.id, event.message);
      return toolCalls === turn.toolCalls ? turn : { ...turn, toolCalls };
    }
    case "skillActivated":
      return {
        ...turn,
        skillActivations: [
          ...turn.skillActivations,
          { id: event.id, name: event.name },
        ],
      };
    case "skillActivationFailed":
      return {
        ...turn,
        skillActivationFailures: [
          ...turn.skillActivationFailures,
          {
            id: event.id,
            name: event.name,
            message: event.message,
            missingBinary: event.missingBinary,
          },
        ],
      };
    case "skillStep":
      return { ...turn, skillSteps: [...turn.skillSteps, event.message] };
    case "toolCall":
      // A tool node is not a progress phase — `phase` stays where the
      // searching/reading/verifying events put it.
      return {
        ...turn,
        toolCalls: [
          ...turn.toolCalls,
          {
            id: event.id,
            name: event.name,
            title: event.title,
            arguments: event.arguments,
            status: null,
            summary: null,
            detail: null,
            // Carried through exactly as the backend stamped it at dispatch —
            // never re-derived here from `planSteps`, which is the live rail and
            // will have moved on by the time this node is rendered.
            stepId: event.stepId,
          },
        ],
      };
    case "toolResult":
      return {
        ...turn,
        toolCalls: withSettlement(turn.toolCalls, {
          id: event.id,
          status: event.status,
          summary: event.summary,
          detail: event.detail,
        }),
      };
    case "transcriptSource":
      return {
        ...turn,
        transcriptSources: [
          ...turn.transcriptSources,
          { label: event.label, relPath: event.relPath },
        ],
      };
    case "partialRun":
      // First reason wins: the earliest is the one that actually ended the work,
      // and a later one would overwrite the cause with a consequence.
      return {
        ...turn,
        partialRun: turn.partialRun ?? event.reason,
      };
    case "elicit":
      return {
        ...turn,
        pendingElicitation: {
          id: event.id,
          question: event.question,
          options: event.options,
          multiSelect: event.multiSelect,
        },
      };
    case "noteWritten":
      return {
        ...turn,
        writtenNotes: [
          ...turn.writtenNotes,
          { relPath: event.relPath, kind: event.kind },
        ],
      };
    case "noteExists":
      // Nothing was written, so this must never reach `writtenNotes` — but it
      // must reach the user (#108). `kind` is the kind that was requested.
      return {
        ...turn,
        existingNotes: [
          ...turn.existingNotes,
          { relPath: event.relPath, kind: event.kind },
        ],
      };
    case "noteEditPreview":
      return {
        ...turn,
        noteEdits: withNoteEdit(turn.noteEdits, {
          id: event.id,
          relPath: event.relPath,
          kind: event.kind,
          body: event.body,
          complete: event.complete,
        }),
      };
    case "noteEditAbandoned":
      return {
        ...turn,
        noteEdits: withAbandonedNoteEdit(turn.noteEdits, event.id, event.reason),
      };
    case "toolApprovalChecking":
      return {
        ...turn,
        toolApprovals: withApproval(turn.toolApprovals, event.id, { checking: true }),
      };
    case "toolApprovalRequested": {
      const pendingApproval = approvalAfter(turn.toolApprovals, event.id, {
        tool: event.tool,
        relPath: event.relPath,
        reason: event.reason,
        expiresInSecs: event.expiresInSecs,
        checking: false,
        resolution: null,
      });
      return {
        ...turn,
        toolApprovals: withApproval(turn.toolApprovals, event.id, pendingApproval),
        pendingApproval,
      };
    }
    case "toolAutoApproved":
      // The prompt is skipped; the record is not. This is the compensating
      // control that keeps YOLO defensible rather than reckless, so it renders a
      // node in every mode that auto-approves.
      return {
        ...turn,
        toolApprovals: withApproval(turn.toolApprovals, event.id, {
          tool: event.tool,
          autoApprovedRule: event.rule,
          checking: false,
          resolution: "approved",
        }),
      };
    case "toolApprovalResolved":
      // Last resolution wins: the gate emits `unavailable` before falling through
      // to the prompt, so the user's actual answer arrives second and is the one
      // the node should settle on.
      return {
        ...turn,
        toolApprovals: withApproval(turn.toolApprovals, event.id, {
          checking: false,
          resolution: event.decision,
        }),
        pendingApproval:
          turn.pendingApproval?.id === event.id ? null : turn.pendingApproval,
      };
    case "toolApprovalDegraded":
      // First reason wins, like `partialRun`: the earliest is the cause, a later
      // one would overwrite it with a consequence.
      return {
        ...turn,
        approvalDegraded: turn.approvalDegraded ?? event.reason,
      };
    case "searching":
      return {
        ...turn,
        phase: "searching",
        activity: [...turn.activity, { kind: "search", query: event.query }],
      };
    case "retrieved":
      return { ...turn, activity: withHitCount(turn.activity, event.query, event.hitCount) };
    case "reading":
      return {
        ...turn,
        phase: "reading",
        activity: [
          ...turn.activity,
          { kind: "reading", relPath: event.relPath, startLine: event.startLine, endLine: event.endLine },
        ],
      };
    case "verifying":
      return {
        ...turn,
        phase: "verifying",
        activity: [...turn.activity, { kind: "verifying" }],
      };
    case "citationDropped":
      return {
        ...turn,
        phase: "verifying",
        activity: [...turn.activity, { kind: "dropped", reason: event.reason }],
      };
    case "thinking":
      return { ...turn, thinking: turn.thinking + event.delta };
    case "answer":
      return { ...turn, answer: turn.answer + event.delta };
    case "answerTruncated":
      // The model hit its token/length ceiling mid-answer. The accumulated
      // answer and citations stay exactly as streamed — only the incomplete
      // flag is set, so the UI can surface it without ever losing the partial.
      return { ...turn, truncated: true };
    case "citation":
      return {
        ...turn,
        citations: [
          ...turn.citations,
          {
            id: event.id,
            relPath: event.relPath,
            startLine: event.startLine,
            endLine: event.endLine,
            text: event.text,
          },
        ],
      };
    case "coverage":
      return {
        ...turn,
        coverage: {
          searchedTerms: event.searchedTerms,
          notesRead: event.notesRead,
          truncated: event.truncated,
          skippedFiles: event.skippedFiles,
        },
      };
    case "plan":
      // Replaces rather than merges, because the backend only ever declares
      // once: `RunPlan::update` returns `declared: Some(..)` on the first
      // accepted call and `None` on every later one, so a second `plan` event
      // cannot reach us with a different set.
      return {
        ...turn,
        planSteps: event.steps.map((step) => ({ ...step, status: "pending" })),
      };
    case "planStepStatus":
      // An id with no declared step is a no-op, and deliberately not appended
      // the way `withApproval`/`withSettlement` append theirs. Those two have to
      // cope with an update arriving before its opener; this one cannot, because
      // `plan.rs::same_steps` refuses any call whose step set differs and emits
      // nothing (`a_refused_update_leaves_the_declared_plan_untouched`). A
      // placeholder branch here would be a row with no label — the one thing a
      // plan step consists of — defending against a state the wire cannot carry.
      return {
        ...turn,
        planSteps: turn.planSteps.map((step) =>
          step.id === event.id ? { ...step, status: event.status } : step,
        ),
      };
    case "usage":
      // Nulls are carried through untouched: `tokensIn`/`tokensOut` are absent
      // when the provider did not report them, and coercing that to 0 here
      // would manufacture a measurement the run never made.
      return {
        ...turn,
        usage: {
          elapsedMs: event.elapsedMs,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          model: event.model,
        },
      };
    case "error":
      // A run ends on `error` too — mark it done so the working indicator
      // clears, but keep the message visible.
      return { ...turn, error: event.message, done: true };
    case "done":
      return { ...turn, done: true };
  }
}
