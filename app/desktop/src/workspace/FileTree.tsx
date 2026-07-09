// The vault file tree (Obsidian-style): collapsible folders, selectable files,
// and full create / rename / delete / move. CRUD goes through api.ts, then
// re-syncs via the store's refreshTree(). Every op failure is surfaced in an
// inline toast — never swallowed. The reader-affecting cases (open note deleted,
// renamed, or moved) are reported up so the parent can keep the reader honest.
// Large vaults render through a virtualized flat row list (flattenTree.ts +
// @tanstack/react-virtual) so only the visible window mounts (PA-005).

import { memo, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FilePlus2, Search, X } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { TemplateInfo, TreeNode } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { isPathInside, normSep } from "./fileMeta";
import { filterTree } from "./filterTree";
import { flattenTree, rowKey, type FlatRow } from "./flattenTree";
import {
  CreateRow,
  TreeRow,
  type CreateKind,
  type CreatingState,
  type TreeContext,
} from "./TreeRow";
import { loadCollapsed, saveCollapsed } from "./treeState";

// ── Virtualization (PA-005) ────────────────────────────────────────────────
// The headline v1 user opens an existing Obsidian vault of thousands of notes
// with folders open by default — mounting every row wrecks first paint and
// scroll. Above this row count the tree body windows via
// @tanstack/react-virtual; below it, rows render plainly (identical DOM to
// the pre-virtualized tree, zero overhead for small vaults).
const VIRTUALIZE_MIN_ROWS = 100;
/** Estimated row height (px) before dynamic measurement lands — a file row is
 *  ~26px (13px text + 5px vertical padding each side). */
const ROW_ESTIMATE = 26;

/** One flattened row: the node (or inline create input) wrapped in one
 *  indent-guide layer per ancestor level. Stacked flush rows join their
 *  `border-l` hairlines into the same continuous guide lines the old
 *  recursive nesting drew. */
function FlatTreeRow({ row, ctx }: Readonly<{ row: FlatRow; ctx: TreeContext }>) {
  let content =
    row.kind === "create" ? (
      <CreateRow kind={row.createKind} ctx={ctx} />
    ) : (
      <TreeRow node={row.node} ctx={ctx} />
    );
  for (let i = 0; i < row.depth; i++) {
    content = <div className="ml-[7px] border-l border-border/60 pl-2">{content}</div>;
  }
  return content;
}

// While the filename filter is active every surviving folder renders expanded:
// this empty set is passed as the tree's collapsed-set so the user's real
// collapse state stays untouched and restores when the filter clears.
const NO_COLLAPSED: Set<string> = new Set();

interface FileTreeProps {
  vaultPath: string;
  tree: TreeNode[];
  activePath: string | null;
  /** Whether the open note has unsaved edits — so deleting it can warn first. */
  activeDirty: boolean;
  refreshTree: () => Promise<void>;
  onSelect: (path: string) => void;
  onDeleted: (node: TreeNode) => void;
  onRemap: (oldPath: string, newNode: TreeNode) => void;
  /** A native-menu request to create a note/folder at the vault root, or null.
   *  Consumed via onCreateConsumed so it opens the inline row exactly once. */
  pendingCreate: CreateKind | null;
  onCreateConsumed: () => void;
}

