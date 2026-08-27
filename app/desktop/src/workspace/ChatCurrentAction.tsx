import { Loader2 } from "lucide-react";
import type { JournalCurrentAction } from "./activityJournalSelectors";

export function ChatCurrentAction({
  action,
}: Readonly<{ action: JournalCurrentAction }>) {
  const animated = !action.waitingForUser;
  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className="flex min-h-6 min-w-0 items-center gap-2 text-[0.75rem] leading-snug text-foreground/80"
    >
      {animated && (
        <Loader2
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
        />
      )}
      <span
        key={action.changeSequence}
        className={animated ? "nn-agent-status-swap min-w-0 flex-1 truncate" : "min-w-0 flex-1 truncate"}
        title={action.message}
      >
        {action.message}
      </span>
      {action.runningSiblings > 0 && (
        <span className="nn-mono shrink-0 text-[0.625rem] text-muted-foreground">
          +{action.runningSiblings} running
        </span>
      )}
    </output>
  );
}
