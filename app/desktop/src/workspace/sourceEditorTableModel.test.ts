import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  monospaceWidth,
  tableColumnWidths,
  tableDelimiterRanges,
  tableModelAt,
  tableSegmentWidths,
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

  it("counts a multi-code-point emoji as the two columns it occupies", () => {
    // Four family emoji: 4 graphemes, 20 code points, 44 UTF-16 code units,
    // and 8 monospace columns — emoji are double-width. Issue #86.
    const doc = "| a | b |\n| --- | --- |\n| 👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧 | y |";
    const editor = state(doc);

    expect(tableColumnWidths(editor, tableModelAt(editor, 0)!)[0]).toBe(8);
  });

  it("sizes a CJK column by the columns it occupies, not its character count", () => {
    const doc = "| a | b |\n| --- | --- |\n| 中文字 | y |";
    const editor = state(doc);

    // "中文字" is 3 characters but 6 monospace columns.
    expect(tableColumnWidths(editor, tableModelAt(editor, 0)!)[0]).toBe(6);
  });
});

describe("column padding folded into the chrome", () => {
  /** Total columns a row paints: its content plus the padding in its gaps. */
  function renderedWidth(doc: string, rowIndex: number): number {
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const widths = tableSegmentWidths(editor, model);
    const ranges = tableDelimiterRanges(model, editor, widths);
    const row = model.rows[rowIndex]!;

    const content = row.slots.reduce(
      (total, slot) => total + monospaceWidth(doc.slice(slot.from, slot.to)),
      0,
    );
    const padding = ranges
      .filter((range) => range.from >= row.from && range.to <= row.to)
      .reduce((total, range) => total + range.padColumns, 0);
    return content + padding;
  }

  it("brings every content row to the same painted width", () => {
    const doc = "| Start date | Commitment |\n| --- | --- |\n| a | b |";
    expect(renderedWidth(doc, 0)).toBe(renderedWidth(doc, 2));
  });

  it("pads a table whose alignment spaces are now hidden", () => {
    // Under chrome the spaces around a pipe are inside the hidden gap, so an
    // already-aligned file still needs painted padding to look aligned.
    const doc = [
      "| Start date | Commitment |",
      "| ---------- | ---------- |",
      "| 2026-04-03 | DJ gig     |",
    ].join("\n");
    expect(renderedWidth(doc, 0)).toBe(renderedWidth(doc, 2));
  });

  it("adds nothing when a column's cells are already equal", () => {
    const doc = "| aaa | bbb |\n| --- | --- |\n| xxx | yyy |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const ranges = tableDelimiterRanges(model, editor, tableSegmentWidths(editor, model));

    expect(ranges.every((range) => range.padColumns === 0)).toBe(true);
  });

  it("never pads the delimiter row, which is drawn as a rule", () => {
    const doc = "| Start date | Commitment |\n| --- | :-: |\n| a | b |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const ranges = tableDelimiterRanges(model, editor, tableSegmentWidths(editor, model));
    const rule = ranges.filter((range) => range.kind === "rule");

    expect(rule).toHaveLength(1);
    expect(rule[0]!.padColumns).toBe(0);
  });

  it("puts a right-aligned column's padding in the gap before its content", () => {
    const doc = "| a | value |\n| --- | --: |\n| x | y |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const ranges = tableDelimiterRanges(model, editor, tableSegmentWidths(editor, model));
    const bodyRow = model.rows[2]!;
    const cell = bodyRow.slots.find((slot) => slot.column === 1)!;

    const before = ranges.find((range) => range.to === cell.from)!;
    const after = ranges.find((range) => range.from === cell.to)!;
    expect(before.padColumns).toBeGreaterThan(0);
    expect(after.padColumns).toBe(0);
  });

  it("emits ranges only, so the document is never edited", () => {
    const doc = "| Start date | Commitment |\n| --- | --- |\n| a | b |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const ranges = tableDelimiterRanges(model, editor, tableSegmentWidths(editor, model));

    for (const range of ranges) {
      expect(range.from).toBeGreaterThanOrEqual(0);
      expect(range.to).toBeLessThanOrEqual(doc.length);
      expect(range).not.toHaveProperty("insert");
    }
  });
});

describe("tableDelimiterRanges", () => {
  it("covers the whole gap between cells, never the bare pipe", () => {
    // atomicRanges guards require a position strictly INSIDE the range
    // (@codemirror/view:3734, @codemirror/commands:1197), so a 1-char pipe can
    // never be protected. Hiding the surrounding spaces too gives it interior
    // positions.
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const ranges = tableDelimiterRanges(tableModelAt(editor, 0)!);

    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      expect(doc.slice(range.from, range.to)).toContain("|");
      expect(range.to).toBeGreaterThan(range.from);
    }
    const dividers = ranges.filter((range) => range.kind === "divider");
    expect(dividers.every((range) => range.to - range.from >= 2)).toBe(true);
    expect(doc.slice(dividers[0]!.from, dividers[0]!.to)).toBe(" | ");
  });

  it("marks the leading and trailing pipes distinctly", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const ranges = tableDelimiterRanges(tableModelAt(editor, 0)!);
    const header = ranges.filter((range) => range.from < doc.indexOf("\n"));

    expect(header.map((range) => range.kind)).toEqual(["leading", "divider", "trailing"]);
  });

  it("omits a leading range for a row written without its opening pipe", () => {
    const doc = "a | b\n--- | ---\nx | y";
    const editor = state(doc);
    const ranges = tableDelimiterRanges(tableModelAt(editor, 0)!);

    expect(ranges.some((range) => range.kind === "leading")).toBe(false);
    expect(ranges.some((range) => range.kind === "divider")).toBe(true);
  });

  it("never overlaps two ranges, which would break Decoration.set", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |  | z |";
    const editor = state(doc);
    const ranges = [...tableDelimiterRanges(tableModelAt(editor, 0)!)]
      .sort((left, right) => left.from - right.from);

    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]!.from).toBeGreaterThanOrEqual(ranges[index - 1]!.to);
    }
  });

  it("covers the delimiter row as one hidden run", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const row = model.rows.find((candidate) => candidate.kind === "delimiter")!;
    const ranges = tableDelimiterRanges(model)
      .filter((range) => range.from >= row.from && range.to <= row.to);

    expect(ranges.map((range) => range.kind)).toEqual(["rule"]);
    expect(ranges[0]).toMatchObject({ from: row.from, to: row.to });
  });
});
