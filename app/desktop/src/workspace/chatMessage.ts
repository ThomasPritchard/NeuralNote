// The chat pane's view model: what a chat IS, and what one assistant turn
// accumulates. A chat is a list of `ChatMessage`s; an assistant turn gathers the
// streamed `ChatEvent`s into the live search/read/verify "harness" log, the
// streamed answer, cited sources, and a coverage footer.
//
// This file is the vocabulary and nothing else — types, and the empty value a
// turn starts from. The three verbs over it each have their own file, so each
// can say what it is without an "and":
//
//   * `chatMessageReducer.ts` folds ONE event into ONE turn, purely.
//   * `chatTurnStream.ts` applies the live stream to the transcript — which turn
//     owns an event, the clock that dates it, what a Stop settles.
//   * `chatTurnReadouts.ts` derives what the UI may honestly SAY about a turn.
//
// Keeping the fold pure and framework-free makes the harness unit-testable
// without React.

import type {
  ApprovalDegradedReason,
  ApprovalReason,
  ApprovalResolution,
  ApprovalRule,
  ElicitOption,
  GatedTool,
  NoteKind,
  PlaylistPosition,
  StepStatus,
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

/** Which turn of the run one train of thought came from.
 *
 *  Reasoning streams on every tool-deciding round AND on the answer turn, so a
 *  run produces several distinct trains of thought rather than one. Both
 *  boundaries are already on the wire and need no event of their own:
 *  `planningRound` opens a round, and `verifying` — emitted between evidence
 *  collection and the streamed answer — opens the answer turn. */
export type ReasoningSource =
  /** One tool-deciding round's reasoning, labelled with the round it came from.
   *  The number is the beacon's, so it survives a ceiling that grows mid-run. */
  | { kind: "round"; round: number }
  /** The answer turn's own reasoning — the run's last train of thought. */
  | { kind: "answer" }
  /** Reasoning that arrived before any boundary named a turn for it. The wire
   *  cannot produce this (the beacon precedes the first model request), so in
   *  practice it is a turn assembled by hand — and it renders unlabelled rather
   *  than being attributed to a guess. */
  | { kind: "unattributed" };

/** Where one train of thought gives way to the next.
 *
 *  Only the boundary is stored, never a second copy of the text: `thinking`
 *  stays the one place reasoning accumulates, and `reasoningSegments` is a view
 *  onto it. Two stores of the same prose eventually disagree, and this one is
 *  the disclosure a user reads to see what the model was doing. */
export interface ReasoningBoundary {
  /** Which turn the reasoning from `at` onwards belongs to. `unattributed` is
   *  excluded because nothing ever announces it — it is what the *absence* of a
   *  boundary produces. */
  source: Exclude<ReasoningSource, { kind: "unattributed" }>;
  /** How many characters of `thinking` had arrived when this turn began. */
  at: number;
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
  /** Every reasoning token the run streamed, in arrival order — the one place
   *  reasoning is stored. Read it for "did any reasoning arrive at all"; read
   *  `reasoningSegments` to render it, because a run reasons several separate
   *  times and this string runs those trains of thought together. */
  thinking: string;
  /** Where each train of thought starts within `thinking`, in order. */
  reasoningBoundaries: ReasoningBoundary[];
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
    reasoningBoundaries: [],
    answer: "",
    citations: [],
    coverage: null,
    error: null,
    done: false,
    stopped: false,
    truncated: false,
  };
}
