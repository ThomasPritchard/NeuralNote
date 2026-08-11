// The assistant turn's process section: one connected vertical rail carrying
// everything the assistant did, in the order a run does it — the skill it tried
// to activate, its reasoning, every tool call it dispatched, and the citation
// verification at the end.
//
// Three behaviours carry the design:
//   1. One rail, not a list. State reads from the glyph column before any text.
//   2. The whole process folds the moment the answer starts streaming — a
//      24-second trace must never push the answer off screen.
//   3. Every dispatched node stays on the rail, live and settled. The rail is
//      the complete, ordered account of what the agent did; one that silently
//      dropped steps WHILE they were happening would break the audit at exactly
//      the moment the user is watching it. Restraint is enforced per node
//      instead — a bounded argument hint (`MAX_HINT_CHARS`) keeps one verbose
//      model-written argument from wrapping over seven lines and swamping the
//      timeline — and the pane's own scroll port already keeps the newest node
//      in view without anything being taken off the record.
//
// Presentational only: every count comes from the reducer's own selectors and
// every label from the backend, so nothing here composes or matches prose.

import { ChevronRight, Loader2 } from "lucide-react";
import { summarizeActivity } from "./chatMessage";
import type {
  AssistantMessage,
  SkillActivationFailure,
  ToolApprovalView,
  ToolCallView,
} from "./chatMessage";
import type { ApprovalDegradedReason } from "../lib/types";
import { playfulProgressCopy } from "./playfulProgressCopy";
import { approvalNodeState } from "./approvalCopy";
import { ApprovalDegradedNode, ToolApprovalNode } from "./ChatApprovalNode";
import {
  ActivationFailureNode,
  DroppedNode,
  ThinkingNode,
  ToolNode,
  VerifyingNode,
} from "./ChatTimelineNodes";

/** Pluralise a count with its noun. Irregular plurals (search→searches) are
 *  passed explicitly rather than guessed from a suffix. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A phase is visible only after the event that grounds it arrives. */
function livePhase(phase: AssistantMessage["phase"], prompt: string): string {
  const playful = playfulProgressCopy(prompt);
  switch (phase) {
    case "sending":
      return playful.sending;
    case "thinking":
      return playful.thinking;
    case "searching":
      return "Searching your vault";
    case "reading":
      return "Reading notes";
    case "verifying":
      return "Verifying citations";
  }
}

/** One rail node, before it is rendered. The wire carries no global sequence
 *  number, so nodes are grouped in the order a run's phases actually occur —
 *  activation, reasoning, dispatched calls, verification — rather than pretending
 *  to an interleaving the events cannot support. */
type TimelineEntry =
  | { kind: "failure"; failure: SkillActivationFailure }
  | { kind: "thinking"; text: string }
  | { kind: "degraded"; reason: ApprovalDegradedReason }
  | { kind: "approval"; approval: ToolApprovalView }
  | { kind: "tool"; call: ToolCallView }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

/** Build the rail's nodes from the folded turn.
 *
 *  `searching` / `reading` activity steps deliberately do NOT become nodes: they
 *  are emitted by the very tool calls above them (`handle_tool_call` sends the
 *  cue, then the call settles), so rendering both would show one act twice. They
 *  still drive the settled summary's counts, where they are the cheapest honest
 *  source.
 *
 *  A previewed write is the same rule one step further. `ChatNoteEditCard` and
 *  the tool node share an id and describe one act, and the card is strictly the
 *  fuller account — it carries the composed body, the running count, and the
 *  call's own settlement and failure detail. So the node stands down. This is a
 *  SET test over the turn's edits, never a test of arrival order: the preview
 *  streams during the turn and its tool call is announced when the turn settles,
 *  so for most of a card's life there is no node to stand down yet. */
function railCalls(turn: AssistantMessage): ToolCallView[] {
  const previewed = new Set(turn.noteEdits.map((edit) => edit.id));
  return turn.toolCalls.filter((call) => !previewed.has(call.id));
}

/** Pair each gated call's approval node with the call it governs.
 *
 *  Walks `toolCalls` rather than `toolApprovals` so an approval lands directly
 *  above the call it decided — the gate runs, then the call dispatches, and the
 *  rail should read in that order. The walk is over ALL calls, not just the ones
 *  the rail shows: a previewed write stands its tool node down in favour of
 *  `ChatNoteEditCard`, but that card carries no account of the approval, so the
 *  approval node stays regardless.
 *
 *  An approval whose `toolCall` has not arrived yet is appended afterwards
 *  instead of being dropped. The gate keys its events on the tool-call id, so in
 *  practice the call is announced first; a request that somehow outruns its call
 *  is a broken contract that has to be visible, not an event to swallow. */
