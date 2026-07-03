// The vault file tree (Obsidian-style): collapsible folders, selectable files,
// and full create / rename / delete / move. CRUD goes through api.ts, then
// re-syncs via the store's refreshTree(). Every op failure is surfaced in an
// inline toast — never swallowed. The reader-affecting cases (open note deleted,
// renamed, or moved) are reported up so the parent can keep the reader honest.

import { memo, useState } from "react";
import { ChevronDown, FilePlus2, Search, X } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { TreeNode } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { isPathInside, normSep } from "./fileMeta";
import { filterTree } from "./filterTree";
import {
  CreateRow,
  TreeRow,
  type CreateKind,
  type CreatingState,
  type TreeContext,
} from "./TreeRow";
import { VaultMenu } from "./VaultMenu";

const EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

// While the filename filter is active every surviving folder renders expanded:
// this empty set is passed as the tree's collapsed-set so the user's real
// collapse state stays untouched and restores when the filter clears.
const NO_COLLAPSED: Set<string> = new Set();

interface FileTreeProps {
  vaultName: string;
  vaultPath: string;
  tree: TreeNode[];
  activePath: string | null;
  /** Whether the open note has unsaved edits — so deleting it can warn first. */
  activeDirty: boolean;
  refreshTree: () => Promise<void>;
  onSelect: (path: string) => void;
  onDeleted: (node: TreeNode) => void;
  onRemap: (oldPath: string, newNode: TreeNode) => void;
  onCloseVault: () => void;
}

