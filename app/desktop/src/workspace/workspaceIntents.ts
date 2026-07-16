// Pure helpers for the workspace's destructive-action guard and persisted tab
// state. A "pending intent" is a destructive action (close a tab/vault/window,
// quit, open another vault, delete an entry) that may need an unsaved-edit
// confirmation before it runs. These functions carry no React state — they're
// the copy + serialisation logic behind the ConfirmDialog and the workspace
// state writer. Extracted verbatim from Workspace.tsx so the view and its
// lifecycle hook can share them.

import type { NoteDoc, TreeNode, WorkspaceState } from "../lib/types";
import type { NoteTab } from "./useNoteTabs";
import { normSep } from "./fileMeta";

export type PendingIntent =
  | { kind: "close-tab"; tabId: string; restoreFocus: HTMLElement | null }
  | { kind: "close-vault" }
  | { kind: "close-window" }
  | { kind: "quit-app" }
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

export function confirmDialogTitle(intent: PendingIntent): string {
  if (intent.kind !== "delete-entry") return "Discard unsaved changes?";
  const entityLabel = intent.node.kind === "folder" ? "folder" : "note";
  return `Delete ${entityLabel}?`;
}

/** A compatible text note is open and directly editable (binary notes are not). */
export function isEditableTextNote(note: NoteDoc | null): boolean {
  return note !== null && !note.binary;
}

export function confirmDialogLabel(intent: PendingIntent): string {
  return intent.kind === "delete-entry" ? "Move to Trash" : "Discard";
}

/** The body of the discard-confirmation dialog for a pending destructive intent.
 *  `dirtyTabCount` is only consulted for the whole-vault/window discard case. */
export function describeDiscard(
  intent: PendingIntent,
  dirtyTabCount: number,
): string {
  if (intent.kind === "delete-entry") {
    const tabNoun = intent.dirtyCount === 1 ? "tab has" : "tabs have";
    const dirtyWarning =
      intent.dirtyCount > 0
        ? ` ${intent.dirtyCount} open ${tabNoun} unsaved changes that will be lost.`
        : "";
    return `“${intent.node.name}” will be moved to the Trash.${dirtyWarning}`;
  }
  if (intent.kind === "close-tab") {
    return "This note has edits that haven't been saved. If you continue, they'll be lost.";
  }
  const tabNoun = dirtyTabCount === 1 ? "note has" : "notes have";
  return `${dirtyTabCount} open ${tabNoun} unsaved changes. If you continue, they'll be lost.`;
}
