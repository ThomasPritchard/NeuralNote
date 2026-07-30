import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

export type ColumnAlignment = "none" | "left" | "center" | "right";
export type TablePadFill = "space" | "dash";
export type TableRowKind = "header" | "delimiter" | "body";

/**
 * One column's slot within a row. An empty cell still gets a slot with
 * `from === to`, because the parser emits no `TableCell` node for it and the
 * column index would otherwise shift left for every later cell in the row.
 */
export interface TableColumnSlot {
  readonly column: number;
  readonly from: number;
  readonly to: number;
  /**
   * The full pipe-to-pipe span, including the whitespace around the content.
   * Alignment must be measured against this, not the trimmed content: a cell
   * that already carries trailing spaces renders wider than its content, so
   * padding the content alone over-pads an already-aligned table.
   */
  readonly segmentFrom: number;
  readonly segmentTo: number;
}

export interface TableRowModel {
  readonly kind: TableRowKind;
  readonly from: number;
  readonly to: number;
  readonly slots: readonly TableColumnSlot[];
}

export interface TableModel {
  readonly from: number;
  readonly to: number;
  readonly columnCount: number;
  readonly alignments: readonly ColumnAlignment[];
  readonly rows: readonly TableRowModel[];
}

/** A purely visual insertion. It carries no range, so it can never edit the document. */
export interface TablePad {
  readonly pos: number;
  readonly width: number;
  readonly fill: TablePadFill;
  readonly side: -1 | 1;
}

const MIN_DELIMITER_WIDTH = 3;

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * Monospace column count for a cell. Graphemes rather than code units, so a
 * multi-code-point emoji occupies one column instead of two or more.
 */
export function displayWidth(text: string): number {
  if (!segmenter) return [...text].length;
  let width = 0;
  for (const _ of segmenter.segment(text)) width += 1;
  return width;
}

function enclosingTable(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node && node.name !== "Table") node = node.parent;
    if (node) return node;
  }
  return null;
}

function pipePositions(row: SyntaxNode): number[] {
  const positions: number[] = [];
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") positions.push(child.from);
  }
  return positions;
}

function scanPipePositions(text: string, base: number): number[] {
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") positions.push(base + index);
  }
  return positions;
}

/**
 * Split a row into one segment per column. Segments run from the row start to
 * the first pipe, between consecutive pipes, and from the last pipe to the row
 * end. Only the outermost segments are dropped when blank, which keeps a
 * genuinely empty middle cell (`| x |  | z |`) while discarding the artefacts of
 * an optional leading pipe and any trailing whitespace after the closing one.
 */
function rowSegments(
  from: number,
  to: number,
  pipes: readonly number[],
  slice: (start: number, end: number) => string,
): Array<{ from: number; to: number }> {
  if (pipes.length === 0) return [{ from, to }];
  const segments = [{ from, to: pipes[0]! }];
  for (let index = 0; index < pipes.length - 1; index += 1) {
    segments.push({ from: pipes[index]! + 1, to: pipes[index + 1]! });
  }
  segments.push({ from: pipes.at(-1)! + 1, to });

  const blank = (segment: { from: number; to: number }) =>
    slice(segment.from, segment.to).trim().length === 0;
  if (segments.length > 0 && blank(segments[0]!)) segments.shift();
  if (segments.length > 0 && blank(segments.at(-1)!)) segments.pop();
  return segments;
}

function toSlots(
  segments: readonly { from: number; to: number }[],
  slice: (start: number, end: number) => string,
): TableColumnSlot[] {
  return segments.map((segment, column) => {
    const text = slice(segment.from, segment.to);
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;
    const bounds = { segmentFrom: segment.from, segmentTo: segment.to };
    if (leading + trailing >= text.length) {
      // Blank cell: anchor just inside the opening space so typing reads `| x |`.
      const anchor = Math.min(segment.from + (text.startsWith(" ") ? 1 : 0), segment.to);
      return { column, from: anchor, to: anchor, ...bounds };
    }
    return { column, from: segment.from + leading, to: segment.to - trailing, ...bounds };
  });
}

