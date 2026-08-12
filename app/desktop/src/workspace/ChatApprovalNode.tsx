// The approval gate's nodes on the chat timeline rail: one per gated call, plus
// the once-per-turn "automatic checking gave up" node.
//
// Every gated call gets a node in EVERY mode. YOLO skips the prompt, never the
// record (§9.6.3) — a skipped prompt that leaves no trace is the exact failure
// the visibility clause exists to prevent, and it is what keeps the mode
// defensible rather than reckless.
//
// Presentational only. The state is derived by `approvalNodeState`, the glyph
// and line come from `approvalCopy`, and nothing here reads model prose.

import { cn } from "../lib/cn";
import {
  APPROVAL_DEGRADED,
  approvalNodeState,
  approvalTone,
  gatedToolCopy,
  type ApprovalTone,
} from "./approvalCopy";
import type { ApprovalDegradedReason } from "../lib/types";
import type { ToolApprovalView } from "./chatMessage";
import { TimelineNode } from "./ChatTimelineNodes";

/** The glyph column for one approval state.
 *
 *  Two kinds of motion, and the difference is the whole design: `pulse` is a
 *  breathing opacity (something is happening, you cannot help), `ping` is a
 *  radiating halo (something needs you). Only `awaitingYou` may ping, so the
 *  one signal that asks for a decision never has to compete with three that
 *  don't. Both reset under `motion-reduce`, where the tone and the line carry
 *  the state on their own. */
function ApprovalGlyph({ tone }: Readonly<{ tone: ApprovalTone }>) {
  const Icon = tone.icon;
  return (
    <span className="relative grid size-3.5 place-items-center">
      {tone.ping && (
        <span
          aria-hidden
          className="absolute inset-0.5 animate-ping rounded-full bg-warning/40 motion-reduce:animate-none"
        />
      )}
      <Icon
        className={cn(
          "relative size-3.5",
          tone.tone,
          tone.pulse && "animate-pulse motion-reduce:animate-none",
          tone.filled && "fill-current",
        )}
        aria-hidden
      />
    </span>
  );
}

/** One gated call's approval state. The tool's plain-language name leads: the
 *  line says what the gate decided, the name says what about. */
export function ToolApprovalNode({
  approval,
  last,
}: Readonly<{ approval: ToolApprovalView; last: boolean }>) {
  const state = approvalNodeState(approval);
  const tone = approvalTone(state);
  const copy = gatedToolCopy(approval.tool);
  return (
    <TimelineNode glyph={<ApprovalGlyph tone={tone} />} last={last}>
      <p className="min-w-0 break-words">
        <span className={tone.tone}>{tone.line}</span>
        {copy !== null && (
          <span className="text-muted-foreground/70"> · {copy.title}</span>
        )}
        {approval.relPath !== null && (
          // The human gets the real path. The judge deliberately never sees it
          // (it gets a salted digest instead): a person can read a deceptive
          // filename and is the right party to judge one; a classifier cannot.
          <span className="nn-mono text-muted-foreground/70"> · {approval.relPath}</span>
        )}
      </p>
    </TimelineNode>
  );
}

/** Automatic checking is off for the rest of the turn.
 *
 *  Pinned at the head of the run's gated section rather than interleaved: the
 *  wire carries no sequence number, and the claim is about the REST of the turn,
 *  so leading with it is true for both reasons — `providerUnsupported` is raised
 *  on the first gated call of a local run, and `judgeUnreliable` frames every
 *  prompt that follows it. Guessing a position would be a fabricated ordering. */
export function ApprovalDegradedNode({
  reason,
  last,
}: Readonly<{ reason: ApprovalDegradedReason; last: boolean }>) {
  const tone = APPROVAL_DEGRADED[reason];
  return (
    <TimelineNode glyph={<ApprovalGlyph tone={tone} />} last={last}>
      <p className={cn("min-w-0 break-words", tone.tone)}>{tone.line}</p>
    </TimelineNode>
  );
}