function approvalEntries(turn: AssistantMessage, onRail: ReadonlySet<string>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const placed = new Set<string>();
  for (const call of turn.toolCalls) {
    const approval = turn.toolApprovals.find((entry) => entry.id === call.id);
    if (approval !== undefined && !placed.has(approval.id)) {
      entries.push({ kind: "approval", approval });
      placed.add(approval.id);
    }
    if (onRail.has(call.id)) entries.push({ kind: "tool", call });
  }
  for (const approval of turn.toolApprovals) {
    if (!placed.has(approval.id)) entries.push({ kind: "approval", approval });
  }
  return entries;
}

function timelineEntries(turn: AssistantMessage, calls: ToolCallView[]): TimelineEntry[] {
  const entries: TimelineEntry[] = turn.skillActivationFailures.map((failure) => ({
    kind: "failure" as const,
    failure,
  }));
  if (turn.thinking.trim() !== "") {
    entries.push({ kind: "thinking", text: turn.thinking });
  }
  if (turn.approvalDegraded !== null) {
    entries.push({ kind: "degraded", reason: turn.approvalDegraded });
  }
  entries.push(...approvalEntries(turn, new Set(calls.map((call) => call.id))));
  for (const step of turn.activity) {
    if (step.kind === "verifying") entries.push({ kind: "verifying" });
    if (step.kind === "dropped") entries.push({ kind: "dropped", reason: step.reason });
  }
  return entries;
}

/** Keys by kind + occurrence. The rail is append-only and never reordered, so
 *  "the 2nd dropped citation" is a durable identity even when a tool id repeats
 *  or two citations are dropped for the same reason. */
function keyed(entries: TimelineEntry[]): Array<{ entry: TimelineEntry; key: string }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const n = seen.get(entry.kind) ?? 0;
    seen.set(entry.kind, n + 1);
    return { entry, key: `${entry.kind}#${n}` };
  });
}

function TimelineEntryNode({
  entry,
  last,
}: Readonly<{ entry: TimelineEntry; last: boolean }>) {
  switch (entry.kind) {
    case "failure":
      return <ActivationFailureNode failure={entry.failure} last={last} />;
    case "thinking":
      return <ThinkingNode text={entry.text} last={last} />;
    case "degraded":
      return <ApprovalDegradedNode reason={entry.reason} last={last} />;
    case "approval":
      return <ToolApprovalNode approval={entry.approval} last={last} />;
    case "tool":
      return <ToolNode call={entry.call} last={last} />;
    case "verifying":
      return <VerifyingNode last={last} />;
    case "dropped":
      return <DroppedNode reason={entry.reason} last={last} />;
  }
}

/** The one-line account the head shows once the process has settled.
 *
 *  Copy: "N tools · N searches · N notes · verified" — or "· nothing found" when
 *  retrieval came up empty (the zero-hit calls stay auditable on the rail). What
 *  went wrong is appended in the destructive/warning register and never hidden:
 *  a failed call and a dropped citation are the two things worth interrupting a
 *  calm summary for. Written notes are pointedly absent — the report card below
 *  owns that ledger, and two independently-computed provenance lines in one turn
 *  eventually disagree with each other. */
function SummaryLine({
  turn,
  calls,
  nodeCount,
  errored,
}: Readonly<{
  turn: AssistantMessage;
  /** The calls the rail actually shows — a previewed write is accounted for by
   *  its own card, so counting it here would report a failure with no node under
   *  the head to explain it. */
  calls: ToolCallView[];
  nodeCount: number;
  errored: boolean;
}>) {
  const { searches, notesRead, dropped, verified } = summarizeActivity(turn.activity);
  // "Failed" and "never ran" are different accounts and the head must not merge
  // them: a call the user declined did not fail, and reporting it as a failure
  // is the same false attribution that made `denied`, `timedOut` and `cancelled`
  // three wire statuses instead of one.
  const failed = calls.filter(
    (call) => call.status === "error" || call.status === "rejected",
  ).length;
  const notRun = calls.filter(
    (call) =>
      call.status === "denied" || call.status === "timedOut" || call.status === "cancelled",
  ).length;
  const segs: string[] = [];
  if (calls.length > 0) {
    segs.push(count(calls.length, "tool", "tools"));
  }
  if (searches > 0) segs.push(count(searches, "search", "searches"));
  if (notesRead > 0) {
    segs.push(count(notesRead, "note", "notes"));
    if (verified) segs.push("verified");
  } else if (searches > 0) {
    segs.push("nothing found");
  }
  // Never an empty head: a rail with nodes but no countable retrieval (a
  // reasoning-only turn, say) still says how much happened.
  const counted = segs.length > 0 ? segs.join(" · ") : count(nodeCount, "step", "steps");
  // A run that died must never wear a grey "completed" summary above a red error
  // box — that reads as "finished, then something unrelated broke". The rail
  // below is where it died, i.e. the diagnostic context for the error box.
  const base = errored ? `Failed — ${counted}` : counted;
  return (
    <span className="min-w-0">
      {base}
      {failed > 0 && (
        <span className="text-warning"> · {count(failed, "call", "calls")} failed</span>
      )}
      {notRun > 0 && (
        <span className="text-warning"> · {count(notRun, "call", "calls")} never ran</span>
      )}
      {dropped > 0 && (
        <span className="text-destructive">
          {" "}
          · {count(dropped, "citation", "citations")} dropped
        </span>
      )}
    </span>
  );
}

