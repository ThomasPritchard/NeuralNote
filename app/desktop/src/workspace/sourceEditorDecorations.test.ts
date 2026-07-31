import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import {
  collectMarkdownPreview,
  safeCollectMarkdownPreview,
  sourceEditorDecorations,
  tableAtomicRanges,
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

  it("keeps heading markers visible while typing at the end of the active line", () => {
    const doc = "##";
    const preview = collectMarkdownPreview(state(doc, [{ anchor: doc.length }]));

    expect(preview).toContainEqual({
      from: 0,
      to: 2,
      kind: "mark",
      className: "nn-lp-marker-active",
    });
  });

  it("plans a semantic table widget while inactive and reveals exact source while active", () => {
    const doc = [
      "| Start date | Commitment |",
      "| --- | --- |",
      "| 2026-04-03 | DJ gig |",
    ].join("\n");

    expect(collectMarkdownPreview(state(doc))).toContainEqual(expect.objectContaining({
      from: 0,
      to: doc.length,
      kind: "widget",
      className: "nn-lp-table",
      table: {
        headers: ["Start date", "Commitment"],
        rows: [["2026-04-03", "DJ gig"]],
      },
    }));

    expect(collectMarkdownPreview(state(doc, [{ anchor: doc.indexOf("DJ gig") + 2 }]))).toContainEqual(
      expect.objectContaining({
        from: 0,
        to: doc.length,
        kind: "mark",
        className: "nn-lp-table-source",
      }),
    );
  });

  it("renders every table cell through the one cell-paint projection", () => {
    const doc = [
      "| Note |",
      "| --- |",
      "| **DJ gig** at the Bell |",
      "| [[Roadmap]] |",
      "| `soundcheck` |",
    ].join("\n");

    const table = collectMarkdownPreview(state(doc)).find((item) => item.table)?.table;

    // The widget and the drawn cell must show the same characters. A wikilink is
    // the case the widget used to get wrong on its own: it has no Markdown node,
    // so a second list of hidden node names never saw it.
    expect(table?.rows).toEqual([["DJ gig at the Bell"], ["Roadmap"], ["soundcheck"]]);
  });

  it("does not project a table's cells while the caret is inside it", () => {
    const doc = ["| a | b |", "| - | - |", "| **c** | d |"].join("\n");
    const editor = state(doc, [{ anchor: doc.indexOf("**c**") + 2 }]);
    const sliceDoc = vi.spyOn(editor, "sliceDoc");

    const preview = collectMarkdownPreview(editor);

    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-table-source" }));
    // The rendered widget is discarded for an active table, so reading any of
    // its interior is pure cost on the keystroke path.
    expect(sliceDoc.mock.calls.filter(([from = 0, to = doc.length]) => from > 0 && to < doc.length))
      .toEqual([]);
  });

  it("limits table preview work to the requested visible range", () => {
    const first = "| First | Value |\n| --- | --- |\n| one | 1 |";
    const second = "| Second | Value |\n| --- | --- |\n| two | 2 |";
    const doc = `${first}\n\n${"plain\n".repeat(2_000)}${second}`;
    const editor = state(doc);
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    const preview = collectMarkdownPreview(editor, [{ from: 0, to: first.length }]);
    const tables = preview.filter((item) => item.table);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.table?.headers).toEqual(["First", "Value"]);
  });

  it("keeps an oversized table as editable source instead of building an unbounded widget", () => {
    const doc = [
      "| Key | Value |",
      "| --- | --- |",
      ...Array.from({ length: 250 }, (_, index) => `| ${index} | ${"x".repeat(160)} |`),
    ].join("\n");
    const preview = collectMarkdownPreview(state(doc), [{ from: 0, to: 100 }]);

    expect(preview.some((item) => item.table)).toBe(false);
    expect(preview).toContainEqual(expect.objectContaining({
      from: 0,
      to: doc.length,
      kind: "mark",
      className: "nn-lp-table-source",
    }));
  });

  it("hides an inactive Markdown destination and reveals it for source editing", () => {
    const doc = "before [Azure Account](Azure%20Account.md) after";
    const linkTo = doc.indexOf(")") + 1;
    const inactive = collectMarkdownPreview(state(doc, [{ anchor: 0 }]));
    const urlFrom = doc.indexOf("Azure%20");
    expect(inactive).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
      kind: "replace",
    }));

    const active = collectMarkdownPreview(state(doc, [{ anchor: urlFrom + 2 }]));
    expect(active).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
      kind: "mark",
      className: "nn-lp-marker-active",
    }));

    const adjacent = collectMarkdownPreview(state(doc, [{ anchor: linkTo }]));
    expect(adjacent).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
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

