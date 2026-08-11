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
import type { AssistantMessage, ToolCallView } from "./chatMessage";
import { playfulProgressCopy } from "./playfulProgressCopy";
import { approvalNodeState } from "./approvalCopy";
import { ApprovalDegradedNode, ToolApprovalNode } from "./ChatApprovalNode";
import { PlanStepNode } from "./ChatPlanNode";
import {
  ActivationFailureNode,
  DroppedNode,
  ThinkingNode,
  ToolNode,
  VerifyingNode,
} from "./ChatTimelineNodes";
import {
  keyed,
  railCalls,
  timelineEntries,
  timelineRows,
  type KeyedEntry,
  type TimelineEntry,
} from "./chatTimelineRows";

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

/** The nodes dispatched under one plan step. `last` is scoped to the group, so
 *  the nested hairline stops at the group's own final node rather than running
 *  on into the step below it. */
function nestedNodes(children: KeyedEntry[]) {
  return children.map(({ entry, key }, i) => (
    <TimelineEntryNode key={key} entry={entry} last={i === children.length - 1} />
  ));
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
    // A step the model declared and could not complete. It says the run did
    // less than the answer above it implies, which is the same reason a failed
    // call opens the fold — and unlike a failed call, nothing else on screen
    // says so.
    turn.planSteps.some((step) => step.status === "failed") ||
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

  // Keyed by kind + occurrence, so a node keeps its identity as the list grows:
  // a re-key would remount the visible rows, restarting the in-flight spinner
  // and discarding any disclosure the user had opened. Keys are assigned before
  // grouping, so gaining a plan re-parents a node rather than remounting it.
  const rows = timelineRows(turn, keyed(entries));

  // Nothing happened and nothing is happening: say nothing at all. Tested on
  // ROWS, not on entries: a plan is content in its own right, and a model that
  // declares three steps and then answers from what it already knew must not
  // have its stated intentions disappear because no tool was dispatched.
  if (rows.length === 0 && !live) return null;

  // Every row the rail carries, nested ones included — the same number as before
  // whenever no plan was declared, which is what keeps the unplanned head
  // unchanged.
  const nodeCount = entries.length + turn.planSteps.length;
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
            <LiveHead phase={turn.phase} prompt={prompt} nodeCount={nodeCount} />
          ) : (
            <SummaryLine
              turn={turn}
              calls={calls}
              nodeCount={nodeCount}
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
            {rows.map((row, i) =>
              row.kind === "node" ? (
                <TimelineEntryNode key={row.key} entry={row.entry} last={i === lastRow} />
              ) : (
                <PlanStepNode key={row.key} step={row.step} last={i === lastRow} nodes={nestedNodes(row.children)} />
              ),
            )}
          </ol>
        )}
      </details>
    </section>
  );
}
