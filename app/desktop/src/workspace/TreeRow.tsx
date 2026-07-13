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
  FolderOpen,
  FolderPlus,
  LayoutTemplate,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { TemplateInfo, TreeNode } from "../lib/types";
import { iconForFile, isPathInside } from "./fileMeta";
import { InlineInput } from "./InlineInput";

export type CreateKind = "note" | "folder";

export interface CreatingState {
  parentPath: string;
  kind: CreateKind;
}

/** Shared callbacks + transient state threaded through the recursive tree. */
export interface TreeContext {
  activePath: string | null;
  collapsed: Set<string>;
  creating: CreatingState | null;
  renaming: string | null;
  dragPath: string | null;
  /** Vault templates offered while creating a note; empty = no picker (the
   *  plain create flow, unchanged). */
  templates: TemplateInfo[];
  /** relPath of the chosen template, or null for a blank note. */
  selectedTemplate: string | null;
  onSelectTemplate: (relPath: string | null) => void;
  toggle: (relPath: string) => void;
  onSelect: (path: string) => void;
  onStartCreate: (parentPath: string, kind: CreateKind) => void;
  onStartRename: (path: string) => void;
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
  const isOpen = creatingHere || !ctx.collapsed.has(node.relPath);
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
          "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
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
        <span className="nn-mono ml-auto pr-1 text-[10px] text-muted-foreground/60">
          {node.children?.length ?? 0}
        </span>
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
        onClick={() => ctx.onSelect(node.path)}
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
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-2 text-left text-[13px] transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
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

/** The inline "name your new note/folder" row shown inside the target folder.
 *  When the vault has templates and a note is being created, a compact picker
 *  appears under the name input (defaulting to "Blank note" — templates are
 *  strictly optional and add zero friction when unused). */
export function CreateRow({
  kind,
  ctx,
}: Readonly<{ kind: CreateKind; ctx: TreeContext }>) {
  // Focus moving between the name input and the template picker must not end
  // the create session — InlineInput's blur-cancel is scoped to this row.
  const rowRef = useRef<HTMLDivElement>(null);
  const Icon = kind === "folder" ? Folder : iconForFile("md");
  const showTemplates = kind === "note" && ctx.templates.length > 0;

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
      {showTemplates && (
        <div className="mt-1 flex items-center gap-1.5 pl-5">
          <LayoutTemplate
            className="size-3 shrink-0 text-muted-foreground/70"
            aria-hidden
          />
          <select
            aria-label="Note template"
            value={ctx.selectedTemplate ?? ""}
            onChange={(e) =>
              ctx.onSelectTemplate(e.target.value === "" ? null : e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Enter here means "done choosing" — hand focus back to the
                // name input so the next Enter creates the note.
                e.preventDefault();
                rowRef.current?.querySelector("input")?.focus();
              } else if (e.key === "Escape") {
                e.preventDefault();
                ctx.onCancelEdit();
              }
            }}
            className="w-full min-w-0 cursor-pointer rounded-md border border-border bg-background px-1 py-[3px] text-[12px] text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <option value="">Blank note</option>
            {ctx.templates.map((t) => (
              <option key={t.relPath} value={t.relPath}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
