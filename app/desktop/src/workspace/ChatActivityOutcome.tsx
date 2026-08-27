import { cn } from "../lib/cn";
import type { JournalActivity } from "./activityJournal";
import { approvalNodeState, approvalTone, gatedToolCopy } from "./approvalCopy";
import type { ToolApprovalView } from "./chatMessage";
import { ChatToolDetails } from "./ChatToolDetails";
import { TOOL_SETTLEMENT } from "./chatToolPresentation";

const STATE_LABEL: Record<JournalActivity["state"], string> = {
  provisional: "incomplete",
  active: "incomplete",
  awaitingUser: "waiting for you",
  succeeded: "completed",
  failed: "failed",
  denied: "denied by you",
  timedOut: "expired unanswered",
  cancelled: "run ended first",
  rejected: "refused by NeuralNote",
  abandoned: "abandoned",
};

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function ChatActivityOutcome({
  activity,
  approval,
  onOpenNote,
}: Readonly<{
  activity: JournalActivity;
  approval: ToolApprovalView | null;
  onOpenNote: (relPath: string) => void;
}>) {
  const settlement = activity.settlement;
  const chrome = settlement === null ? null : TOOL_SETTLEMENT[settlement.status];
  const Icon = chrome?.icon;
  const statusLabel = chrome?.label || STATE_LABEL[activity.state];
  const tone = chrome?.tone ?? "text-muted-foreground/70";
  const approvalState = approval === null ? null : approvalNodeState(approval);
  const approvalAccount = approvalState === null ? null : approvalTone(approvalState);
  const approvalTool = approval === null ? null : gatedToolCopy(approval.tool);
  const detail = settlement?.detail;
  const noteOutcome = activity.noteOutcome;

  return (
    <li className="min-w-0 rounded-md border border-border/60 bg-background/30 px-2.5 py-2">
      <div className="flex min-w-0 items-start gap-2 text-[0.6875rem] leading-snug">
        {Icon !== undefined && (
          <Icon
            aria-hidden
            className={cn(
              "mt-px size-3.5 shrink-0",
              tone,
              chrome?.filled && "fill-current",
            )}
          />
        )}
        <p className="min-w-0 flex-1 break-words">
          <span className="font-medium text-foreground/80">
            {activity.title ?? "Activity"}
          </span>
          <span className={cn("ml-1.5", tone)}>· {statusLabel}</span>
          {settlement !== null && (
            <span className="nn-mono ml-1.5 text-muted-foreground/60">
              · {durationLabel(settlement.durationMs)}
            </span>
          )}
        </p>
      </div>
      {settlement?.summary && (
        <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
          {settlement.summary}
        </p>
      )}
      {approvalAccount !== null && (
        <p className={cn("mt-1 text-[0.6875rem] leading-snug", approvalAccount.tone)}>
          {approvalAccount.line}
          {approvalTool !== null && ` · ${approvalTool.title}`}
          {approval?.relPath !== null && ` · ${approval?.relPath}`}
        </p>
      )}
      {noteOutcome !== null && (
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <span>{noteOutcome.kind === "written" ? "Written" : "Already existed"}</span>
          <button
            type="button"
            onClick={() => onOpenNote(noteOutcome.relPath)}
            className="nn-mono min-w-0 truncate rounded-sm text-left text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {noteOutcome.relPath}
          </button>
        </p>
      )}
      {activity.abandonmentReason !== null && (
        <p className="mt-1 text-[0.6875rem] leading-snug text-warning">
          Note draft abandoned: {activity.abandonmentReason}
        </p>
      )}
      {detail !== null && detail !== undefined && detail !== "" && settlement !== null && (
        <ChatToolDetails
          name={activity.name ?? "unknown"}
          argumentsJson={activity.arguments ?? "{}"}
          detail={detail}
          status={settlement.status}
        />
      )}
      {(detail === null || detail === undefined) &&
        activity.progress !== null &&
        ["failed", "cancelled", "abandoned"].includes(activity.state) && (
          <p className="mt-1 text-[0.625rem] leading-snug text-muted-foreground">
            {activity.progress}
          </p>
        )}
    </li>
  );
}