function alignmentOf(text: string): ColumnAlignment {
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

export function tableModelAt(state: EditorState, pos: number): TableModel | null {
  const table = enclosingTable(state, pos);
  if (!table) return null;
  const slice = (start: number, end: number) => state.sliceDoc(start, end);

  const rows: TableRowModel[] = [];
  let alignments: ColumnAlignment[] = [];

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader" || child.name === "TableRow") {
      rows.push({
        kind: child.name === "TableHeader" ? "header" : "body",
        from: child.from,
        to: child.to,
        slots: toSlots(rowSegments(child.from, child.to, pipePositions(child), slice), slice),
      });
    } else if (child.name === "TableDelimiter") {
      // The delimiter row arrives as one flat node with no cell children.
      const text = slice(child.from, child.to);
      const slots = toSlots(
        rowSegments(child.from, child.to, scanPipePositions(text, child.from), slice),
        slice,
      );
      alignments = slots.map((slot) => alignmentOf(slice(slot.from, slot.to)));
      rows.push({ kind: "delimiter", from: child.from, to: child.to, slots });
    }
  }

  if (rows.length === 0) return null;
  const columnCount = Math.max(...rows.map((row) => row.slots.length));
  return { from: table.from, to: table.to, columnCount, alignments, rows };
}

export function tableColumnWidths(state: EditorState, model: TableModel): number[] {
  const widths = Array.from({ length: model.columnCount }, () => MIN_DELIMITER_WIDTH);
  for (const row of model.rows) {
    for (const slot of row.slots) {
      const width = displayWidth(state.sliceDoc(slot.from, slot.to));
      widths[slot.column] = Math.max(widths[slot.column] ?? MIN_DELIMITER_WIDTH, width);
    }
  }
  return widths;
}

/**
 * On-screen width of each column as it currently renders: the whole pipe-to-pipe
 * span, whitespace included. Alignment must target this rather than the trimmed
 * content width, because a cell carrying trailing spaces already renders wider
 * than its content and padding the content alone would push it wider still.
 */
export function tableSegmentWidths(state: EditorState, model: TableModel): number[] {
  const widths = Array.from({ length: model.columnCount }, () => 0);
  for (const row of model.rows) {
    for (const slot of row.slots) {
      const width = displayWidth(state.sliceDoc(slot.segmentFrom, slot.segmentTo));
      widths[slot.column] = Math.max(widths[slot.column] ?? 0, width);
    }
  }
  return widths;
}

export function tableAlignmentPads(
  state: EditorState,
  model: TableModel,
  widths: readonly number[],
): TablePad[] {
  const pads: TablePad[] = [];
  for (const row of model.rows) {
    for (const slot of row.slots) {
      const segment = state.sliceDoc(slot.segmentFrom, slot.segmentTo);
      const deficit = (widths[slot.column] ?? 0) - displayWidth(segment);
      if (deficit <= 0) continue;

      if (row.kind === "delimiter") {
        // Grow the dash run in place, staying inside a trailing alignment colon.
        const text = state.sliceDoc(slot.from, slot.to);
        const pos = text.endsWith(":") ? Math.max(slot.from, slot.to - 1) : slot.to;
        pads.push({ pos, width: deficit, fill: "dash", side: 1 });
        continue;
      }

      switch (model.alignments[slot.column] ?? "none") {
        case "right":
          pads.push({ pos: slot.segmentFrom, width: deficit, fill: "space", side: -1 });
          break;
        case "center": {
          const before = Math.floor(deficit / 2);
          if (before > 0) {
            pads.push({ pos: slot.segmentFrom, width: before, fill: "space", side: -1 });
          }
          if (deficit - before > 0) {
            pads.push({ pos: slot.segmentTo, width: deficit - before, fill: "space", side: 1 });
          }
          break;
        }
        default:
          pads.push({ pos: slot.segmentTo, width: deficit, fill: "space", side: 1 });
      }
    }
  }
  return pads;
}
