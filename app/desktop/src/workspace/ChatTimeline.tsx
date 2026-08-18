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

import { ChevronRight, Hourglass, Loader2 } from "lucide-react";
import { searchOutcome, summarizeActivity } from "./chatTurnReadouts";
import type { AssistantMessage, ToolCallView } from "./chatMessage";
import { cn } from "../lib/cn";
import { approvalNodeState } from "./approvalCopy";
import { ApprovalDegradedNode, ToolApprovalNode } from "./ChatApprovalNode";
import { PlanStepNode } from "./ChatPlanNode";
import { VideoPreviewCard } from "./ChatVideoPreview";
import { useTurnLiveness } from "./turnLiveness";
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

/** What the run is actually doing, named plainly.
 *
 *  A phase is visible only after the event that grounds it arrives, and
 *  "Thinking" is not one of them: it is a claim that reasoning tokens are
 *  arriving right now, so it is read off `reasoningStreaming` and disappears
 *  with the deltas. */
function livePhase(turn: AssistantMessage): string {
  if (turn.reasoningStreaming) return "Thinking";
  switch (turn.phase) {
    case "sending":
      return "Sending message";
    case "planning":
      return "Planning";
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
      return <ThinkingNode text={entry.text} source={entry.source} last={last} />;
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
 *  Copy: "N tools · N searches · N notes · verified" when notes were opened.
 *  When none were, the line reports what retrieval actually said, which is three
 *  different statements and not one (see `RetrievalOutcome`):
 *
 *    · N spans · nothing read  — the vault had material; the model opened none
 *    · nothing found           — every search reported, every one of them empty
 *    (nothing appended)        — a search has yet to report, so neither holds
 *
 *  The zero-hit calls stay auditable on the rail either way. What went wrong is
 *  appended in the destructive/warning register and never hidden:
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
  const retrieval = searchOutcome(turn.activity);
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
  } else if (retrieval.kind === "hits") {
    // The vault had material and none of it was opened. The span total is what
    // makes the absent "N notes" legible — without it the line reads as though
    // retrieval simply did not happen, and it is also the number that has to
    // agree with the nodes directly beneath the head.
    segs.push(count(retrieval.spans, "span", "spans"), "nothing read");
  } else if (retrieval.kind === "empty") {
    segs.push("nothing found");
  }
  // `pending` deliberately adds nothing: a search that has not reported yet
  // cannot be summarised as either outcome, and the search count above already
  // says what went out.
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

/** The run clock, to the second. Under a minute it is bare seconds; past one it
 *  takes the same `2m 05s` shape `formatElapsed` uses for the settled figure, so
 *  the live readout and the record it hands over to read as one thing.
 *
 *  Whole seconds, no decimal: the readout is re-read once a second, and a tenths
 *  digit would be stale for most of the second it was showing. `formatElapsed`
 *  keeps its decimal precisely because it is describing something that stopped. */
function formatLiveElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** How much internal work has happened, in ONE slot rather than two.
 *
 *  The round pair and the node tally answer the same question — how much has
 *  this run got through — so the head shows whichever of them is the better
 *  answer rather than both. The round wins wherever it exists because it comes
 *  with a denominator; the tally fills the short window before the first
 *  planning beacon, when there is no round to report yet.
 *
 *  During a playlist the round deliberately loses its denominator. `max_rounds`
 *  is the iteration ceiling, which a playlist blows straight past (three videos
 *  reach ~24 rounds under a cap of 16) and which a mid-run skill activation can
 *  raise anyway. The honest denominator during a playlist is the playlist's own
 *  length, and that is already in the phase line — so the round stays as a bare
 *  count of model turns instead of claiming a ceiling it is not measured
 *  against. */
function workCounter(turn: AssistantMessage, nodeCount: number): string | null {
  if (turn.round !== null) {
    return turn.playlist !== null
      ? `round ${turn.round.current}`
      : `round ${turn.round.current} of ${turn.round.max}`;
  }
  return nodeCount > 0 ? count(nodeCount, "step", "steps") : null;
}

/** The ticking half of the head, isolated in its own component so the
 *  once-a-second commit repaints one span instead of the whole rail — which
 *  carries rendered markdown and would re-parse it every tick.
 *
 *  **`aria-hidden`, deliberately.** `<summary>` is a focusable control whose
 *  accessible name is composed from its contents, so an un-hidden clock would
 *  rewrite that name once a second under a screen reader's cursor. The stall
 *  notice is the thing that gets announced; the clock is for the eye. */
function LiveElapsed({ turn }: Readonly<{ turn: AssistantMessage }>) {
  // `true` rather than a threaded prop: this renders only inside `LiveHead`,
  // which the timeline mounts only while the run is live. The interval is
  // therefore torn down by unmounting, not by flipping a flag.
  const { elapsedMs } = useTurnLiveness(turn, true);
  // Null until the first event lands. Rendering `0s` there would report a
  // measurement of a run that has not started reporting — a different statement.
  if (elapsedMs === null) return null;
  return (
    <span aria-hidden className="nn-mono shrink-0 tabular-nums">
      · {formatLiveElapsed(elapsedMs)}
    </span>
  );
}

/** The live head: the phase the run is genuinely in, where it has got to, and
 *  how long it has been going.
 *
 *  What is announced and what is not is the whole design here. The live region
 *  holds the phase and, during a playlist, the item in flight — two low-churn
 *  statements (the phase changes ~3× a run; the item changes once per video,
 *  against a denominator that cannot move). Everything in the right-hand cluster
 *  is `aria-hidden`: the node tally churns 15–20 times a run, the round counter
 *  as often, and the clock every second.
 *
 *  The layout cannot change height. The phase group truncates and the counters
 *  never shrink, so a long phase on a narrow pane loses its tail rather than
 *  wrapping the head onto a second line and jolting the transcript under it.
 *
 *  Under `prefers-reduced-motion` the spinner is frozen, which leaves the phase
 *  word and the clock as the only evidence the run is alive. They are sized and
 *  worded to carry that on their own — the clock is never the thing that gets
 *  truncated away. */
function LiveHead({
  turn,
  nodeCount,
}: Readonly<{ turn: AssistantMessage; nodeCount: number }>) {
  const counter = workCounter(turn, nodeCount);
  return (
    <>
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden
      />
      <output className="min-w-0 truncate">
        {livePhase(turn)}
        {turn.playlist !== null && (
          <span className="font-normal text-muted-foreground/70">
            {" · "}
            Video {turn.playlist.position} of {turn.playlist.total}
          </span>
        )}
      </output>
      <span className="flex shrink-0 items-center gap-1.5 font-normal text-muted-foreground/60">
        {counter !== null && (
          <span aria-hidden className="shrink-0">
            · {counter}
          </span>
        )}
        <LiveElapsed turn={turn} />
      </span>
    </>
  );
}

/** Nothing has progressed for a while — said once, never counted down.
 *
 *  A counting-down prompt manufactures urgency, which is why the approval sheet
 *  renders its expiry once and leaves it alone (`approvalCopy.expiryLine`). This
 *  is the same ruling applied to a slow run: a threshold crossing, not a timer.
 *  Neither sentence claims a failure, because nothing has failed — the run is
 *  still open in both.
 *
 *  The two states are genuinely different news and get different registers.
 *  Keepalives still arriving means the connection is fine and the model is
 *  thinking — that sentence says what WE are doing, and reads muted. Nothing
 *  arriving at all means the provider itself has gone quiet — that sentence says
 *  what IT is doing, and takes the warning tone, on the glyph only, with the
 *  words in `text-foreground`, because a tinted fill drags its own ground toward
 *  the tone colour and pushes tinted body text under AA.
 *
 *  Both are short on purpose. Measured in a real browser at the docked pane's
 *  narrowest width, the first drafts of these sentences wrapped onto a second
 *  line, which is a notice about a stalled run pushing the transcript down at
 *  the exact moment its whole job is to be reassuring.
 *
 *  Mounted empty from the start of the run and holding one line of its own type,
 *  so it both announces reliably (a live region inserted together with its text
 *  is often skipped by screen readers) and reserves its own footprint. The
 *  notice appearing at 45 seconds moves nothing.
 *
 *  `1.375em` is `leading-snug`'s own ratio, applied to this element's own font
 *  size — one line, with no pixel value to drift. `1lh` says the same thing more
 *  directly and is not used: the unit needs Safari 16.4, and a webview older
 *  than that would drop the declaration and quietly lose the reservation. */
function StallNotice({
  turn,
  live,
}: Readonly<{ turn: AssistantMessage; live: boolean }>) {
  const { stalled, silent } = useTurnLiveness(turn, live);
  if (!live) return null;
  return (
    <output className="mt-1.5 flex min-h-[1.375em] items-center gap-1.5 text-[0.6875rem] leading-snug">
      {stalled && (
        <>
          <Hourglass
            className={cn(
              "size-3 shrink-0",
              silent ? "text-warning" : "text-muted-foreground/70",
            )}
            aria-hidden
          />
          <span className={silent ? "text-foreground" : "text-muted-foreground"}>
            {silent
              ? "The model has been quiet for a while."
              : "Still working. Nothing new for a while."}
          </span>
        </>
      )}
    </output>
  );
}

/** Whether the fold has something the user should be pushed into rather than
 *  left to discover. All three are honesty signals, not decoration: a dropped
 *  citation is the moat's own alarm, a refused or failed call means the run did
 *  less than it looks like it did, and a search whose results were never opened
 *  is worth the user's eye whichever way it went — either the queries missed and
 *  are worth rephrasing, or the vault answered and the run walked past it. Both
 *  readings live behind this one condition, which is why it stays a plain
 *  "searched but read nothing" rather than branching on the outcome. */
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
  answering,
  suppressLive,
}: Readonly<{
  turn: AssistantMessage;
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
            <LiveHead turn={turn} nodeCount={nodeCount} />
          ) : (
            <SummaryLine
              turn={turn}
              calls={calls}
              nodeCount={nodeCount}
              errored={errored}
            />
          )}
        </summary>
        {/* What the run is working on, directly under the head that says how far
            through it is. Live only: once the answer is streaming, the video is
            the answer's subject and the card is one more thing between the user
            and it. */}
        {live && (
          <VideoPreviewCard preview={turn.videoPreview} playlist={turn.playlist} />
        )}
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
      {/* Outside the fold on purpose. The fold's `open` is derived but not
          re-asserted, so a user who collapsed it keeps it collapsed — and
          "wondering whether the app has hung" is exactly the moment someone has
          tidied the rail away. A notice about the run must not be inside the
          thing it explains. */}
      <StallNotice turn={turn} live={live} />
    </section>
  );
}
