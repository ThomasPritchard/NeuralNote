import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  formatTable,
  formatTableAt,
  guardTableDelimiter,
  nextTableRow,
  tableCellStep,
  tableRowStep,
} from "./sourceEditorTableCommands";
import {
  tableDelimiterGuard,
  tableStructuralEdit,
} from "./sourceEditorTableDelimiterGuard";

const TABLE = [
  "# Notes",
  "",
  "| Start date | Commitment |",
  "| --- | --- |",
  "| 2026-04-03 | DJ gig |",
].join("\n");

function state(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    ],
  });
}

/** Apply a spec and return the resulting document plus the selected text. */
function apply(editor: EditorState, spec: ReturnType<typeof tableCellStep>) {
  if (!spec) return null;
  const next = editor.update(spec).state;
  const { from, to } = next.selection.main;
  return { doc: next.doc.toString(), selected: next.sliceDoc(from, to), head: next.selection.main.head };
}

const at = (needle: string, offset = 0) => TABLE.indexOf(needle) + offset;

/** Cells a GFM renderer would see in one row. */
const cellCount = (line: string) => line.split("|").slice(1, -1).length;

describe("tableCellStep", () => {
  it("does nothing when the caret is outside a table", () => {
    expect(tableCellStep(state(TABLE, 2), 1)).toBeNull();
  });

  it("selects the next cell in the same row", () => {
    const result = apply(state(TABLE, at("Start date")), tableCellStep(state(TABLE, at("Start date")), 1));
    expect(result?.selected).toBe("Commitment");
  });

  it("wraps forward into the next row, skipping the delimiter row", () => {
    const editor = state(TABLE, at("Commitment"));
    expect(apply(editor, tableCellStep(editor, 1))?.selected).toBe("2026-04-03");
  });

  it("wraps backward into the previous row's last cell", () => {
    const editor = state(TABLE, at("2026-04-03"));
    expect(apply(editor, tableCellStep(editor, -1))?.selected).toBe("Commitment");
  });

  it("returns null before the very first cell so Tab keeps its default behaviour", () => {
    expect(tableCellStep(state(TABLE, at("Start date")), -1)).toBeNull();
  });

  it("falls through at the final cell so Tab can move keyboard focus out", () => {
    // Regression (WCAG 2.1.2): forward Tab used to append a row and return a
    // transaction, so preventDefault always fired and focus could never leave
    // the editor from inside a table — and it wrote to the file to do it.
    expect(tableCellStep(state(TABLE, at("DJ gig")), 1)).toBeNull();
  });

  it("does not act at the very end of a table, where it still renders", () => {
    // The preview treats `table.to` as outside the table, so it draws the
    // read-only widget there. Acting would write to a table the user sees
    // rendered rather than as source.
    expect(tableCellStep(state(TABLE, TABLE.length), 1)).toBeNull();
    expect(tableRowStep(state(TABLE, TABLE.length))).toBeNull();
  });

  it("resolves a caret in a cell's trailing whitespace to that cell", () => {
    // Regression: nearest-slot ranking used slot.from only, so a caret in the
    // padding after "DJ gig" resolved to the NEXT cell.
    const aligned = [
      "| Start date | Commitment |",
      "| ---------- | ---------- |",
      "| 2026-04-03 | DJ gig     |",
    ].join("\n");
    const trailing = aligned.indexOf("DJ gig") + "DJ gig  ".length;
    const editor = state(aligned, trailing);

    expect(apply(editor, tableCellStep(editor, -1))?.selected).toBe("2026-04-03");
  });
});

