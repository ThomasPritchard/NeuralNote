// Unit spec for the sidebar filename filter — a pure tree → tree transform.
// The FileTree component owns the input/auto-expand UX around it; this pins
// the filtering semantics: files match by name substring (case-insensitive),
// folders survive on own-name match OR a surviving descendant, and a matching
// folder keeps its FILTERED children, never all of them.

import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/types";
import { filterTree } from "./filterTree";

const file = (name: string, relPath = name): TreeNode => ({
  kind: "file",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const folder = (name: string, children: TreeNode[], relPath = name): TreeNode => ({
  kind: "folder",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children,
});

describe("filterTree — empty query", () => {
  it("returns the input array unchanged (same reference) for an empty query", () => {
    const nodes = [file("a.md")];
    expect(filterTree(nodes, "")).toBe(nodes);
  });

  it("returns the input array unchanged for a whitespace-only query", () => {
    const nodes = [file("a.md")];
    expect(filterTree(nodes, "   ")).toBe(nodes);
  });
});

describe("filterTree — files", () => {
  it("keeps a file iff its name contains the query, case-insensitively", () => {
    const nodes = [file("Alpha.md"), file("beta.md")];
    expect(filterTree(nodes, "ALPHA").map((n) => n.name)).toEqual(["Alpha.md"]);
  });

  it("matches on substring, not prefix", () => {
    const nodes = [file("Alpha.md"), file("beta.md")];
    expect(filterTree(nodes, "eta").map((n) => n.name)).toEqual(["beta.md"]);
  });

  it("trims the query before matching", () => {
    const nodes = [file("beta.md")];
    expect(filterTree(nodes, "  beta  ").map((n) => n.name)).toEqual(["beta.md"]);
  });
});

describe("filterTree — folders", () => {
  it("keeps ancestor folders of a match and drops branches with none", () => {
    const nodes = [
      folder("A", [folder("B", [file("deep.md", "A/B/deep.md")], "A/B")]),
      folder("C", [file("other.md", "C/other.md")]),
    ];

    const result = filterTree(nodes, "deep");

    expect(result.map((n) => n.name)).toEqual(["A"]);
    const b = result[0].children!;
    expect(b.map((n) => n.name)).toEqual(["B"]);
    expect(b[0].children!.map((n) => n.name)).toEqual(["deep.md"]);
  });

  it("keeps a folder whose own name matches, with filtered children — not all", () => {
    const nodes = [
      folder("Projects", [
        file("alpha.md", "Projects/alpha.md"),
        file("project-plan.md", "Projects/project-plan.md"),
      ]),
    ];

    const result = filterTree(nodes, "project");

    expect(result.map((n) => n.name)).toEqual(["Projects"]);
    expect(result[0].children!.map((n) => n.name)).toEqual(["project-plan.md"]);
  });

  it("keeps a matching folder even when no children match (empty children)", () => {
    const nodes = [folder("Archive", [file("a.md", "Archive/a.md")])];

    const result = filterTree(nodes, "archive");

    expect(result.map((n) => n.name)).toEqual(["Archive"]);
    expect(result[0].children).toEqual([]);
  });

  it("tolerates a folder with null children", () => {
    const nodes: TreeNode[] = [{ ...folder("Empty", []), children: null }];
    expect(filterTree(nodes, "empty").map((n) => n.name)).toEqual(["Empty"]);
    expect(filterTree(nodes, "nope")).toEqual([]);
  });
});

describe("filterTree — purity", () => {
  it("does not mutate the input tree", () => {
    const kept = file("keep.md", "Notes/keep.md");
    const dropped = file("other.md", "Notes/other.md");
    const notes = folder("Notes", [kept, dropped]);
    const nodes = [notes];

    filterTree(nodes, "keep");

    expect(notes.children).toHaveLength(2);
    expect(notes.children![0]).toBe(kept);
    expect(notes.children![1]).toBe(dropped);
  });
});
