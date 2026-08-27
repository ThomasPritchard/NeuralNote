import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { JournalPlanStep } from "./activityJournal";
import { ChatPlanStatus, PLAN_STATUS_CHROME } from "./ChatPlanStatus";

function PlanRows({
  steps,
  scrollable = false,
}: Readonly<{ steps: JournalPlanStep[]; scrollable?: boolean }>) {
  return (
    <ol
      aria-label={scrollable ? "Plan tasks" : undefined}
      /* A live plan is a bounded native scrollport. WebKit does not make it
         keyboard-focusable automatically, so the focused list is the direct
         keyboard path to tasks that overflow the fixed-height region. */
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={scrollable ? 0 : undefined}
      className={scrollable
        ? "flex max-h-48 flex-col gap-1.5 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        : "flex flex-col gap-1.5"}
    >
      {steps.map((step) => (
        <li
          key={step.id}
          className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 rounded-md px-1.5 py-1"
        >
          <ChatPlanStatus status={step.status} />
          <span
            className={`min-w-0 break-words text-[0.6875rem] leading-snug ${PLAN_STATUS_CHROME[step.status].labelTone}`}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ChatTurnPlan({
  steps,
  active,
  earlyEnd,
}: Readonly<{
  steps: JournalPlanStep[];
  active: boolean;
  earlyEnd: string | null;
}>) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.status === "done").length;

  if (active) {
    return (
      <section
        aria-label="Task plan"
        className="sticky bottom-0 z-10 rounded-lg border border-border/80 bg-background/95 px-2.5 py-2 shadow-[0_-8px_20px_hsl(var(--background)/0.75)] backdrop-blur-sm"
      >
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <h3 className="text-[0.6875rem] font-semibold text-foreground/85">Plan</h3>
          <span className="text-[0.625rem] text-muted-foreground">
            {done} of {steps.length} done
          </span>
        </div>
        {/* The full plan is always present. Its own native scrollport keeps a
            long declaration accountable without taking over the transcript. */}
        <PlanRows steps={steps} scrollable />
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {earlyEnd !== null && (
        <p className="rounded-md border border-warning/35 bg-warning/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-foreground/80">
          Run ended early: {earlyEnd}
        </p>
      )}
      <details
        className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          Plan · {done} of {steps.length} done
        </summary>
        {open && (
          <div className="mt-2 pl-1">
            <PlanRows steps={steps} scrollable />
          </div>
        )}
      </details>
    </div>
  );
}