describe("tableRowStep", () => {
  it("moves down the same column", () => {
    const editor = state(TABLE, at("Commitment"));
    expect(apply(editor, tableRowStep(editor))?.selected).toBe("DJ gig");
  });

  it("appends a row from the last row and lands in the same column", () => {
    const editor = state(TABLE, at("DJ gig"));
    const result = apply(editor, tableRowStep(editor));

    expect(result?.doc.endsWith("\n|  |  |")).toBe(true);
    expect(result?.doc.startsWith(TABLE)).toBe(true);
  });

  it("leaves the table and removes the row when Enter lands on a blank one", () => {
    const doc = `${TABLE}\n|  |  |`;
    const editor = state(doc, doc.length - 4);
    const result = apply(editor, tableRowStep(editor));

    expect(result?.doc).toBe(`${TABLE}\n`);
    expect(result?.head).toBe(TABLE.length + 1);
  });

  it("keeps the rows below when Enter lands on a blank row mid-table", () => {
    // Regression, and data loss: the blank-row exit deleted to `model.to`, the
    // end of the whole table, rather than to the end of the blank row's own
    // line. Every row below vanished with no warning.
    //
    // The fixture needs a row AFTER the blank one whose next row yields no
    // slot, or `tableRowStep` steps down a column and never reaches the exit
    // branch. A lone `|` is the shape a user leaves while building a table by
    // hand, and it parses as a row with no cells at all.
    const doc = "| a | b |\n| - | - |\n|   |   |\n|\n| c | d |\n";
    const editor = state(doc, doc.indexOf("|   |   |") + 2);
    const result = apply(editor, tableRowStep(editor));

    expect(result?.doc).toContain("| c | d |");
    // The blank row goes and nothing else does.
    expect(result?.doc).toBe("| a | b |\n| - | - |\n\n|\n| c | d |\n");
  });

  it("refuses the blank-row exit for a table nested in a blockquote", () => {
    // Regression: the branch deleted from `row.from - 1`, which inside a
    // blockquote is the space after ">" rather than a newline, stranding "> ".
    const doc = "> | a | b |\n> | --- | --- |\n> |  |  |";
    const editor = state(doc, doc.lastIndexOf("|  |  |") + 2);
    const result = apply(editor, tableRowStep(editor));

    expect(result?.doc.startsWith(doc)).toBe(true);
    expect(result?.doc).not.toContain(">\n\n");
  });

  it("clamps to the last column when the next row is ragged", () => {
    // Regression: selectSlot returned null for a missing column, so Enter fell
    // through to defaultKeymap and split the table mid-row.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |\n";
    const editor = state(doc, doc.indexOf("c"));
    const result = apply(editor, tableRowStep(editor));

    expect(result).not.toBeNull();
    expect(result?.doc).toBe(doc);
  });
});

describe("formatTableAt", () => {
  it("writes the alignment into the source", () => {
    const editor = state(TABLE, at("DJ gig"));
    const result = apply(editor, formatTableAt(editor));

    expect(result?.doc).toBe([
      "# Notes",
      "",
      "| Start date | Commitment |",
      "| ---------- | ---------- |",
      "| 2026-04-03 | DJ gig     |",
    ].join("\n"));
  });

  it("preserves alignment colons when padding the delimiter row", () => {
    const doc = "| a | b | c |\n| :-- | :-: | --: |\n| xxxx | yyyy | zzzz |";
    const editor = state(doc, doc.indexOf("yyyy"));

    expect(apply(editor, formatTableAt(editor))?.doc).toBe(
      "| a    | b    | c    |\n| :--- | :--: | ---: |\n| xxxx | yyyy | zzzz |",
    );
  });

  it("does not add a column when a body row has more cells than the header", () => {
    // GFM and Obsidian render this as a TWO-column table and discard "z".
    // Rewriting every row to the widest row gave the delimiter row three cells,
    // so Obsidian then rendered three columns and "z" became visible data:
    // formatting changed the document's meaning, not its whitespace. (#87)
    const doc = "| a | b |\n| --- | --- |\n| x | y | z |";
    const editor = state(doc, doc.indexOf("x"));
    const result = apply(editor, formatTableAt(editor));
    const lines = (result?.doc ?? doc).split("\n");

    expect(cellCount(lines[0]!)).toBe(2);
    expect(cellCount(lines[1]!)).toBe(2);
    expect(result?.doc).toContain("z");
  });

  it("returns null for a table that is already aligned", () => {
    const doc = "| aaa | bbb |\n| --- | --- |\n| xxx | yyy |";
    expect(formatTableAt(state(doc, doc.indexOf("xxx")))).toBeNull();
  });

  it("leaves the line count untouched", () => {
    const editor = state(TABLE, at("DJ gig"));
    const result = apply(editor, formatTableAt(editor));

    expect(result?.doc.split("\n")).toHaveLength(TABLE.split("\n").length);
  });

  it("refuses at the table's end boundary, where the table renders read-only", () => {
    // `active()` in the preview layer is exclusive of `to`, so at exactly
    // `table.to` the user is looking at the rendered widget, not the source.
    // `tableCellStep` and `tableRowStep` already refuse there. This is the one
    // command that changes bytes, which makes it agreeing matter more, not less.
    const ragged = "| a | b |\n| --- | --- |\n|   c   |   d   |";
    const editor = state(ragged, ragged.length);

    expect(formatTableAt(editor)).toBeNull();
  });
});

