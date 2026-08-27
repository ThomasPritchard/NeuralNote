import type { AgentActivityEnvelope } from "../lib/bindings/AgentActivityEnvelope";
import type { ToolStatus } from "../lib/bindings/ToolStatus";
import {
  INCOMPLETE_ACTIVITY_HISTORY,
  type ActivityJournalState,
  type JournalActivity,
  type JournalActivityState,
  type JournalCycle,
  type JournalThinking,
} from "./activityJournal";

function isTerminalActivity(state: JournalActivityState): boolean {
  return !["provisional", "active", "awaitingUser"].includes(state);
}

function hasValidScope(envelope: AgentActivityEnvelope): boolean {
  const runScoped = envelope.cycleId === null && envelope.activityId === null;
  const cycleScoped = envelope.cycleId !== null && envelope.activityId === null;
  const activityScoped = envelope.cycleId !== null && envelope.activityId !== null;
  switch (envelope.payload.type) {
    case "runStarted":
    case "skillActivated":
    case "hostStatus":
    case "skillActivationFailed":
    case "approvalDegraded":
    case "partialRun":
    case "verifying":
    case "citationDropped":
    case "answer":
    case "answerTruncated":
    case "citation":
    case "coverage":
    case "plan":
    case "planStepStatus":
    case "usage":
    case "runFailed":
    case "runCompleted":
      return runScoped;
    case "cycleStarted":
    case "cycleSummary":
      return cycleScoped;
    case "keepalive":
      return envelope.activityId === null;
    case "thinking":
      return envelope.payload.source === "finalAnswer" ? runScoped : cycleScoped;
    case "activityProgress":
    case "videoPreview":
    case "elicit":
    case "activityStarted":
    case "activitySettled":
    case "transcriptSource":
    case "noteWritten":
    case "noteExists":
    case "noteEditPreview":
    case "noteEditAbandoned":
    case "approvalChecking":
    case "approvalRequested":
    case "autoApproved":
    case "approvalResolved":
    case "activityAbandoned":
      return activityScoped;
    case "searching":
    case "retrieved":
    case "reading":
      return envelope.cycleId !== null;
  }
}

function abandonLiveActivities(
  activities: ActivityJournalState["activities"],
  reason: string,
): ActivityJournalState["activities"] {
  return Object.fromEntries(
    Object.entries(activities).map(([id, activity]) => [
      id,
      isTerminalActivity(activity.state)
        ? activity
        : { ...activity, state: "abandoned", abandonmentReason: reason },
    ]),
  );
}

export function markActivityJournalIncomplete(
  journal: ActivityJournalState,
): ActivityJournalState {
  if (journal.terminal.kind === "incomplete") return journal;
  return {
    ...journal,
    activities: abandonLiveActivities(
      journal.activities,
      INCOMPLETE_ACTIVITY_HISTORY,
    ),
    terminal: { kind: "incomplete", message: INCOMPLETE_ACTIVITY_HISTORY },
    warning: INCOMPLETE_ACTIVITY_HISTORY,
  };
}

export function markActivityJournalCancelled(
  journal: ActivityJournalState,
): ActivityJournalState {
  return {
    ...journal,
    terminal: { kind: "cancelled", message: null },
  };
}

function activityStateFromStatus(status: ToolStatus): JournalActivityState {
  switch (status) {
    case "ok": return "succeeded";
    case "error": return "failed";
    case "denied": return "denied";
    case "timedOut": return "timedOut";
    case "cancelled": return "cancelled";
    case "rejected": return "rejected";
  }
}

function cycleIndex(journal: ActivityJournalState, cycleId: string | null): number {
  return cycleId === null
    ? -1
    : journal.cycles.findIndex((cycle) => cycle.id === cycleId);
}

function withCycle(
  journal: ActivityJournalState,
  cycleId: string | null,
  update: (cycle: JournalCycle) => JournalCycle,
): ActivityJournalState {
  const index = cycleIndex(journal, cycleId);
  if (index < 0) return markActivityJournalIncomplete(journal);
  const cycles = journal.cycles.slice();
  cycles[index] = update(cycles[index]);
  return { ...journal, cycles };
}

function withActivity(
  journal: ActivityJournalState,
  envelope: AgentActivityEnvelope,
  update: (activity: JournalActivity) => JournalActivity,
): ActivityJournalState {
  const id = envelope.activityId;
  if (id === null) return markActivityJournalIncomplete(journal);
  const activity = journal.activities[id];
  if (activity === undefined || activity.cycleId !== envelope.cycleId) {
    return markActivityJournalIncomplete(journal);
  }
  return {
    ...journal,
    activities: { ...journal.activities, [id]: update(activity) },
  };
}

