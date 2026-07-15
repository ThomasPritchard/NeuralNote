// Filename-filter support for the LAZY file tree (issue #40). The sidebar filter
// is a DISPLAY filter over what is currently loaded — per spec §Coherence it
// matches only LOADED nodes and is NOT vault search (⌘K stays full and still
// reaches files behind an unexpanded folder or an "N more…" row).
//
// `flattenTree` consumes the store's per-directory `loaded` map. To filter, we:
//   1. reconstruct the nested tree of the loaded portion (`loadedToTree`),
//   2. reuse the tested `filterTree` to keep matches + their ancestor folders,
//   3. re-emit that filtered tree as a `loaded` map + an all-folders-expanded set
//      (`treeToLoaded`), so the same frozen `flattenTree` renders it with every
//      surviving folder open — the lazy equivalent of the old "force everything
//      open while filtering" behaviour.
// Loading/error/truncation rows are intentionally dropped while filtering: a
// folder still in flight has no loaded children to match, so there is nothing to
// show for it under an active filter.

import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";
import { filterTree } from "./filterTree";

/** Reconstruct the nested tree of the LOADED portion of the vault from the
 *  per-directory `loaded` map. A folder that is loaded gets its children (and,
 *  recursively, their loaded subtrees); an unloaded or in-flight folder gets
 *  `children: []` — it can hold no filter match, so this only affects filtering. */
export function loadedToTree(
  loaded: ReadonlyMap<string, LoadedDir>,
  relPath = "",
): TreeNode[] {
  const listing = loaded.get(relPath);
  if (!listing || listing.status !== "loaded") return [];
  return listing.children.map((node) =>
    node.kind === "folder"
      ? { ...node, children: loadedToTree(loaded, node.relPath) }
      : node,
  );
}

/** Re-emit a nested tree as a `loaded` map (keyed by relPath, `""` = root) plus
 *  the set of every folder relPath in it — so callers can render it fully
 *  expanded through `flattenTree`. Folder nodes are stored with `children: null`
 *  (the map, not the node, carries the children `flattenTree` reads). */
export function treeToLoaded(tree: TreeNode[]): {
  map: Map<string, LoadedDir>;
  expanded: Set<string>;
} {
  const map = new Map<string, LoadedDir>();
  const expanded = new Set<string>();
  const walk = (nodes: TreeNode[], relPath: string): void => {
    map.set(relPath, {
      status: "loaded",
      children: nodes.map((node) =>
        node.kind === "folder" ? { ...node, children: null } : node,
      ),
      truncated: null,
    });
    for (const node of nodes) {
      if (node.kind === "folder") {
        expanded.add(node.relPath);
        walk(node.children ?? [], node.relPath);
      }
    }
  };
  walk(tree, "");
  return { map, expanded };
}

/** The `loaded` map + expanded set for an active filename filter: the loaded
 *  tree filtered to files matching `query` plus the folders needed to reach
 *  them, with every surviving folder expanded. */
export function filterLoadedTree(
  loaded: ReadonlyMap<string, LoadedDir>,
  query: string,
): { map: Map<string, LoadedDir>; expanded: Set<string> } {
  return treeToLoaded(filterTree(loadedToTree(loaded), query));
}
