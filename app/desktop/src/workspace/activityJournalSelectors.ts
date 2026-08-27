import {
  isJournalActivityWorking,
  type ActivityJournalState,
  type JournalActivity,
  type JournalCycle,
} from "./activityJournal";

export interface JournalCurrentAction {
  cycleId: string | null;
  activityId: string | null;
  message: string;
  runningSiblings: number;
  waitingForUser: boolean;
  changeSequence: number;
}

export function selectCycleActivities(
  journal: ActivityJournalState,
  cycle: JournalCycle,
): JournalActivity[] {
  return cycle.activityIds
    .map((id) => journal.activities[id])
    .filter((activity): activity is JournalActivity => activity !== undefined)
    .sort((left, right) => left.firstSequence - right.firstSequence);
}

function latestActivity(
  journal: ActivityJournalState,
  predicate: (activity: JournalActivity) => boolean,
): JournalActivity | null {
  let latest: JournalActivity | null = null;
  for (const activity of Object.values(journal.activities)) {
    if (!predicate(activity)) continue;
    if (latest === null || activity.lastActiveSequence > latest.lastActiveSequence) {
      latest = activity;
    }
  }
  return latest;
}

function latestCycleSequence(
  journal: ActivityJournalState,
  cycle: JournalCycle,
): number {
  const activitySequence = selectCycleActivities(journal, cycle).reduce(
    (latest, activity) => Math.max(latest, activity.lastSequence),
    cycle.lastSequence,
  );
  return Math.max(
    activitySequence,
    cycle.thinking.lastSequence,
    cycle.summary?.sequence ?? cycle.firstSequence,
  );
}

export function selectCurrentWorkingActivity(
  journal: ActivityJournalState,
): JournalActivity | null {
  if (journal.terminal.kind !== "active") return null;
  return latestActivity(journal, isJournalActivityWorking);
}

export function selectCurrentWaitingActivity(
  journal: ActivityJournalState,
): JournalActivity | null {
  if (journal.terminal.kind !== "active") return null;
  return latestActivity(journal, (activity) => activity.state === "awaitingUser");
}

export function selectRunningSiblingCount(
  journal: ActivityJournalState,
  current: JournalActivity,
): number {
  return Object.values(journal.activities).filter(
    (activity) =>
      activity.id !== current.id &&
      activity.cycleId === current.cycleId &&
      isJournalActivityWorking(activity),
  ).length;
}

export function selectCurrentAction(
  journal: ActivityJournalState,
): JournalCurrentAction | null {
  const working = selectCurrentWorkingActivity(journal);
  const waiting = selectCurrentWaitingActivity(journal);
  if (
    waiting !== null &&
    (working === null || waiting.lastSequence >= working.lastActiveSequence)
  ) {
    return {
      cycleId: waiting.cycleId,
      activityId: waiting.id,
      message: "Waiting for you",
      runningSiblings: 0,
      waitingForUser: true,
      changeSequence: waiting.lastSequence,
    };
  }

  if (working !== null) {
    return {
      cycleId: working.cycleId,
      activityId: working.id,
      message: working.progress ?? working.title ?? "Preparing the next action",
      runningSiblings: selectRunningSiblingCount(journal, working),
      waitingForUser: false,
      changeSequence: working.lastActiveSequence,
    };
  }

  if (journal.terminal.kind !== "active") return null;
  const latestCycle = journal.cycles.at(-1);
  if (
    journal.hostStatus !== null &&
    (latestCycle === undefined ||
      journal.hostStatus.sequence >= latestCycleSequence(journal, latestCycle))
  ) {
    return {
      cycleId: latestCycle?.id ?? null,
      activityId: null,
      message: journal.hostStatus.message,
      runningSiblings: 0,
      waitingForUser: false,
      changeSequence: journal.hostStatus.sequence,
    };
  }

  if (
    latestCycle === undefined ||
    latestCycle.summary !== null ||
    latestCycle.activityIds.length > 0
  ) return null;
  return {
    cycleId: latestCycle.id,
    activityId: null,
    message: "Thinking",
    runningSiblings: 0,
    waitingForUser: false,
    changeSequence: latestCycle.lastSequence,
  };
}

export function selectCycleIsSettled(
  journal: ActivityJournalState,
  cycle: JournalCycle,
): boolean {
  const activities = selectCycleActivities(journal, cycle);
  if (activities.length === 0) return false;
  return activities.every(
    (activity) =>
      !isJournalActivityWorking(activity) && activity.state !== "awaitingUser",
  );
}

export function selectCycleFailureCount(
  journal: ActivityJournalState,
  cycle: JournalCycle,
): number {
  return selectCycleActivities(journal, cycle).filter(
    (activity) => activity.state === "failed",
  ).length;
}
