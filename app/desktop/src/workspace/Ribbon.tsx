// The far-left icon rail (Obsidian's workspace switcher). Files is the only live
// view in this phase; Search, Capture, and Graph are present-but-inert
// placeholders for the next phase — kept as real, labelled, aria-disabled
// buttons so the locked layout is honest without faking behaviour.

import {
  Brain,
  FilePlus2,
  Files,
  Network,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

interface RibbonItem {
  icon: LucideIcon;
  label: string;
  active: boolean;
}

const items: RibbonItem[] = [
  { icon: Files, label: "Files", active: true },
  { icon: Search, label: "Search", active: false },
  { icon: FilePlus2, label: "Capture", active: false },
  { icon: Network, label: "Graph view", active: false },
];

export function Ribbon() {
  return (
    <nav
      aria-label="Workspace"
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-3"
    >
      <div className="mb-3 grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_22px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
        <Brain className="size-[18px]" aria-hidden />
      </div>

      {items.map(({ icon: Icon, label, active }) => (
        <RibbonButton key={label} icon={Icon} label={label} active={active} />
      ))}

      <RibbonButton icon={Settings} label="Settings" active={false} className="mt-auto" />
    </nav>
  );
}

function RibbonButton({
  icon: Icon,
  label,
  active,
  className,
}: RibbonItem & { className?: string }) {
  // Only "Files" is functional this phase; the rest are honest placeholders.
  const inert = !active;
  return (
    <button
      type="button"
      aria-label={inert ? `${label} (coming soon)` : label}
      aria-disabled={inert || undefined}
      title={inert ? "Coming in a later phase" : label}
      className={cn(
        "relative grid size-9 place-items-center rounded-lg transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        EASE,
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        className,
      )}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      )}
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}
