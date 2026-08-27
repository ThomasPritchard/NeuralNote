import { useState, type SyntheticEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolStatus } from "../lib/types";
import { formatArguments } from "./chatToolPresentation";

const COLUMN_LABEL =
  "text-[0.5625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60";

const DETAIL_BODY =
  "nn-mono max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken px-2 py-1.5 text-[0.625rem] leading-relaxed text-muted-foreground";

export function ChatToolDetails({
  name,
  argumentsJson,
  detail,
  status,
}: Readonly<{
  name: string;
  argumentsJson: string;
  detail: string;
  status: ToolStatus;
}>) {
  const [open, setOpen] = useState(status !== "ok");
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };
  return (
    <details
      open={status !== "ok" || undefined}
      onToggle={onToggle}
      className="group/detail mt-1"
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 rounded-sm text-[0.625rem] font-medium text-muted-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open/detail:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        Details
      </summary>
      {open && (
        <div className="mt-1 grid gap-1.5 @[30rem]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p className={COLUMN_LABEL}>
              Arguments
              <span className="nn-mono ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/50">
                {name}
              </span>
            </p>
            <p className={DETAIL_BODY}>{formatArguments(argumentsJson)}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <p className={COLUMN_LABEL}>Result</p>
            <p className={DETAIL_BODY}>{detail}</p>
          </div>
        </div>
      )}
    </details>
  );
}