// Memoized: the workspace re-renders on every editor keystroke, but the tree
// only needs to re-render when its inputs actually change. Workspace passes
// referentially stable handlers (useCallback) so this skips the keystroke churn.
export const FileTree = memo(function FileTree({
  vaultPath,
  tree,
  activePath,
  activeDirty,
  refreshTree,
  onSelect,
  onDeleted,
  onRemap,
  pendingCreate,
  onCreateConsumed,
}: FileTreeProps) {
  // Folders are open by default (empty set); the user's manual folds persist per
  // vault so they survive an app restart. Lazy-loaded once — vaultPath is stable
  // for a mount because App swaps Workspace↔Welcome on any vault change.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(vaultPath));
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  // Templates offered in the note-create row (fetched when a create begins)
  // and the picked one (null = blank note). A monotonic token guards a slow
  // list_templates response from landing on a later create session.
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const templatesReq = useRef(0);

  // Mirror the fold state to storage on every change. Cheap (a short array) and
  // idempotent, so the redundant write on mount is harmless.
  useEffect(() => {
    saveCollapsed(vaultPath, collapsed);
  }, [vaultPath, collapsed]);

  const startCreate = (parentPath: string, kind: CreateKind) => {
    setRenaming(null);
    setOpError(null);
    setCreating({ parentPath, kind });
    setTemplates([]);
    setSelectedTemplate(null);
    const id = ++templatesReq.current;
    if (kind !== "note") return;
    // Templates are strictly optional: with none (or on failure) the create
    // flow is byte-identical to before — a blank note, zero added friction.
    api
      .listTemplates()
      .then((list) => {
        if (id === templatesReq.current) setTemplates(list);
      })
      .catch((e) => {
        // Surfaced (never silent), but it must not block creating the note.
        if (id === templatesReq.current) setOpError(errorMessage(e));
      });
  };

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

  const startRename = (path: string) => {
    templatesReq.current++;
    setCreating(null);
    setOpError(null);
    setRenaming(path);
  };

  const cancelEdit = () => {
    templatesReq.current++;
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
      let node: TreeNode;
      if (kind === "folder") {
        node = await api.createFolder(parentPath, name);
      } else if (selectedTemplate === null) {
        node = await api.createNote(parentPath, name);
      } else {
        node = await api.createNoteFromTemplate(parentPath, name, selectedTemplate);
      }
      templatesReq.current++;
      setCreating(null);
      await refreshTree();
      if (kind === "note") onSelect(node.path);
    } catch (e) {
      // Keep the input open (and the chosen template) so the user can correct
      // the name.
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
  // (the workspace passes stable handlers), and virtualization now bounds how
  // many rows mount at all; making row-level memo effective means
  // useCallback-ing these handlers + useMemo-ing ctx — a future optimisation,
  // deferred as a low-value nicety.
  const filterActive = filter.trim() !== "";
  const visibleTree = filterActive ? filterTree(tree, filter) : tree;

  // The flat, ordered list of rows actually visible (open folders only, plus
  // the transient create row) — the model the windowed body renders from.
  const flatRows = flattenTree(
    visibleTree,
    filterActive ? NO_COLLAPSED : collapsed,
    creating,
    vaultPath,
  );
  const virtualize = flatRows.length > VIRTUALIZE_MIN_ROWS;

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    // Below the threshold the plain branch renders every row itself; disabling
    // also detaches the scroll/resize observers so small vaults pay nothing.
    enabled: virtualize,
    getItemKey: (index) => rowKey(flatRows[index]),
  });

  const ctx: TreeContext = {
    activePath,
    // Filtering forces every surviving folder open without touching the real
    // collapse state, so it restores intact when the filter clears.
    collapsed: filterActive ? NO_COLLAPSED : collapsed,
    creating,
    renaming,
    dragPath,
    templates,
    selectedTemplate,
    onSelectTemplate: setSelectedTemplate,
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
      {/* Panel top row — filename filter + root note create, mirroring the
          SearchPanel's field-first opening. The vault switcher and its menu
          moved to the window titlebar; root note creation stays here because
          it's a file-explorer affordance, not window chrome. Full-text vault
          search lives in the ⌘K SearchPanel; this filter only matches file
          names. */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 text-[13px] text-muted-foreground/70">
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
        <button
          type="button"
          aria-label="New note"
          title="New note"
          onClick={() => startCreate(vaultPath, "note")}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <FilePlus2 className="size-4" aria-hidden />
        </button>
      </div>

      {/* Tree — the scroll body is also the drop target for "move to vault root".
          role="tree" reflects the actual semantics; tabIndex={-1} satisfies the
          focusability requirement for an element carrying drag handlers without
          adding a tab stop (keyboard operation is via the row buttons inside). */}
      <div
        ref={scrollRef}
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
        {virtualize ? (
          // Windowed body: a spacer at the full list height, with only the
          // visible slice mounted, absolutely placed at its offset. Rows
          // measure themselves (measureElement) so the taller create row and
          // any future variable-height rows stay correctly stacked.
          <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={rowVirtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <FlatTreeRow row={flatRows[item.index]} ctx={ctx} />
              </div>
            ))}
          </div>
        ) : (
          flatRows.map((row) => <FlatTreeRow key={rowKey(row)} row={row} ctx={ctx} />)
        )}
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
