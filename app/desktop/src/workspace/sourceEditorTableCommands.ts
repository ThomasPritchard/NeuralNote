import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command } from "@codemirror/view";

import {
  displayWidth,
  tableColumnWidths,
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
    // Caret sits on a pipe or in padding: fall back to the nearest slot start.
    const nearest = [...row.slots].sort(
      (left, right) => Math.abs(left.from - pos) - Math.abs(right.from - pos),
    )[0];
    if (nearest) return { rowIndex, column: nearest.column };
  }
  return null;
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
  const model = tableModelAt(state, pos);
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
    // Past the last cell, Tab grows the table; before the first, do nothing.
    return direction === 1 ? appendRow(model, 0) : null;
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
  const model = tableModelAt(state, pos);
  if (!model) return null;
  const location = locateCell(model, pos);
  if (!location) return null;

  const order = contentRows(model);
  const next = order[order.indexOf(location.rowIndex) + 1];
  if (next !== undefined) return selectSlot(model.rows[next]!, location.column);

  const row = model.rows[location.rowIndex]!;
  if (rowIsBlank(state, row) && row.kind === "body") {
    return {
      changes: { from: Math.max(model.from, row.from - 1), to: model.to, insert: "\n\n" },
      selection: EditorSelection.cursor(Math.max(model.from, row.from - 1) + 2),
      scrollIntoView: true,
    };
  }
  return appendRow(model, location.column);
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
  const model = tableModelAt(state, state.selection.main.head);
  if (!model) return null;
  const widths = tableColumnWidths(state, model);

  // One change per row, so the line boundaries between rows are never rewritten.
  const changes = model.rows.map((row) => {
    const cells = Array.from({ length: model.columnCount }, (_, column) => {
      const slot = row.slots.find((candidate) => candidate.column === column);
      const width = widths[column] ?? 0;
      if (row.kind === "delimiter") {
        return delimiterCell(width, model.alignments[column] ?? "none");
      }
      const text = slot ? state.sliceDoc(slot.from, slot.to) : "";
      return text + " ".repeat(Math.max(0, width - displayWidth(text)));
    });
    return { from: row.from, to: row.to, insert: `| ${cells.join(" | ")} |` };
  });

  if (changes.every((change) => state.sliceDoc(change.from, change.to) === change.insert)) {
    return null;
  }
  return { changes, scrollIntoView: true };
}

function toCommand(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    const spec = build(view.state);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  };
}

export const nextTableCell = toCommand((state) => tableCellStep(state, 1));
export const previousTableCell = toCommand((state) => tableCellStep(state, -1));
export const nextTableRow = toCommand(tableRowStep);
export const formatTable = toCommand(formatTableAt);
