import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";
import { filterLoadedTree, loadedToTree, treeToLoaded } from "./loadedTree";

const file = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

// A folder NODE carries children: null in the lazy model; its children live in
// the loaded map keyed by relPath.
const folder = (relPath: string): TreeNode => ({
  kind: "folder",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children: null,
});

const dir = (children: TreeNode[]): LoadedDir => ({
  status: "loaded",
  children,
  truncated: null,
});

/** Narrow a loaded-map entry to its children — treeToLoaded/filterLoadedTree only
 *  ever emit `loaded` dirs, so a missing/other status yields `[]`. */
const childrenOf = (map: Map<string, LoadedDir>, key: string): TreeNode[] => {
  const d = map.get(key);
  return d?.status === "loaded" ? d.children : [];
};

/** root → A → B, plus a top-level file, all loaded. */
const fullyLoaded = (): Map<string, LoadedDir> =>
  new Map<string, LoadedDir>([
    ["", dir([folder("A"), file("top.md")])],
    ["A", dir([file("A/alpha.md"), folder("A/B")])],
    ["A/B", dir([file("A/B/beta.md")])],
  ]);

describe("loadedToTree", () => {
  it("reconstructs the nested tree from the loaded map", () => {
    const tree = loadedToTree(fullyLoaded());
    expect(tree.map((n) => n.relPath)).toEqual(["A", "top.md"]);
    const a = tree[0];
    expect(a.children?.map((n) => n.relPath)).toEqual(["A/alpha.md", "A/B"]);
    const b = a.children?.find((n) => n.relPath === "A/B");
    expect(b?.children?.map((n) => n.relPath)).toEqual(["A/B/beta.md"]);
  });

  it("gives an unloaded folder empty children (it can hold no match)", () => {
    const loaded = new Map<string, LoadedDir>([["", dir([folder("A")])]]);
    const tree = loadedToTree(loaded);
    expect(tree[0].children).toEqual([]);
  });

  it("returns [] when the root itself is not loaded", () => {
    expect(loadedToTree(new Map())).toEqual([]);
    expect(
      loadedToTree(new Map([["", { status: "loading" }]])),
    ).toEqual([]);
  });
});

describe("treeToLoaded", () => {
  it("round-trips a tree back into a map with every folder expanded", () => {
    const { map, expanded } = treeToLoaded(loadedToTree(fullyLoaded()));
    expect([...expanded].sort()).toEqual(["A", "A/B"]);
    expect(childrenOf(map, "").map((n) => n.relPath)).toEqual(["A", "top.md"]);
    expect(childrenOf(map, "A/B").map((n) => n.relPath)).toEqual(["A/B/beta.md"]);
    // Folder nodes are stored with children: null (the map carries the children).
    const aNode = childrenOf(map, "").find((n) => n.relPath === "A");
    expect(aNode?.children).toBeNull();
  });
});

describe("filterLoadedTree", () => {
  it("keeps matching files plus the folders needed to reach them, all expanded", () => {
    const { map, expanded } = filterLoadedTree(fullyLoaded(), "beta");
    // Only A → A/B → beta.md survives; alpha.md and top.md are gone.
    expect(childrenOf(map, "").map((n) => n.relPath)).toEqual(["A"]);
    expect(childrenOf(map, "A").map((n) => n.relPath)).toEqual(["A/B"]);
    expect(childrenOf(map, "A/B").map((n) => n.relPath)).toEqual(["A/B/beta.md"]);
    expect(expanded.has("A")).toBe(true);
    expect(expanded.has("A/B")).toBe(true);
  });

  it("matches only loaded nodes — an unloaded subtree contributes nothing", () => {
    // A is a folder but its children were never loaded (not in the map).
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), file("top.md")])],
    ]);
    const { map } = filterLoadedTree(loaded, "beta");
    // "beta" lives inside the unloaded A, so nothing matches.
    expect(childrenOf(map, "")).toEqual([]);
  });

  it("keeps a folder whose own name matches, with only its filtered children", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("Projects")])],
      ["Projects", dir([file("Projects/alpha.md"), file("Projects/plan.md")])],
    ]);
    const { map } = filterLoadedTree(loaded, "project");
    expect(childrenOf(map, "").map((n) => n.relPath)).toEqual(["Projects"]);
    // The folder matches by name but resurrects none of its non-matching files.
    expect(childrenOf(map, "Projects")).toEqual([]);
  });
});
