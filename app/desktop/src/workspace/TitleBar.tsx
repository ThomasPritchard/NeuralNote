// The integrated titlebar (macOS overlay style). The webview extends
// under the native traffic lights, so this bar draws the window chrome around
// them: a 78px spacer clears the lights, then sidebar toggle + vault switcher
// (left), the single active-note tab (centre), and chat + settings (right).
//
// Dragging: a dedicated absolutely-positioned layer BEHIND the interactive
// clusters carries `data-tauri-drag-region`; the clusters sit above it (z-10)
// so clicks land on buttons while empty gaps between clusters fall through to
// the drag layer and move the window. Native traffic-light clicks are OS-handled;
// the 78px spacer is padding on the left cluster, so it does not fall through.
//
// Pure presentation, prop-driven. Radix owns the vault menu's interaction state.

import {
  ChevronDown,
  PanelLeft,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { NoteDoc } from "../lib/types";
import { extFromPath, iconForFile } from "./fileMeta";
import { VaultMenu } from "./VaultMenu";

export interface TitleBarProps {
  /** Vault display name, shown in the switcher. */
  vaultName: string;
  /** Whether the left sidebar (FileTree/SearchPanel) is showing. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Whether the cited-recall chat panel is showing. */
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenSettings: () => void;
  /** The active note, or null when nothing is open. */
  note: NoteDoc | null;
  /** Whether the active note has unsaved edits. */
  noteDirty: boolean;
  onCloseNote: () => void;
  /** Vault-menu actions. */
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCloseVault: () => void;
}

export function TitleBar({
  vaultName,
  sidebarOpen,
  onToggleSidebar,
  chatOpen,
  onToggleChat,
  onOpenSettings,
  note,
  noteDirty,
  onCloseNote,
  onNewNote,
  onNewFolder,
  onRefresh,
  onCloseVault,
}: Readonly<TitleBarProps>) {
  return (
    <header
      className="nn-titlebar relative grid h-(--titlebar-height) shrink-0 items-center border-b border-border bg-titlebar"
      data-sidebar-open={sidebarOpen}
      data-chat-open={chatOpen}
    >
      {/* Drag layer — behind the z-10 clusters. If a button click ever moves
          the window instead of firing, this layering is what broke. */}
      <div data-tauri-drag-region aria-hidden className="absolute inset-0" />

      {/* Left: traffic-light spacer (pl), sidebar toggle, vault switcher. */}
      <div className="relative z-10 flex min-w-0 items-center gap-1 pl-[78px] pr-2">
        <TitleBarButton
          icon={PanelLeft}
          label="Toggle sidebar"
          pressed={sidebarOpen}
          onClick={onToggleSidebar}
        />

        {/* `relative` anchor for VaultMenu (the FileTree header idiom);
            self-stretch makes `top-full` the bar's bottom edge. */}
        <VaultMenu
          trigger={
            <button
              type="button"
              title="Vault actions"
              className="flex min-w-0 max-w-48 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-semibold text-sidebar-foreground transition-colors duration-150 ease-spring hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{vaultName}</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </button>
          }
          onNewNote={onNewNote}
          onNewFolder={onNewFolder}
          onRefresh={onRefresh}
          onCloseVault={onCloseVault}
        />
      </div>

      {/* Centre: the single active-note tab (nothing when no note is open). */}
      <div className="relative z-10 min-w-0 justify-self-start px-3">
        {note && <NoteTab note={note} dirty={noteDirty} onClose={onCloseNote} />}
      </div>

      {/* Right: cited-recall chat toggle, then settings. */}
      <div className="relative z-10 flex shrink-0 items-center justify-end gap-1 pr-3">
        <TitleBarButton
          icon={Sparkles}
          label="Toggle chat panel"
          pressed={chatOpen}
          onClick={onToggleChat}
        />
        <TitleBarButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </header>
  );
}

/** The active-note tab — the NotePane tab design, relocated into the titlebar
 *  as a raised chip: icon, truncated title, unsaved dot, close button. */
function NoteTab({
  note,
  dirty,
  onClose,
}: Readonly<{ note: NoteDoc; dirty: boolean; onClose: () => void }>) {
  const TabIcon = iconForFile(extFromPath(note.path));
  return (
    <div className="flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] text-foreground">
      <TabIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="truncate">{note.title}</span>
      {dirty && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          aria-label="Unsaved changes"
        />
      )}
      <IconButton
        aria-label="Close note"
        label="Close note"
        onClick={onClose}
        className="ml-1 size-6 opacity-60 hover:opacity-100"
      >
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

interface TitleBarButtonProps {
  icon: LucideIcon;
  label: string;
  /** Present for toggles (surfaced as aria-pressed); absent for plain actions. */
  pressed?: boolean;
  onClick: () => void;
}

/** Icon button following the RibbonButton conventions, sized for a 40px bar. */
function TitleBarButton({
  icon: Icon,
  label,
  pressed,
  onClick,
}: Readonly<TitleBarButtonProps>) {
  return (
    <IconButton
      label={label}
      pressed={pressed}
      onClick={onClick}
      className="size-8"
    >
      <Icon className="size-4" aria-hidden />
    </IconButton>
  );
}
