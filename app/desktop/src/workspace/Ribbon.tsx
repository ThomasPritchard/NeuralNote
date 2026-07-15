// The expandable workspace navigation. Files/Search select the adjacent
// primary pane while Graph changes the center view; resizing or compacting
// this control never owns either pane's mount state.

import {
  ChevronDown,
  FilePlus2,
  Files,
  FolderOpen,
  Network,
  Search,
  type LucideIcon,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "../lib/cn";
import { VaultMenu } from "./VaultMenu";
import type { SidebarPanel } from "./workspaceLayout";

/** Which sidebar panel is showing (Workspace-local view state). */
export type { SidebarPanel } from "./workspaceLayout";
/** What the center pane renders (Workspace-local view state). */
export type CenterView = "note" | "graph";

interface RibbonProps {
  navigationExpanded: boolean;
  vaultName: string;
  sidebarPanel: SidebarPanel;
  centerView: CenterView;
  onShowFiles: () => void;
  onShowSearch: () => void;
  onInsertTemplate: () => void;
  onToggleGraph: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCloseVault: () => void;
}

export function Ribbon({
  navigationExpanded,
  vaultName,
  sidebarPanel,
  centerView,
  onShowFiles,
  onShowSearch,
  onInsertTemplate,
  onToggleGraph,
  onNewNote,
  onNewFolder,
  onRefresh,
  onCloseVault,
}: Readonly<RibbonProps>) {
  return (
    <nav
      aria-label="Workspace"
      data-navigation-expanded={navigationExpanded}
      className="nn-ribbon flex shrink-0 flex-col items-stretch border-r border-border bg-sidebar py-3"
    >
      <VaultMenu
        triggerTooltip={
          navigationExpanded ? undefined : `Vault actions for ${vaultName}`
        }
        trigger={
          <button
            type="button"
            aria-label={
              navigationExpanded ? vaultName : `Vault actions for ${vaultName}`
            }
            className="mb-5 flex h-9 w-full min-w-0 items-center rounded-md text-left text-[0.8125rem] font-semibold text-sidebar-foreground transition-colors duration-150 ease-spring hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="nn-navigation-icon-gutter flex w-[56px] shrink-0 justify-center">
              <FolderOpen className="size-[18px]" aria-hidden />
            </span>
            <span className="nn-navigation-copy flex min-w-0 flex-1 items-center gap-2 pr-2" aria-hidden>
              <span className="min-w-0 flex-1 truncate">{vaultName}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </span>
          </button>
        }
        onNewNote={onNewNote}
        onNewFolder={onNewFolder}
        onRefresh={onRefresh}
        onCloseVault={onCloseVault}
      />

      <div
        role="group"
        aria-labelledby="nn-quick-links-label"
        className="flex flex-col gap-1"
      >
        <span
          id="nn-quick-links-label"
          className="nn-navigation-copy mb-1 pl-[56px] pr-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        >
          Quick links
        </span>
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
        <RibbonButton
          icon={FilePlus2}
          label="Insert from template"
          onClick={onInsertTemplate}
        />
        <RibbonButton
          icon={Network}
          label="Graph view"
          active={centerView === "graph"}
          onClick={onToggleGraph}
        />
      </div>
    </nav>
  );
}

interface RibbonButtonProps {
  icon: LucideIcon;
  label: string;
  /** Toggle actions pass their selected state; one-shot actions omit it. */
  active?: boolean;
  onClick: () => void;
}

function RibbonButton({
  icon: Icon,
  label,
  active,
  onClick,
}: Readonly<RibbonButtonProps>) {
  return (
    <IconButton
      label={label}
      pressed={active}
      onClick={onClick}
      className={cn(
        "relative h-9 w-full justify-start gap-0 px-0",
        active && "bg-surface-selected text-foreground",
      )}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      )}
      <span className="nn-navigation-icon-gutter flex w-[56px] shrink-0 justify-center">
        <Icon className="size-[18px] shrink-0" aria-hidden />
      </span>
      <span
        className="nn-navigation-copy min-w-0 truncate pr-2 text-[0.8125rem]"
        aria-hidden
      >
        {label}
      </span>
    </IconButton>
  );
}