/** The live head: the phase the run is genuinely in, plus a running tally.
 *
 *  Only the phase word is a live region — it changes ~3× a run. The tally is
 *  aria-hidden because its per-node churn would otherwise announce 15–20 times.
 *  (`<output>` carries an implicit status role and renders inline.) */
function LiveHead({
  phase,
  prompt,
  nodeCount,
}: Readonly<{ phase: AssistantMessage["phase"]; prompt: string; nodeCount: number }>) {
  return (
    <>
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden
      />
      <output>{livePhase(phase, prompt)}</output>
      {nodeCount > 0 && (
        <span aria-hidden className="font-normal text-muted-foreground/60">
          · {count(nodeCount, "step", "steps")}
        </span>
      )}
    </>
  );
}

/** Whether the fold has something the user should be pushed into rather than
 *  left to discover. All three are honesty signals, not decoration: a dropped
 *  citation is the moat's own alarm, a refused or failed call means the run did
 *  less than it looks like it did, and searches that read nothing are the queries
 *  worth rephrasing. */
function needsAttention(turn: AssistantMessage, calls: ToolCallView[]): boolean {
  const { searches, notesRead, dropped } = summarizeActivity(turn.activity);
  return (
    dropped > 0 ||
    calls.some((call) => call.status !== null && call.status !== "ok") ||
    (searches > 0 && notesRead === 0) ||
    // Anything the gate did that is not a settled automatic approval. A prompt
    // the user has to answer, a check they are waiting on, or a call that never
    // ran must never be one collapsed fold away — and automatic checking having
    // switched itself off is the frame for every prompt that follows it.
    turn.approvalDegraded !== null ||
    turn.toolApprovals.some((approval) => {
      const kind = approvalNodeState(approval).kind;
      return kind !== "autoApproved" && kind !== "approvedByYou";
    })
  );
}

/** The process section, routed by run phase:
 *
 *  • streaming, pre-answer → open, with a bounded live window.
 *  • answering / settled   → folded to the one-line summary; expanding audits
 *    the whole rail.
 *  • errored, or anything to act on → stays open, because the rail is then the
 *    diagnostic context for what went wrong, not an optional detail.
 *
 *  `open` is derived, never mirrored in state: React writes the DOM prop only
 *  when the value changes, so the fold auto-collapses when the answer starts and
 *  a user who re-opens it afterwards keeps it open. */
export function ChatTimeline({
  turn,
  prompt,
  answering,
  suppressLive,
}: Readonly<{
  turn: AssistantMessage;
  prompt: string;
  /** Answer tokens have started arriving — the answer is the live focus now. */
  answering: boolean;
  /** A skill narrative (header/steps/question) is already carrying the live
   *  view, so no spinner may claim "Searching your vault" over a run that isn't
   *  searching — it may be waiting on the user. The rail's nodes still show. */
  suppressLive: boolean;
}>) {
  const errored = turn.error !== null;
  const calls = railCalls(turn);
  const entries = timelineEntries(turn, calls);
  const live = !turn.done && !answering && !suppressLive;

  // Nothing happened and nothing is happening: say nothing at all.
  if (entries.length === 0 && !live) return null;

  // Keyed by kind + occurrence, so a node keeps its identity as the list grows:
  // a re-key would remount the visible rows, restarting the in-flight spinner
  // and discarding any disclosure the user had opened.
  const rows = keyed(entries);
  const lastRow = rows.length - 1;
  return (
    <section aria-label="What the assistant did" className="min-w-0">
      <details
        open={errored || !answering || needsAttention(turn, calls)}
        className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground"
      >
        <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 font-medium text-muted-foreground/90 [&::-webkit-details-marker]:hidden">
          {/* The fold affordance is always present, live or settled, and its 12px
              width plus the 6px gap is what the rail's `pl-[18px]` aligns to. */}
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          {live ? (
            <LiveHead phase={turn.phase} prompt={prompt} nodeCount={entries.length} />
          ) : (
            <SummaryLine
              turn={turn}
              calls={calls}
              nodeCount={entries.length}
              errored={errored}
            />
          )}
        </summary>
        {rows.length > 0 && (
          // A floor under the live rail, not a ceiling: the first node or two
          // sit in a reserved footprint so the block does not jolt a row taller
          // on every dispatch. Past that it simply grows, and the transcript's
          // own pin keeps the newest node in view.
          <ol
            className={
              live
                ? "mt-1.5 flex min-h-[3.75rem] flex-col justify-end pl-[18px]"
                : "mt-1.5 flex flex-col pl-[18px]"
            }
          >
            {rows.map(({ entry, key }, i) => (
              <TimelineEntryNode key={key} entry={entry} last={i === lastRow} />
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
