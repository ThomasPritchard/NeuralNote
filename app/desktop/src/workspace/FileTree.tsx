// The vault file tree (Obsidian-style): collapsible folders, selectable files,
// and full create / rename / delete / move. It renders the LAZY store model
// (issue #40): folders start collapsed and load their children on expand, so a
// large vault never walks or mounts its whole tree up front. Expansion state
// (`expanded`) and per-directory listings (`loaded`) live in the store; this
// component is the pure display. CRUD goes through api.ts, then re-lists just the
// affected folder via the store's refreshDir(); every op failure is surfaced in
// an inline toast/row — never swallowed. Reader-affecting cases (open note
// deleted, renamed, or moved) are reported up so the parent keeps the reader
// honest. Rows flatten (flattenTree.ts) and window through
// @tanstack/react-virtual so only the visible slice mounts (PA-005).
//
// This file is the composing top-level view: it owns the filter + virtualization
// and assembles the row context, delegating the create/rename and move/drag
// concerns to co-located hooks (useFileTreeCrud, useFileTreeMove) and the row
// markup to FileTreeRow.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FilePlus2, Search, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { LoadedDir } from "../lib/store";
import type { TreeNode } from "../lib/types";
import { vaultRelPath } from "./fileMeta";
import { filterLoadedTree } from "./loadedTree";
import { flattenTree, rowKey } from "./flattenTree";
import { type CreateKind, type TreeContext } from "./TreeRow";
import { MoveToDialog } from "./MoveToDialog";
import { FlatTreeRow } from "./FileTreeRow";
import { useFileTreeCrud } from "./useFileTreeCrud";
import { useFileTreeMove } from "./useFileTreeMove";

// ── Virtualization (PA-005) ────────────────────────────────────────────────
// A large expanded vault can still flatten to thousands of rows; above this
// count the tree body windows via @tanstack/react-virtual; below it, rows render
// plainly (identical DOM to the un-windowed tree, zero overhead for small
// vaults).
const VIRTUALIZE_MIN_ROWS = 100;
/** Estimated row height (px) before dynamic measurement lands — a file row is
 *  ~26px (13px text + 5px vertical padding each side). */
const ROW_ESTIMATE = 26;

