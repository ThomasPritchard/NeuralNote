import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command } from "@codemirror/view";

import { tableStructuralEdit } from "./sourceEditorTableDelimiterGuard";
import {
  monospaceWidth,
  tableColumnWidths,
  tableDelimiterRanges,
  tableModelAt,
  type TableModel,
  type TableRowModel,
} from "./sourceEditorTableModel";

interface CellLocation {
  readonly rowIndex: number;
  readonly column: number;
}

/** Rows a caret can occupy. The delimiter row is structural, never tabbed into. */
function contentRows(model: TableModel): number[] {
  return model.rows.flatMap((row, index) => (row.kind === "delimiter" ? [] : [index]));
}

function locateCell(model: TableModel, pos: number): CellLocation | null {
  for (const rowIndex of contentRows(model)) {
    const row = model.rows[rowIndex]!;
    if (pos < row.from || pos > row.to) continue;
    const exact = row.slots.find((slot) => pos >= slot.from && pos <= slot.to);
    if (exact) return { rowIndex, column: exact.column };
    // Caret sits on a pipe or in a cell's whitespace. Rank by distance to the
    // whole span: ranking on `from` alone resolved a caret in a cell's trailing
    // spaces to the NEXT cell, which turned Tab into "append a row".
    const nearest = [...row.slots].sort(
      (left, right) => distanceToSlot(left, pos) - distanceToSlot(right, pos),
    )[0];
    if (nearest) return { rowIndex, column: nearest.column };
  }
  return null;
}

/** Distance from a position to a slot's span; zero when inside it. */
function distanceToSlot(slot: { from: number; to: number }, pos: number): number {
  return Math.max(slot.from - pos, 0, pos - slot.to);
}

/**
 * The model, but only when the caret is genuinely inside the table. `active()`
 * in the preview layer is exclusive of `to`, so at exactly `table.to` the table
 * still renders as a read-only widget. The commands must agree, or Enter writes
 * a row to a table the user sees as rendered.
 */
function activeTableAt(state: EditorState, pos: number): TableModel | null {
  const model = tableModelAt(state, pos);
  if (!model || pos < model.from || pos >= model.to) return null;
  return model;
}

function selectSlot(row: TableRowModel, column: number): TransactionSpec | null {
  const slot = row.slots.find((candidate) => candidate.column === column);
  if (!slot) return null;
  return {
    selection: EditorSelection.single(slot.from, slot.to),
    scrollIntoView: true,
  };
}

/** `|  |  |` sized to the table, with the caret offset of each empty cell. */
function emptyRow(columnCount: number): { text: string; cellOffsets: number[] } {
  let text = "|";
  const cellOffsets: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    text += " ";
    cellOffsets.push(text.length);
    text += " |";
  }
  return { text, cellOffsets };
}

function appendRow(model: TableModel, column: number): TransactionSpec {
  const { text, cellOffsets } = emptyRow(model.columnCount);
  const anchor = model.to + 1 + (cellOffsets[column] ?? cellOffsets[0] ?? 1);
  return {
    changes: { from: model.to, insert: `\n${text}` },
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
  };
}

function rowIsBlank(state: EditorState, row: TableRowModel): boolean {
  return row.slots.every((slot) => state.sliceDoc(slot.from, slot.to).trim().length === 0);
}

/**
 * Move one cell forward or back, wrapping across rows. Returns null at the
 * table edges so the caller can fall through to the default key behaviour,
 * which is what keeps Tab available for escaping the editor.
 */
