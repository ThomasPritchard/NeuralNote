import { describe, expect, it } from "vitest";

import { sourceTitleInsertion, sourceTitleMode } from "./sourceDocumentTitle";

describe("sourceDocumentTitle", () => {
  it.each([
    ["# Existing\nbody", "source"],
    ["# Different\nbody", "source"],
    ["\uFEFF#   My Note  \r\nbody", "source"],
    ["---\r\ntags: [one]\r\n---\r\n\r\n# My Note\r\nbody", "source"],
    ["---\ntags: [one]\n...\n# My Note\nbody", "source"],
    ["---\rtitle: x\r---\r# My Note\rbody", "source"],
    ["   # Indented title\nbody", "source"],
    ["Setext title\n============\nbody", "source"],
    ["body", "placeholder"],
    ["paragraph\n# Later", "placeholder"],
    ["## Section\nbody", "placeholder"],
    ["\uFEFFbody", "placeholder"],
    ["---\ntags: [one]\n---\nbody", "placeholder"],
    ["---\ntitle: [\nbody", "external"],
  ] as const)("selects the %s-backed editable-title mode", (source, mode) => {
    expect(sourceTitleMode(source)).toBe(mode);
  });

  it("keeps a closed but parser-invalid frontmatter title external", () => {
    expect(sourceTitleMode("---\ntitle: [\n---\nbody", { frontmatterError: true })).toBe("external");
  });

  it("inserts a source H1 after BOM/frontmatter without rewriting existing bytes", () => {
    expect(sourceTitleInsertion("\uFEFFbody", "Azure Hierarchy")).toEqual({
      from: 1,
      insert: "# Azure Hierarchy\n\n",
      caret: 18,
    });
    const frontmatter = "---\r\ntags: [azure]\r\n---\r\nbody";
    expect(sourceTitleInsertion(frontmatter, "Azure Hierarchy")).toEqual({
      from: 25,
      insert: "# Azure Hierarchy\n\n",
      caret: 42,
    });
  });

  it("separates the inserted H1 from body text beyond the bounded scan", () => {
    const prefix = `---\n${"x".repeat(65_527)}\n---\n`;
    expect(prefix).toHaveLength(65_536);
    expect(sourceTitleInsertion(prefix, "Boundary", { documentLength: prefix.length + 4 })).toEqual({
      from: 65_536,
      insert: "# Boundary\n\n",
      caret: 65_546,
    });
  });

  it("separates an H1 from a frontmatter closing delimiter at end-of-file", () => {
    const source = "---\ntitle: Azure\n---";
    expect(sourceTitleInsertion(source, "Azure Hierarchy")).toEqual({
      from: source.length,
      insert: "\n# Azure Hierarchy",
      caret: source.length + 18,
    });
  });
});
