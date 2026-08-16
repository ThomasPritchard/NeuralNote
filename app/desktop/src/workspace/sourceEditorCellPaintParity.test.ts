// A drawn table cell paints exactly what `cellPaintPlan` projects for it.
//
// `cellPaintPlan` is what sizes a column's track, so a marker the collector
// leaves on screen inside a drawn cell is painted wider than the track it was
// given, and — the cell being a grid item in a fixed-pixel track with no
// overflow — spills over the column rule into its neighbour. Nothing in the
// suite noticed, because BOTH arms of the measurement read the plan and the
// paint was never compared against it. That is what this file does, at the
// collector's own seam; `sourceEditorTableRender.test.ts` does it again against
// the rendered DOM, and `SourceNoteEditor.tableWiring.browser.test.tsx` against
// real geometry.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { withPublishedParse } from "../test/publishedParse";
import { cellPaintPlan } from "./sourceEditorCellPaintPlan";
import { collectMarkdownPreview, type PreviewDecoration } from "./sourceEditorDecorations";
import { tableModelAt } from "./sourceEditorTableModel";

// Every reader below — `tableModelAt`, `cellPaintPlan`, `collectMarkdownPreview`
// — walks `syntaxTree(state)`, so the finished parse has to be PUBLISHED into
// the state before any of them runs. See `src/test/publishedParse.ts` for why
// building the state is not enough. Measured: `Error: No table at 43` from
// "paints exactly the text its own paint plan projects", once in 8 full-suite
// runs under 20 CPU burners.
function state(doc: string, anchor: number) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(anchor),
      extensions: [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      ],
    }),
    doc,
  );
}

/**
 * A table whose second column carries every construct the collector owns. The
 * leading paragraph is load-bearing: offset 0 has to be OUTSIDE the table, or
 * the inactive arm below can never be reached.
 */
const INLINE_CELL_TABLE = [
  "Before.",
  "",
  "| Task | Detail |",
  "| --- | --- |",
  "| anchor | **Urgent** and `now` and [label](https://example.com/a) |",
  // The QA vault's own "Inline formatting in cells" row
  // (`fixtures/note-test-vault/02 Markdown/Tables.md`). An autolink is the one
  // construct whose enclosing node is not in `CONSTRUCT_NAMES`, so its markers
  // used to resolve their active state against the whole DOCUMENT — trivially
  // true wherever the caret is — and stayed on screen while the plan dropped
  // them. The read-only table widget has always hidden them
  // (`SourceNoteEditor.test.tsx`, "preserves bare URLs and autolinks"), so the
  // two renderings of one table disagreed.
  "| autolink | <https://example.org> |",
  // A GFM escaped pipe. The plan hides the backslash and paints the `|` it
  // protects, so the collector has to hide exactly the same one character —
  // otherwise the column is measured at `a | b` and painted `a \| b`, and the
  // cell overruns its track by a character.
  "| escape | a \\| b |",
].join("\n");

/**
 * The characters the collector leaves on screen inside `[from, to)`: a
 * `replace` drops its span, a `widget` puts its label there instead, and
 * everything else is painted as itself.
 */
function paintedText(
  editor: EditorState,
  preview: readonly PreviewDecoration[],
  from: number,
  to: number,
): string {
  const hiding = preview
    .filter((item) => item.kind === "replace" || item.kind === "widget")
    .filter((item) => item.from >= from && item.to <= to)
    .sort((left, right) => left.from - right.from);

  let painted = "";
  let position = from;
  for (const item of hiding) {
    if (item.from < position) continue;
    painted += editor.sliceDoc(position, item.from);
    if (item.kind === "widget") painted += item.label ?? "";
    position = item.to;
  }
  return painted + editor.sliceDoc(position, to);
}

/** Every content slot of the table at `pos`, paired with its row's context. */
function cellSlots(editor: EditorState, pos: number) {
  const model = tableModelAt(editor, pos);
  if (!model) throw new Error(`No table at ${pos}`);
  return model.rows
    .filter((row) => row.kind !== "delimiter")
    .flatMap((row) => row.slots.map((slot) => ({
      slot,
      context: row.kind === "header" ? ("header" as const) : ("body" as const),
    })));
}

