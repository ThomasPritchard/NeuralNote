// The far-left icon rail (Obsidian's workspace switcher). Files/Search swap
// the sidebar panel and Graph view toggles the center pane — the view state
// lives in Workspace, so this rail is a pure prop-driven control with real
// active states. Settings is window-scoped and lives in the titlebar. Capture
// remains a present-but-inert placeholder for a later phase: a real, labelled,
// aria-disabled button so the locked layout is honest without faking
// behaviour.

import {
  FilePlus2,
  Files,
  Network,
  Search,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "@/components/ui/icon-button";
import { AiMark } from "@/components/neural/patterns";

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
      className="nn-ribbon flex shrink-0 flex-col items-center border-r border-border bg-sidebar py-3"
    >
      <AiMark className="mb-3 size-8" />

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
    <IconButton
      aria-label={inert ? `${label} (coming soon)` : label}
      label={inert ? `${label} (coming soon)` : label}
      tooltip={inert ? "Coming in a later phase" : label}
      aria-disabled={inert || undefined}
      pressed={inert ? undefined : active}
      onClick={onClick}
      className={cn(
        "relative size-9",
        active && "bg-surface-selected text-foreground",
      )}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      )}
      <Icon className="size-[18px]" aria-hidden />
    </IconButton>
  );
}
