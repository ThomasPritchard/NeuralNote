// The chat pane's view model + the pure event reducer. A chat is a list of
// `ChatMessage`s; an assistant turn accumulates the streamed `ChatEvent`s (the
// live search/read/verify "harness" log, the streamed answer, cited sources,
// and a coverage footer). Keeping the fold pure and framework-free makes the
// harness feel unit-testable without React.

import type {
  ApprovalDegradedReason,
  ApprovalReason,
  ApprovalResolution,
  ApprovalRule,
  ChatEvent,
  ChatTurn,
  ElicitOption,
  GatedTool,
  NoteKind,
  PlaylistPosition,
  StepStatus,
  ToolStatus,
} from "../lib/types";
import { reduceAssistant } from "./chatMessageReducer";

// Re-exported so every existing importer keeps its import path. The fold itself
// lives in `chatMessageReducer.ts`, with the `: AssistantMessage` annotation that
// makes it total.
export { reduceAssistant };

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
  /** The `planSteps` id this call was dispatched under, so the timeline can nest
   *  it beneath that step. The backend stamps it at dispatch and it never moves
   *  again — a step that starts later must not adopt a node that already went
   *  out.
   *
   *  `null` is ordinary, not a failure: the run declared no plan (the common
   *  case), or no step was running when the call went out. Such a node renders
   *  ungrouped, exactly as every node did before plans existed. It takes no part
   *  in settlement, which correlates on `id` alone. */
  stepId: string | null;
  /** The latest line the running tool sent about itself, or absent while it has
   *  said nothing. Rust-composed, never model prose, and last-writer-wins: a
   *  long tool narrates its stages and only the current one is worth standing.
   *
   *  Optional because a node only carries what actually arrived — a call that
   *  never narrated itself has no line, which is different from an empty one. */
  progress?: string;
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

/** The approval gate's state for one gated tool call, keyed by the tool-call id
 *  so it pairs with the `toolCalls` entry of the same id rather than becoming a
 *  second node.
 *
 *  Every field here is Rust-authored except `id` (the provider's correlation
 *  key): the tool, the reason, the resolution and the rule are all closed enums,
 *  and `relPath` is the path the APP resolved. None of it is model prose, which
 *  is what keeps a security prompt's copy out of the model's hands. */