describe("guardTableDelimiter", () => {
  const DOC = "| a | bb |\n| --- | --- |\n| x | yy |";
  const cellStart = (needle: string) => DOC.indexOf(needle);

  it("turns Backspace at a cell start into a move, never a deletion", () => {
    // The delimiter is invisible once drawn as chrome. Deleting it would
    // silently re-shape the table with nothing on screen to explain it.
    const pos = cellStart("yy");
    const editor = state(DOC, pos);
    const spec = guardTableDelimiter(editor, -1);

    expect(spec).not.toBeNull();
    expect(spec).not.toHaveProperty("changes");
    const next = editor.update(spec!).state;
    expect(next.doc.toString()).toBe(DOC);
    // Lands at the end of the previous cell's content, past the hidden gap.
    expect(next.selection.main.head).toBe(DOC.indexOf("| x |") + 3);
  });

  it("turns Delete at a cell end into a move", () => {
    const pos = DOC.indexOf("| x |") + 3;
    const editor = state(DOC, pos);
    const next = editor.update(guardTableDelimiter(editor, 1)!).state;

    expect(next.doc.toString()).toBe(DOC);
    expect(next.selection.main.head).toBe(cellStart("yy"));
  });

  it("stays out of the way in the middle of a cell", () => {
    expect(guardTableDelimiter(state(DOC, cellStart("yy") + 1), -1)).toBeNull();
  });

  it("stays out of the way outside a table", () => {
    const doc = "# Heading\n\nplain text";
    expect(guardTableDelimiter(state(doc, 5), -1)).toBeNull();
  });

  it("does not trap the caret at the very start of a table", () => {
    // Backspace before the opening pipe must fall through to normal editing,
    // or the table becomes impossible to remove.
    expect(guardTableDelimiter(state(DOC, 0), -1)).toBeNull();
  });
});

function guardedState(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      tableDelimiterGuard,
    ],
  });
}

/** A command target that applies what it is given and keeps the transactions. */
function target(doc: string, anchor: number) {
  let editor = guardedState(doc, anchor);
  const applied: Transaction[] = [];
  const view = {
    get state() { return editor; },
    dispatch: (...specs: TransactionSpec[]) => {
      const transaction = editor.update(...specs);
      applied.push(transaction);
      editor = transaction.state;
    },
  };
  return {
    view: view as unknown as EditorView,
    applied,
    document: () => editor.doc.toString(),
  };
}

const refusals = (applied: readonly Transaction[]) =>
  applied.filter((transaction) =>
    transaction.effects.some((effect) => effect.is(EditorView.announce)));

describe("structural commands are exempt from the delimiter guard", () => {
  // Every one of these commands rewrites spans the guard refuses from ordinary
  // editing — a whole row, or the delimiter row. Without the annotation each is
  // silently refused in the running editor, which is the regression these pin.

  it("lets formatTable rewrite every row, delimiter row included", () => {
    const { view, applied, document } = target(TABLE, at("DJ gig"));

    expect(formatTable(view)).toBe(true);
    expect(applied[0]?.annotation(tableStructuralEdit)).toBe(true);
    expect(refusals(applied)).toEqual([]);
    expect(document()).toContain("| ---------- |");
  });

  it("lets Enter drop a blank trailing row and leave the table", () => {
    const doc = `${TABLE}\n|  |  |`;
    const { view, applied, document } = target(doc, doc.length - 4);

    expect(nextTableRow(view)).toBe(true);
    expect(applied[0]?.annotation(tableStructuralEdit)).toBe(true);
    expect(refusals(applied)).toEqual([]);
    expect(document()).toBe(`${TABLE}\n`);
  });
});
