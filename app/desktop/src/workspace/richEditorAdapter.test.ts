import { describe, expect, it } from "vitest";
import {
  buildRichEditPatch,
  preflightMountedRichDocument,
  preflightRichDocument,
  richLinkIsSafe,
  type MarkdownEditorBridge,
  type RichSourceDocument,
} from "./richEditorAdapter";

function source(
  body: string,
  blocks: RichSourceDocument["blocks"],
): RichSourceDocument {
  return { revision: "rev-1", body, blocks };
}

function exactBridge(transform: (value: string) => string = (value) => value): MarkdownEditorBridge {
  let markdown = "";
  return {
    setMarkdown(value) {
      markdown = transform(value);
    },
    getMarkdown() {
      return markdown;
    },
  };
}

describe("rich editor compatibility preflight", () => {
  it("round-trips each source block and restores one unrepresentable terminal LF", () => {
    const document = source("Alpha\nBeta\n", [
      { id: "a", leadingSeparator: "", markdown: "Alpha\n", trailingSeparator: "" },
      { id: "b", leadingSeparator: "", markdown: "Beta\n", trailingSeparator: "" },
    ]);

    expect(preflightRichDocument(exactBridge(), document)).toEqual({
      ok: true,
      editorMarkdown: "Alpha\nBeta",
      terminalLf: true,
    });
  });

  it("keeps exact inter-block separators outside the package round trip", () => {
    const document = source("Alpha\n\nBeta", [
      { id: "a", leadingSeparator: "", markdown: "Alpha", trailingSeparator: "\n\n" },
      { id: "b", leadingSeparator: "", markdown: "Beta", trailingSeparator: "" },
    ]);

    expect(preflightRichDocument(exactBridge(), document)).toEqual({
      ok: true,
      editorMarkdown: "Alpha\n\nBeta",
      terminalLf: false,
    });
  });

  it("fails closed when the package normalizes any candidate block", () => {
    const document = source("Escaped \\[brackets\\].", [
      { id: "a", leadingSeparator: "", markdown: "Escaped \\[brackets\\].", trailingSeparator: "" },
    ]);

    expect(
      preflightRichDocument(
        exactBridge((value) => value.replace("\\]", "]")),
        document,
      ),
    ).toEqual({
      ok: false,
      message: "This note uses Markdown that the rich editor would rewrite. It is open as raw Markdown instead.",
    });
  });

  it("fails closed when block text and preserved separators do not reconstruct the body", () => {
    const document = source("Alpha\n\nBeta", [
      { id: "a", leadingSeparator: "", markdown: "Alpha", trailingSeparator: "\n" },
      { id: "b", leadingSeparator: "", markdown: "Beta", trailingSeparator: "" },
    ]);

    expect(preflightRichDocument(exactBridge(), document)).toEqual({
      ok: false,
      message: "This note could not be mapped to stable source ranges. It is open as raw Markdown instead.",
    });
  });

  it("round-trips a 5,000-block document in one mounted-editor pass", async () => {
    const blocks = Array.from({ length: 5_000 }, (_, index) => ({
      id: `block-${index}`,
      leadingSeparator: "",
      markdown: `Paragraph ${index}`,
      trailingSeparator: index === 4_999 ? "" : "\n\n",
    }));
    const document = source(blocks.map((block) => `${block.markdown}${block.trailingSeparator}`).join(""), blocks);
    let setCalls = 0;
    const bridge = exactBridge((value) => {
      setCalls += 1;
      return value;
    });

    await expect(preflightMountedRichDocument(bridge, document)).resolves.toMatchObject({ ok: true });
    expect(setCalls).toBe(1);
  });
});

describe("rich source-range patch mapping", () => {
  const document = source("Alpha\n\nBeta\n\nGamma", [
    { id: "a", leadingSeparator: "", markdown: "Alpha", trailingSeparator: "\n\n" },
    { id: "b", leadingSeparator: "", markdown: "Beta", trailingSeparator: "\n\n" },
    { id: "c", leadingSeparator: "", markdown: "Gamma", trailingSeparator: "" },
  ]);

  it("returns no patch when the editor has not changed source", () => {
    expect(buildRichEditPatch(document, document.body)).toBeNull();
  });

  it("replaces the smallest contiguous original block range", () => {
    expect(buildRichEditPatch(document, "Alpha\n\nBeta changed\n\nGamma")).toEqual({
      expectedRevision: "rev-1",
      changedBlockIds: ["b"],
      replacementMarkdown: "Beta changed\n\n",
    });
  });

  it("binds a pure insertion between blocks to its left neighbour", () => {
    expect(buildRichEditPatch(document, "Alpha\n\nInserted\n\nBeta\n\nGamma")).toEqual({
      expectedRevision: "rev-1",
      changedBlockIds: ["a"],
      replacementMarkdown: "Alpha\n\nInserted\n\n",
    });
  });

  it("maps deletion and movement to one contiguous guarded range", () => {
    expect(buildRichEditPatch(document, "Gamma\n\nAlpha")).toEqual({
      expectedRevision: "rev-1",
      changedBlockIds: ["a", "b", "c"],
      replacementMarkdown: "Gamma\n\nAlpha",
    });
  });

  it("maps edits to an empty note without inventing a block id", () => {
    expect(buildRichEditPatch(source("", []), "First paragraph")).toEqual({
      expectedRevision: "rev-1",
      changedBlockIds: [],
      replacementMarkdown: "First paragraph",
    });
  });

  it("blocks unsafe exported URLs before they reach native persistence", () => {
    expect(() =>
      buildRichEditPatch(document, "[Run](javascript:alert(1))"),
    ).toThrow("unsafe link");
  });
});

describe("rich link validation", () => {
  it.each([
    "https://example.com/path?q=1",
    "http://example.com",
    "mailto:tom@example.com",
    "Areas/ADHD/Study%20Strategies.md",
  ])("accepts the supported destination %s", (url) => {
    expect(richLinkIsSafe(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java%73cript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:invalid",
    "mailto:tom%40example.com",
    "//evil.example/path",
    "/absolute/path.md",
    "../../../outside.md",
    "../Sibling.md",
    "Areas/%2e%2e/%2e%2e/outside.md",
    "Areas/%2foutside.md",
    "javascript&colon;alert(1)",
    "Areas&sol;..&sol;secret.md",
    "..?x",
    "..#x",
  ])("rejects the unsafe destination %s", (url) => {
    expect(richLinkIsSafe(url)).toBe(false);
  });
});
