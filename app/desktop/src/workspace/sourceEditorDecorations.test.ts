import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import {
  collectMarkdownPreview,
  safeCollectMarkdownPreview,
  type PreviewDecoration,
} from "./sourceEditorDecorations";

function state(doc: string, ranges: Array<{ anchor: number; head?: number }> = [{ anchor: doc.length }]) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head ?? anchor)),
    ),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    ],
  });
}

const classes = (items: PreviewDecoration[]) => items.map((item) => item.className);

describe("sourceEditorDecorations", () => {
  it("plans live preview for the supported standard Markdown constructs", () => {
    const doc = [
      "# Heading",
      "",
      "*em* **strong** ~~strike~~ `code`",
      "- [ ] task",
      "1. ordered",
      "> quote",
      "---",
      "```ts",
      "code",
      "```",
      "[text](https://example.com) ![alt](https://example.com/a.png)",
      "| a | b |",
      "| - | - |",
      "| c | d |",
    ].join("\n");

    const preview = collectMarkdownPreview(state(doc));
    const found = new Set(classes(preview));

    expect(found).toEqual(
      expect.objectContaining(
        new Set([
          "nn-lp-heading-1",
          "nn-lp-emphasis",
          "nn-lp-strong",
          "nn-lp-strikethrough",
          "nn-lp-inline-code",
          "nn-lp-list-marker",
          "nn-lp-task",
          "nn-lp-blockquote",
          "nn-lp-thematic-break",
          "nn-lp-fenced-code",
          "nn-lp-link",
          "nn-lp-image",
          "nn-lp-table",
        ]),
      ),
    );
    expect(preview.some((item) => item.kind === "widget" && item.className === "nn-lp-image")).toBe(true);
  });

  it("applies heading typography to complete Setext headings", () => {
    const doc = "Primary\n=======\nSecondary\n---------";
    const found = new Set(classes(collectMarkdownPreview(state(doc))));
    expect(found).toContain("nn-lp-heading-1");
    expect(found).toContain("nn-lp-heading-2");
  });

  it("replaces syntax markers only when their complete construct is outside every selection", () => {
    const doc = "# Heading\n\n*em* and **strong**";
    const headingCaret = state(doc, [{ anchor: 3 }, { anchor: doc.indexOf("strong") + 2 }]);
    const preview = collectMarkdownPreview(headingCaret);

    const headingMarker = preview.find((item) => item.from === 0 && item.to === 1);
    const emphasisMarker = preview.find(
      (item) => item.from === doc.indexOf("*em*") && item.to === doc.indexOf("*em*") + 1,
    );
    const strongMarker = preview.find(
      (item) => item.from === doc.indexOf("**strong**") && item.to === doc.indexOf("**strong**") + 2,
    );

    expect(headingMarker?.kind).toBe("mark");
    expect(emphasisMarker?.kind).toBe("replace");
    expect(strongMarker?.kind).toBe("mark");
  });

  it("hides an inactive Markdown destination and reveals it for source editing", () => {
    const doc = "[Azure Account](Azure%20Account.md)";
    const inactive = collectMarkdownPreview(state(doc));
    const urlFrom = doc.indexOf("Azure%20");
    expect(inactive).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: doc.length - 1,
      kind: "replace",
    }));

    const active = collectMarkdownPreview(state(doc, [{ anchor: urlFrom + 2 }]));
    expect(active).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: doc.length - 1,
      kind: "mark",
      className: "nn-lp-marker-active",
    }));
  });

  it("renders inactive task markers as accessible, source-backed checkbox widgets", () => {
    const doc = "- [ ] open\n- [x] done";
    const preview = collectMarkdownPreview(state(doc));
    const tasks = preview.filter((item) => item.className.startsWith("nn-lp-task"));

    expect(tasks).toEqual([
      expect.objectContaining({ kind: "widget", checked: false, label: "Mark task complete" }),
      expect.objectContaining({ kind: "widget", checked: true, label: "Mark task incomplete" }),
    ]);
  });

  it("keeps malformed and partially typed constructs literal", () => {
    const doc = "#unterminated *em and [link and ```";
    const preview = collectMarkdownPreview(state(doc));

    expect(preview.every((item) => item.kind !== "replace" && item.kind !== "widget")).toBe(true);
  });

  it("builds only inside the requested visible range", () => {
    const doc = `${"plain\n".repeat(200)}# Visible\n${"tail\n".repeat(200)}`;
    const from = doc.indexOf("# Visible");
    const preview = collectMarkdownPreview(state(doc), [{ from, to: from + 10 }]);

    expect(preview.length).toBeGreaterThan(0);
    expect(preview.every((item) => item.from >= from && item.to <= from + 10)).toBe(true);
  });

  it("does not copy the complete document to decorate tasks and images", () => {
    const editor = state("- [ ] task ![alt](local.png)");
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    const preview = collectMarkdownPreview(editor, [{ from: 0, to: editor.doc.length }]);
    expect(classes(preview)).toEqual(expect.arrayContaining(["nn-lp-task", "nn-lp-image"]));
  });

  it("turns decoration failures into undecorated editable source", () => {
    const result = safeCollectMarkdownPreview(state("# source"), undefined, () => {
      throw new Error("parser failed");
    });

    expect(result.decorations).toEqual([]);
    expect(result.error).toBe("Live preview is temporarily unavailable. Your source is unchanged.");
  });
});
