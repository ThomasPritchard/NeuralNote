// Pure seam for the virtualized file tree (PA-005): flattens the VISIBLE
// portion of the vault tree — open folders only, plus the transient inline
// create row — into the ordered row list the FileTree body renders. The
// windowing layer (@tanstack/react-virtual) needs a flat `count`/index model;
// this module owns "which rows exist, in what order, at what depth" so that
// logic stays unit-testable without any DOM.
//
// Ordering contract (matches the old recursive render exactly):
//   - a create row at the vault root comes before everything else;
//   - each folder row is followed by its create row (when creating inside it),
//     then its children, depth-first;
//   - a folder being created into is forced open even when collapsed — the
//     same `creatingHere || !collapsed.has(relPath)` rule FolderRow uses for
//     its chevron, so the visual open state and the row list never disagree.

import type { TreeNode } from "../lib/types";
import type { CreateKind, CreatingState } from "./TreeRow";

export type FlatRow =
  | { kind: "node"; node: TreeNode; depth: number }
  | { kind: "create"; createKind: CreateKind; parentPath: string; depth: number };

/** Stable React key per row. The create row keys by its parent folder so
 *  moving the create affordance between folders remounts the input (fresh
 *  text), exactly as the old nested render did. */
export function rowKey(row: FlatRow): string {
  return row.kind === "node" ? `n:${row.node.relPath}` : `create:${row.parentPath}`;
}

export function flattenTree(
  tree: TreeNode[],
  collapsed: ReadonlySet<string>,
  creating: CreatingState | null,
  rootPath: string,
): FlatRow[] {
  const rows: FlatRow[] = [];
  if (creating?.parentPath === rootPath) {
    rows.push({
      kind: "create",
      createKind: creating.kind,
      parentPath: creating.parentPath,
      depth: 0,
    });
  }
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ kind: "node", node, depth });
      if (node.kind !== "folder") continue;
      const creatingHere = creating?.parentPath === node.path;
      if (!creatingHere && collapsed.has(node.relPath)) continue;
      if (creatingHere && creating) {
        rows.push({
          kind: "create",
          createKind: creating.kind,
          parentPath: creating.parentPath,
          depth: depth + 1,
        });
      }
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}