function withLiveActivity(
  journal: ActivityJournalState,
  envelope: AgentActivityEnvelope,
  update: (activity: JournalActivity) => JournalActivity,
): ActivityJournalState {
  const id = envelope.activityId;
  const activity = id === null ? undefined : journal.activities[id];
  if (activity !== undefined && isTerminalActivity(activity.state)) {
    return markActivityJournalIncomplete(journal);
  }
  return withActivity(journal, envelope, update);
}

function newActivity(
  envelope: AgentActivityEnvelope,
  state: JournalActivityState,
): JournalActivity | null {
  if (envelope.activityId === null || envelope.cycleId === null) return null;
  return {
    id: envelope.activityId,
    cycleId: envelope.cycleId,
    firstSequence: envelope.sequence,
    lastSequence: envelope.sequence,
    lastActiveSequence: envelope.sequence,
    name: null,
    title: null,
    arguments: null,
    stepId: null,
    progress: null,
    preview: null,
    state,
    settlement: null,
    approvalResolution: null,
    noteOutcome: null,
    abandonmentReason: null,
  };
}

function addActivity(
  journal: ActivityJournalState,
  activity: JournalActivity,
): ActivityJournalState {
  const cycle = journal.cycles.find((candidate) => candidate.id === activity.cycleId);
  if (cycle === undefined) return markActivityJournalIncomplete(journal);
  return {
    ...withCycle(journal, activity.cycleId, (current) => ({
      ...current,
      activityIds: [...current.activityIds, activity.id],
    })),
    activities: { ...journal.activities, [activity.id]: activity },
  };
}

function appendThinking(
  thinking: JournalThinking | null,
  sequence: number,
  delta: string,
): JournalThinking {
  return thinking === null
    ? { text: delta, firstSequence: sequence, lastSequence: sequence }
    : { ...thinking, text: thinking.text + delta, lastSequence: sequence };
}

