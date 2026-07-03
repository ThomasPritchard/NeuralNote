// Sidebar filename filter: case-insensitive substring match over node names.
// A file survives iff its name matches; a folder survives iff its own name
// matches OR any descendant survives — and either way it keeps only its
// FILTERED children, so a matching folder never resurrects non-matching files.
// Pure: surviving folders are copies; the input tree is never mutated.

import type { TreeNode } from "../lib/types";

/**
 * Filter a vault tree down to files whose names contain `query`
 * (case-insensitive) plus the folders needed to reach them.
 *
 * @param nodes The tree to filter (not mutated).
 * @param query Filter text; trimmed before matching. Empty/whitespace-only
 *   returns `nodes` unchanged (same reference), so callers can cheaply detect
 *   "no filter active".
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return nodes;
  return filterNodes(nodes, needle);
}

function filterNodes(nodes: TreeNode[], needle: string): TreeNode[] {
  const kept: TreeNode[] = [];
  for (const node of nodes) {
    const nameMatches = node.name.toLowerCase().includes(needle);
    if (node.kind === "file") {
      if (nameMatches) kept.push(node);
      continue;
    }
    const children = filterNodes(node.children ?? [], needle);
    if (nameMatches || children.length > 0) kept.push({ ...node, children });
  }
  return kept;
}
