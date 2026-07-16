// Co-located create/rename state + async CRUD for the vault file tree. Grouped
// out of FileTree so the composing view stays a lean assembly; every declaration
// is moved verbatim with its original dependency array, so the callbacks keep
// the same identities and TreeRow's React.memo boundary (issue #25) is preserved.
//
// CRUD ops re-list just the affected folder(s) via onRefreshDir so the sidebar
// updates immediately without depending on the filesystem watcher being alive.
// Every op failure is surfaced — inline for name-validation errors so the user
// can correct the name, a toast otherwise — and never swallowed.

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { useToast } from "../notifications";
import type { TreeNode } from "../lib/types";
import { parentRelPath, vaultRelPath } from "./fileMeta";
import type { CreateKind, CreatingState } from "./TreeRow";

export interface UseFileTreeCrud {
  creating: CreatingState | null;
  renaming: string | null;
  opError: string | null;
  setOpError: (value: string | null) => void;
  surfaceOperationError: (error: unknown, allowInlineValidation?: boolean) => void;
  startCreate: (parentPath: string, kind: CreateKind) => void;
  startRename: (path: string) => void;
  cancelEdit: () => void;
  submitCreate: (name: string) => Promise<void>;
  submitRename: (path: string, name: string) => Promise<void>;
}

export function useFileTreeCrud({
  vaultPath,
  expanded,
  onToggle,
  onRefreshDir,
  onSelect,
  onRemap,
  pendingCreate,
  onCreateConsumed,
}: Readonly<{
  vaultPath: string;
  /** Folder relPaths currently expanded (persisted by the store). */
  expanded: ReadonlySet<string>;
  /** Expand/collapse a folder (the store fetches it on first expand). */
  onToggle: (relPath: string) => void;
  /** Re-list one folder in place after a CRUD op (targeted, never a full walk). */
  onRefreshDir: (relPath: string) => Promise<void>;
  onSelect: (path: string, openInNewTab: boolean) => void;
  onRemap: (oldPath: string, newNode: TreeNode) => void;
  /** A native-menu request to create a note/folder at the vault root, or null.
   *  Consumed via onCreateConsumed so it opens the inline row exactly once. */
  pendingCreate: CreateKind | null;
  onCreateConsumed: () => void;
}>): UseFileTreeCrud {
  const toast = useToast();
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  // Callbacks below are memoized (useCallback) so the row context object built
  // from them stays referentially stable across FileTree re-renders that don't
  // touch a row's inputs — that is what lets TreeRow's React.memo actually skip
  // unchanged rows (issue #25). Each dep list carries exactly the state/props the
  // handler reads, so no closure ever goes stale.
  const surfaceOperationError = useCallback(
    (error: unknown, allowInlineValidation = false) => {
      const kind =
        error && typeof error === "object" && "kind" in error
          ? String(error.kind)
          : null;
      if (allowInlineValidation && (kind === "invalidName" || kind === "alreadyExists")) {
        setOpError(errorMessage(error));
      } else {
        toast.error(errorMessage(error));
      }
    },
    [toast],
  );

  const startCreate = useCallback(
    (parentPath: string, kind: CreateKind) => {
      setRenaming(null);
      setOpError(null);
      // Ensure the target folder is expanded (and its children fetched) so the
      // inline create row is reachable under it. The row itself shows immediately
      // via the force-open below even before this expand round-trips; expanding
      // also loads the folder's existing siblings. The root needs no expansion.
      if (parentPath !== vaultPath) {
        const rel = vaultRelPath(parentPath, vaultPath);
        if (!expanded.has(rel)) onToggle(rel);
      }
      setCreating({ parentPath, kind });
    },
    [vaultPath, expanded, onToggle],
  );

  // Open the inline create row when the native menu (File → New Note/Folder)
  // requests one at the vault root. A ref keeps startCreate current without
  // re-running the effect every render; consuming the request clears it so a
  // sidebar remount (files ↔ search) can't replay a stale create.
  const startCreateRef = useRef(startCreate);
  startCreateRef.current = startCreate;
  useEffect(() => {
    if (!pendingCreate) return;
    startCreateRef.current(vaultPath, pendingCreate);
    onCreateConsumed();
  }, [pendingCreate, vaultPath, onCreateConsumed]);

  const startRename = useCallback((path: string) => {
    setCreating(null);
    setOpError(null);
    setRenaming(path);
  }, []);

  const cancelEdit = useCallback(() => {
    setCreating(null);
    setRenaming(null);
  }, []);

  // CRUD ops re-list just the affected folder(s) so the sidebar updates
  // immediately without depending on the filesystem watcher being alive (a dead
  // watcher must not leave the tree silently stale). The watcher (store.tsx) is
  // the backstop for *external* changes.
  const submitCreate = useCallback(
    async (name: string) => {
      if (!creating) return;
      const { parentPath, kind } = creating;
      try {
        let node: TreeNode;
        if (kind === "folder") {
          node = await api.createFolder(parentPath, name);
        } else {
          node = await api.createNote(parentPath, name);
        }
        setCreating(null);
        await onRefreshDir(vaultRelPath(parentPath, vaultPath));
        if (kind === "note") onSelect(node.path, false);
      } catch (e) {
        // Keep the input open (and the chosen template) so the user can correct
        // the name.
        surfaceOperationError(e, true);
      }
    },
    [creating, vaultPath, onRefreshDir, onSelect, surfaceOperationError],
  );

  const submitRename = useCallback(
    async (path: string, name: string) => {
      try {
        const node = await api.renameEntry(path, name);
        setRenaming(null);
        // The name and its sort position changed, so re-list the parent folder.
        await onRefreshDir(parentRelPath(vaultRelPath(path, vaultPath)));
        onRemap(path, node);
      } catch (e) {
        surfaceOperationError(e, true);
      }
    },
    [vaultPath, onRefreshDir, onRemap, surfaceOperationError],
  );

  return {
    creating,
    renaming,
    opError,
    setOpError,
    surfaceOperationError,
    startCreate,
    startRename,
    cancelEdit,
    submitCreate,
    submitRename,
  };
}
