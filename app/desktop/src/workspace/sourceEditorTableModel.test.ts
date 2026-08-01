import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import type { CellPaintPlan } from "./sourceEditorCellPaintPlan";
import {
  CELL_TRACK_GUTTER_CH,
  CELL_TRACK_GUTTER_PX,
  tableColumnWidths,
  tableDelimiterRanges,
  tableModelAt,
  tableRenderPlan,
  type TableModel,
  type TableRenderPlan,
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

const columnsOf = (plan: TableRenderPlan, row: number): number[] =>
  plan.rows[row]!.cells.map((cell) => cell.column);

/** A probe standing in for P3a's: ten pixels per painted character. */
const tenPixelsPerCharacter = (plan: CellPaintPlan): number => plan.visibleText.length * 10;

/** The same probe, unprimed for one column — CT-4's normal first frame. */
const unprimedForCcc = (plan: CellPaintPlan): number | null =>
  plan.visibleText === "ccc" ? null : tenPixelsPerCharacter(plan);

describe("tableRenderPlan", () => {

  it("gives every content row one cell per declared column, numbered from one", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x | y | z |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.rows.map((row) => row.kind)).toEqual(["header", "delimiter", "body"]);
    expect(columnsOf(plan, 0)).toEqual([1, 2, 3]);
    expect(columnsOf(plan, 2)).toEqual([1, 2, 3]);
    expect(plan.rows[1]!.cells).toEqual([]);
  });

  it("marks a declared-but-blank cell as empty, with a zero-length range", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |  | z |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);
    const cells = plan.rows[2]!.cells;

    expect(cells.map((cell) => cell.kind)).toEqual(["content", "empty", "content"]);
    expect(cells[1]!.from).toBe(cells[1]!.to);
  });

  it("fills a ragged row's missing columns at the last declared cell's end", () => {
    const doc = "| Task | Owner | Due |\n| --- | --- | --- |\n| Ship v0.3 | Tom |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const plan = tableRenderPlan(editor, model);
    const cells = plan.rows[2]!.cells;
    const lastDeclared = model.rows[2]!.slots.at(-1)!;

    expect(cells.map((cell) => cell.kind)).toEqual(["content", "content", "filler"]);
    expect(cells.at(-1)).toMatchObject({ column: 3, from: lastDeclared.to, to: lastDeclared.to });
  });

  it("gives a row missing two columns one filler each, at the same offset", () => {
    // CT1-Q2's shape: two adjacent zero-length widgets.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| only |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);
    const fillers = plan.rows[2]!.cells.filter((cell) => cell.kind === "filler");

    expect(fillers.map((cell) => cell.column)).toEqual([2, 3]);
    expect(new Set(fillers.map((cell) => cell.from)).size).toBe(1);
  });

  it("places chrome at the column it opens, and the trailing chrome at the last column", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x | y | z |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.rows[0]!.chrome.map((chrome) => [chrome.kind, chrome.gridColumn])).toEqual([
      ["leading", "1"],
      ["divider", "2"],
      ["divider", "3"],
      ["trailing", "3"],
    ]);
  });

  it("keeps a ragged row's trailing chrome out of the columns it never declared", () => {
    // K7d: the closing edge belongs at the table's last column, not the row's.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| only |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);
    const trailing = plan.rows[2]!.chrome.find((chrome) => chrome.kind === "trailing")!;

    expect(trailing.gridColumn).toBe("3");
  });

  it("draws the alignment row as one rule spanning every column", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.rows[1]!.chrome.map((chrome) => [chrome.kind, chrome.gridColumn]))
      .toEqual([["rule", "1 / -1"]]);
  });

  it("names each row's kind and stamps the table edges on two different lines", () => {
    // A one-row table is the case where first and last cannot be the same line.
    const doc = "| Key | Value |\n| --- | --- |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.rows.map((row) => row.className)).toEqual([
      "nn-lp-table-row nn-lp-table-row-header nn-lp-table-row-first",
      "nn-lp-table-row nn-lp-table-row-delimiter nn-lp-table-row-last",
    ]);
  });

  it("marks the first and last line of a three-row table and nothing between", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.rows.map((row) => row.edge)).toEqual(["first", null, "last"]);
  });

  it("anchors each row's line decoration at the start of its line", () => {
    const doc = "text\n\n| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, doc.indexOf("| a"))!);

    for (const row of plan.rows) {
      expect(editor.doc.lineAt(row.lineFrom).from).toBe(row.lineFrom);
    }
  });

  it("sizes a track from what the cell PAINTS, not from its source characters", () => {
    // G3: the width belongs to the string the user sees. `**bold**` is eight
    // source characters and four painted ones; measuring the source serves the
    // column a width that belongs to a different string.
    const doc = "| **bold** | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.trackTemplate.split(" ")[0]).toBe(`${4 + CELL_TRACK_GUTTER_CH}ch`);
  });

  it("sizes each track to the widest cell in its column", () => {
    const doc = "| a | bb |\n| --- | --- |\n| ccc | d |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!);

    expect(plan.trackTemplate).toBe(
      `${3 + CELL_TRACK_GUTTER_CH}ch ${2 + CELL_TRACK_GUTTER_CH}ch`,
    );
  });

  it("stamps measured pixels once every column has been measured", () => {
    const doc = "| a | bb |\n| --- | --- |\n| ccc | d |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!, {
      measureCell: tenPixelsPerCharacter,
    });

    expect(plan.trackTemplate)
      .toBe(`${30 + CELL_TRACK_GUTTER_PX}px ${20 + CELL_TRACK_GUTTER_PX}px`);
  });

  it("falls back to character tracks for every column while any one is unmeasured", () => {
    // CT-4: a null width is "not primed yet", the normal first frame. Mixing
    // units across columns would leave the table aligned to neither.
    const doc = "| a | bb |\n| --- | --- |\n| ccc | d |";
    const editor = state(doc);
    const plan = tableRenderPlan(editor, tableModelAt(editor, 0)!, {
      measureCell: unprimedForCcc,
    });

    expect(plan.trackTemplate)
      .toBe(`${3 + CELL_TRACK_GUTTER_CH}ch ${2 + CELL_TRACK_GUTTER_CH}ch`);
  });

  it("reports the table's own bounds, so a caller never re-derives them", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const editor = state(doc);
    const model = tableModelAt(editor, 0)!;
    const plan = tableRenderPlan(editor, model);

    expect({ from: plan.from, to: plan.to }).toEqual({ from: model.from, to: model.to });
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
