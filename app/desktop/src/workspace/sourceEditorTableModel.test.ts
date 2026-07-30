import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  tableAlignmentPads,
  tableColumnWidths,
  tableModelAt,
  type TableModel,
} from "./sourceEditorTableModel";

function state(doc: string) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    ],
  });
}

function slotText(doc: string, model: TableModel, row: number, column: number): string {
  const slot = model.rows[row]?.slots.find((candidate) => candidate.column === column);
  return slot ? doc.slice(slot.from, slot.to) : "<missing>";
}

const SIMPLE = [
  "| Start date | Commitment |",
  "| --- | :--: |",
  "| 2026-04-03 | DJ gig |",
].join("\n");

describe("tableModelAt", () => {
  it("returns null when the position is not inside a table", () => {
    const doc = "# Heading\n\nplain paragraph";
    expect(tableModelAt(state(doc), 3)).toBeNull();
  });

  it("models header, delimiter, and body rows with their source ranges", () => {
    const model = tableModelAt(state(SIMPLE), SIMPLE.indexOf("DJ gig"));

    expect(model).not.toBeNull();
    expect(model?.from).toBe(0);
    expect(model?.to).toBe(SIMPLE.length);
    expect(model?.columnCount).toBe(2);
    expect(model?.rows.map((row) => row.kind)).toEqual(["header", "delimiter", "body"]);
    expect(slotText(SIMPLE, model!, 0, 0)).toBe("Start date");
    expect(slotText(SIMPLE, model!, 0, 1)).toBe("Commitment");
    expect(slotText(SIMPLE, model!, 2, 0)).toBe("2026-04-03");
    expect(slotText(SIMPLE, model!, 2, 1)).toBe("DJ gig");
  });

  it("splits the delimiter row, which the parser emits as one flat node", () => {
    const model = tableModelAt(state(SIMPLE), 0);

    expect(slotText(SIMPLE, model!, 1, 0)).toBe("---");
    expect(slotText(SIMPLE, model!, 1, 1)).toBe(":--:");
  });

  it("reads column alignment from the delimiter row", () => {
    const doc = "| a | b | c | d |\n| --- | :-- | :-: | --: |\n| 1 | 2 | 3 | 4 |";
    expect(tableModelAt(state(doc), 0)?.alignments).toEqual(["none", "left", "center", "right"]);
  });

  it("keeps column indexes correct when a cell is empty and emits no cell node", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |  | z |";
    const model = tableModelAt(state(doc), doc.indexOf("| x |"));

    expect(model?.columnCount).toBe(3);
    expect(slotText(doc, model!, 2, 0)).toBe("x");
    expect(slotText(doc, model!, 2, 1)).toBe("");
    expect(slotText(doc, model!, 2, 2)).toBe("z");
  });

  it("tolerates a ragged row with fewer cells than the header", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |";
    const model = tableModelAt(state(doc), doc.length - 1);

    expect(model?.columnCount).toBe(3);
    expect(model?.rows.at(-1)?.slots.map((slot) => slot.column)).toEqual([0]);
  });

  it("keeps an escaped pipe inside a single cell", () => {
    const doc = "| a | b |\n| --- | --- |\n| x \\| y | z |";
    const model = tableModelAt(state(doc), doc.indexOf("x \\|"));

    expect(slotText(doc, model!, 2, 0)).toBe("x \\| y");
    expect(slotText(doc, model!, 2, 1)).toBe("z");
  });

  it("models a table written without leading and trailing pipes", () => {
    const doc = "a | b\n--- | ---\nx | y";
    const model = tableModelAt(state(doc), 0);

    expect(model?.columnCount).toBe(2);
    expect(slotText(doc, model!, 0, 0)).toBe("a");
    expect(slotText(doc, model!, 2, 1)).toBe("y");
  });
});

describe("tableColumnWidths", () => {
  it("sizes each column to its widest content row", () => {
    const editor = state(SIMPLE);
    const model = tableModelAt(editor, 0)!;

    expect(tableColumnWidths(editor, model)).toEqual(["Start date".length, "Commitment".length]);
  });

  it("never sizes a column below the three characters a delimiter row needs", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);

    expect(tableColumnWidths(editor, tableModelAt(editor, 0)!)).toEqual([3, 3]);
  });

  it("counts a multi-code-point emoji as a single column", () => {
    // Four family emoji: 4 graphemes, 20 code points, 44 UTF-16 code units.
    const doc = "| a | b |\n| --- | --- |\n| 👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧 | y |";
    const editor = state(doc);

    expect(tableColumnWidths(editor, tableModelAt(editor, 0)!)[0]).toBe(4);
  });
});

describe("tableAlignmentPads", () => {
  function pads(doc: string) {
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    return tableAlignmentPads(editor, model, tableColumnWidths(editor, model));
  }

  it("pads every short cell so each column reaches a single width", () => {
    const doc = "| Start date | Commitment |\n| --- | --- |\n| a | b |";
    const result = pads(doc);

    const forCell = (needle: string) =>
      result.filter((pad) => pad.pos === doc.indexOf(needle) + needle.length);
    expect(forCell("| a")[0]?.width).toBe("Start date".length - 1);
    expect(result.every((pad) => pad.width > 0)).toBe(true);
  });

  it("emits insertions only, so the document bytes never change", () => {
    const result = pads(SIMPLE);

    expect(result.length).toBeGreaterThan(0);
    for (const pad of result) {
      expect(Number.isSafeInteger(pad.pos)).toBe(true);
      expect(pad).not.toHaveProperty("from");
      expect(pad).not.toHaveProperty("to");
    }
  });

  it("fills the delimiter row with dashes and content rows with spaces", () => {
    const result = pads(SIMPLE);
    const fills = new Set(result.map((pad) => pad.fill));

    expect(fills.has("dash")).toBe(true);
    expect(fills.has("space")).toBe(true);
  });

  it("pads before the content for a right-aligned column", () => {
    const doc = "| a | value |\n| --- | --: |\n| x | y |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const result = tableAlignmentPads(editor, model, tableColumnWidths(editor, model));
    const cell = model.rows[2]!.slots.find((slot) => slot.column === 1)!;

    expect(result.some((pad) => pad.pos === cell.from && pad.fill === "space")).toBe(true);
    expect(result.some((pad) => pad.pos === cell.to && pad.fill === "space")).toBe(false);
  });

  it("splits padding either side of the content for a centred column", () => {
    const doc = "| a | value |\n| --- | :-: |\n| x | y |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const result = tableAlignmentPads(editor, model, tableColumnWidths(editor, model));
    const cell = model.rows[2]!.slots.find((slot) => slot.column === 1)!;

    expect(result.some((pad) => pad.pos === cell.from)).toBe(true);
    expect(result.some((pad) => pad.pos === cell.to)).toBe(true);
  });

  it("produces no padding for a table whose columns already line up", () => {
    expect(pads("| aaa | bbb |\n| --- | --- |\n| xxx | yyy |")).toEqual([]);
  });
});
