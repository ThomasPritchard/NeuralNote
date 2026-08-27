import type { ApprovalResolution } from "../lib/bindings/ApprovalResolution";
import type { CycleSummarySource } from "../lib/bindings/CycleSummarySource";
import type { CycleSummaryProtocolIssue } from "../lib/bindings/CycleSummaryProtocolIssue";
import type { NoteKind } from "../lib/bindings/NoteKind";
import type { StepStatus } from "../lib/bindings/StepStatus";
import type { ToolStatus } from "../lib/bindings/ToolStatus";

export const INCOMPLETE_ACTIVITY_HISTORY = "Activity history is incomplete.";

export type ActivityProtocol = "legacy" | "v1" | null;

export interface JournalThinking {
  text: string;
  firstSequence: number;
  lastSequence: number;
}

export interface JournalCycleSummary {
  source: CycleSummarySource;
  message: string;
  protocolIssues: CycleSummaryProtocolIssue[];
  sequence: number;
}

export interface JournalCycle {
  id: string;
  firstSequence: number;
  lastSequence: number;
  thinking: JournalThinking;
  summary: JournalCycleSummary | null;
  activityIds: string[];
}

export interface JournalNotePreview {
  relPath: string | null;
  kind: NoteKind | null;
  body: string;
  complete: boolean;
}

export type JournalActivityState =
  | "provisional"
  | "active"
  | "awaitingUser"
  | "succeeded"
  | "failed"
  | "denied"
  | "timedOut"
  | "cancelled"
  | "rejected"
  | "abandoned";

export interface JournalActivity {
  id: string;
  cycleId: string;
  firstSequence: number;
  lastSequence: number;
  lastActiveSequence: number;
  name: string | null;
  title: string | null;
  arguments: string | null;
  stepId: string | null;
  progress: string | null;
  preview: JournalNotePreview | null;
  state: JournalActivityState;
  settlement: {
    status: ToolStatus;
    summary: string | null;
    detail: string | null;
    durationMs: number;
  } | null;
  approvalResolution: ApprovalResolution | null;
  noteOutcome: {
    kind: "written" | "exists";
    relPath: string;
    noteKind: NoteKind;
  } | null;
  abandonmentReason: string | null;
}

export interface JournalPlanStep {
  id: string;
  label: string;
  status: StepStatus;
}

export interface ActivityJournalState {
  cycles: JournalCycle[];
  activities: Record<string, JournalActivity>;
  finalThinking: JournalThinking | null;
  /** Latest typed host-authored run status. Replace-in-place only; model cycle
   * summaries live on their cycles and can never enter this field. */
  hostStatus: { message: string; sequence: number } | null;
  plan: JournalPlanStep[];
  partialRun: string | null;
  terminal: {
    kind: "active" | "completed" | "failed" | "cancelled" | "incomplete";
    message: string | null;
  };
  warning: string | null;
  lastSequence: number;
}

export function emptyActivityJournal(): ActivityJournalState {
  return {
    cycles: [],
    activities: {},
    finalThinking: null,
    hostStatus: null,
    plan: [],
    partialRun: null,
    terminal: { kind: "active", message: null },
    warning: null,
    lastSequence: 0,
  };
}

export function isJournalActivityWorking(activity: JournalActivity): boolean {
  return activity.state === "active" || activity.state === "provisional";
}

export function selectCurrentActivity(
  journal: ActivityJournalState,
): JournalActivity | null {
  if (journal.terminal.kind !== "active") return null;
  let selected: JournalActivity | null = null;
  for (const activity of Object.values(journal.activities)) {
    if (!isJournalActivityWorking(activity)) continue;
    if (
      selected === null ||
      activity.lastActiveSequence > selected.lastActiveSequence
    ) {
      selected = activity;
    }
  }
  return selected;
}

export function selectRunningSiblingCount(journal: ActivityJournalState): number {
  const current = selectCurrentActivity(journal);
  if (current === null) return 0;
  return Object.values(journal.activities).filter(
    (activity) =>
      activity.id !== current.id &&
      activity.cycleId === current.cycleId &&
      isJournalActivityWorking(activity),
  ).length;
}
