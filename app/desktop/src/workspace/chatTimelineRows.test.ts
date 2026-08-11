// The timeline's row model — which node hangs beneath which declared plan step,
// and where the unaffiliated ones end up.
//
// Everything here is built from fixtures with KNOWN ids and then checked against
// the step the node was expected to land under. Reading a node's `stepId` back
// off the very object that placed it would pass forever: it compares a value
// with its own source.

import { describe, expect, it } from "vitest";
import type { StepStatus } from "../lib/types";
import {
  emptyAssistant,
  type AssistantMessage,
  type PlanStepView,
  type ToolCallView,
} from "./chatMessage";
import {
  keyed,
  railCalls,
  timelineEntries,
  timelineRows,
  type TimelineRow,
} from "./chatTimelineRows";

const planStep = (
  id: string,
  label: string,
  status: StepStatus = "done",
): PlanStepView => ({ id, label, status });

const call = (
  id: string,
  stepId: string | null,
  title = "Search notes",
): ToolCallView => ({
  id,
  name: "search_notes",
  title,
  arguments: '{"query":"recall"}',
  status: "ok",
  summary: null,
  detail: null,
  stepId,
});

function rowsOf(overrides: Partial<AssistantMessage>): TimelineRow[] {
  const turn: AssistantMessage = { ...emptyAssistant(), ...overrides };
  return timelineRows(turn, keyed(timelineEntries(turn, railCalls(turn))));
}

/** `step:<label>` for a plan row, `tool:<title>` for a node, so an assertion
 *  reads as the rail reads. Children are listed under their step. */
function shape(rows: TimelineRow[]): string[] {
  return rows.map((row) =>
    row.kind === "node"
      ? `tool:${row.entry.kind === "tool" ? row.entry.call.title : row.entry.kind}`
      : `step:${row.step.label}[${row.children
          .map((child) =>
            child.entry.kind === "tool" ? child.entry.call.title : child.entry.kind,
          )
          .join(",")}]`,
  );
}

describe("timelineRows — no plan declared", () => {
  it("returns the flat entry list untouched", () => {
    // The degradation guarantee: most turns never declare a plan, and those
    // must render exactly as they did before plans existed. What goes red here
    // is any grouping that leaks into the unplanned path.
    const rows = rowsOf({
      toolCalls: [call("c1", null), call("c2", null, "Read note")],
      activity: [{ kind: "verifying" }],
    });

    expect(shape(rows)).toEqual(["tool:Search notes", "tool:Read note", "tool:verifying"]);
    expect(rows.every((row) => row.kind === "node")).toBe(true);
  });
});

describe("timelineRows — nodes nest under the step they were dispatched under", () => {
  const PLAN = [
    planStep("s1", "Find notes on spaced repetition"),
    planStep("s2", "Read the two most relevant", "running"),
    planStep("s3", "Draft the summary", "pending"),
  ];

  it("puts each call beneath its own step, and leaves an untouched step empty", () => {
    const rows = rowsOf({
      planSteps: PLAN,
      toolCalls: [
        call("c1", "s1"),
        call("c2", "s1", "Search notes again"),
        call("c3", "s2", "Read note"),
      ],
    });

    expect(shape(rows)).toEqual([
      "step:Find notes on spaced repetition[Search notes,Search notes again]",
      "step:Read the two most relevant[Read note]",
      // Declared and not yet worked on. "I said I would do this and have not"
      // is information, so the row stays rather than waiting to be earned.
      "step:Draft the summary[]",
    ]);
  });

  it("keeps the declared order even when the work arrives out of it", () => {
    // The plan is a stated intention. If steps re-ordered themselves as work
    // landed, the rail would stop being a readable account of what was promised.
    const rows = rowsOf({
      planSteps: PLAN,
      toolCalls: [call("c3", "s3", "Draft"), call("c1", "s1", "Search")],
    });

    expect(shape(rows)).toEqual([
      "step:Find notes on spaced repetition[Search]",
      "step:Read the two most relevant[]",
      "step:Draft the summary[Draft]",
    ]);
  });

  it("leaves an unaffiliated node in transcript order around the plan", () => {
    // `stepId: null` is ORDINARY. The `update_plan` call that declares the plan
    // is itself unaffiliated — it went out before the plan existed — and the
    // verification pass at the end belongs to no step either. Neither may be
    // swallowed into a step, and neither may be moved.
    const rows = rowsOf({
      planSteps: PLAN,
      toolCalls: [
        call("c0", null, "Update plan"),
        call("c1", "s1"),
        call("c9", null, "List folders"),
      ],
      activity: [{ kind: "verifying" }],
    });

    expect(shape(rows)).toEqual([
      "tool:Update plan",
      "step:Find notes on spaced repetition[Search notes]",
      "step:Read the two most relevant[]",
      "step:Draft the summary[]",
      "tool:List folders",
      "tool:verifying",
    ]);
  });

  it("puts the plan at the end while nothing has been dispatched under it", () => {
    // The moment a plan is declared, the only node on the rail is the call that
    // declared it. Anchoring the block at the END is what stops it jumping from
    // above that node to below it the instant the first real call lands.
    const rows = rowsOf({
      planSteps: PLAN,
      toolCalls: [call("c0", null, "Update plan")],
    });

    expect(shape(rows)).toEqual([
      "tool:Update plan",
      "step:Find notes on spaced repetition[]",
      "step:Read the two most relevant[]",
      "step:Draft the summary[]",
    ]);
  });

  it("renders a node naming an undeclared step as unaffiliated", () => {
    // The rail may only show steps the model actually declared. A stamp that
    // names something else is a broken contract; conjuring a row for it would
    // put words in the model's mouth.
    const rows = rowsOf({
      planSteps: [planStep("s1", "Find notes on spaced repetition")],
      toolCalls: [call("c1", "ghost", "Read note")],
    });

    expect(shape(rows)).toEqual([
      "tool:Read note",
      "step:Find notes on spaced repetition[]",
    ]);
  });

  it("keeps an approval with the call it gated", () => {
    // One act, two rows. A security prompt floating outside the step whose work
    // it authorised would read as an unrelated event.
    const rows = rowsOf({
      planSteps: [planStep("s1", "Write the note")],
      toolCalls: [call("c1", "s1", "Write note")],
      toolApprovals: [
        {
          id: "c1",
          tool: "writeNote",
          relPath: "Atomic/Recall.md",
          reason: "irreversible",
          expiresInSecs: 120,
          checking: false,
          resolution: "approved",
          autoApprovedRule: null,
        },
      ],
    });

    expect(shape(rows)).toEqual(["step:Write the note[approval,Write note]"]);
  });
});

describe("timelineRows — identity", () => {
  it("gives a node the same key with and without a plan", () => {
    // Keys are assigned over the flat list, before grouping, so gaining a plan
    // RE-PARENTS a node rather than remounting it. A remount would restart an
    // in-flight spinner and throw away a disclosure the user had opened.
    const toolCalls = [call("c1", "s1"), call("c2", "s1", "Read note")];
    const flat = rowsOf({ toolCalls: toolCalls.map((c) => ({ ...c, stepId: null })) });
    const grouped = rowsOf({ planSteps: [planStep("s1", "Find notes")], toolCalls });

    const flatKeys = flat.map((row) => row.key);
    const groupedKeys = grouped.flatMap((row) =>
      row.kind === "step" ? row.children.map((child) => child.key) : [row.key],
    );
    expect(groupedKeys).toEqual(flatKeys);
  });
});
