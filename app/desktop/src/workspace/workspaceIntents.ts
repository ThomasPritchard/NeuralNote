// Pure helpers for the workspace's destructive-action guard and persisted tab
// state. A "pending intent" is a destructive action (close a tab/vault/window,
// quit, install an update, open another vault, delete an entry) that may need an
// unsaved-edit confirmation before it runs. These functions carry no React
// state — they're the copy + serialisation logic behind the ConfirmDialog and
// the workspace state writer. Extracted verbatim from Workspace.tsx so the view
// and its lifecycle hook can share them.

import type { NoteDoc, TreeNode, WorkspaceState } from "../lib/types";
import type { NoteTab } from "./useNoteTabs";
import { normSep } from "./fileMeta";

export type PendingIntent =
  | { kind: "close-tab"; tabId: string; restoreFocus: HTMLElement | null }
  | { kind: "close-vault" }
  | { kind: "close-window" }
  | { kind: "quit-app" }
  // The update dialog is mounted above the vault, so it cannot see dirty tabs.
  // It hands its install down here instead, and this guard runs first.
  | { kind: "install-update"; install: () => void }
  | { kind: "open-vault" }
  | { kind: "open-recent"; path: string }
  | { kind: "delete-entry"; node: TreeNode; dirtyCount: number };

function tabRelativePath(vaultPath: string, tab: NoteTab): string | null {
  if (tab.note?.relPath) return tab.note.relPath;
  const root = `${normSep(vaultPath).replace(/\/$/, "")}/`;
  const path = normSep(tab.path);
  return path.startsWith(root) ? path.slice(root.length) : null;
}

export function persistedWorkspaceState(
  vaultPath: string,
  tabs: readonly NoteTab[],
  activeTabId: string | null,
): WorkspaceState {
  const paths = new Map<string, string>();
  for (const tab of tabs) {
    const relative = tabRelativePath(vaultPath, tab);
    if (relative) paths.set(tab.id, relative);
  }
  return {
    openPaths: [...paths.values()],
    activePath: activeTabId ? (paths.get(activeTabId) ?? null) : null,
  };
}

/** The unreachable arm of every dispatch over `PendingIntent`. `never` is the
 *  guard that matters: adding a variant to the union without teaching a call
 *  site about it stops being a silent inheritance of whatever generic copy or
 *  no-op followed the chain, and becomes a BUILD error at each site — on a
 *  destructive-action path where the wrong copy gets the wrong thing confirmed.
 *  Same idiom as `useWorkspaceMenu`'s exhaustive MenuAction default; the runtime
 *  warn is belt-and-braces if an untyped intent ever reaches one. */
export function warnUnhandledIntent(intent: never): void {
  console.warn("unhandled workspace intent:", intent);
}

export function confirmDialogTitle(intent: PendingIntent): string {
  switch (intent.kind) {
    case "delete-entry": {
      const entityLabel = intent.node.kind === "folder" ? "folder" : "note";
      return `Delete ${entityLabel}?`;
    }
    case "install-update":
      return "Install update and relaunch?";
    case "close-tab":
    case "close-vault":
    case "close-window":
    case "quit-app":
    case "open-vault":
    case "open-recent":
      break;
    default:
      warnUnhandledIntent(intent);
  }
  return "Discard unsaved changes?";
}

/** A compatible text note is open and directly editable. */
export function isEditableTextNote(note: NoteDoc | null): boolean {
  return note !== null && !note.binary && !note.exceedsEditableSize;
}

export function confirmDialogLabel(intent: PendingIntent): string {
  switch (intent.kind) {
    case "delete-entry":
      return "Move to Trash";
    case "install-update":
      return "Install and relaunch";
    case "close-tab":
    case "close-vault":
    case "close-window":
    case "quit-app":
    case "open-vault":
    case "open-recent":
      break;
    default:
      warnUnhandledIntent(intent);
  }
  return "Discard";
}

function unsavedNotesClause(dirtyTabCount: number): string {
  const noun = dirtyTabCount === 1 ? "note has" : "notes have";
  return `${dirtyTabCount} open ${noun} unsaved changes`;
}

/** The body of the discard-confirmation dialog for a pending destructive intent.
 *  `dirtyTabCount` is only consulted where the whole workspace is at stake —
 *  the vault/window discards and the update relaunch. */
export function describeDiscard(
  intent: PendingIntent,
  dirtyTabCount: number,
): string {
  switch (intent.kind) {
    case "delete-entry": {
      const tabNoun = intent.dirtyCount === 1 ? "tab has" : "tabs have";
      const dirtyWarning =
        intent.dirtyCount > 0
          ? ` ${intent.dirtyCount} open ${tabNoun} unsaved changes that will be lost.`
          : "";
      return `“${intent.node.name}” will be moved to the Trash.${dirtyWarning}`;
    }
    case "close-tab":
      return "This note has edits that haven't been saved. If you continue, they'll be lost.";
    case "install-update":
      // Naming the relaunch matters: the consent already given in the update
      // dialog was about release notes, not about losing unsaved work.
      return `NeuralNote will relaunch to install the update. ${unsavedNotesClause(dirtyTabCount)} that will be lost.`;
    case "close-vault":
    case "close-window":
    case "quit-app":
    case "open-vault":
    case "open-recent":
      break;
    default:
      warnUnhandledIntent(intent);
  }
  return `${unsavedNotesClause(dirtyTabCount)}. If you continue, they'll be lost.`;
}
