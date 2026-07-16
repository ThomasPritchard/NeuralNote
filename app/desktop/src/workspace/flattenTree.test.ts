// flattenTree: the pure "which rows exist, in what order, at what depth" seam
// behind the virtualized FileTree (PA-005), now driven by the LAZY store model
// (issue #40) — a `loaded` map of per-directory listings plus an `expanded` set,
// rather than one eager recursive tree. These tests pin the ordering contract
// (folders depth-first, create rows follow their folder) and the lazy-only rows:
// a loading row for an in-flight directory, an error row for a failed one, and a
// "N more…" row for a truncated one.

import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";
import { flattenTree, rowKey, type FlatRow } from "./flattenTree";

const file = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

// In the lazy model a folder NODE carries children: null (unloaded); its actual
// children live in the `loaded` map keyed by relPath.
const folder = (relPath: string): TreeNode => ({
  kind: "folder",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children: null,
});

const dir = (children: TreeNode[], truncated: number | null = null): LoadedDir => ({
  status: "loaded",
  children,
  truncated,
});

const NONE: ReadonlySet<string> = new Set();

/** Compact fingerprint per row so the ordering contract reads at a glance. */
const createKey = (rows: FlatRow[]): string | undefined =>
  rows.map(rowKey).find((k) => k.startsWith("create:"));

const shape = (rows: FlatRow[]): string[] =>
  rows.map((r) => {
    switch (r.kind) {
      case "node":
        return `${r.node.relPath}@${r.depth}`;
      case "create":
        return `+${r.createKind}@${r.depth}`;
      case "loading":
        return `loading:${r.parentPath}@${r.depth}`;
      case "error":
        return `error:${r.parentPath}@${r.depth}`;
      case "more":
        return `more:${r.parentPath}:${r.count}@${r.depth}`;
    }
  });

/** A fully-loaded three-level vault: root → A → B, plus a top-level file. */
const fullyLoaded = (): Map<string, LoadedDir> =>
  new Map<string, LoadedDir>([
    ["", dir([folder("A"), file("top.md")])],
    ["A", dir([file("A/a.md"), folder("A/B")])],
    ["A/B", dir([file("A/B/b.md")])],
  ]);

describe("flattenTree — ordering", () => {
  it("flattens expanded folders depth-first with correct depths", () => {
    const rows = flattenTree(fullyLoaded(), new Set(["A", "A/B"]), null, "/v");
    expect(shape(rows)).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "A/B/b.md@2",
      "top.md@0",
    ]);
  });

  it("does not descend into a collapsed folder but keeps its row", () => {
    // A collapsed → its whole subtree is pruned even though it is loaded.
    expect(shape(flattenTree(fullyLoaded(), NONE, null, "/v"))).toEqual([
      "A@0",
      "top.md@0",
    ]);
    // A open, A/B collapsed → only A/B's subtree is pruned.
    expect(shape(flattenTree(fullyLoaded(), new Set(["A"]), null, "/v"))).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "top.md@0",
    ]);
  });

  it("re-reveals cached children on re-expand without a loading row", () => {
    // The SAME loaded map, collapsed then re-expanded, yields the children
    // straight back — proving the flatten never needs a re-fetch to redraw a
    // folder whose listing is still cached (collapse→re-expand stays instant).
    const loaded = fullyLoaded();
    expect(shape(flattenTree(loaded, NONE, null, "/v"))).toEqual([
      "A@0",
      "top.md@0",
    ]);
    const reExpanded = shape(flattenTree(loaded, new Set(["A"]), null, "/v"));
    expect(reExpanded).toEqual(["A@0", "A/a.md@1", "A/B@1", "top.md@0"]);
    expect(reExpanded).not.toContain("loading:A@1");
  });
});

