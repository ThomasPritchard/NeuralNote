// Pure seam for the virtualized file tree (PA-005): flattens the VISIBLE portion
// of the LAZY vault tree (issue #40) into the ordered row list the FileTree body
// renders. The windowing layer (@tanstack/react-virtual) needs a flat
// `count`/index model; this module owns "which rows exist, in what order, at what
// depth" so that logic stays unit-testable without any DOM.
//
// The lazy model replaces the old eager `TreeNode[]` tree with two inputs:
//   - `loaded`: a Map from directory relPath ("" = root) to its LoadedDir (the
//     one level of children fetched for it, plus loading/error status and any
//     truncation count);
//   - `expanded`: the set of folder relPaths the user has opened.
// The walk descends ONLY into expanded folders, and only reads children from
// `loaded` — a collapsed or unloaded folder is never fetched here.
//
// Ordering contract (matches the old recursive render exactly):
//   - a create row for a directory comes right after that directory's own row
//     (or first, at the root), before its children;
//   - each folder row is followed by its children, depth-first;
//   - lazy-only rows sit at the child depth of the directory they describe: a
//     `loading` row while a listing is in flight, an `error` row when it failed,
//     and a `more` row after a truncated directory's children.

import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";
import type { CreateKind, CreatingState } from "./TreeRow";

export type FlatRow =
  | { kind: "node"; node: TreeNode; depth: number }
  | { kind: "create"; createKind: CreateKind; parentPath: string; depth: number }
  // A folder's children are in flight (its LoadedDir is loading, or not yet
  // present because the fetch was just kicked off). parentPath is the folder's
  // relPath ("" for the root).
  | { kind: "loading"; parentPath: string; depth: number }
  // Listing the folder failed; `message` is shown inline with a retry affordance.
  | { kind: "error"; parentPath: string; message: string; depth: number }
  // The folder held more than the per-directory cap; `count` entries are hidden
  // behind an explicit "N more…" row (truncation is never silent).
  | { kind: "more"; parentPath: string; count: number; depth: number };

/** Stable React key per row. Create/loading/error/more all key by the directory
 *  (relPath) they belong to, so at most one of each exists per directory and the
 *  keys never collide with a node's `n:` key. */
export function rowKey(row: FlatRow): string {
  switch (row.kind) {
    case "node":
      return `n:${row.node.relPath}`;
    case "create":
      return `create:${row.parentPath}`;
    case "loading":
      return `loading:${row.parentPath}`;
    case "error":
      return `error:${row.parentPath}`;
    case "more":
      return `more:${row.parentPath}`;
  }
}

/**
 * Flatten the visible portion of the lazy tree into ordered rows.
 *
 * @param loaded   Per-directory listings, keyed by relPath (`""` = root).
 * @param expanded Folder relPaths the user has expanded.
 * @param creating The transient inline create input, or null.
 * @param rootPath The vault root's absolute path — the `parentPath` a root-level
 *   create row is matched against (create state carries absolute paths).
 */
export function flattenTree(
  loaded: ReadonlyMap<string, LoadedDir>,
  expanded: ReadonlySet<string>,
  creating: CreatingState | null,
  rootPath: string,
): FlatRow[] {
  const rows: FlatRow[] = [];

  // Emit the rows for one directory's children at `depth`. `dirRelPath` keys the
  // `loaded` map; `dirAbsPath` is matched against the create state's parentPath.
  const emitDir = (dirRelPath: string, dirAbsPath: string, depth: number): void => {
    if (creating?.parentPath === dirAbsPath) {
      rows.push({ kind: "create", createKind: creating.kind, parentPath: creating.parentPath, depth });
    }

    const listing = loaded.get(dirRelPath);
    // Absent means "expanded but the fetch hasn't landed yet" — same visual as
    // an explicit loading status, so the row list never shows an empty folder
    // that is actually still loading.
    if (!listing || listing.status === "loading") {
      rows.push({ kind: "loading", parentPath: dirRelPath, depth });
      return;
    }
    if (listing.status === "error") {
      rows.push({
        kind: "error",
        parentPath: dirRelPath,
        message: listing.error,
        depth,
      });
      return;
    }

    for (const node of listing.children) {
      rows.push({ kind: "node", node, depth });
      if (node.kind === "folder" && expanded.has(node.relPath)) {
        emitDir(node.relPath, node.path, depth + 1);
      }
    }
    if (listing.truncated != null && listing.truncated > 0) {
      rows.push({ kind: "more", parentPath: dirRelPath, count: listing.truncated, depth });
    }
  };

  emitDir("", rootPath, 0);
  return rows;
}
