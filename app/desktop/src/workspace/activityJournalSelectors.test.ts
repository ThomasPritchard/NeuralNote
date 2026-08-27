import { describe, expect, it } from "vitest";
import {
  emptyActivityJournal,
  type ActivityJournalState,
  type JournalActivity,
  type JournalCycle,
} from "./activityJournal";
import {
  selectCurrentAction,
  selectCurrentWorkingActivity,
  selectCycleActivities,
  selectRunningSiblingCount,
} from "./activityJournalSelectors";

function activity(
  id: string,
  firstSequence: number,
  overrides: Partial<JournalActivity> = {},
): JournalActivity {
  return {
    id,
    cycleId: "cycle-a",
    firstSequence,
    lastSequence: firstSequence,
    lastActiveSequence: firstSequence,
    name: "read_note",
    title: "Read note",
    arguments: "{}",
    stepId: null,
    progress: null,
    preview: null,
    state: "active",
    settlement: null,
    approvalResolution: null,
    noteOutcome: null,
    abandonmentReason: null,
    ...overrides,
  };
}

function cycle(activityIds: string[], lastSequence = 2): JournalCycle {
  return {
    id: "cycle-a",
    firstSequence: 1,
    lastSequence,
    thinking: { text: "", firstSequence: 1, lastSequence: 1 },
    summary: null,
    activityIds,
  };
}

function journal(activities: JournalActivity[]): ActivityJournalState {
  const state = emptyActivityJournal();
  return {
    ...state,
    cycles: [cycle(activities.map(({ id }) => id))],
    activities: Object.fromEntries(activities.map((item) => [item.id, item])),
    lastSequence: Math.max(...activities.map(({ lastSequence }) => lastSequence), 2),
  };
}

describe("activity journal selectors", () => {
  it("selects the latest genuinely working activity and counts active siblings", () => {
    const earlier = activity("earlier", 3, {
      progress: "Fetching captions",
      lastSequence: 6,
      lastActiveSequence: 6,
    });
    const current = activity("current", 4, {
      progress: "Drafting the note",
      lastSequence: 8,
      lastActiveSequence: 8,
    });
    const state = journal([earlier, current]);

    expect(selectCurrentWorkingActivity(state)).toBe(current);
    expect(selectRunningSiblingCount(state, current)).toBe(1);
    expect(selectCurrentAction(state)).toMatchObject({
      activityId: "current",
      message: "Drafting the note",
      runningSiblings: 1,
    });
  });

  it("promotes the most recently active remaining sibling after settlement", () => {
    const remaining = activity("remaining", 3, {
      progress: "Still reading",
      lastSequence: 7,
      lastActiveSequence: 7,
    });
    const settled = activity("settled", 4, {
      progress: "Writing",
      lastSequence: 9,
      lastActiveSequence: 8,
      state: "succeeded",
      settlement: {
        status: "ok",
        summary: "Written",
        detail: null,
        durationMs: 20,
      },
    });

    expect(selectCurrentAction(journal([remaining, settled]))).toMatchObject({
      activityId: "remaining",
      message: "Still reading",
      runningSiblings: 0,
    });
  });

  it("lets a newer user-owned prompt park the line without a running count", () => {
    const working = activity("working", 3, {
      lastSequence: 6,
      lastActiveSequence: 6,
    });
    const waiting = activity("waiting", 4, {
      state: "awaitingUser",
      lastSequence: 7,
      lastActiveSequence: 4,
    });

    expect(selectCurrentAction(journal([working, waiting]))).toMatchObject({
      activityId: "waiting",
      message: "Waiting for you",
      runningSiblings: 0,
      waitingForUser: true,
    });
  });

  it("uses only a newer typed host status as the run-level fallback", () => {
    const state = emptyActivityJournal();
    const currentCycle = cycle([], 4);
    const newer: ActivityJournalState = {
      ...state,
      cycles: [currentCycle],
      hostStatus: { message: "Preparing captions", sequence: 5 },
      lastSequence: 5,
    };
    expect(selectCurrentAction(newer)?.message).toBe("Preparing captions");

    const stale: ActivityJournalState = {
      ...newer,
      cycles: [
        {
          ...currentCycle,
          thinking: { text: "Still deciding", firstSequence: 1, lastSequence: 6 },
        },
      ],
    };
    expect(selectCurrentAction(stale)?.message).toBe("Thinking");
  });

  it("orders settled activities by first sequence, never completion order", () => {
    const later = activity("later", 7, { state: "succeeded", lastSequence: 8 });
    const earlier = activity("earlier", 3, { state: "succeeded", lastSequence: 10 });
    const state = journal([later, earlier]);

    expect(selectCycleActivities(state, state.cycles[0]).map(({ id }) => id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
