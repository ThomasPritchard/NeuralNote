// The 40px integrated titlebar (macOS overlay style). The webview extends
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
// Pure presentation, prop-driven. The one piece of local state is whether the
// vault menu is open (mirrors FileTree's `menuOpen`).

import { useState } from "react";
import {
  ChevronDown,
  PanelLeft,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
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
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="relative flex h-10 shrink-0 items-center border-b border-border bg-sidebar">
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
        <div className="relative flex min-w-0 items-center self-stretch">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Vault actions"
            className={cn(
              "flex min-w-0 max-w-48 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-semibold text-sidebar-foreground",
              "transition-colors duration-300 ease-spring hover:bg-sidebar-accent/60 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            )}
          >
            <span className="truncate">{vaultName}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </button>

          {menuOpen && (
            <VaultMenu
              onClose={() => setMenuOpen(false)}
              onNewNote={onNewNote}
              onNewFolder={onNewFolder}
              onRefresh={onRefresh}
              onCloseVault={onCloseVault}
            />
          )}
        </div>
      </div>

      {/* Centre: the single active-note tab (nothing when no note is open). */}
      <div className="relative z-10 mx-auto min-w-0 px-2">
        {note && <NoteTab note={note} dirty={noteDirty} onClose={onCloseNote} />}
      </div>

      {/* Right: cited-recall chat toggle, then settings. */}
      <div className="relative z-10 flex shrink-0 items-center gap-1 pr-3">
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
      <button
        type="button"
        aria-label="Close note"
        onClick={onClose}
        className="ml-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground opacity-60 transition hover:bg-muted hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <X className="size-3.5" aria-hidden />
      </button>
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
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-300 ease-spring",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        pressed
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
