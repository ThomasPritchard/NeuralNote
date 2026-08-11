// The chat pane's view model + the pure event reducer. A chat is a list of
// `ChatMessage`s; an assistant turn accumulates the streamed `ChatEvent`s (the
// live search/read/verify "harness" log, the streamed answer, cited sources,
// and a coverage footer). Keeping the fold pure and framework-free makes the
// harness feel unit-testable without React.

import type {
  ChatEvent,
  ChatTurn,
  ElicitOption,
  NoteKind,
  ToolStatus,
} from "../lib/types";

/** One row in the live activity log — the visible trace of the agent working. */
export type ActivityStep =
  | { kind: "search"; query: string; hitCount?: number }
  | { kind: "reading"; relPath: string; startLine: number; endLine: number }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

/** A verified citation the answer leans on — the click target that opens the
 *  cited note. Mirrors the `citation` ChatEvent minus its discriminant. */
export interface CitationView {
  id: string;
  relPath: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** The coverage footer — how much of the vault the turn actually saw, kept
 *  honest (partial/skipped coverage is surfaced, never hidden). */
export interface CoverageView {
  searchedTerms: string[];
  notesRead: string[];
  truncated: boolean;
  skippedFiles: number;
}

export interface PendingElicitation {
  id: string;
  question: string;
  options: ElicitOption[];
  multiSelect: boolean;
}

/** One tool call the model made, and how it settled. `status === null` means the
 *  call is still in flight: the backend emits exactly one settlement per call on
 *  every path, so a node that stays null after the turn ends is a backend bug,
 *  not a UI state to design around. Every string here is Rust-authored except
 *  `arguments`, which is raw model output and must be treated as untrusted. */
export interface ToolCallView {
  id: string;
  name: string;
  title: string;
  arguments: string;
  status: ToolStatus | null;
  summary: string | null;
  detail: string | null;
}

/** A note the model is composing, as the backend's partial parse of the streamed
 *  tool call sees it. Keyed by the tool-call id, so the card upgrades in place
 *  into the written note rather than becoming a second row.
 *
 *  `complete` means the arguments closed and parse — NOT that anything was
 *  written. The tool still has to be dispatched and can still be rejected, so a
 *  settled preview is not evidence a file exists; `writtenNotes` is. */
export interface NoteEditView {
  id: string;
  /** Absent until the path finished arriving — half a path is not a path. */
  relPath: string | null;
  kind: NoteKind | null;
  body: string;
  complete: boolean;
  /** Why the edit was abandoned, or `null` while it is still live. Set means the
   *  note will never land, so the diff must stop reading as if it had. */
  abandoned: string | null;
}

/** A skill the user asked for that could not be activated. `missingBinary` is the
 *  only structured remedy the backend offers; `message` is display-only prose. */
export interface SkillActivationFailure {
  id: string;
  name: string;
  message: string;
  missingBinary: string | null;
}

/** How a transcript was actually obtained, as reported by the tool that obtained
 *  it. `relPath` is absent until a note exists to attach it to. */
export interface TranscriptSourceView {
  label: string;
  relPath: string | null;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** Caller-generated identity used to route events and cancellation outcomes. */
  turnId: string | null;
  /** The last progress phase backed by an actual transport/backend event. */
  phase: "sending" | "thinking" | "searching" | "reading" | "verifying";
  skillActivations: Array<{ id: string; name: string }>;
  /** Skills that could not be activated, reported structurally by the backend —
   *  never inferred from the wording of a progress message. */
  skillActivationFailures: SkillActivationFailure[];
  skillSteps: string[];
  pendingElicitation: PendingElicitation | null;
  writtenNotes: Array<{ relPath: string; kind: NoteKind }>;
  /** Create-only writes that hit a note the user already had, so nothing was
   *  written (#108). Kept separate from `writtenNotes`: nothing landed on disk,
   *  but the no-op is not allowed to disappear either. */
  existingNotes: Array<{ relPath: string; kind: NoteKind }>;
  /** Notes the model composed live, in first-seen order. An entry here has NOT
   *  been written — it pairs with the `toolCalls` entry of the same id, which is
   *  what says whether the write went on to succeed. */
  noteEdits: NoteEditView[];
  /** Every tool call of the turn, in the order the model made them. */
  toolCalls: ToolCallView[];
  /** Transcript provenance as reported by the tools that fetched it. */
  transcriptSources: TranscriptSourceView[];
  /** Why the run ended having done only part of its work, straight from the
   *  orchestrator that knows. `null` means it did not end short. */
  partialRun: string | null;
  /** The live "searching / reading / verifying" trace, in order. */
  activity: ActivityStep[];
  /** Pinned at turn creation because reasoning can be toggled off mid-stream;
   *  the finished turn stays self-describing against the opt-in it ran under. */
  reasoningRequested: boolean;
  /** Optional streamed reasoning tokens (rendered collapsed). */
  thinking: string;
  /** The streamed answer markdown, accumulated delta by delta. */
  answer: string;
  citations: CitationView[];
  coverage: CoverageView | null;
  /** A surfaced, non-fatal turn error — shown inline, never swallowed. */
  error: string | null;
  /** True once the run ended (a `done` or `error` event). */
  done: boolean;
  /** A matching user stop won before normal completion. */
  stopped: boolean;
  /** The streamed answer hit the model's token/length ceiling and was cut off.
   *  The partial answer and its citations are still valid — this only marks the
   *  turn incomplete so the UI can say so; it never discards accumulated text.
   *  (Distinct from `CoverageView.truncated`, which is about search coverage.) */
  truncated: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

/** A fresh assistant turn, before any event has landed. */
export function emptyAssistant(
  reasoningRequested = false,
  turnId: string | null = null,
): AssistantMessage {
  return {
    role: "assistant",
    turnId,
    phase: "sending",
    skillActivations: [],
    skillActivationFailures: [],
    skillSteps: [],
    pendingElicitation: null,
    writtenNotes: [],
    existingNotes: [],
    noteEdits: [],
    toolCalls: [],
    transcriptSources: [],
    partialRun: null,
    activity: [],
    reasoningRequested,
    thinking: "",
    answer: "",
    citations: [],
    coverage: null,
    error: null,
    done: false,
    stopped: false,
    truncated: false,
  };
}

/** The distinct transcript-source labels this run reported, in first-seen order.
 *
 *  These come from the `transcriptSource` events the fetching tools emit, so they
 *  say where the text actually came from. They used to be regexed out of
 *  concatenated model prose, which meant any answer that merely *quoted* a label
 *  claimed it as provenance — a false claim about the source of the user's own
 *  notes, which is the one thing this app must never make. */
export function modelReportedProvenance(turn: AssistantMessage): string[] {
  return [...new Set(turn.transcriptSources.map((source) => source.label))];
}

/** Whether a settled skill run wrote notes but did not finish its work.
 *
 *  Both signals are authoritative: `stopped` is the user's own stop, and
 *  `partialRun` is the orchestrator reporting a guard it tripped or a
 *  cancellation it honoured. This used to test the model's prose for
 *  "cancelled|stopped|partial", so an answer that merely mentioned the word
 *  reported a complete run as incomplete. */
export function isPartialSkillRun(turn: AssistantMessage): boolean {
  if (
    !turn.done ||
    turn.skillActivations.length === 0 ||
    turn.writtenNotes.length === 0
  ) {
    return false;
  }
  return turn.stopped || turn.partialRun !== null;
}

/** The turn searched the vault and genuinely found nothing to cite.
 *
 *  Zero surviving citations does not mean the vault held nothing — it can also
 *  mean a note was read and the model answered without an [eN] marker, or the
 *  verifier dropped the quote. In either of those the vault *did* cover it, so
 *  "nothing covers this" would be a false claim about the user's own notes. The
 *  card fires only when the turn read nothing (`notesRead` empty) and dropped
 *  nothing; otherwise the footer and the model's own answer carry the account. */
export function showsNothingFoundCard(turn: AssistantMessage): boolean {
  return (
    turn.done &&
    !turn.stopped &&
    turn.error === null &&
    turn.coverage !== null &&
    turn.coverage.searchedTerms.length > 0 &&
    turn.coverage.notesRead.length === 0 &&
    turn.citations.length === 0 &&
    !turn.activity.some((step) => step.kind === "dropped")
  );
}

/** Fold one transport event into the assistant turn that owns its caller ID. */
export function reduceAssistantForTurn(
  messages: ChatMessage[],
  turnId: string,
  event: ChatEvent,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  if (turn.done && (!turn.stopped || event.type !== "noteWritten")) {
    return messages;
  }
  const next = messages.slice();
  next[index] = reduceAssistant(turn, event);
  return next;
}

/** Set the neutral stopped terminal state only on the matching active turn. */
export function markAssistantStopped(
  messages: ChatMessage[],
  turnId: string,
): ChatMessage[] {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      !message.done,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  const next = messages.slice();
  next[index] = {
    ...turn,
    pendingElicitation: null,
    error: null,
    done: true,
    stopped: true,
  };
  return next;
}

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
 *  that has to be visible, not a stray event to swallow. */
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
  return [...calls, { name: "", title: "", arguments: "", ...settlement }];
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

/** Immutably fold one streamed `ChatEvent` into the assistant turn's view
 *  state. Total over the `ChatEvent` union — a new variant is a compile error
 *  here, so the UI can never silently ignore a backend event. */
export function reduceAssistant(
  turn: AssistantMessage,
  event: ChatEvent,
): AssistantMessage {
  switch (event.type) {
    case "processing":
      return { ...turn, phase: "thinking" };
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
    case "error":
      // A run ends on `error` too — mark it done so the working indicator
      // clears, but keep the message visible.
      return { ...turn, error: event.message, done: true };
    case "done":
      return { ...turn, done: true };
  }
}

/** Resolve `[eN]` citation markers in an answer against the verified citations.
 *  Citations arrive only after the answer has streamed, so while the turn is
 *  still running the markers are left exactly as the model emitted them. Once the
 *  turn is `done`, any `[eN]` with no matching verified citation was dropped by
 *  the verifier or hallucinated by the model — strip it (and a leading space) so
 *  a discredited citation is never left showing as a live reference. Citation
 *  fidelity is the moat: a marker pointing at nothing is a broken citation. */
export function resolveAnswerMarkers(
  answer: string,
  citations: CitationView[],
  done: boolean,
): string {
  if (!done) return answer;
  const verified = new Set(citations.map((c) => c.id));
  // Case-insensitive to mirror the Rust citation extractor (which accepts `[E9]`
  // and folds to lowercase); compare against the lowercased id the citation carries.
  return answer.replace(/ ?\[(e\d+)\]/gi, (whole, id: string) =>
    verified.has(id.toLowerCase()) ? whole : "",
  );
}

/** A `reading` step with the number of times that note was read consecutively
 *  folded in — so five back-to-back reads of one note render as one row (`×5`),
 *  not five identical lines. Its range widens to span every folded read. */
export type GroupedStep =
  | { kind: "search"; query: string; hitCount?: number }
  | { kind: "reading"; relPath: string; startLine: number; endLine: number; count: number }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

/** Collapse *consecutive* reads of the same note into a single counted row. Only
 *  consecutive runs merge, so the trace stays in execution order (a note re-read
 *  after other steps still shows again) — the common bloat case is a burst of reads
 *  of one note, which this flattens. Searches stay per-row: distinct queries are the
 *  point of the "watch it search" trace. */
export function groupActivity(activity: ActivityStep[]): GroupedStep[] {
  const out: GroupedStep[] = [];
  for (const step of activity) {
    const last = out.at(-1);
    if (step.kind === "reading" && last?.kind === "reading" && last.relPath === step.relPath) {
      last.count += 1;
      last.startLine = Math.min(last.startLine, step.startLine);
      last.endLine = Math.max(last.endLine, step.endLine);
      continue;
    }
    out.push(step.kind === "reading" ? { ...step, count: 1 } : step);
  }
  return out;
}

/** The one-line footer the collapsed trace shows once the turn is done. `notesRead`
 *  counts *distinct* notes (provenance honesty — reading one note five times is one
 *  source, not five), `dropped` counts discarded citations (surfaced, never hidden —
 *  a dropped citation is the moat's honesty signal). */
export interface ActivitySummary {
  searches: number;
  notesRead: number;
  dropped: number;
  verified: boolean;
  totalSteps: number;
}

export function summarizeActivity(activity: ActivityStep[]): ActivitySummary {
  let searches = 0;
  let dropped = 0;
  let verified = false;
  const notes = new Set<string>();
  for (const step of activity) {
    switch (step.kind) {
      case "search":
        searches += 1;
        break;
      case "reading":
        notes.add(step.relPath);
        break;
      case "verifying":
        verified = true;
        break;
      case "dropped":
        dropped += 1;
        break;
    }
  }
  return { searches, notesRead: notes.size, dropped, verified, totalSteps: activity.length };
}

/** Strip every `[eN]` citation marker from a prior answer before it re-enters a
 *  later turn's context. Evidence ids are assigned fresh per run (the Rust registry
 *  starts empty each `run_chat`), so a marker carried forward refers to nothing in
 *  the new turn's registry — and if the model echoes it, the verifier can validate it
 *  against an *unrelated* freshly-retrieved span, surfacing as a "verified" citation
 *  whose source text doesn't match the prose claim (SUS-1 — the exact failure the moat
 *  forbids). History is plain conversational context, so the markers add nothing;
 *  dropping all of them (verified or not) closes the hole at the source. */
export function stripCitationMarkers(answer: string): string {
  return answer.replace(/ ?\[e\d+\]/gi, "");
}

/** Cap on how many prior turns are resent as context. Without it, every `chat`
 *  request carries the entire transcript, so per-turn token cost grows linearly with
 *  conversation length and a long chat eventually trips the provider's context limit
 *  (PA-003). We keep the most recent turns and drop older ones — recency is what the
 *  next answer usually needs. (The core separately caps tool-result content within a
 *  run via `max_context_chars`; this bounds the conversation history.) */
const MAX_HISTORY_TURNS = 20;

/** The prior conversation as plain `ChatTurn`s, for the next `chat` request.
 *  Empty assistant turns (errored / no answer) are dropped so the model isn't
 *  handed blank context; `[eN]` markers are stripped so stale ids can't re-enter a
 *  later run and mis-cite (see `stripCitationMarkers`); and the history is windowed
 *  to the last `MAX_HISTORY_TURNS` so per-turn cost stays bounded (see above). */
export function toHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .map((m): ChatTurn =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: stripCitationMarkers(m.answer) },
    )
    .filter((turn) => turn.content.trim() !== "")
    .slice(-MAX_HISTORY_TURNS);
}