interface FileTreeProps {
  vaultPath: string;
  activePath: string | null;
  /** Per-directory listings, keyed by relPath ("" = root) — the lazy store state. */
  loaded: ReadonlyMap<string, LoadedDir>;
  /** Folder relPaths currently expanded (persisted by the store). */
  expanded: ReadonlySet<string>;
  /** Expand/collapse a folder (the store fetches it on first expand). */
  onToggle: (relPath: string) => void;
  /** Re-attempt a folder's lazy listing (the error row's Retry). */
  onListDir: (relPath: string) => Promise<void>;
  /** Re-list one folder in place after a CRUD op (targeted, never a full walk). */
  onRefreshDir: (relPath: string) => Promise<void>;
  onSelect: (path: string, openInNewTab: boolean) => void;
  /** Workspace owns delete confirmation because background tabs may be dirty. */
  onDeleteRequest: (node: TreeNode) => void;
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
  activePath,
  loaded,
  expanded,
  onToggle,
  onListDir,
  onRefreshDir,
  onSelect,
  onDeleteRequest,
  onRemap,
  pendingCreate,
  onCreateConsumed,
}: FileTreeProps) {
  const [filter, setFilter] = useState("");

  // Create/rename state + async CRUD (co-located). surfaceOperationError is
  // shared with the move flow so both surface failures the same way.
  const {
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
  } = useFileTreeCrud({
    vaultPath,
    expanded,
    onToggle,
    onRefreshDir,
    onSelect,
    onRemap,
    pendingCreate,
    onCreateConsumed,
  });

  // Move/drag state + the single move path (co-located).
  const {
    dragPath,
    moving,
    moveDestinations,
    setDragPath,
    moveTo,
    openMove,
    closeMove,
    confirmMove,
    handleDragEnd,
  } = useFileTreeMove({ vaultPath, loaded, onRefreshDir, onRemap, surfaceOperationError });

  const filterActive = filter.trim() !== "";
  // While filtering, render over the LOADED portion filtered to matches +
  // their ancestor folders, every surviving folder forced open — the lazy
  // equivalent of the old "expand everything while filtering". This is a display
  // filter over loaded nodes only, NOT vault search (⌘K, which stays full).
  const filtered = filterActive ? filterLoadedTree(loaded, filter) : null;
  const flattenMap = filtered ? filtered.map : loaded;

  // Force-open the folder currently being created in (if not the root), so its
  // inline create row is visible before the store's expand round-trips.
  const creatingRel =
    creating && creating.parentPath !== vaultPath
      ? vaultRelPath(creating.parentPath, vaultPath)
      : null;
  const baseExpanded = filtered ? filtered.expanded : expanded;
  // Memoized so its identity only changes with the real expand state — otherwise
  // the create force-open branch would mint a fresh Set every render and churn
  // the row context (issue #25). In the steady state it is exactly `expanded`.
  const flattenExpanded = useMemo(
    () =>
      creatingRel !== null && !baseExpanded.has(creatingRel)
        ? new Set(baseExpanded).add(creatingRel)
        : baseExpanded,
    [baseExpanded, creatingRel],
  );

  // The flat, ordered list of rows actually visible — the model the windowed
  // body renders from.
  const flatRows = flattenTree(flattenMap, flattenExpanded, creating, vaultPath);
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

  const toggle = useCallback(
    (relPath: string) => {
      // A toggle while filtering would mutate the real expand state with no
      // visible effect (everything renders open) — ignore it instead.
      if (filterActive) return;
      onToggle(relPath);
    },
    [filterActive, onToggle],
  );

  const childCount = useCallback(
    (relPath: string) => {
      const listing = loaded.get(relPath);
      return listing?.status === "loaded" ? listing.children.length : null;
    },
    [loaded],
  );

  const handleRetry = useCallback((relPath: string) => void onListDir(relPath), [onListDir]);

  // Memoized so an unrelated FileTree re-render hands every row the SAME context
  // object — the referential stability TreeRow's React.memo needs to skip
  // unchanged rows (issue #25). Its identity turns over only when a value or
  // handler a row actually reads changes.
  const ctx: TreeContext = useMemo(
    () => ({
      activePath,
      // Same set the flatten used, so the chevron/aria-expanded state and the row
      // list can never disagree (covers filter force-open + create force-open).
      expanded: flattenExpanded,
      creating,
      renaming,
      dragPath,
      toggle,
      childCount,
      onRetry: handleRetry,
      onSelect,
      onStartCreate: startCreate,
      onStartRename: startRename,
      onMove: openMove,
      onDelete: onDeleteRequest,
      onSubmitCreate: submitCreate,
      onSubmitRename: submitRename,
      onCancelEdit: cancelEdit,
      onDragStart: setDragPath,
      onDragEnd: handleDragEnd,
      onDrop: moveTo,
    }),
    [
      activePath,
      flattenExpanded,
      creating,
      renaming,
      dragPath,
      toggle,
      childCount,
      handleRetry,
      onSelect,
      startCreate,
      startRename,
      openMove,
      onDeleteRequest,
      submitCreate,
      submitRename,
      cancelEdit,
      setDragPath,
      handleDragEnd,
      moveTo,
    ],
  );

  const rootListing = loaded.get("");
  const rootReady = rootListing?.status === "loaded";
  const rootEmpty = rootReady && rootListing.children.length === 0;
  const creatingAtRoot = creating?.parentPath === vaultPath;
  // "No match" only once the root has loaded and the filtered flatten yields no
  // actual node rows (a lone create row doesn't count as a match).
  const noFilterMatch =
    filterActive && rootReady && !flatRows.some((row) => row.kind === "node");

  return (
    <aside className="nn-sidebar flex shrink-0 flex-col border-r border-border bg-sidebar">
      {/* Panel top row — filename filter + root note create, mirroring the
          SearchPanel's field-first opening. The vault switcher and its menu
          moved to the window titlebar; root note creation stays here because
          it's a file-explorer affordance, not window chrome. Full-text vault
          search lives in the ⌘K SearchPanel; this filter only matches file
          names that are currently loaded. */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5 text-[0.8125rem] text-muted-foreground/70">
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
            <IconButton
              label="Clear filter"
              onClick={() => setFilter("")}
              className="size-6 shrink-0"
            >
              <X className="size-3.5" aria-hidden />
            </IconButton>
          )}
        </label>
        <IconButton
          label="New note"
          onClick={() => startCreate(vaultPath, "note")}
          className="size-6 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <FilePlus2 className="size-4" aria-hidden />
        </IconButton>
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
        {rootEmpty && !creatingAtRoot && !filterActive && (
          <p className="px-2 py-6 text-center text-[0.75rem] leading-relaxed text-muted-foreground/70">
            This vault is empty. Use the + above to create your first note.
          </p>
        )}
        {noFilterMatch && (
          <p className="px-2 py-6 text-center text-[0.75rem] leading-relaxed text-muted-foreground/70">
            No files match &quot;{filter}&quot;
          </p>
        )}
        {virtualize ? (
          // Windowed body: a spacer at the full list height, with only the
          // visible slice mounted, absolutely placed at its offset. Rows
          // measure themselves (measureElement) so the taller create row and
          // any variable-height rows stay correctly stacked.
          <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                ref={rowVirtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <FlatTreeRow row={flatRows[item.index]} ctx={ctx} onMove={openMove} />
              </div>
            ))}
          </div>
        ) : (
          flatRows.map((row) => (
            <FlatTreeRow key={rowKey(row)} row={row} ctx={ctx} onMove={openMove} />
          ))
        )}
      </div>

      {moving && (
        <MoveToDialog
          node={moving}
          destinations={moveDestinations}
          onMove={confirmMove}
          onClose={closeMove}
        />
      )}

      {opError && (
        <div className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-3 py-2">
          <div className="flex items-start gap-2 text-[0.75rem] text-destructive">
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
    </aside>
  );
});
