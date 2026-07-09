// flattenTree: the pure "which rows exist, in what order, at what depth" seam
// behind the virtualized FileTree (PA-005). These tests pin the ordering
// contract the old recursive render established, so the windowed body renders
// byte-identical row sequences.

import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/types";
import { flattenTree, rowKey, type FlatRow } from "./flattenTree";

const file = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const folder = (relPath: string, children: TreeNode[]): TreeNode => ({
  kind: "folder",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children,
});

const NONE: ReadonlySet<string> = new Set();

/** Compact fingerprint: "relPath@depth" for nodes, "+note@depth" for creates. */
const shape = (rows: FlatRow[]) =>
  rows.map((r) =>
    r.kind === "node" ? `${r.node.relPath}@${r.depth}` : `+${r.createKind}@${r.depth}`,
  );

describe("flattenTree", () => {
  const tree = [
    folder("A", [file("A/a.md"), folder("A/B", [file("A/B/b.md")])]),
    file("top.md"),
  ];

  it("flattens open folders depth-first with correct depths", () => {
    expect(shape(flattenTree(tree, NONE, null, "/v"))).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "A/B/b.md@2",
      "top.md@0",
    ]);
  });

  it("hides a collapsed folder's descendants but keeps its row", () => {
    expect(shape(flattenTree(tree, new Set(["A"]), null, "/v"))).toEqual([
      "A@0",
      "top.md@0",
    ]);
    // A nested collapse only prunes that subtree.
    expect(shape(flattenTree(tree, new Set(["A/B"]), null, "/v"))).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "top.md@0",
    ]);
  });

  it("inserts a root create row before everything else", () => {
    const rows = flattenTree(tree, NONE, { parentPath: "/v", kind: "note" }, "/v");
    expect(shape(rows)[0]).toBe("+note@0");
    expect(rows).toHaveLength(6);
  });

  it("inserts a folder's create row right after the folder, one level deeper", () => {
    const rows = flattenTree(tree, NONE, { parentPath: "/v/A/B", kind: "folder" }, "/v");
    expect(shape(rows)).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "+folder@2",
      "A/B/b.md@2",
      "top.md@0",
    ]);
  });

  it("forces a collapsed folder open while creating inside it", () => {
    const rows = flattenTree(
      tree,
      new Set(["A", "A/B"]),
      { parentPath: "/v/A/B", kind: "note" },
      "/v",
    );
    // A stays collapsed (not the create target)… but wait — A/B lives inside A.
    // The create target itself opens; its collapsed ANCESTOR still hides it,
    // matching the old render where a hidden folder's create row never showed.
    expect(shape(rows)).toEqual(["A@0", "top.md@0"]);

    const openAncestor = flattenTree(
      tree,
      new Set(["A/B"]),
      { parentPath: "/v/A/B", kind: "note" },
      "/v",
    );
    expect(shape(openAncestor)).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "+note@2",
      "A/B/b.md@2",
      "top.md@0",
    ]);
  });

  it("gives every row a unique, stable key; create keys follow their folder", () => {
    const rows = flattenTree(tree, NONE, { parentPath: "/v/A", kind: "note" }, "/v");
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);

    const atRoot = flattenTree(tree, NONE, { parentPath: "/v", kind: "note" }, "/v");
    const createKey = (rs: FlatRow[]) => rs.map(rowKey).find((k) => k.startsWith("create:"));
    // Moving the create affordance to another folder changes its key (fresh input).
    expect(createKey(rows)).not.toBe(createKey(atRoot));
  });
});
