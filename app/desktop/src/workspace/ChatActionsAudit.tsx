import { useState, type SyntheticEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { CycleSummaryProtocolIssue } from "../lib/bindings/CycleSummaryProtocolIssue";
import type { JournalActivity } from "./activityJournal";
import type { ToolApprovalView } from "./chatMessage";
import { ChatActivityOutcome } from "./ChatActivityOutcome";

function protocolIssueLabel(issue: CycleSummaryProtocolIssue): string {
  switch (issue.kind) {
    case "malformedArguments":
      return "Cycle summary arguments were malformed.";
    case "emptyMessage":
      return "Cycle summary was empty.";
    case "multipleParagraphs":
      return "Cycle summary used multiple paragraphs.";
    case "controlCharacter":
      return "Cycle summary contained an unsupported control character.";
    case "tooLong":
      return "Cycle summary was too long.";
    case "duplicate":
      return "An extra cycle summary was ignored.";
    case "late":
      return "A late cycle summary was ignored.";
    case "missing":
      return "Cycle summary was missing.";
    case "additional":
      return `${issue.count} additional cycle summaries were ignored.`;
  }
}

export function ChatActionsAudit({
  activities,
  failures,
  protocolIssues,
  approvals,
  onOpenNote,
}: Readonly<{
  activities: JournalActivity[];
  failures: number;
  protocolIssues: CycleSummaryProtocolIssue[];
  approvals: ReadonlyMap<string, ToolApprovalView>;
  onOpenNote: (relPath: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };

  return (
    <details onToggle={onToggle} className="group/actions">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 rounded-sm text-[0.6875rem] font-medium text-muted-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open/actions:rotate-90 motion-reduce:transition-none"
        />
        Actions ({activities.length})
        {failures > 0 && <span className="text-destructive">· {failures} failed</span>}
      </summary>
      {open && (
        <div className="mt-2">
          <ol className="flex flex-col gap-1.5">
            {activities.map((activity) => (
              <ChatActivityOutcome
                key={activity.id}
                activity={activity}
                approval={approvals.get(activity.id) ?? null}
                onOpenNote={onOpenNote}
              />
            ))}
          </ol>
          {protocolIssues.length > 0 && (
            <div className="mt-2 rounded-md border border-warning/30 bg-warning/[0.06] px-2.5 py-2">
              <p className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-warning">
                Protocol details
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.6875rem] text-muted-foreground">
                {protocolIssues.map((issue, index) => (
                  <li key={`${issue.kind}-${index}`}>{protocolIssueLabel(issue)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