function reducePayload(
  journal: ActivityJournalState,
  envelope: AgentActivityEnvelope,
): ActivityJournalState {
  const payload = envelope.payload;
  switch (payload.type) {
    case "runStarted":
    case "keepalive":
    case "skillActivated":
    case "skillActivationFailed":
    case "approvalDegraded":
    case "citationDropped":
    case "answer":
    case "answerTruncated":
    case "citation":
    case "coverage":
    case "usage":
      return journal;
    case "hostStatus":
      return {
        ...journal,
        hostStatus: { message: payload.message, sequence: envelope.sequence },
      };
    case "cycleStarted": {
      if (
        envelope.cycleId === null ||
        envelope.activityId !== null ||
        cycleIndex(journal, envelope.cycleId) >= 0
      ) return markActivityJournalIncomplete(journal);
      return {
        ...journal,
        cycles: [...journal.cycles, {
          id: envelope.cycleId,
          firstSequence: envelope.sequence,
          lastSequence: envelope.sequence,
          thinking: { text: "", firstSequence: envelope.sequence, lastSequence: envelope.sequence },
          summary: null,
          activityIds: [],
        }],
      };
    }
    case "thinking":
      if (payload.source === "finalAnswer") {
        if (envelope.cycleId !== null || envelope.activityId !== null) {
          return markActivityJournalIncomplete(journal);
        }
        return {
          ...journal,
          finalThinking: appendThinking(
            journal.finalThinking,
            envelope.sequence,
            payload.delta,
          ),
        };
      }
      if (envelope.activityId !== null) return markActivityJournalIncomplete(journal);
      return withCycle(journal, envelope.cycleId, (cycle) => ({
        ...cycle,
        thinking: appendThinking(
          cycle.thinking.text === "" ? null : cycle.thinking,
          envelope.sequence,
          payload.delta,
        ),
      }));
    case "cycleSummary":
      if (envelope.activityId !== null) return markActivityJournalIncomplete(journal);
      return withCycle(journal, envelope.cycleId, (cycle) =>
        cycle.summary === null
          ? { ...cycle, summary: { ...payload, sequence: envelope.sequence } }
          : cycle,
      );
    case "noteEditPreview": {
      const id = envelope.activityId;
      if (id === null) return markActivityJournalIncomplete(journal);
      const existing = journal.activities[id];
      if (existing === undefined) {
        const activity = newActivity(envelope, "provisional");
        if (activity === null) return markActivityJournalIncomplete(journal);
        return addActivity(journal, {
          ...activity,
          preview: payload,
        });
      }
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        lastActiveSequence: envelope.sequence,
        preview: payload,
      }));
    }
    case "activityStarted": {
      const id = envelope.activityId;
      if (id === null) return markActivityJournalIncomplete(journal);
      const existing = journal.activities[id];
      if (existing !== undefined) {
        if (existing.state !== "provisional" || existing.cycleId !== envelope.cycleId) {
          return markActivityJournalIncomplete(journal);
        }
        return withActivity(journal, envelope, (activity) => ({
          ...activity,
          ...payload,
          lastSequence: envelope.sequence,
          lastActiveSequence: envelope.sequence,
          state: "active",
        }));
      }
      const activity = newActivity(envelope, "active");
      if (activity === null) return markActivityJournalIncomplete(journal);
      return addActivity(journal, { ...activity, ...payload });
    }
    case "activityProgress":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        progress: payload.message,
        lastSequence: envelope.sequence,
        lastActiveSequence: envelope.sequence,
      }));
    case "activitySettled":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        state: activityStateFromStatus(payload.status),
        settlement: payload,
      }));
    case "activityAbandoned":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        state: "abandoned",
        abandonmentReason: payload.reason,
      }));
    case "noteEditAbandoned":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        // A provider-side abandonment can terminate a preview that never
        // became a call. Once dispatch has started, it only records that the
        // visible draft was not committed; ToolResult remains the one
        // authoritative terminal event for the activity.
        state: activity.state === "provisional" ? "abandoned" : activity.state,
        abandonmentReason: payload.reason,
      }));
    case "noteWritten":
    case "noteExists":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        noteOutcome: {
          kind: payload.type === "noteWritten" ? "written" : "exists",
          relPath: payload.relPath,
          noteKind: payload.kind,
        },
      }));
    case "videoPreview":
    case "transcriptSource":
    case "searching":
    case "retrieved":
    case "reading":
      return envelope.activityId === null
        ? journal
        : withLiveActivity(journal, envelope, (activity) => ({
            ...activity,
            lastSequence: envelope.sequence,
            lastActiveSequence: envelope.sequence,
          }));
    case "approvalChecking":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        lastActiveSequence: envelope.sequence,
      }));
    case "approvalRequested":
    case "elicit":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        state: "awaitingUser",
      }));
    case "autoApproved":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        lastActiveSequence: envelope.sequence,
        state: "active",
        approvalResolution: "approved",
      }));
    case "approvalResolved":
      return withLiveActivity(journal, envelope, (activity) => ({
        ...activity,
        lastSequence: envelope.sequence,
        lastActiveSequence: envelope.sequence,
        // Approval is a gate outcome, not tool settlement. Denial, timeout and
        // cancellation still receive one following ActivitySettled event.
        state: "active",
        approvalResolution: payload.decision,
      }));
    case "partialRun":
      return { ...journal, partialRun: journal.partialRun ?? payload.reason };
    case "plan":
      return {
        ...journal,
        plan: payload.steps.map((step) => ({ ...step, status: "pending" })),
      };
    case "planStepStatus":
      if (!journal.plan.some((step) => step.id === payload.id)) {
        return markActivityJournalIncomplete(journal);
      }
      return {
        ...journal,
        plan: journal.plan.map((step) =>
          step.id === payload.id ? { ...step, status: payload.status } : step,
        ),
      };
    case "verifying":
      return journal;
    case "runFailed":
      return {
        ...journal,
        activities: abandonLiveActivities(journal.activities, payload.message),
        terminal: { kind: "failed", message: payload.message },
      };
    case "runCompleted":
      return {
        ...journal,
        activities: abandonLiveActivities(journal.activities, "Run completed"),
        terminal: { kind: "completed", message: null },
      };
  }
}

export function reduceActivityJournal(
  journal: ActivityJournalState,
  envelope: AgentActivityEnvelope,
): ActivityJournalState {
  if (journal.terminal.kind === "incomplete") return journal;
  if (!hasValidScope(envelope)) {
    return {
      ...markActivityJournalIncomplete(journal),
      lastSequence: envelope.sequence,
    };
  }
  let next = reducePayload(journal, envelope);
  if (next.warning !== null) return { ...next, lastSequence: envelope.sequence };
  if (envelope.cycleId !== null) {
    next = withCycle(next, envelope.cycleId, (cycle) => ({
      ...cycle,
      lastSequence: Math.max(cycle.lastSequence, envelope.sequence),
    }));
  }
  return next.lastSequence === envelope.sequence
    ? next
    : { ...next, lastSequence: envelope.sequence };
}
