import { describe, expect, it } from "vitest";
import type { TreeNode } from "../lib/types";
import {
  buildNoteIndex,
  resolveMarkdownLink,
  resolveWikilink,
  type NoteIndexEntry,
} from "./linkResolve";

const file = (relPath: string, ext = "md"): TreeNode => {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return {
    kind: "file",
    name,
    path: `/vault/${relPath}`,
    relPath,
    ext,
    children: null,
  };
};

const folder = (relPath: string, children: TreeNode[]): TreeNode => {
  const name = relPath === "" ? "Vault" : relPath.slice(relPath.lastIndexOf("/") + 1);
  return {
    kind: "folder",
    name,
    path: relPath === "" ? "/vault" : `/vault/${relPath}`,
    relPath,
    ext: null,
    children,
  };
};

const index: NoteIndexEntry[] = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Areas/Projects/Deep Work.md", stem: "deep work" },
  { relPath: "References/NeuralNote.md", stem: "neuralnote" },
  { relPath: "Beta/Topic.md", stem: "topic" },
  { relPath: "Alfa/Topic.md", stem: "topic" },
];

describe("buildNoteIndex", () => {
  it("flattens markdown notes from the loaded tree and lowercases file stems", () => {
    const root = folder("", [
      folder("Areas", [
        file("Areas/Deep Work.md"),
        file("Areas/Graph.MDX", "mdx"),
        file("Areas/Attachment.png", "png"),
      ]),
      file("Loose.markdown", "markdown"),
      file("Scratch.txt", "txt"),
    ]);

    expect(buildNoteIndex(root)).toEqual([
      { relPath: "Areas/Deep Work.md", stem: "deep work" },
      { relPath: "Areas/Graph.MDX", stem: "graph" },
      { relPath: "Loose.markdown", stem: "loose" },
    ]);
  });
});

describe("resolveWikilink", () => {
  it("strips aliases before resolving the target", () => {
    expect(resolveWikilink("Daily|shown title", index)).toBe("Daily.md");
  });

  it("strips headings and block anchors before resolving the target", () => {
    expect(resolveWikilink("Daily#Section", index)).toBe("Daily.md");
    expect(resolveWikilink("Daily#^block-id", index)).toBe("Daily.md");
  });

  it("resolves extensionless and .md filename targets", () => {
    expect(resolveWikilink("Daily", index)).toBe("Daily.md");
    expect(resolveWikilink("Daily.md", index)).toBe("Daily.md");
  });

  it("resolves nested path-qualified targets by segment-aligned suffix", () => {
    expect(resolveWikilink("Projects/Deep Work", index)).toBe(
      "Areas/Projects/Deep Work.md",
    );
  });

  it("returns null instead of throwing when a path-qualified target has no candidates", () => {
    let resolved: string | null | undefined;
    expect(() => {
      resolved = resolveWikilink("Projects/Missing", []);
    }).not.toThrow();
    expect(resolved).toBeNull();
  });

  it("matches filename stems case-insensitively", () => {
    expect(resolveWikilink("neuralnote", index)).toBe("References/NeuralNote.md");
  });

  it("uses the core tiebreak for ambiguous stems: shortest relPath, then lexicographic", () => {
    expect(resolveWikilink("Topic", index)).toBe("Alfa/Topic.md");
  });

  it("returns null for unknown and empty targets", () => {
    expect(resolveWikilink("Missing", index)).toBeNull();
    expect(resolveWikilink("   ", index)).toBeNull();
  });
});

describe("resolveMarkdownLink", () => {
  it("resolves relative markdown hrefs with and without the .md extension", () => {
    expect(resolveMarkdownLink("Daily.md", index)).toBe("Daily.md");
    expect(resolveMarkdownLink("Daily", index)).toBe("Daily.md");
  });

  it("drops heading fragments and decodes %20 like the core markdown-link normalizer", () => {
    expect(resolveMarkdownLink("Areas/Projects/Deep%20Work#Section", index)).toBe(
      "Areas/Projects/Deep Work.md",
    );
  });

  it("returns null for external, absolute, escaping, non-note and empty hrefs", () => {
    expect(resolveMarkdownLink("https://example.com/Daily.md", index)).toBeNull();
    expect(resolveMarkdownLink("/Daily.md", index)).toBeNull();
    expect(resolveMarkdownLink("../Daily.md", index)).toBeNull();
    expect(resolveMarkdownLink("image.png", index)).toBeNull();
    expect(resolveMarkdownLink("   ", index)).toBeNull();
  });
});