// Memoized: the workspace re-renders on every editor keystroke, but the tree
// only needs to re-render when its inputs actually change. Workspace passes
// referentially stable handlers (useCallback) so this skips the keystroke churn.
export const FileTree = memo(function FileTree({
  vaultName,
  vaultPath,
  tree,
  activePath,
  activeDirty,
  refreshTree,
  onSelect,
  onDeleted,
  onRemap,
  onCloseVault,
}: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const startCreate = (parentPath: string, kind: CreateKind) => {
    setRenaming(null);
    setOpError(null);
    setCreating({ parentPath, kind });
  };

  const startRename = (path: string) => {
    setCreating(null);
    setOpError(null);
    setRenaming(path);
  };

  const cancelEdit = () => {
    setCreating(null);
    setRenaming(null);
  };

  // CRUD ops refresh the tree explicitly so the sidebar updates immediately and
  // never depends on the filesystem watcher being alive (a dead watcher must not
  // leave the tree silently stale). The watcher (store.tsx) is the backstop for
  // *external* changes; the brief double-rescan when both fire is acceptable for
  // an infrequent, user-initiated op.
  const submitCreate = async (name: string) => {
    if (!creating) return;
    const { parentPath, kind } = creating;
    try {
      const node =
        kind === "folder"
          ? await api.createFolder(parentPath, name)
          : await api.createNote(parentPath, name);
      setCreating(null);
      await refreshTree();
      if (kind === "note") onSelect(node.path);
    } catch (e) {
      // Keep the input open so the user can correct the name.
      setOpError(errorMessage(e));
    }
  };

  const submitRename = async (path: string, name: string) => {
    try {
      const node = await api.renameEntry(path, name);
      setRenaming(null);
      await refreshTree();
      onRemap(path, node);
    } catch (e) {
      setOpError(errorMessage(e));
    }
  };

  const confirmDelete = async () => {
    const node = pendingDelete;
    if (!node) return;
    setPendingDelete(null);
    try {
      await api.deleteEntry(node.path);
      await refreshTree();
      onDeleted(node);
    } catch (e) {
      setOpError(errorMessage(e));
    }
  };

  const moveTo = async (destFolderPath: string) => {
    const src = dragPath;
    setDragPath(null);
    if (!src) return;
    const srcNorm = normSep(src);
    const currentParent = srcNorm.slice(0, srcNorm.lastIndexOf("/"));
    if (currentParent === normSep(destFolderPath)) return; // no-op
    try {
      const node = await api.moveEntry(src, destFolderPath);
      await refreshTree();
      onRemap(src, node);
    } catch (e) {
      setOpError(errorMessage(e));
    }
  };

  // TODO(PA-010): `ctx` is rebuilt every render, so React.memo(TreeRow) never
  // bites. The per-keystroke win already comes from React.memo(FileTree) above
  // (the workspace passes stable handlers); making row-level memo effective for
  // large vaults means useCallback-ing these handlers + useMemo-ing ctx — a
  // future optimisation, deferred as a low-value nicety.
  const filterActive = filter.trim() !== "";
  const visibleTree = filterActive ? filterTree(tree, filter) : tree;

  const ctx: TreeContext = {
    activePath,
    // Filtering forces every surviving folder open without touching the real
    // collapse state, so it restores intact when the filter clears.
    collapsed: filterActive ? NO_COLLAPSED : collapsed,
    creating,
    renaming,
    dragPath,
    toggle: (relPath) => {
      // A toggle while filtering would mutate the real collapse state with no
      // visible effect (everything renders expanded) — ignore it instead.
      if (filterActive) return;
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(relPath)) next.delete(relPath);
        else next.add(relPath);
        return next;
      });
    },
    onSelect,
    onStartCreate: startCreate,
    onStartRename: startRename,
    onDelete: setPendingDelete,
    onSubmitCreate: submitCreate,
    onSubmitRename: submitRename,
    onCancelEdit: cancelEdit,
    onDragStart: setDragPath,
    onDragEnd: () => setDragPath(null),
    onDrop: moveTo,
  };

  const creatingAtRoot = creating?.parentPath === vaultPath;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <header className="relative flex items-center justify-between px-3 pb-1.5 pt-3">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={cn(
            "flex min-w-0 items-center gap-1 rounded text-[13px] font-semibold text-sidebar-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            EASE,
          )}
        >
          <span className="truncate">{vaultName}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="New note"
          title="New note"
          onClick={() => startCreate(vaultPath, "note")}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <FilePlus2 className="size-4" aria-hidden />
        </button>

        {menuOpen && (
          <VaultMenu
            onClose={() => setMenuOpen(false)}
            onNewNote={() => startCreate(vaultPath, "note")}
            onNewFolder={() => startCreate(vaultPath, "folder")}
            onRefresh={() => void refreshTree()}
            onCloseVault={onCloseVault}
          />
        )}
      </header>

      {/* Filename filter — narrows the tree as you type. Full-text vault
          search lives in the ⌘K SearchPanel; this only matches file names. */}
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 text-[13px] text-muted-foreground/70">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filter !== "") {
                e.stopPropagation();
                setFilter("");
              }
            }}
            aria-label="Filter files by name"
            placeholder="Filter files…"
            className="w-full bg-transparent placeholder:text-muted-foreground/60 focus:outline-none"
          />
          {filter !== "" && (
            <button
              type="button"
              aria-label="Clear filter"
              title="Clear filter"
              onClick={() => setFilter("")}
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </label>
      </div>

      {/* Tree — the scroll body is also the drop target for "move to vault root".
          role="tree" reflects the actual semantics; tabIndex={-1} satisfies the
          focusability requirement for an element carrying drag handlers without
          adding a tab stop (keyboard operation is via the row buttons inside). */}
      <div
        role="tree"
        tabIndex={-1}
        className="flex-1 overflow-y-auto px-1.5 pb-2"
        onDragOver={(e) => {
          if (dragPath) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void moveTo(vaultPath);
        }}
      >
        {creatingAtRoot && creating && <CreateRow kind={creating.kind} ctx={ctx} />}
        {tree.length === 0 && !creatingAtRoot && (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-muted-foreground/70">
            This vault is empty. Use the + above to create your first note.
          </p>
        )}
        {tree.length > 0 && filterActive && visibleTree.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-muted-foreground/70">
            No files match &quot;{filter}&quot;
          </p>
        )}
        {visibleTree.map((node) => (
          <TreeRow key={node.relPath} node={node} ctx={ctx} />
        ))}
      </div>

      {opError && (
        <div className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-3 py-2">
          <div className="flex items-start gap-2 text-[12px] text-destructive">
            <span className="min-w-0 flex-1 break-words leading-snug">{opError}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setOpError(null)}
              className="shrink-0 rounded p-0.5 hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.kind === "folder" ? "folder" : "note"}?`}
          message={
            activeDirty &&
            activePath !== null &&
            isPathInside(activePath, pendingDelete.path)
              ? `"${pendingDelete.name}" will be moved to your system trash. The open note has unsaved changes that will be lost — the trash only restores the last saved version.`
              : `"${pendingDelete.name}" will be moved to your system trash, where you can restore it.`
          }
          confirmLabel="Move to trash"
          tone="danger"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
});
