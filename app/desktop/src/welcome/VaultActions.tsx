import type { ReactNode } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { cn } from "../lib/cn";

interface VaultActionsProps {
  /** Open the native folder picker and open the chosen vault. */
  onOpen: () => void;
  /** Begin the create-new-vault flow (pick a parent location). */
  onCreate: () => void;
}

/** The two primary entry points shown on the welcome screen. */
export function VaultActions({ onOpen, onCreate }: VaultActionsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <ActionCard
        icon={<FolderOpen className="size-5" aria-hidden="true" />}
        label="Open vault"
        description="An existing folder"
        onClick={onOpen}
        primary
      />
      <ActionCard
        icon={<Sparkles className="size-5" aria-hidden="true" />}
        label="New vault"
        description="Start fresh"
        onClick={onCreate}
      />
    </div>
  );
}

interface ActionCardProps {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
}

function ActionCard({
  icon,
  label,
  description,
  onClick,
  primary = false,
}: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl px-4 py-5 text-sm font-medium",
        "transition duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
        "hover:-translate-y-0.5 active:translate-y-0",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        primary
          ? "bg-primary text-primary-foreground shadow-[0_0_22px_-8px_var(--color-primary)] hover:bg-primary/90"
          : "border border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent",
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          "text-xs font-normal",
          primary ? "text-primary-foreground/70" : "text-muted-foreground",
        )}
      >
        {description}
      </span>
    </button>
  );
}
