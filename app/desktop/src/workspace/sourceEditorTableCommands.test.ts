import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  formatTableAt,
  tableCellStep,
  tableRowStep,
} from "./sourceEditorTableCommands";

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

  it("returns null for a table that is already aligned", () => {
    const doc = "| aaa | bbb |\n| --- | --- |\n| xxx | yyy |";
    expect(formatTableAt(state(doc, doc.indexOf("xxx")))).toBeNull();
  });

  it("leaves the line count untouched", () => {
    const editor = state(TABLE, at("DJ gig"));
    const result = apply(editor, formatTableAt(editor));

    expect(result?.doc.split("\n")).toHaveLength(TABLE.split("\n").length);
  });
});
