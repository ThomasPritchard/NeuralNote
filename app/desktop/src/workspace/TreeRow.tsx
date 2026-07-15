// One node in the vault tree, rendered as a single flat row — FileTree flattens
// the visible tree (flattenTree.ts) and windows it, so rows never recurse into
// children here (PA-005). Folders collapse/expand and act as drop targets;
// files select into the reader. Hover (or keyboard focus) reveals per-node
// actions: new note / new folder (folders only), rename, delete. Inline
// create/rename inputs live here; the parent FileTree owns the async ops.

import { memo, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { TreeNode } from "../lib/types";
import { iconForFile, isPathInside } from "./fileMeta";
import { InlineInput } from "./InlineInput";

export type CreateKind = "note" | "folder";

export interface CreatingState {
  parentPath: string;
  kind: CreateKind;
}

/** Shared callbacks + transient state threaded through the flattened tree. */
export interface TreeContext {
  activePath: string | null;
  /** Folder relPaths currently expanded (lazy store state). A folder not in the
   *  set is collapsed and its children are not rendered. */
  expanded: ReadonlySet<string>;
  creating: CreatingState | null;
  renaming: string | null;
  dragPath: string | null;
  toggle: (relPath: string) => void;
  /** Immediate child count for a loaded folder (for its row badge), or null when
   *  the folder isn't loaded yet — so a collapsed, never-opened folder shows no
   *  count rather than a misleading zero. */
  childCount: (relPath: string) => number | null;
  /** Re-attempt the lazy listing of a folder whose fetch errored (error row's
   *  Retry). */
  onRetry: (relPath: string) => void;
  onSelect: (path: string, openInNewTab: boolean) => void;
  onStartCreate: (parentPath: string, kind: CreateKind) => void;
  onStartRename: (path: string) => void;
  /** Open the "Move to" destination picker for this entry — the visible,
   *  labelled twin of the `m` keyboard shortcut (issue #24). */
  onMove: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
  onSubmitCreate: (name: string) => void;
  onSubmitRename: (path: string, name: string) => void;
  onCancelEdit: () => void;
  onDragStart: (path: string) => void;
  onDragEnd: () => void;
  onDrop: (destFolderPath: string) => void;
}

const ACTION_BTN =
  "grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary";

const ACTIONS_WRAP =
  "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-sidebar pl-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100";

// Memoized so an unchanged row skips re-rendering when its siblings or an
// ancestor re-render (e.g. the workspace re-rendering on each editor keystroke);
// it bites once `ctx` is referentially stable, which FileTree now memoizes.
export const TreeRow = memo(function TreeRow({
  node,
  ctx,
}: Readonly<{
  node: TreeNode;
  ctx: TreeContext;
}>) {
  if (ctx.renaming === node.path) {
    return (
      <div className="px-1 py-px">
        <InlineInput
          initialValue={node.name}
          placeholder="Name"
          ariaLabel={`Rename ${node.name}`}
          onSubmit={(name) => ctx.onSubmitRename(node.path, name)}
          onCancel={ctx.onCancelEdit}
        />
      </div>
    );
  }

  return node.kind === "folder" ? (
    <FolderRow node={node} ctx={ctx} />
  ) : (
    <FileRow node={node} ctx={ctx} />
  );
});

function FolderRow({
  node,
  ctx,
}: Readonly<{ node: TreeNode; ctx: TreeContext }>) {
  const [dropActive, setDropActive] = useState(false);
  const creatingHere = ctx.creating?.parentPath === node.path;
  // Mirrors flattenTree's open rule — the chevron and the row list must agree.
  // Creating inside a folder forces it open even before the store has expanded
  // it, so the inline create row is visible immediately.
  const isOpen = creatingHere || ctx.expanded.has(node.relPath);
  const childCount = ctx.childCount(node.relPath);
  // A folder cannot be dropped into itself or one of its descendants.
  const canDrop =
    ctx.dragPath !== null &&
    ctx.dragPath !== node.path &&
    !isPathInside(node.path, ctx.dragPath);

  return (
    // role="treeitem" reflects the row's place in the tree; tabIndex={-1}
    // meets the focusability requirement for an element with drag handlers
    // without adding a tab stop (the toggle button inside is the keyboard
    // control). aria-selected is required for treeitem (S6807); a folder is
    // never the active selection (only files are), so it is always false.
    <div
      role="treeitem"
      aria-selected={false}
      tabIndex={-1}
      className={cn(
        "group relative flex items-center rounded-md transition-colors",
        "ease-spring",        dropActive && canDrop && "bg-primary/15 ring-1 ring-inset ring-primary/40",
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.path);
        ctx.onDragStart(node.path);
      }}
      onDragEnd={ctx.onDragEnd}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
        if (canDrop) ctx.onDrop(node.path);
      }}
    >
      <button
        type="button"
        onClick={() => ctx.toggle(node.relPath)}
        onDoubleClick={() => ctx.onStartRename(node.path)}
        aria-expanded={isOpen}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-[0.8125rem] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          "ease-spring",        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform duration-200",
            "ease-spring",            isOpen && "rotate-90",
          )}
          aria-hidden
        />
        {isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-primary/80" aria-hidden />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="truncate">{node.name}</span>
        {childCount !== null && (
          <span className="nn-mono ml-auto pr-1 text-[0.625rem] text-muted-foreground/60">
            {childCount}
          </span>
        )}
      </button>

      <div className={ACTIONS_WRAP}>
        <button
          type="button"
          aria-label={`New note in ${node.name}`}
          title="New note"
          onClick={() => ctx.onStartCreate(node.path, "note")}
          className={ACTION_BTN}
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`New folder in ${node.name}`}
          title="New folder"
          onClick={() => ctx.onStartCreate(node.path, "folder")}
          className={ACTION_BTN}
        >
          <FolderPlus className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Rename ${node.name}`}
          title="Rename"
          onClick={() => ctx.onStartRename(node.path)}
          className={ACTION_BTN}
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Move ${node.name}`}
          title="Move to… (m)"
          onClick={() => ctx.onMove(node)}
          className={ACTION_BTN}
        >
          <FolderInput className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Delete ${node.name}`}
          title="Delete"
          onClick={() => ctx.onDelete(node)}
          className={cn(ACTION_BTN, "hover:text-destructive")}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function FileRow({ node, ctx }: Readonly<{ node: TreeNode; ctx: TreeContext }>) {
  const active = node.path === ctx.activePath;
  const Icon = iconForFile(node.ext);
  return (
    <div
      role="treeitem"
      aria-selected={active}
      tabIndex={-1}
      className="group relative flex items-center"
      // A file is not a drop target: swallow the drop so it doesn't bubble to the
      // tree container and get treated as "move to vault root" (mirrors FolderRow).
      // role="treeitem" + tabIndex={-1}: honest tree semantics and the
      // focusability the onDrop handler requires, without adding a tab stop.
      // aria-selected (required for treeitem, S6807) tracks the open file.
      onDrop={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={(event) => ctx.onSelect(node.path, event.metaKey)}
        onDoubleClick={() => ctx.onStartRename(node.path)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.path);
          ctx.onDragStart(node.path);
        }}
        onDragEnd={ctx.onDragEnd}
        aria-current={active || undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-2 text-left text-[0.8125rem] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
          "ease-spring",          active
            ? "bg-primary/12 text-foreground ring-1 ring-inset ring-primary/25"
            : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        )}
      >
        <Icon
          className={cn("size-3.5 shrink-0", active ? "text-primary" : "opacity-70")}
          aria-hidden
        />
        <span className="truncate">{node.name}</span>
      </button>

      <div className={ACTIONS_WRAP}>
        <button
          type="button"
          aria-label={`Rename ${node.name}`}
          title="Rename"
          onClick={() => ctx.onStartRename(node.path)}
          className={ACTION_BTN}
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Move ${node.name}`}
          title="Move to… (m)"
          onClick={() => ctx.onMove(node)}
          className={ACTION_BTN}
        >
          <FolderInput className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Delete ${node.name}`}
          title="Delete"
          onClick={() => ctx.onDelete(node)}
          className={cn(ACTION_BTN, "hover:text-destructive")}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The inline blank-note/folder creation row shown inside the target folder. */
export function CreateRow({
  kind,
  ctx,
}: Readonly<{ kind: CreateKind; ctx: TreeContext }>) {
  // Focus moving between the name input and the template picker must not end
  // the create session — InlineInput's blur-cancel is scoped to this row.
  const rowRef = useRef<HTMLDivElement>(null);
  const Icon = kind === "folder" ? Folder : iconForFile("md");

  return (
    <div ref={rowRef} className="py-px pl-1.5 pr-1">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <InlineInput
          placeholder={kind === "folder" ? "Folder name" : "Note name"}
          ariaLabel={kind === "folder" ? "New folder name" : "New note name"}
          onSubmit={ctx.onSubmitCreate}
          onCancel={ctx.onCancelEdit}
          blurWithin={rowRef}
        />
      </div>
    </div>
  );
}

/** Human label for a folder relPath, used in the retry control's aria-label. */
function folderLabel(relPath: string): string {
  return relPath === "" ? "the vault root" : (relPath.split("/").pop() ?? relPath);
}

/** Shown under an expanded folder while its lazy `list_dir` fetch is in flight
 *  (issue #40). A quiet spinner so a large or slow folder never looks empty or
 *  stuck — it reads as "loading", not "no files". */
export function LoadingRow() {
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-busy
      tabIndex={-1}
      className="flex items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-2 text-[0.8125rem] text-muted-foreground/70"
    >
      <Loader2
        className="size-3.5 shrink-0 animate-spin opacity-70 motion-reduce:animate-none"
        aria-hidden
      />
      <span className="italic opacity-90">Loading…</span>
    </div>
  );
}

/** Shown when a folder's lazy listing FAILED (e.g. an unreadable directory).
 *  Scoped to that one folder — siblings and the rest of the tree stay usable —
 *  and never auto-retries: the user drives recovery with the Retry control, which
 *  re-runs `list_dir` for this folder only. The failure is surfaced, not
 *  swallowed. */
export function ErrorRow({
  parentPath,
  message,
  onRetry,
}: Readonly<{
  parentPath: string;
  message: string;
  onRetry: (relPath: string) => void;
}>) {
  return (
    <div
      role="treeitem"
      aria-selected={false}
      tabIndex={-1}
      className="flex items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-1 text-[0.8125rem] text-destructive/90"
    >
      <TriangleAlert className="size-3.5 shrink-0 opacity-80" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      <button
        type="button"
        onClick={() => onRetry(parentPath)}
        aria-label={`Retry loading ${folderLabel(parentPath)}`}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium text-destructive transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
      >
        <RotateCw className="size-3" aria-hidden />
        Retry
      </button>
    </div>
  );
}

/** The explicit truncation row for a folder wider than the per-directory cap
 *  (issue #40) — the extra entries are never hidden silently. It is deliberately
 *  NON-interactive: these files are still fully indexed, so full-vault search
 *  (⌘K) reaches them even though the tree doesn't list them here. */
export function MoreRow({ count }: Readonly<{ count: number }>) {
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-disabled
      tabIndex={-1}
      title="Hidden here to keep the tree fast — full-vault search (⌘K) still finds these files."
      className="flex items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-2 text-[0.8125rem] text-muted-foreground/60"
    >
      <MoreHorizontal className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="italic">{count.toLocaleString()} more…</span>
    </div>
  );
}
