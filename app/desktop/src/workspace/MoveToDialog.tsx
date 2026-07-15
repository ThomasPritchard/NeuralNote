// The keyboard-accessible destination picker for the file tree's "Move to" flow
// (issue #24). It composes the shared Radix dialog primitive, so focus-trap,
// aria-modal semantics and focus-return-to-invoker come for free — this file
// only owns the destination list and the move-validation rule. The SAME rule
// (isValidMoveTarget) gates both this picker and the drag path in FileTree, so
// keyboard and drag can never diverge on what counts as a legal move.

import { FolderOpen, X } from "lucide-react";
import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import type { TreeNode } from "../lib/types";
import { isPathInside, normSep } from "./fileMeta";

/** A folder an entry may be moved into. `path` is the absolute on-disk path
 *  handed straight to `move_entry`; `label` is the human relPath ("Vault root"
 *  for the vault root itself). */
export interface MoveDestination {
  path: string;
  label: string;
}

/**
 * True when `destFolderPath` is a legal place to move `srcPath` into. Rejects
 * exactly the cases the drag flow rejects: a no-op (already the entry's parent),
 * moving an entry into itself, and moving a folder into one of its descendants.
 * Separator-agnostic so it holds on Windows (`\`) as well as POSIX. This is the
 * single source of truth both the drag path and this picker validate against.
 */
export function isValidMoveTarget(srcPath: string, destFolderPath: string): boolean {
  const src = normSep(srcPath);
  const dest = normSep(destFolderPath);
  const currentParent = src.slice(0, src.lastIndexOf("/"));
  if (currentParent === dest) return false; // no-op: already there
  return !isPathInside(dest, src); // reject the entry itself and its descendants
}

/** Split a destination label into a scannable primary (the folder's own name)
 *  and the full relPath shown beneath it in mono — mirroring the two-line rows
 *  in TemplateInsertDialog. Separator-agnostic. The vault root and any top-level
 *  folder have no distinct parent path, so only the primary line renders. */
function destinationLabel(label: string): { name: string; path: string | null } {
  const cut = Math.max(label.lastIndexOf("/"), label.lastIndexOf("\\"));
  return cut < 0 ? { name: label, path: null } : { name: label.slice(cut + 1), path: label };
}

export function MoveToDialog({
  node,
  destinations,
  onMove,
  onClose,
}: Readonly<{
  node: TreeNode;
  destinations: MoveDestination[];
  onMove: (destFolderPath: string) => void;
  onClose: () => void;
}>) {
  const valid = useMemo(
    () => destinations.filter((d) => isValidMoveTarget(node.path, d.path)),
    [destinations, node.path],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        hideClose
        className="flex max-h-[min(70vh,32rem)] max-w-md flex-col overflow-hidden p-0"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="nn-heading text-base font-semibold text-foreground">
              Move to
            </DialogTitle>
            <DialogDescription className="mt-1 text-[0.75rem] text-muted-foreground">
              Move <span className="font-medium text-foreground">{node.name}</span> into a
              folder.
            </DialogDescription>
          </div>
          <IconButton label="Cancel move" onClick={onClose} className="size-7">
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>

        {valid.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <FolderOpen className="size-7 text-muted-foreground/40" aria-hidden />
            <p role="status" className="text-[0.8125rem] leading-relaxed text-muted-foreground">
              No available destinations for{" "}
              <span className="font-medium text-foreground">{node.name}</span>.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <ul
              aria-label="Destination folders"
              className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-surface-sunken/40 p-1"
            >
              {valid.map((d) => {
                const { name, path } = destinationLabel(d.label);
                return (
                  <li key={d.path}>
                    <button
                      type="button"
                      onClick={() => onMove(d.path)}
                      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <FolderOpen className="size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate text-[0.8125rem] font-medium text-foreground">
                          {name}
                        </span>
                        {path && (
                          <span className="nn-mono block truncate text-[0.625rem] text-muted-foreground">
                            {path}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Teaches the keyboard shortcut for next time — a user who opened this
            via the row's Move button may not know a focused row also responds
            to `m`. */}
        <div className="flex items-center justify-center gap-1.5 border-t border-border px-5 py-2.5 text-[0.6875rem] text-muted-foreground">
          <span>Tip: press</span>
          <kbd className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
            m
          </kbd>
          <span>on a focused row to move it.</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