export interface ToolApprovalView {
  id: string;
  /** `null` only for a resolution that arrived before its request — the gate
   *  reports `unavailable` ahead of the prompt so the pause is explained. */
  tool: GatedTool | null;
  /** For the human. The judge never sees it. */
  relPath: string | null;
  reason: ApprovalReason | null;
  expiresInSecs: number | null;
  /** The gate is waiting on the judge. Never terminal: it resolves within the
   *  judge's budget or because of it. */
  checking: boolean;
  /** How it settled, or `null` while it is still open. */
  resolution: ApprovalResolution | null;
  /** The compiled-in rule an automatic approval ran under, or `null` when the
   *  user was asked. Present under YOLO too — the prompt is skipped, the record
   *  is not. */
  autoApprovedRule: ApprovalRule | null;
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

/** Which tool-deciding round the run is on, as the last beacon said.
 *
 *  `max` is never cached: activating a skill raises the ceiling mid-run, so the
 *  backend re-reads it every round and this holds whatever the latest beacon
 *  carried. During a playlist it is not the number to show at all — the
 *  playlist's own length is (see `AssistantMessage.playlist`). */
export interface PlanningRoundView {
  current: number;
  max: number;
}

/** The video the run is working on, for the card beside the live head.
 *
 *  Every field is host-read metadata, never model prose. A `null` thumbnail is
 *  the *degraded path, not an error*: the fetch is capped and timed out, and a
 *  card with no image is the one that has to look deliberate. */
export interface VideoPreviewView {
  videoId: string;
  title: string;
  durationSecs: number | null;
  channel: string | null;
  thumbnailDataUri: string | null;
}

/** One step of the plan the model declared, and where it has got to.
 *
 *  `label` is model prose — unavoidably, since only the model knows what it
 *  intends — so it is rendered as a label and never matched on. */
export interface PlanStepView {
  id: string;
  label: string;
  status: StepStatus;
}

/** What the run cost. Token counts are nullable because not every provider
 *  reports them, and an unreported count must render as *absent*: a `0` would
 *  read as a real measurement of nothing. `elapsedMs` is always ours to
 *  measure, so it is never null. */
export interface UsageView {
  elapsedMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  /** Caller-generated identity used to route events and cancellation outcomes. */
  turnId: string | null;
  /** The last progress phase backed by an actual transport/backend event.
   *
   *  There is deliberately no `"thinking"` member. "Thinking" is a claim that
   *  reasoning tokens are arriving *right now*, which no phase can hold on to —
   *  it used to be set by `processing`, an event emitted before a single token
   *  had been asked for. `reasoningStreaming` carries that claim instead, and
   *  the absence of the member is what stops it coming back. */
  phase: "sending" | "planning" | "searching" | "reading" | "verifying";
  /** Reasoning deltas are arriving right now: true on a `thinking` delta and
   *  false again on the next event that reports anything else. */
  reasoningStreaming: boolean;
  /** The tool-deciding round the run is on, or `null` before the first beacon. */
  round: PlanningRoundView | null;
  /** Which video of a selected playlist is in flight, or `null` when no
   *  playlist is running. Re-read from every beacon, so the end of a playlist
   *  clears it rather than leaving "video 3 of 3" over the answer turn. */
  playlist: PlaylistPosition | null;
  /** The card for the video being processed, or `null`. */
  videoPreview: VideoPreviewView | null;
  /** When the turn's first event landed, as the client's clock read it — the
   *  origin for the live elapsed readout. `0` means nothing has arrived yet,
   *  and renders as no clock rather than as `0s`. */
  startedAt: number;
  /** The last event that reported PROGRESS. What the stall notice watches. */
  lastEventAt: number;
  /** The last event of any kind, keepalives included. What tells "still
   *  working" apart from "the provider has gone away". */
  lastAliveAt: number;
  skillActivations: Array<{ id: string; name: string }>;
  /** Skills that could not be activated, reported structurally by the backend —
   *  never inferred from the wording of a progress message. */
  skillActivationFailures: SkillActivationFailure[];
  skillSteps: string[];
  pendingElicitation: PendingElicitation | null;
  /** The approval gate's state per gated call, in first-seen order. */
  toolApprovals: ToolApprovalView[];
  /** The security prompt currently awaiting the user, or `null`. Deliberately a
   *  separate field from `pendingElicitation`: answering a model-authored
   *  question must never be able to satisfy a security prompt, and the two go to
   *  different Tauri commands. */
  pendingApproval: ToolApprovalView | null;
  /** Why automatic checking switched off for the rest of the turn, or `null`.
   *  First reason wins, like `partialRun`. */
  approvalDegraded: ApprovalDegradedReason | null;
  writtenNotes: Array<{ relPath: string; kind: NoteKind }>;
  /** Create-only writes that hit a note the user already had, so nothing was
   *  written (#108). Kept separate from `writtenNotes`: nothing landed on disk,
   *  but the no-op is not allowed to disappear either. */
  existingNotes: Array<{ relPath: string; kind: NoteKind }>;
  /** Notes the model composed live, in first-seen order. An entry here has NOT
   *  been written — it pairs with the `toolCalls` entry of the same id, which is
   *  what says whether the write went on to succeed. */
  noteEdits: NoteEditView[];
  /** The steps the model declared it intended to take, in declared order.
   *
   *  Empty when it never declared a plan, which is the ordinary case and not a
   *  failure — the rail simply renders without step grouping. The backend
   *  declares the set once and refuses any later call that changes it
   *  (`plan.rs::same_steps`), so entries are only ever *restatused* here, never
   *  added, removed or relabelled after the fact. */
  planSteps: PlanStepView[];
  /** What the run cost, or `null` until the backend reports it (immediately
   *  before `done`) — and `null` forever if it never does. */
  usage: UsageView | null;
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
    reasoningStreaming: false,
    round: null,
    playlist: null,
    videoPreview: null,
    // Stamped by the first event rather than by this factory, so a turn built
    // for a test is a fixed value and two of them are still comparable.
    startedAt: 0,
    lastEventAt: 0,
    lastAliveAt: 0,
    skillActivations: [],
    skillActivationFailures: [],
    skillSteps: [],
    pendingElicitation: null,
    toolApprovals: [],
    pendingApproval: null,
    approvalDegraded: null,
    writtenNotes: [],
    existingNotes: [],
    noteEdits: [],
    planSteps: [],
    usage: null,
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
 *  mean a note was read and the model answered without an [eN] marker, the
 *  verifier dropped the quote, or the search returned spans the model never
 *  opened. In every one of those the vault *did* cover it, so "nothing covers
 *  this" would be a false claim about the user's own notes.
 *
 *  Coverage decides whether the card is eligible; the activity log only ever
 *  vetoes it. A dropped citation is one veto and a search that reported spans is
 *  another — the second was missing, so the card made the same false claim as
 *  the rail summary in #122, one line lower and in bigger type. A search still
 *  awaiting its `retrieved` event vetoes it too: nothing has confirmed the vault
 *  is empty, and "not yet known" must not render as "no". */
export function showsNothingFoundCard(turn: AssistantMessage): boolean {
  const retrieval = searchOutcome(turn.activity).kind;
  // `none` is not a veto: the activity log simply has nothing to say about
  // retrieval, and coverage governs exactly as it did before hit counts existed.
  const retrievalAgrees = retrieval === "empty" || retrieval === "none";
  return (
    turn.done &&
    !turn.stopped &&
    turn.error === null &&
    turn.coverage !== null &&
    turn.coverage.searchedTerms.length > 0 &&
    turn.coverage.notesRead.length === 0 &&
    turn.citations.length === 0 &&
    retrievalAgrees &&
    !turn.activity.some((step) => step.kind === "dropped")
  );
}

/** Fold one event in, and date the turn by it.
 *
 *  This is where a `keepalive` finally means something. It refreshes
 *  `lastAliveAt` and deliberately leaves `lastEventAt` alone, which is the whole
 *  distinction: the socket being alive is not the work progressing, so a
 *  provider emitting comment lines forever can never clear a stall notice about
 *  a run that has stopped producing anything.
 *
 *  The clock lives here rather than in the pure fold so `reduceAssistant` stays
 *  a function of the event alone — and so a caller folding a fixture with
 *  `Array.reduce` cannot accidentally pass the array index in as the time.
 *
 *  `startedAt` is set by the first event to arrive, not by the send: the
 *  backend emits `processing` at the top of the run, before any provider call,
 *  so this is within an IPC hop of the moment `usage.elapsedMs` measures from. */
function foldWithLiveness(
  turn: AssistantMessage,
  event: ChatEvent,
  now: number,
): AssistantMessage {
  if (event.type === "keepalive") return { ...turn, lastAliveAt: now };
  const folded = reduceAssistant(turn, event);
  // An event that changed nothing has nothing to date either — and dating it
  // would cost the identity check below the render it exists to prevent.
  if (folded === turn) return turn;
  return {
    ...folded,
    startedAt: turn.startedAt === 0 ? now : turn.startedAt,
    lastEventAt: now,
    lastAliveAt: now,
  };
}

/** Fold one transport event into the assistant turn that owns its caller ID. */
export function reduceAssistantForTurn(
  messages: ChatMessage[],
  turnId: string,
  event: ChatEvent,
  now: number = Date.now(),
): ChatMessage[] {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId,
  );
  if (index < 0) return messages;
  const turn = messages[index] as AssistantMessage;
  if (turn.done && (!turn.stopped || !isPostStopSettlement(event))) {
    return messages;
  }
  const reduced = foldWithLiveness(turn, event, now);
  // An event that changed nothing returns the SAME list, not a copy of it: a
  // fresh array would still commit a render, and the transcript's scroll-follow
  // re-asserts its pin on every commit. The only event that reaches here with
  // nothing to say is a `toolProgress` naming a call this turn never saw live —
  // which the wire cannot produce (see `withProgress`). A `keepalive` does not
  // qualify: it refreshes the liveness the head reads, which is a real change
  // to real state.
  if (reduced === turn) return messages;
  const next = messages.slice();
  next[index] = reduced;
  return next;
}

/** Events that may still arrive after the user presses Stop.
 *
 *  Stop marks the turn `done` so the composer re-opens. In-flight tools,
 *  partial-run notices, and notes already committed must still land —
 *  otherwise a playlist-enumeration node spins forever. Answer, error, and
 *  Done must not: those would revive a turn the user already ended. */
function isPostStopSettlement(event: ChatEvent): boolean {
  return (
    event.type === "noteWritten" ||
    event.type === "toolResult" ||
    event.type === "partialRun" ||
    event.type === "usage" ||
    event.type === "coverage"
  );
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
    // A stopped run must not leave a security sheet on screen either — it would
    // sit there looking live while Rust, the only expiry authority, has already
    // torn the approval down.
    pendingApproval: null,
    error: null,
    done: true,
    stopped: true,
  };
  return next;
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

/** What a turn's searches have said about the vault. Three states, not two.
 *
 *  A search reports its hit count in a *separate* `retrieved` event, so between
 *  `searching` and `retrieved` the count is `undefined` — and `undefined` is
 *  "hasn't said yet", never zero. Collapsing those two into one boolean is what
 *  produced #122: the summary tested whether anything had been READ and then
 *  told the user nothing had been FOUND. They are different events, and the gap
 *  between them is routine — searches return spans and the model decides none
 *  are worth opening. Telling a user their vault holds nothing on a subject it
 *  demonstrably covers is a false claim about their own notes, which is the same
 *  class of failure as a wrong citation. */
export type RetrievalOutcome =
  /** No search ran, so there is no retrieval to report on. */
  | { kind: "none" }
  /** Every search that reported came back empty. The only state in which
   *  "nothing found" is a true statement about the vault. */
  | { kind: "empty" }
  /** A search is still to report and nothing has come back yet, so neither
   *  outcome may be claimed. Silence is the only honest answer here. */
  | { kind: "pending" }
  /** The vault returned `spans`. Whether any were opened is a separate question
   *  the model answers, and `notesRead` is where that is counted. */
  | { kind: "hits"; spans: number };

/** `hits` wins over `pending`: once one search has reported spans, retrieval
 *  demonstrably found something and a later straggler cannot unsay it. Only the
 *  empty-versus-not-yet distinction actually needs the pending guard. */
export function searchOutcome(activity: ActivityStep[]): RetrievalOutcome {
  let searches = 0;
  let spans = 0;
  let awaitingReport = false;
  for (const step of activity) {
    if (step.kind !== "search") continue;
    searches += 1;
    if (step.hitCount === undefined) awaitingReport = true;
    else spans += step.hitCount;
  }
  if (searches === 0) return { kind: "none" };
  if (spans > 0) return { kind: "hits", spans };
  return awaitingReport ? { kind: "pending" } : { kind: "empty" };
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
const MAX_CONTINUATION_PLAN_LABEL_CHARS = 240;

function continuationPlanLabel(label: string): string {
  const flattened = label.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flattened);
  if (chars.length <= MAX_CONTINUATION_PLAN_LABEL_CHARS) return flattened;
  return `${chars.slice(0, MAX_CONTINUATION_PLAN_LABEL_CHARS).join("")}…`;
}

/** A host-authored record of durable or incomplete run state for a later turn.
 *  Provider errors are deliberately not copied into model context: the next turn
 *  needs to know what completed, not receive transport prose as an instruction. */
function continuationRecord(turn: AssistantMessage): string | null {
  if (!turn.done) return null;
  const hasRecord =
    turn.writtenNotes.length > 0 ||
    turn.existingNotes.length > 0 ||
    turn.partialRun !== null ||
    turn.stopped ||
    turn.error !== null;
  if (!hasRecord) return null;

  const lines = ["NeuralNote continuation record:"];
  if (turn.writtenNotes.length > 0) {
    lines.push(
      "Completed note writes:",
      ...turn.writtenNotes.map((note) => `- ${note.relPath} (${note.kind})`),
    );
  }
  if (turn.existingNotes.length > 0) {
    lines.push(
      "Notes already present and left unchanged:",
      ...turn.existingNotes.map((note) => `- ${note.relPath} (${note.kind})`),
    );
  }
  if (turn.planSteps.length > 0) {
    lines.push(
      "Plan state:",
      ...turn.planSteps.map(
        (step) => `- [${step.status}] ${continuationPlanLabel(step.label)}`,
      ),
    );
  }
  if (turn.partialRun !== null) {
    lines.push(`Run ended early: ${turn.partialRun}`);
  } else if (turn.stopped) {
    lines.push("The run was stopped before it completed.");
  }
  if (turn.error !== null) {
    const recordedWork =
      turn.writtenNotes.length > 0 ||
      turn.existingNotes.length > 0 ||
      turn.planSteps.length > 0;
    lines.push(
      recordedWork
        ? "The final answer failed after the recorded work."
        : "The run failed before producing a final answer.",
    );
  }
  lines.push(
    turn.writtenNotes.length > 0
      ? "Continue from this record without repeating completed note writes."
      : "Use this status when responding to the next turn.",
  );
  return lines.join("\n");
}

function assistantHistoryContent(turn: AssistantMessage): string {
  const answer = stripCitationMarkers(turn.answer);
  const record = continuationRecord(turn);
  if (answer.trim() === "") return record ?? "";
  return record === null ? answer : `${answer}\n\n${record}`;
}

/** The prior conversation as plain `ChatTurn`s, for the next `chat` request.
 *  Empty assistant turns are dropped only when they have neither an answer nor a
 *  host-authored continuation record; `[eN]` markers are stripped so stale ids
 *  can't re-enter a later run and mis-cite (see `stripCitationMarkers`); and the
 *  history is windowed to the last `MAX_HISTORY_TURNS` so per-turn cost stays
 *  bounded (see above). */
export function toHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .map((m): ChatTurn =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: assistantHistoryContent(m) },
    )
    .filter((turn) => turn.content.trim() !== "")
    .slice(-MAX_HISTORY_TURNS);
}
