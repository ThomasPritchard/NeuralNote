import { useMemo, type ReactNode } from "react";
import { AlertTriangle, ShieldOff } from "lucide-react";
import { cn } from "../lib/cn";
import { APPROVAL_DEGRADED } from "./approvalCopy";
import {
  selectCurrentAction,
  selectCycleActivities,
  selectCycleFailureCount,
  selectCycleIsSettled,
} from "./activityJournalSelectors";
import type { AssistantMessage } from "./chatMessage";
import { ChatActivityCycle } from "./ChatActivityCycle";
import { ChatCurrentAction } from "./ChatCurrentAction";
import { ActivationFailureNode } from "./ChatTimelineNodes";
import { ChatThinkingDisclosure } from "./ChatThinkingDisclosure";
import { ChatTurnPlan } from "./ChatTurnPlan";
import "./agentActivityJournal.css";

function ActivationFailures({ turn }: Readonly<{ turn: AssistantMessage }>) {
  if (turn.skillActivationFailures.length === 0) return null;
  return (
    <ol aria-label="Skill activation problems" className="flex flex-col">
      {turn.skillActivationFailures.map((failure, index) => (
        <ActivationFailureNode
          key={failure.id}
          failure={failure}
          last={index === turn.skillActivationFailures.length - 1}
        />
      ))}
    </ol>
  );
}

function RunNotices({
  turn,
  planOwnsEarlyEnd,
}: Readonly<{ turn: AssistantMessage; planOwnsEarlyEnd: boolean }>) {
  const journal = turn.activityJournal;
  const earlyEnd = journal.partialRun ?? turn.partialRun;
  const terminalMessage = journal.terminal.message;
  const showTerminal =
    terminalMessage !== null &&
    terminalMessage !== journal.warning &&
    terminalMessage !== turn.error;
  return (
    <>
      {earlyEnd !== null && !planOwnsEarlyEnd && (
        <p className="rounded-md border border-warning/30 bg-warning/[0.06] px-2.5 py-1.5 text-[0.6875rem] leading-snug text-warning">
          Run ended early: {earlyEnd}
        </p>
      )}
      {journal.warning !== null && (
        <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/[0.06] px-2.5 py-1.5 text-[0.6875rem] leading-snug text-warning">
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          {journal.warning}
        </p>
      )}
      {showTerminal && (
        <p
          className={cn(
            "flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[0.6875rem] leading-snug",
            journal.terminal.kind === "failed"
              ? "border-destructive/30 bg-destructive/[0.06] text-destructive"
              : "border-warning/30 bg-warning/[0.06] text-warning",
          )}
        >
          <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
          {journal.terminal.kind === "failed" ? "Run failed: " : "Run ended incomplete: "}
          {terminalMessage}
        </p>
      )}
    </>
  );
}

export function ChatActivityJournal({
  turn,
  onOpenNote,
  children,
}: Readonly<{
  turn: AssistantMessage;
  onOpenNote: (relPath: string) => void;
  children?: ReactNode;
}>) {
  const journal = turn.activityJournal;
  const currentAction = selectCurrentAction(journal);
  const currentActivity =
    currentAction?.activityId === null || currentAction === null
      ? null
      : journal.activities[currentAction.activityId] ?? null;
  const approvals = useMemo(
    () => new Map(turn.toolApprovals.map((approval) => [approval.id, approval])),
    [turn.toolApprovals],
  );
  const currentCycleId = currentAction?.cycleId ?? null;
  const currentCycle = journal.cycles.find((cycle) => cycle.id === currentCycleId);
  const degradation =
    turn.approvalDegraded === null ? null : APPROVAL_DEGRADED[turn.approvalDegraded];
  const active = journal.terminal.kind === "active";
  const earlyEnd = journal.partialRun ?? turn.partialRun;
  const planOwnsEarlyEnd = !active && journal.plan.length > 0 && earlyEnd !== null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ActivationFailures turn={turn} />
      {degradation !== null && (
        <p className={cn("flex items-start gap-1.5 text-[0.6875rem] leading-snug", degradation.tone)}>
          <ShieldOff aria-hidden className="mt-px size-3.5 shrink-0" />
          {degradation.line}
        </p>
      )}
      {currentAction !== null && currentAction.cycleId === null && (
        <ChatCurrentAction action={currentAction} />
      )}
      {journal.cycles.map((cycle) => {
        const activities = selectCycleActivities(journal, cycle);
        const ownsCurrent = cycle.id === currentCycleId;
        return (
          <ChatActivityCycle
            key={cycle.id}
            cycle={cycle}
            activities={activities}
            currentAction={ownsCurrent ? currentAction : null}
            currentActivity={ownsCurrent ? currentActivity : null}
            settled={selectCycleIsSettled(journal, cycle)}
            failures={selectCycleFailureCount(journal, cycle)}
            approvals={approvals}
            preview={ownsCurrent ? turn.videoPreview : null}
            playlist={ownsCurrent ? turn.playlist : null}
            onOpenNote={onOpenNote}
          />
        );
      })}
      {currentCycle === undefined &&
        currentAction?.cycleId !== null &&
        currentAction !== null && <ChatCurrentAction action={currentAction} />}
      <ChatTurnPlan steps={journal.plan} active={active} earlyEnd={active ? null : earlyEnd} />
      <RunNotices turn={turn} planOwnsEarlyEnd={planOwnsEarlyEnd} />
      {children}
      {journal.finalThinking !== null && (
        <ChatThinkingDisclosure text={journal.finalThinking.text} />
      )}
    </div>
  );
}
