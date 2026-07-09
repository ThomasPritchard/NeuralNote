// The far-left icon rail (Obsidian's workspace switcher). Files/Search swap
// the sidebar panel and Graph view toggles the center pane — the view state
// lives in Workspace, so this rail is a pure prop-driven control with real
// active states. Settings is window-scoped and lives in the titlebar. Capture
// remains a present-but-inert placeholder for a later phase: a real, labelled,
// aria-disabled button so the locked layout is honest without faking
// behaviour.

import {
  Brain,
  FilePlus2,
  Files,
  Network,
  Search,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";

/** Which sidebar panel is showing (Workspace-local view state). */
export type SidebarPanel = "files" | "search";
/** What the center pane renders (Workspace-local view state). */
export type CenterView = "note" | "graph";

interface RibbonProps {
  sidebarPanel: SidebarPanel;
  centerView: CenterView;
  onShowFiles: () => void;
  onShowSearch: () => void;
  onToggleGraph: () => void;
}

export function Ribbon({
  sidebarPanel,
  centerView,
  onShowFiles,
  onShowSearch,
  onToggleGraph,
}: Readonly<RibbonProps>) {
  return (
    <nav
      aria-label="Workspace"
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-3"
    >
      <div className="mb-3 grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_22px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
        <Brain className="size-[18px]" aria-hidden />
      </div>

      <RibbonButton
        icon={Files}
        label="Files"
        active={sidebarPanel === "files"}
        onClick={onShowFiles}
      />
      <RibbonButton
        icon={Search}
        label="Search"
        active={sidebarPanel === "search"}
        onClick={onShowSearch}
      />
      <RibbonButton icon={FilePlus2} label="Capture" active={false} />
      <RibbonButton
        icon={Network}
        label="Graph view"
        active={centerView === "graph"}
        onClick={onToggleGraph}
      />
    </nav>
  );
}

interface RibbonButtonProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  /** Absent for the not-yet-built placeholders (aria-disabled, no-op). */
  onClick?: () => void;
}

function RibbonButton({
  icon: Icon,
  label,
  active,
  onClick,
}: Readonly<RibbonButtonProps>) {
  const inert = !onClick;
  return (
    <button
      type="button"
      aria-label={inert ? `${label} (coming soon)` : label}
      aria-disabled={inert || undefined}
      aria-pressed={inert ? undefined : active}
      title={inert ? "Coming in a later phase" : label}
      onClick={onClick}
      className={cn(
        "relative grid size-9 place-items-center rounded-lg transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "ease-spring",        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
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