export function tableCellStep(state: EditorState, direction: 1 | -1): TransactionSpec | null {
  const pos = state.selection.main.head;
  const model = activeTableAt(state, pos);
  if (!model) return null;
  const location = locateCell(model, pos);
  if (!location) return null;

  const row = model.rows[location.rowIndex]!;
  const nextColumn = location.column + direction;
  if (nextColumn >= 0 && nextColumn < row.slots.length) {
    return selectSlot(row, nextColumn);
  }

  const order = contentRows(model);
  const position = order.indexOf(location.rowIndex);
  const neighbour = order[position + direction];
  if (neighbour === undefined) {
    // At either edge Tab falls through to the browser, so keyboard focus can
    // always leave the editor (WCAG 2.1.2). Growing the table here would both
    // trap focus and write to a file the user only navigated through; Enter is
    // the affordance for adding a row.
    return null;
  }
  const target = model.rows[neighbour]!;
  return selectSlot(target, direction === 1 ? 0 : target.slots.length - 1);
}

/**
 * Enter moves down a column. On the last row it appends one, unless that row is
 * already blank, in which case the blank row is removed and the caret leaves the
 * table. That gives a way out without stranding an empty row behind.
 */
export function tableRowStep(state: EditorState): TransactionSpec | null {
  const pos = state.selection.main.head;
  const model = activeTableAt(state, pos);
  if (!model) return null;
  const location = locateCell(model, pos);
  if (!location) return null;

  const order = contentRows(model);
  const next = order[order.indexOf(location.rowIndex) + 1];
  if (next !== undefined) {
    // Clamp rather than bail: a ragged next row missing this column would
    // otherwise return null and let defaultKeymap split the table mid-row.
    const target = model.rows[next]!;
    const column = Math.min(location.column, Math.max(0, target.slots.length - 1));
    const step = selectSlot(target, column);
    if (step) return step;
  }

  const row = model.rows[location.rowIndex]!;
  if (rowIsBlank(state, row) && row.kind === "body" && isTopLevelRow(state, row)) {
    // Drop the blank row and land below the table. Delete from the END of the
    // previous line, not `row.from - 1`: inside a blockquote or list item the
    // character before the row is the block prefix, not a newline, and cutting
    // there strands an orphaned "> " behind.
    const line = state.doc.lineAt(row.from);
    const from = line.number > 1 ? state.doc.line(line.number - 1).to : model.from;
    return {
      changes: { from, to: model.to, insert: "\n" },
      selection: EditorSelection.cursor(from + 1),
      scrollIntoView: true,
    };
  }
  return appendRow(model, location.column);
}

/**
 * True when the row starts its own line. A table nested in a blockquote or list
 * carries a prefix (`> `, indentation) that the row node excludes, so range
 * arithmetic around the row would eat into that prefix.
 */
function isTopLevelRow(state: EditorState, row: TableRowModel): boolean {
  return state.doc.lineAt(row.from).from === row.from;
}

/**
 * Backspace, Delete and the arrow keys across a hidden cell delimiter.
 *
 * `atomicRanges` cannot do this: both its motion guard
 * (`@codemirror/view` index.js:3734) and its deletion guard
 * (`@codemirror/commands` index.js:1197) require a position strictly inside the
 * range, and a row written `|a|b|` yields a one-character gap that has none. So
 * the keys are owned here instead of delegated.
 *
 * A boundary keystroke MOVES rather than deletes. Removing an invisible
 * delimiter would silently change the table's shape with nothing on screen to
 * explain it; emptying the cell first, then deleting, is the honest path. Rows
 * and columns are removed by their own explicit commands.
 *
 * Returns null whenever the caret is not against a delimiter, so ordinary
 * editing — including deleting the table itself from outside — is untouched.
 */
export function guardTableDelimiter(
  state: EditorState,
  direction: 1 | -1,
): TransactionSpec | null {
  const range = state.selection.main;
  if (!range.empty) return null;

  const model = activeTableAt(state, range.head);
  if (!model) return null;

  const adjacent = tableDelimiterRanges(model).find((delimiter) =>
    direction === -1 ? delimiter.to === range.head : delimiter.from === range.head,
  );
  if (!adjacent) return null;

  // A leading delimiter reached backwards, or a trailing one reached forwards,
  // is the table's outer edge. Falling through lets the user delete the table.
  if (direction === -1 && adjacent.kind === "leading") return null;
  if (direction === 1 && adjacent.kind === "trailing") return null;

  return {
    selection: EditorSelection.cursor(direction === -1 ? adjacent.from : adjacent.to),
    scrollIntoView: true,
  };
}

