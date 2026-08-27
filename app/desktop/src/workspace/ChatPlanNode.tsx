// One declared plan step on the timeline rail, with the tool calls dispatched
// under it nested beneath.
//
// A plan is the model saying what it intends to do before it does it, so this
// node's whole job is to keep that statement honest as work lands against it:
// what is still owed, what happened, and — for the two statuses that owe the
// user an account — why a step produced no work.
//
// Presentational only. `label` is model prose, so it is rendered and never
// matched on; every other string here is ours.

import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { PlanStepView } from "./chatMessage";
import { QUALIFIER, TimelineNode } from "./ChatTimelineNodes";
import { PLAN_STATUS_CHROME } from "./ChatPlanStatus";

/** How each declared status reads.
 *
 *  `skipped` and `failed` are the pair this table exists for. They are two
 *  accounts of the same missing work and only one of them is a problem — the
 *  same distinction `TOOL_SETTLEMENT` draws between `cancelled` (calm: nobody
 *  refused anything) and `timedOut` (a warning: the window closed on someone).
 *  Collapsing them would tell a user something went wrong when the model simply
 *  decided a step was unnecessary, and that is a false report about the run.
 *
 *  They are kept apart on three independent channels, so no single one has to
 *  carry it: a different glyph, a different tone, and a different sentence.
 *
 *  • `skipped` — `CircleMinus`, muted, "skipped as unnecessary". A ruled-out
 *    step, in the same calm register as a call the run ended before reaching.
 *  • `failed` — `AlertTriangle`, warning, "did not work". Warning and not
 *    destructive on purpose: a step fails because something under it failed, and
 *    that child node already carries the destructive account. Two red triangles
 *    for one failure is the rail shouting the same news twice.
 *
 *  `account` is the status in words. It is rendered VISIBLY only for those two:
 *  the other three are fully carried by the glyph, and a rail that affixed
 *  "done" to every finished step would be six words of furniture per run. They
 *  still say it to a screen reader, which cannot see the glyph column at all. */
export function PlanStepNode({
  step,
  last,
  nodes,
}: Readonly<{
  step: PlanStepView;
  last: boolean;
  /** The rendered nodes dispatched under this step. Empty is ordinary: a step
   *  can be pending, or can be finished by the model's own reasoning without
   *  dispatching anything. */
  nodes: ReactNode[];
}>) {
  const chrome = PLAN_STATUS_CHROME[step.status];
  return (
    <TimelineNode
      glyph={
        <chrome.icon
          className={cn(
            "size-3.5",
            chrome.tone,
            chrome.spin === true && "animate-spin motion-reduce:animate-none",
          )}
          aria-hidden
        />
      }
      last={last}
    >
      <p className="min-w-0 break-words font-medium">
        {/* Ahead of the label, so the status is heard before the step it
            describes — the reading order the glyph column has visually. */}
        {!chrome.accountVisible && <span className="sr-only">{`${chrome.account}: `}</span>}
        <span className={chrome.labelTone}>{step.label}</span>
        {/* Kept whole for the same reason a tool node's summary is (`QUALIFIER`
            carries the whole argument): both visible accounts are more than one
            word, and left to ordinary inline layout the step's own verdict
            breaks across two lines of a model-written label. */}
        {chrome.accountVisible && (
          <>
            {" "}
            <span className={cn(QUALIFIER, chrome.tone)}>· {chrome.account}</span>
          </>
        )}
      </p>
      {nodes.length > 0 && (
        // The nested list needs no indent of its own: it starts where the step's
        // LABEL starts (the parent's glyph gutter has already offset it), and the
        // parent's own hairline runs down the outside of the whole group, because
        // that spine is drawn to the node's bottom edge and this list is inside
        // it. Two parallel hairlines, one per level, and no extra horizontal
        // budget spent in a pane that has none to spare.
        <ol className="mt-1.5 flex flex-col">{nodes}</ol>
      )}
    </TimelineNode>
  );
}