describe("a table cell the editor draws rather than replaces", () => {
  it("paints exactly the text its own paint plan projects", () => {
    // The caret sits in the FIRST column on purpose: it has to be inside the
    // table for the cells to be drawn at all, and inside the markup it would
    // reveal those constructs in the plan AND on screen, so the two would agree
    // without anything ever hiding a marker.
    const caret = INLINE_CELL_TABLE.indexOf("anchor");
    const editor = state(INLINE_CELL_TABLE, caret);
    const preview = collectMarkdownPreview(editor);

    const cells = cellSlots(editor, caret);
    const painted = cells.map(({ slot }) => paintedText(editor, preview, slot.from, slot.to));
    const projected = cells.map(({ slot, context }) =>
      cellPaintPlan(editor, slot, { context }).visibleText);

    expect(painted).toEqual(projected);
  });

  it("emits a hiding decoration over every character the plan drops", () => {
    // `hiddenRanges` is the plan's own statement of what never reaches the
    // screen. A character the plan drops and the collector paints is a column
    // measured against a string the user never sees.
    //
    // Character-wise, not range-wise: the plan merges adjacent gaps into one
    // range, so `](https://example.com/a)` is a single hidden range covered by
    // four separate decorations. What has to hold is that every character is
    // covered, not that one decoration covers each range.
    const caret = INLINE_CELL_TABLE.indexOf("anchor");
    const editor = state(INLINE_CELL_TABLE, caret);
    const hidden = new Set<number>();
    for (const item of collectMarkdownPreview(editor)) {
      if (item.kind !== "replace" && item.kind !== "widget") continue;
      for (let position = item.from; position < item.to; position += 1) hidden.add(position);
    }

    const painted = cellSlots(editor, caret)
      .flatMap(({ slot, context }) => cellPaintPlan(editor, slot, { context }).hiddenRanges)
      .flatMap((range) => Array.from(
        { length: range.to - range.from },
        (_, offset) => range.from + offset,
      ))
      .filter((position) => !hidden.has(position))
      .map((position) => `${position}: ${editor.sliceDoc(position, position + 1)}`);

    expect(painted).toEqual([]);
  });

  it("reveals a cell's markers when the caret enters the construct, as anywhere else", () => {
    // The other half of the same parity. The plan flips a construct to its
    // revealed classes from `caretInside`; so must the paint, or the caret's own
    // cell is the one measured against the wrong string.
    const caret = INLINE_CELL_TABLE.indexOf("Urgent");
    const editor = state(INLINE_CELL_TABLE, caret);
    const preview = collectMarkdownPreview(editor);

    const cells = cellSlots(editor, caret);
    const painted = cells.map(({ slot }) => paintedText(editor, preview, slot.from, slot.to));
    const projected = cells.map(({ slot, context }) =>
      cellPaintPlan(editor, slot, { context }).visibleText);

    expect(painted).toEqual(projected);
    expect(painted).toContain("**Urgent** and now and label");
  });

  it("keeps a table's whole source literal while its cells are replaced by the widget", () => {
    // The inactive arm replaces the table wholesale with a read-only widget, so
    // nothing inside it reaches the screen and decorating its interior is cost
    // on the keystroke path for a value that is thrown away.
    const editor = state(INLINE_CELL_TABLE, 0);
    const preview = collectMarkdownPreview(editor);

    expect(preview.filter((item) => item.table)).toHaveLength(1);
    expect(preview.filter((item) => item.from >= INLINE_CELL_TABLE.indexOf("| Task")))
      .toHaveLength(1);
  });

  it("descends no further than the requested visible range", () => {
    // The bound on the descent. A note may hold a table far larger than the
    // viewport, and the collector runs on the keystroke path.
    const filler = Array.from({ length: 400 }, (_, index) => `| **r${index}** | v |`);
    const doc = ["| a | b |", "| --- | --- |", ...filler].join("\n");
    const window = { from: doc.indexOf("| **r1** |"), to: doc.indexOf("| **r3** |") };
    const editor = state(doc, window.from + 3);

    const preview = collectMarkdownPreview(editor, [window]);
    const strayed = preview.filter((item) =>
      !item.tableSource && (item.from < window.from || item.to > window.to));

    expect(strayed).toEqual([]);
    expect(preview.some((item) => item.kind === "replace")).toBe(true);
  });
});