function delimiterCell(width: number, alignment: string): string {
  if (alignment === "center") return `:${"-".repeat(Math.max(1, width - 2))}:`;
  if (alignment === "left") return `:${"-".repeat(Math.max(1, width - 1))}`;
  if (alignment === "right") return `${"-".repeat(Math.max(1, width - 1))}:`;
  return "-".repeat(Math.max(1, width));
}

/**
 * Write the visual alignment into the file for real. This is the one path that
 * changes bytes, and only ever on an explicit request.
 */
export function formatTableAt(state: EditorState): TransactionSpec | null {
  // `activeTableAt`, not `tableModelAt`: at exactly `table.to` the preview layer
  // still draws the read-only widget, and `tableCellStep` and `tableRowStep`
  // already refuse there. This is the one command that rewrites bytes, so it
  // disagreeing meant Format table could reformat a table the user was looking
  // at as rendered output.
  const model = activeTableAt(state, state.selection.main.head);
  if (!model) return null;
  const widths = tableColumnWidths(state, model);

  // The DELIMITER row defines a GFM table's arity, not the widest row. Sizing
  // every row to the maximum gave the delimiter row an extra cell, so Obsidian
  // then rendered a column that had not existed and previously-discarded text
  // became visible data: formatting changed the document's meaning rather than
  // its whitespace.
  const arity = model.rows.find((row) => row.kind === "delimiter")?.slots.length
    ?? model.columnCount;

  // One change per row, so the line boundaries between rows are never rewritten.
  const changes = model.rows.map((row) => {
    const cells = Array.from({ length: arity }, (_, column) => {
      const slot = row.slots.find((candidate) => candidate.column === column);
      const width = widths[column] ?? 0;
      if (row.kind === "delimiter") {
        return delimiterCell(width, model.alignments[column] ?? "none");
      }
      const text = slot ? state.sliceDoc(slot.from, slot.to) : "";
      return text + " ".repeat(Math.max(0, width - monospaceWidth(text)));
    });

    // Cells beyond the table's arity are left exactly as authored. Renderers
    // already discard them; deleting the user's text to tidy the file would be
    // worse than leaving the row ragged.
    const surplus = row.slots
      .filter((slot) => slot.column >= arity)
      .map((slot) => state.sliceDoc(slot.from, slot.to));
    const tail = surplus.length > 0 ? ` ${surplus.join(" | ")} |` : "";

    return { from: row.from, to: row.to, insert: `| ${cells.join(" | ")} |${tail}` };
  });

  if (changes.every((change) => state.sliceDoc(change.from, change.to) === change.insert)) {
    return null;
  }
  return { changes, scrollIntoView: true };
}

/**
 * The single seam every structural table command dispatches through, and so the
 * one place the delimiter guard's exemption is declared. These commands rewrite
 * whole rows and the delimiter row on purpose, with the result on screen;
 * `tableDelimiterGuard` refuses that same shape of change when it arrives from
 * ordinary editing, where the bytes would vanish unexplained.
 */
function toCommand(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    const spec = build(view.state);
    if (!spec) return false;
    view.dispatch(spec, { annotations: tableStructuralEdit.of(true) });
    return true;
  };
}

export const guardTableDelimiterBackward = toCommand((state) => guardTableDelimiter(state, -1));
export const guardTableDelimiterForward = toCommand((state) => guardTableDelimiter(state, 1));
export const nextTableCell = toCommand((state) => tableCellStep(state, 1));
export const previousTableCell = toCommand((state) => tableCellStep(state, -1));
export const nextTableRow = toCommand(tableRowStep);
export const formatTable = toCommand(formatTableAt);
