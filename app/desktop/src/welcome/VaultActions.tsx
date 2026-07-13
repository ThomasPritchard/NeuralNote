import type { ReactNode } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { cn } from "../lib/cn";
import { buttonVariants } from "@/components/ui/button";

interface VaultActionsProps {
  /** Open the native folder picker and open the chosen vault. */
  onOpen: () => void;
  /** Begin the create-new-vault flow (pick a parent location). */
  onCreate: () => void;
}

/** The two primary entry points shown on the welcome screen. */
export function VaultActions({ onOpen, onCreate }: Readonly<VaultActionsProps>) {
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
}: Readonly<ActionCardProps>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        buttonVariants({ tone: primary ? "primary" : "quiet", size: "lg" }),
        "h-auto flex-col gap-2 rounded-xl px-4 py-5",
        "transition duration-200 ease-spring",
        "hover:-translate-y-0.5 active:translate-y-0",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        primary ? "text-primary-foreground" : "text-foreground hover:border-primary/35",
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
