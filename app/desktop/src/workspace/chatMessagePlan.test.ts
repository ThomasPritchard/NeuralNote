// The plan/usage half of the chat fold: the declared step list, the status
// transitions that move through it, and the run's cost.
//
// Split from `chatMessage.test.ts` by concern, following `chatMessageApproval`.
//
// Phase 5 is the only part of the timeline that degrades to *nothing*: a model
// that never declares a plan, or a provider that never reports usage, must leave
// a turn that renders exactly as it did before either existed. Most of what is
// asserted here is that absence stays absent.

import { describe, expect, it } from "vitest";
import type { ChatEvent, StepStatus } from "../lib/types";
import { emptyAssistant, type AssistantMessage } from "./chatMessage";
import { reduceAssistant } from "./chatMessageReducer";

const fold = (events: ChatEvent[], from: AssistantMessage = emptyAssistant()) =>
  events.reduce(reduceAssistant, from);

const declared: ChatEvent = {
  type: "plan",
  steps: [
    { id: "s1", label: "Find the notes on spaced repetition" },
    { id: "s2", label: "Read the two most relevant" },
    { id: "s3", label: "Draft the summary" },
  ],
};

const status = (id: string, next: StepStatus): ChatEvent => ({
  type: "planStepStatus",
  id,
  status: next,
});

describe("a turn that never declares a plan", () => {
  it("carries no steps and no usage", () => {
    const turn = emptyAssistant();

    expect(turn.planSteps).toEqual([]);
    expect(turn.usage).toBeNull();
  });

  it("still folds an ordinary turn to completion", () => {
    // The degradation guarantee: no plan, no usage, nothing broken.
    const turn = fold([
      { type: "processing" },
      { type: "answer", delta: "Here you go." },
      { type: "done" },
    ]);

    expect(turn.planSteps).toEqual([]);
    expect(turn.usage).toBeNull();
    expect(turn.answer).toBe("Here you go.");
    expect(turn.done).toBe(true);
  });
});

describe("the declared plan", () => {
  it("lands in declared order, every step pending", () => {
    const turn = fold([declared]);

    expect(turn.planSteps).toEqual([
      { id: "s1", label: "Find the notes on spaced repetition", status: "pending" },
      { id: "s2", label: "Read the two most relevant", status: "pending" },
      { id: "s3", label: "Draft the summary", status: "pending" },
    ]);
  });

  it("moves one step and leaves its neighbours alone", () => {
    const turn = fold([declared, status("s2", "running")]);

    expect(turn.planSteps.map((step) => step.status)).toEqual([
      "pending",
      "running",
      "pending",
    ]);
  });

  it("keeps the label when the status moves", () => {
    // The label is the only thing a step consists of; a transition must not be
    // able to blank it.
    const turn = fold([declared, status("s1", "done")]);

    expect(turn.planSteps[0]).toEqual({
      id: "s1",
      label: "Find the notes on spaced repetition",
      status: "done",
    });
  });

  it.each<StepStatus>(["pending", "running", "done", "skipped", "failed"])(
    "carries '%s' through unchanged",
    (next) => {
      // `skipped` and `failed` are distinct on the wire on purpose — "I decided
      // this was unnecessary" and "I tried and it did not work" are different
      // accounts, and only one is a problem. The fold must not conflate them.
      const turn = fold([declared, status("s3", next)]);

      expect(turn.planSteps[2].status).toBe(next);
    },
  );

  it("survives the rest of the turn", () => {
    const turn = fold([
      declared,
      status("s1", "done"),
      { type: "searching", query: "spaced repetition", callId: null },
      { type: "answer", delta: "..." },
      { type: "done" },
    ]);

    expect(turn.planSteps[0].status).toBe("done");
  });

  it("ignores a status for a step that was never declared", () => {
    // DECIDED, not defensive. `withApproval` and `withSettlement` append an
    // unmatched update because the backend genuinely can emit one before its
    // opener. This one cannot: `plan.rs::same_steps` refuses any call whose step
    // set differs and emits nothing at all, proven by the Rust test
    // `a_refused_update_leaves_the_declared_plan_untouched`.
    //
    // This case is pinned so nobody "fixes" it into an append later — which
    // would put a row with no label on the rail.
    const turn = fold([declared, status("ghost", "failed")]);

    expect(turn.planSteps).toHaveLength(3);
    expect(turn.planSteps.map((step) => step.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("what the run cost", () => {
  it("records elapsed time and the model that answered", () => {
    const turn = fold([
      { type: "usage", elapsedMs: 8412, tokensIn: 3120, tokensOut: 486, model: "qwen3.5:9b" },
    ]);

    expect(turn.usage).toEqual({
      elapsedMs: 8412,
      tokensIn: 3120,
      tokensOut: 486,
      model: "qwen3.5:9b",
    });
  });

  it("keeps an unreported token count null rather than zero", () => {
    // The whole reason the counts are nullable. A `0` here would render as a
    // real measurement — a run that consumed nothing — rather than as a provider
    // that declined to say. The distinction is the difference between reporting
    // and inventing.
    const turn = fold([
      { type: "usage", elapsedMs: 1200, tokensIn: null, tokensOut: null, model: "local" },
    ]);

    expect(turn.usage?.tokensIn).toBeNull();
    expect(turn.usage?.tokensOut).toBeNull();
    expect(turn.usage?.elapsedMs).toBe(1200);
  });

  it("records a half-reported pair without filling in the gap", () => {
    const turn = fold([
      { type: "usage", elapsedMs: 900, tokensIn: 512, tokensOut: null, model: "local" },
    ]);

    expect(turn.usage?.tokensIn).toBe(512);
    expect(turn.usage?.tokensOut).toBeNull();
  });

  it("is still readable after the run ends", () => {
    // Usage arrives immediately before `done`, so anything that reset it on the
    // terminal event would make it unrenderable in practice.
    const turn = fold([
      { type: "usage", elapsedMs: 700, tokensIn: 10, tokensOut: 20, model: "m" },
      { type: "done" },
    ]);

    expect(turn.usage?.elapsedMs).toBe(700);
    expect(turn.done).toBe(true);
  });
});