describe("flattenTree — lazy-only rows", () => {
  it("emits a loading row under an expanded folder whose listing is in flight", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), file("top.md")])],
      ["A", { status: "loading" }],
    ]);
    expect(shape(flattenTree(loaded, new Set(["A"]), null, "/v"))).toEqual([
      "A@0",
      "loading:A@1",
      "top.md@0",
    ]);
  });

  it("treats an expanded-but-unloaded folder as loading (fetch presumed pending)", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), file("top.md")])],
    ]);
    expect(shape(flattenTree(loaded, new Set(["A"]), null, "/v"))).toEqual([
      "A@0",
      "loading:A@1",
      "top.md@0",
    ]);
  });

  it("emits an error row carrying the message for a failed listing", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), file("top.md")])],
      [
        "A",
        { status: "error", error: "Permission denied" },
      ],
    ]);
    const rows = flattenTree(loaded, new Set(["A"]), null, "/v");
    expect(shape(rows)).toEqual(["A@0", "error:A@1", "top.md@0"]);
    const errorRow = rows.find((r) => r.kind === "error");
    expect(errorRow).toMatchObject({ message: "Permission denied", depth: 1 });
  });

  it("emits a 'N more…' row after a truncated directory's children", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), file("top.md")])],
      ["A", dir([file("A/a.md")], 5)],
    ]);
    const rows = flattenTree(loaded, new Set(["A"]), null, "/v");
    expect(shape(rows)).toEqual([
      "A@0",
      "A/a.md@1",
      "more:A:5@1",
      "top.md@0",
    ]);
  });

  it("emits a root-level 'N more…' row when the root itself is truncated", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([file("top.md")], 12)],
    ]);
    expect(shape(flattenTree(loaded, NONE, null, "/v"))).toEqual([
      "top.md@0",
      "more::12@0",
    ]);
  });

  it("omits the more row when truncated is null or zero", () => {
    const zero = new Map<string, LoadedDir>([["", dir([file("top.md")], 0)]]);
    expect(shape(flattenTree(zero, NONE, null, "/v"))).toEqual(["top.md@0"]);
  });

  it("renders nothing but a root create row while the root itself is still loading", () => {
    const loaded = new Map<string, LoadedDir>();
    expect(shape(flattenTree(loaded, NONE, null, "/v"))).toEqual(["loading:@0"]);
  });
});

describe("flattenTree — create rows", () => {
  it("inserts a root create row before everything else", () => {
    const rows = flattenTree(
      fullyLoaded(),
      new Set(["A", "A/B"]),
      { parentPath: "/v", kind: "note" },
      "/v",
    );
    expect(shape(rows)[0]).toBe("+note@0");
  });

  it("inserts a folder's create row right after the folder, one level deeper", () => {
    const rows = flattenTree(
      fullyLoaded(),
      new Set(["A", "A/B"]),
      { parentPath: "/v/A/B", kind: "folder" },
      "/v",
    );
    expect(shape(rows)).toEqual([
      "A@0",
      "A/a.md@1",
      "A/B@1",
      "+folder@2",
      "A/B/b.md@2",
      "top.md@0",
    ]);
  });

  it("shows a create row inside an expanded folder even while its listing loads", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A")])],
      ["A", { status: "loading" }],
    ]);
    const rows = flattenTree(
      loaded,
      new Set(["A"]),
      { parentPath: "/v/A", kind: "note" },
      "/v",
    );
    expect(shape(rows)).toEqual(["A@0", "+note@1", "loading:A@1"]);
  });
});

describe("flattenTree — row keys", () => {
  it("gives every row a unique, stable key across all variants", () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folder("A"), folder("Bad"), file("top.md")], 3)],
      ["A", dir([file("A/a.md")], 2)],
      [
        "Bad",
        { status: "error", error: "boom" },
      ],
    ]);
    const rows = flattenTree(
      loaded,
      new Set(["A", "Bad"]),
      { parentPath: "/v/A", kind: "note" },
      "/v",
    );
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys the create row by its parent so moving it remounts the input", () => {
    const rootCreate = flattenTree(
      fullyLoaded(),
      new Set(["A"]),
      { parentPath: "/v", kind: "note" },
      "/v",
    );
    const folderCreate = flattenTree(
      fullyLoaded(),
      new Set(["A"]),
      { parentPath: "/v/A", kind: "note" },
      "/v",
    );
    expect(createKey(rootCreate)).not.toBe(createKey(folderCreate));
  });
});