const FIRST_TABLE = ["| aa | bb |", "| --- | --- |", "| cc | dd |"].join("\n");
const SECOND_TABLE = ["| ee | ff |", "| --- | --- |", "| gg | hh |"].join("\n");
const TWO_TABLES = `${FIRST_TABLE}\n\nbetween\n\n${SECOND_TABLE}`;

function spans(set: DecorationSet): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    found.push({ from: cursor.from, to: cursor.to });
  }
  return found;
}

describe("tableAtomicRanges", () => {
  it("covers every table in the visible ranges, not only the one holding the caret", () => {
    // It used to derive its single table from `state.selection.main.head`, so a
    // second table on screen was left unprotected.
    const editor = state(TWO_TABLES, [{ anchor: 3 }]);
    const secondFrom = TWO_TABLES.indexOf(SECOND_TABLE);
    const found = spans(tableAtomicRanges(editor, [{ from: 0, to: TWO_TABLES.length }]));

    expect(found.some((span) => span.to <= FIRST_TABLE.length)).toBe(true);
    expect(found.some((span) => span.from >= secondFrom)).toBe(true);
    expect(found.every((span) => span.to > span.from)).toBe(true);
  });

  it("marks nothing for an oversized table, whose pipes are still painted", () => {
    // The visual path bails above the preview bounds and leaves the source
    // literal. Making visible pipes atomic would stop the caret on characters
    // the user can see.
    const oversized = [
      "| Key | Value |",
      "| --- | --- |",
      ...Array.from({ length: 200 }, (_, index) => `| k${index} | v${index} |`),
    ].join("\n");

    expect(spans(tableAtomicRanges(state(oversized), [{ from: 0, to: oversized.length }])))
      .toEqual([]);
  });

  it("marks nothing when no range is visible", () => {
    expect(spans(tableAtomicRanges(state(FIRST_TABLE), []))).toEqual([]);
  });
});

const withDecorations = (doc: string) => EditorState.create({
  doc,
  extensions: [
    markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    sourceEditorDecorations(() => {}),
  ],
});

describe("sourceEditorDecorations extensions", () => {
  it("registers the delimiter guard, so the editor component needs no wiring", () => {
    // The array returned here is already consumed at SourceNoteEditor.tsx:139.
    // Registering the filter alongside the decorations is what makes the
    // refusal reach the running editor without touching the component.
    const editor = withDecorations(FIRST_TABLE);
    const gap = { from: FIRST_TABLE.indexOf("aa") + 2, to: FIRST_TABLE.indexOf("bb") };
    const transaction = editor.update({ changes: { from: gap.from, to: gap.to } });

    expect(transaction.effects.some((effect) => effect.is(EditorView.announce))).toBe(true);
    expect(transaction.state.doc.toString()).toBe(FIRST_TABLE);
  });

  it("registers an atomic-ranges provider that reads the live viewport", () => {
    const editor = withDecorations(TWO_TABLES);
    const providers = editor.facet(EditorView.atomicRanges);
    expect(providers).toHaveLength(1);

    const viewport = { state: editor, visibleRanges: [{ from: 0, to: TWO_TABLES.length }] };
    expect(spans(providers[0]!(viewport as unknown as EditorView)).length).toBeGreaterThan(0);
  });
});
