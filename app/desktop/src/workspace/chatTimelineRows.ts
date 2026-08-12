// The chat timeline's row model: which nodes the rail shows, in what order, and
// which declared plan step (if any) each one hangs beneath.
//
// It lives apart from `ChatTimeline.tsx` because the ordering rules are the
// interesting part and they are worth proving without a renderer — and because
// the file that renders them is at the 500-line guardrail. Pure: no JSX, no
// React, nothing here reads or composes backend prose.

import type { ApprovalDegradedReason } from "../lib/types";
import type {
  AssistantMessage,
  PlanStepView,
  SkillActivationFailure,
  ToolApprovalView,
  ToolCallView,
} from "./chatMessage";

/** One rail node, before it is rendered. The wire carries no global sequence
 *  number, so nodes are grouped in the order a run's phases actually occur —
 *  activation, reasoning, dispatched calls, verification — rather than pretending
 *  to an interleaving the events cannot support. */
export type TimelineEntry =
  | { kind: "failure"; failure: SkillActivationFailure }
  | { kind: "thinking"; text: string }
  | { kind: "degraded"; reason: ApprovalDegradedReason }
  | { kind: "approval"; approval: ToolApprovalView }
  | { kind: "tool"; call: ToolCallView }
  | { kind: "verifying" }
  | { kind: "dropped"; reason: string };

export interface KeyedEntry {
  entry: TimelineEntry;
  key: string;
}

/** A row of the rail: either an ordinary node, exactly as the rail has always
 *  rendered one, or a declared plan step carrying the nodes dispatched under
 *  it. Both shapes coexist in one list — a mixed rail is the ordinary case, not
 *  a fallback. */
export type TimelineRow =
  | ({ kind: "node" } & KeyedEntry)
  | { kind: "step"; key: string; step: PlanStepView; children: KeyedEntry[] };

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
export function railCalls(turn: AssistantMessage): ToolCallView[] {
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
function approvalEntries(
  turn: AssistantMessage,
  onRail: ReadonlySet<string>,
): TimelineEntry[] {
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

export function timelineEntries(
  turn: AssistantMessage,
  calls: ToolCallView[],
): TimelineEntry[] {
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
 *  or two citations are dropped for the same reason.
 *
 *  Computed over the FLAT entry list, before any grouping: a node that later
 *  moves beneath a step row keeps the key it already had, so it is re-parented
 *  rather than remounted — a remount would restart an in-flight spinner and
 *  discard a disclosure the user had opened. */
export function keyed(entries: TimelineEntry[]): KeyedEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const n = seen.get(entry.kind) ?? 0;
    seen.set(entry.kind, n + 1);
    return { entry, key: `${entry.kind}#${n}` };
  });
}

const asNode = (item: KeyedEntry): TimelineRow => ({ kind: "node", ...item });

/** Which declared step an entry belongs to, or `null` for an unaffiliated one.
 *
 *  An approval takes the affiliation of the call it gated: the two describe one
 *  act, and a security prompt floating outside the step whose work it authorised
 *  would read as a separate event. */
function entryStepId(
  entry: TimelineEntry,
  stepOfCall: ReadonlyMap<string, string | null>,
): string | null {
  if (entry.kind === "tool") return entry.call.stepId;
  if (entry.kind === "approval") return stepOfCall.get(entry.approval.id) ?? null;
  return null;
}

/**
 * Fold the flat entry list into rows, nesting each affiliated node beneath the
 * step it was dispatched under.
 *
 * Two properties are deliberate and both are load-bearing:
 *
 * 1. **No plan means no change at all.** An empty `planSteps` — the ordinary
 *    case, since most turns never declare one — returns exactly the flat list,
 *    so a turn without a plan renders identically to the way it did before plans
 *    existed. That is this whole feature's degradation guarantee.
 *
 * 2. **Unaffiliated nodes keep their place.** `stepId: null` is routine: every
 *    unplanned turn, and — even in a planned one — the `update_plan` call that
 *    DECLARES the plan, which went out before the plan existed. Those nodes stay
 *    in transcript order around the plan, never inside it.
 *
 * The declared steps render as one contiguous block, in the order the model
 * declared them, anchored at the position of the first node affiliated with any
 * of them. A plan is a stated intention, so its steps must not shuffle as work
 * lands against them, and a step nothing was dispatched under still renders —
 * "I said I would do this and have not yet" is information. Before anything has
 * been dispatched the block sits at the end of the rail, which is where the next
 * node will appear, so it does not jump when the first one arrives.
 *
 * An entry naming a step that was never declared is treated as unaffiliated
 * rather than conjuring a row for it: the rail may only show steps the model
 * actually stated.
 */
export function timelineRows(
  turn: AssistantMessage,
  entries: KeyedEntry[],
): TimelineRow[] {
  if (turn.planSteps.length === 0) return entries.map(asNode);

  const stepOfCall = new Map(turn.toolCalls.map((call) => [call.id, call.stepId]));
  const declared = new Set(turn.planSteps.map((step) => step.id));
  const children = new Map<string, KeyedEntry[]>();
  const before: KeyedEntry[] = [];
  const after: KeyedEntry[] = [];
  let anchored = false;

  for (const item of entries) {
    const stepId = entryStepId(item.entry, stepOfCall);
    if (stepId !== null && declared.has(stepId)) {
      anchored = true;
      const bucket = children.get(stepId);
      if (bucket === undefined) children.set(stepId, [item]);
      else bucket.push(item);
      continue;
    }
    (anchored ? after : before).push(item);
  }

  const steps = turn.planSteps.map((step): TimelineRow => ({
    kind: "step",
    key: `plan-step#${step.id}`,
    step,
    children: children.get(step.id) ?? [],
  }));
  return [...before.map(asNode), ...steps, ...after.map(asNode)];
}
