import {
  AlertTriangle,
  Check,
  Circle,
  CircleMinus,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { StepStatus } from "../lib/types";

export const PLAN_STATUS_CHROME: Record<
  StepStatus,
  {
    icon: LucideIcon;
    label: string;
    tone: string;
    labelTone: string;
    /** Established timeline account; the full-plan surface uses `label`. */
    account: string;
    accountVisible: boolean;
    spin?: true;
  }
> = {
  pending: {
    icon: Circle,
    label: "Pending",
    tone: "text-muted-foreground/35",
    labelTone: "text-muted-foreground/60",
    account: "Not started",
    accountVisible: false,
  },
  running: {
    icon: Loader2,
    label: "In progress",
    tone: "text-primary",
    labelTone: "text-foreground/80",
    account: "In progress",
    accountVisible: false,
    spin: true,
  },
  done: {
    icon: Check,
    label: "Done",
    tone: "text-muted-foreground/70",
    labelTone: "text-muted-foreground",
    account: "Done",
    accountVisible: false,
  },
  skipped: {
    icon: CircleMinus,
    label: "Skipped",
    tone: "text-muted-foreground/60",
    labelTone: "text-muted-foreground/70",
    account: "skipped as unnecessary",
    accountVisible: true,
  },
  failed: {
    icon: AlertTriangle,
    label: "Failed",
    tone: "text-warning",
    labelTone: "text-muted-foreground",
    account: "did not work",
    accountVisible: true,
  },
};

export function ChatPlanStatus({ status }: Readonly<{ status: StepStatus }>) {
  const chrome = PLAN_STATUS_CHROME[status];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", chrome.tone)}>
      <chrome.icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          chrome.spin && "animate-spin motion-reduce:animate-none",
        )}
      />
      <span className="text-[0.625rem] font-semibold uppercase tracking-[0.06em]">
        {chrome.label}
      </span>
    </span>
  );
}
