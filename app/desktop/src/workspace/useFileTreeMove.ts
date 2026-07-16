// Co-located move/drag state + the single move path for the vault file tree.
// Grouped out of FileTree so the composing view stays a lean assembly; every
// declaration is moved verbatim with its original dependency array, so the
// callbacks keep the same identities and TreeRow's React.memo boundary
// (issue #25) is preserved. Both drag-and-drop and the keyboard "Move to" flow
// funnel through performMove, so validation and refresh/remap/error handling can
// never diverge between the two.

import { useCallback, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { LoadedDir } from "../lib/store";
import type { TreeNode } from "../lib/types";
import { normSep, parentRelPath, vaultRelPath } from "./fileMeta";
import { isValidMoveTarget, type MoveDestination } from "./MoveToDialog";

export interface UseFileTreeMove {
  dragPath: string | null;
  moving: TreeNode | null;
  moveDestinations: MoveDestination[];
  setDragPath: (path: string | null) => void;
  moveTo: (destFolderPath: string) => Promise<void>;
  openMove: (node: TreeNode) => void;
  closeMove: () => void;
  confirmMove: (destFolderPath: string) => Promise<void>;
  handleDragEnd: () => void;
}

export function useFileTreeMove({
  vaultPath,
  loaded,
  onRefreshDir,
  onRemap,
  surfaceOperationError,
}: Readonly<{
  vaultPath: string;
  /** Per-directory listings, keyed by relPath ("" = root) — the lazy store state. */
  loaded: ReadonlyMap<string, LoadedDir>;
  onRefreshDir: (relPath: string) => Promise<void>;
  onRemap: (oldPath: string, newNode: TreeNode) => void;
  surfaceOperationError: (error: unknown, allowInlineValidation?: boolean) => void;
}>): UseFileTreeMove {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [moving, setMoving] = useState<TreeNode | null>(null);

  // The single move path: both drag-and-drop and the keyboard "Move to" flow
  // call this, so the validation rule and the refresh/remap/error handling can
  // never diverge between the two. Validation reuses isValidMoveTarget (the same
  // rule MoveToDialog filters its destinations with), which rejects no-ops,
  // moving an entry into itself, and moving a folder into a descendant.
  const performMove = useCallback(
    async (srcPath: string, destFolderPath: string) => {
      if (!isValidMoveTarget(srcPath, destFolderPath)) return;
      try {
        const node = await api.moveEntry(srcPath, destFolderPath);
        const srcParentRel = parentRelPath(vaultRelPath(srcPath, vaultPath));
        const destRel = vaultRelPath(destFolderPath, vaultPath);
        await onRefreshDir(srcParentRel);
        // Only re-list the destination if it is currently loaded (on screen); a
        // collapsed/unloaded destination fetches fresh on its next expand, so
        // there is nothing on screen to update.
        if (loaded.has(destRel)) await onRefreshDir(destRel);
        onRemap(srcPath, node);
      } catch (e) {
        surfaceOperationError(e);
      }
    },
    [vaultPath, loaded, onRefreshDir, onRemap, surfaceOperationError],
  );

  const moveTo = useCallback(
    async (destFolderPath: string) => {
      const src = dragPath;
      setDragPath(null);
      if (!src) return;
      await performMove(src, destFolderPath);
    },
    [dragPath, performMove],
  );

  const openMove = useCallback((node: TreeNode) => setMoving(node), []);
  const closeMove = useCallback(() => setMoving(null), []);
  const confirmMove = useCallback(
    async (destFolderPath: string) => {
      const target = moving;
      setMoving(null); // close first so focus returns to the invoking row
      if (target) await performMove(target.path, destFolderPath);
    },
    [moving, performMove],
  );

  // Candidate destinations for the keyboard picker: every folder currently in
  // the lazy store, plus the vault root. A lazy vault only lists folders it has
  // loaded, so this offers the loaded folder set (MoveToDialog filters out the
  // ones that would be illegal for the specific entry).
  const moveDestinations = useMemo<MoveDestination[]>(() => {
    const seen = new Set<string>([normSep(vaultPath)]);
    const folders: MoveDestination[] = [];
    for (const dir of loaded.values()) {
      if (dir.status !== "loaded") continue;
      for (const child of dir.children) {
        if (child.kind !== "folder") continue;
        const key = normSep(child.path);
        if (seen.has(key)) continue;
        seen.add(key);
        folders.push({ path: child.path, label: child.relPath });
      }
    }
    folders.sort((a, b) => a.label.localeCompare(b.label));
    return [{ path: vaultPath, label: "Vault root" }, ...folders];
  }, [loaded, vaultPath]);

  const handleDragEnd = useCallback(() => setDragPath(null), []);

  return {
    dragPath,
    moving,
    moveDestinations,
    setDragPath,
    moveTo,
    openMove,
    closeMove,
    confirmMove,
    handleDragEnd,
  };
}
