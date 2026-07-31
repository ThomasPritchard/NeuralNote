import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { cellPaintPlan, type CellPaintPlan } from "./sourceEditorCellPaintPlan";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

export type ColumnAlignment = "none" | "left" | "center" | "right";
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

const MIN_DELIMITER_WIDTH = 3;

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * Code points that render two columns wide in a monospace font: the East Asian
 * Wide (W) and Fullwidth (F) classes of Unicode Annex #11, plus emoji. Ranges
 * rather than a per-character table, because the classes are contiguous blocks.
 */
const DOUBLE_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, small form variants
  [0xff00, 0xff60], // Fullwidth ASCII variants
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: symbols, pictographs, emoticons
  [0x1f900, 0x1f9ff], // Emoji: supplemental symbols and pictographs
  [0x17000, 0x18aff], // Tangut
  [0x1b000, 0x1b12f], // Kana supplement
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extensions B onward
];

/** Code points that occupy no column at all: combining marks and joiners. */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) // combining diacritical marks
    || code === 0x200b // zero-width space
    || code === 0x200d // zero-width joiner
    || (code >= 0xfe00 && code <= 0xfe0f) // variation selectors
    || code === 0x20e3 // combining enclosing keycap
  );
}

function isDoubleWidth(code: number): boolean {
  return DOUBLE_WIDTH_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * How many columns a string occupies in a monospace font.
 *
 * Counting graphemes is wrong: CJK ideographs, Hangul syllables, fullwidth
 * forms and emoji all render two columns wide, so a grapheme count pads a CJK
 * table to visibly ragged columns (issue #86). A grapheme's width is taken from
 * its FIRST non-zero-width code point, which makes an emoji ZWJ sequence such
 * as a family emoji count as one glyph of width 2 rather than as its parts.
 */
export function monospaceWidth(text: string): number {
  const clusters = segmenter
    ? [...segmenter.segment(text)].map((entry) => entry.segment)
    : [...text];

  let width = 0;
  for (const cluster of clusters) {
    let clusterWidth = 0;
    for (const character of cluster) {
      const code = character.codePointAt(0);
      if (code === undefined || isZeroWidth(code)) continue;
      clusterWidth = isDoubleWidth(code) ? 2 : 1;
      break;
    }
    width += clusterWidth;
  }
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
    if (leading + trailing >= text.length) {
      // Blank cell: anchor just inside the opening space so typing reads `| x |`.
      const anchor = Math.min(segment.from + (text.startsWith(" ") ? 1 : 0), segment.to);
      return { column, from: anchor, to: anchor };
    }
    return { column, from: segment.from + leading, to: segment.to - trailing };
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
      const width = monospaceWidth(state.sliceDoc(slot.from, slot.to));
      widths[slot.column] = Math.max(widths[slot.column] ?? MIN_DELIMITER_WIDTH, width);
    }
  }
  return widths;
}

export type TableDelimiterKind = "leading" | "divider" | "trailing" | "rule";

/** A span of source to hide and replace with drawn chrome. */
export interface TableDelimiterRange {
  readonly from: number;
  readonly to: number;
  readonly kind: TableDelimiterKind;
}

/**
 * The spans to hide when a table is drawn as cells rather than as pipes.
 *
 * Deliberately the whole gap between two cells — the trailing space, the pipe
 * and the leading space — not the bare pipe. `atomicRanges` protects a range
 * only from a position strictly inside it (`@codemirror/view` index.js:3734 and
 * `@codemirror/commands` index.js:1197), and a one-character range has none, so
 * hiding just the pipe would leave Backspace free to delete an invisible
 * delimiter and silently re-shape the table.
 *
 * The delimiter row is returned whole, as a single `rule` range: it carries no
 * user content and is drawn as the header rule.
 */
export function tableDelimiterRanges(model: TableModel): TableDelimiterRange[] {
  const ranges: TableDelimiterRange[] = [];

  for (const row of model.rows) {
    if (row.kind === "delimiter") {
      if (row.to > row.from) ranges.push({ from: row.from, to: row.to, kind: "rule" });
      continue;
    }

    const slots = [...row.slots].sort((left, right) => left.from - right.from);
    if (slots.length === 0) continue;

    // Everything before the first cell's content: `| ` when the row opens with
    // a pipe, nothing when GFM's optional leading pipe was omitted.
    if (slots[0]!.from > row.from) {
      ranges.push({ from: row.from, to: slots[0]!.from, kind: "leading" });
    }

    for (let index = 0; index < slots.length - 1; index += 1) {
      const gapFrom = slots[index]!.to;
      const gapTo = slots[index + 1]!.from;
      if (gapTo > gapFrom) ranges.push({ from: gapFrom, to: gapTo, kind: "divider" });
    }

    const last = slots.at(-1)!;
    if (row.to > last.to) ranges.push({ from: last.to, to: row.to, kind: "trailing" });
  }

  return ranges;
}

/* ------------------------------------------------------------------------- *
 * CT-2 — the render plan: which grid column every drawn element belongs to,
 * and the track list each row line stamps.
 * ------------------------------------------------------------------------- */

/**
 * Breathing room inside a track, past the text it holds. It belongs to the
 * producer rather than the stylesheet because CT-2 reserves
 * `grid-template-columns` for `var(--nn-table-tracks)` alone: a gutter authored
 * in CSS would have to be a literal template, which fights the stamp.
 *
 * Two constants, one intent, because the two track modes measure in different
 * units — {@link CELL_TRACK_GUTTER_PX} pairs with a measured pixel width and
 * {@link CELL_TRACK_GUTTER_CH} with the character fallback.
 */
export const CELL_TRACK_GUTTER_PX = 16;
export const CELL_TRACK_GUTTER_CH = 2;

/**
 * Why a cell exists. `content` has source a `Decoration.mark` can cover;
 * `empty` is a column the row declares and leaves blank; `filler` is a column
 * the table declares and this row never wrote. The last two carry no source at
 * all, so they can only be zero-length widgets — a mark may not be empty.
 */
export type TableCellKind = "content" | "empty" | "filler";

/** Which end of the table a row line sits at. Stamped, never inferred (CT-1). */
export type TableRowEdge = "first" | "last" | null;

export interface TableRenderCell {
  /** The stamped `grid-column`, counting from one. */
  readonly column: number;
  readonly from: number;
  readonly to: number;
  readonly kind: TableCellKind;
}

export interface TableRenderChrome extends TableDelimiterRange {
  /** The stamped `grid-column`: the column this chrome opens, or the rule's span. */
  readonly gridColumn: string;
}

export interface TableRenderRow {
  readonly kind: TableRowKind;
  readonly edge: TableRowEdge;
  /** Start of the line the row occupies, where its `Decoration.line` anchors. */
  readonly lineFrom: number;
  readonly className: string;
  readonly cells: readonly TableRenderCell[];
  readonly chrome: readonly TableRenderChrome[];
}

export interface TableRenderPlan {
  readonly from: number;
  readonly to: number;
  /** The `--nn-table-tracks` value: one track per declared column. */
  readonly trackTemplate: string;
  readonly rows: readonly TableRenderRow[];
}

export interface TableRenderOptions {
  /**
   * CT-4's measurement probe. `null` for a cell means "not primed yet", which
   * is the normal first frame rather than an error, and drops the whole table
   * to character tracks.
   */
  readonly measureCell?: (plan: CellPaintPlan) => number | null;
}

/** The row line's own classes, in the order CT-1 freezes them. */
export function tableRowClassName(kind: TableRowKind, edge: TableRowEdge): string {
  const hooks = ["nn-lp-table-row", `nn-lp-table-row-${kind}`];
  if (edge) hooks.push(`nn-lp-table-row-${edge}`);
  return hooks.join(" ");
}

/** What one cell paints, as the single projection both widths and text read. */
function slotPaintPlan(
  state: EditorState,
  row: TableRowModel,
  slot: TableColumnSlot,
): CellPaintPlan {
  return cellPaintPlan(state, { from: slot.from, to: slot.to }, {
    context: row.kind === "header" ? "header" : "body",
  });
}

interface ColumnWidth {
  /** Measured pixels, or `null` once any cell in the column is unmeasured. */
  readonly px: number | null;
  readonly ch: number;
}

/**
 * How wide each column's widest cell PAINTS.
 *
 * Deliberately read off {@link cellPaintPlan} rather than the source text. G3:
 * `**bold**` is eight source characters and four painted ones, so a width taken
 * from the source belongs to a different string than the user sees — which
 * shows up as column jitter, not as an error.
 */
function columnWidths(
  state: EditorState,
  model: TableModel,
  measureCell: TableRenderOptions["measureCell"],
): ColumnWidth[] {
  const widths: ColumnWidth[] = Array.from(
    { length: model.columnCount },
    () => ({ px: 0, ch: 0 }),
  );
  for (const row of model.rows) {
    if (row.kind === "delimiter") continue;
    for (const slot of row.slots) {
      const current = widths[slot.column];
      if (!current) continue;
      const plan = slotPaintPlan(state, row, slot);
      const measured = measureCell?.(plan) ?? null;
      widths[slot.column] = {
        px: current.px === null || measured === null ? null : Math.max(current.px, measured),
        ch: Math.max(current.ch, monospaceWidth(plan.visibleText)),
      };
    }
  }
  return widths;
}

/**
 * The stamped track list. Pixels once every column has been measured, and
 * character widths until then — never a mix, because two columns sized in
 * different units are aligned to neither.
 */
function trackTemplate(
  state: EditorState,
  model: TableModel,
  measureCell: TableRenderOptions["measureCell"],
): string {
  const widths = columnWidths(state, model, measureCell);
  return widths.every((width) => width.px !== null)
    ? widths.map((width) => `${width.px! + CELL_TRACK_GUTTER_PX}px`).join(" ")
    : widths.map((width) => `${width.ch + CELL_TRACK_GUTTER_CH}ch`).join(" ");
}

/**
 * Every cell of one row, including the columns it never declared.
 *
 * A filler is anchored at the last declared cell's `to` — the offset the
 * trailing chrome also starts at — so the closing edge stays the row's last
 * stamped child while the filler still holds its column open (CT-1).
 */
function renderCells(row: TableRowModel, columnCount: number): TableRenderCell[] {
  const cells: TableRenderCell[] = row.slots.map((slot) => ({
    column: slot.column + 1,
    from: slot.from,
    to: slot.to,
    kind: slot.from === slot.to ? "empty" : "content",
  }));
  const last = row.slots.at(-1);
  if (!last) return cells;
  for (let column = row.slots.length; column < columnCount; column += 1) {
    cells.push({ column: column + 1, from: last.to, to: last.to, kind: "filler" });
  }
  return cells;
}

/**
 * The row's hidden spans, each stamped with the column it opens.
 *
 * Looked up by the exact offset {@link tableDelimiterRanges} keys them on, so
 * the drawn chrome and the spans the delimiter guard protects can never be two
 * different answers. A gap that produced no range — the omitted leading pipe of
 * a GFM row, say — simply has no chrome, because there is nothing there to hide.
 */
function renderChrome(
  row: TableRowModel,
  columnCount: number,
  rangeFrom: ReadonlyMap<number, TableDelimiterRange>,
): TableRenderChrome[] {
  const chrome: TableRenderChrome[] = [];
  const at = (from: number, gridColumn: string) => {
    const range = rangeFrom.get(from);
    if (range) chrome.push({ ...range, gridColumn });
  };

  if (row.kind === "delimiter") {
    at(row.from, "1 / -1");
    return chrome;
  }

  at(row.from, "1");
  for (let index = 1; index < row.slots.length; index += 1) {
    at(row.slots[index - 1]!.to, String(index + 1));
  }
  const last = row.slots.at(-1);
  // K7d: the closing edge belongs at the table's last column even on a ragged
  // row, or it lands inside the content columns.
  if (last) at(last.to, String(columnCount));
  return chrome;
}

/**
 * Project a table onto what the editor draws for it: one cell per declared
 * column on every row, the chrome that hides each delimiter, and the track list
 * every row line stamps.
 *
 * @param state - the editor state the table belongs to
 * @param model - the table, as {@link tableModelAt} reports it
 * @param options - the measurement probe, when one has been primed
 * @returns the rows in document order, each with its cells, chrome and hooks
 */
export function tableRenderPlan(
  state: EditorState,
  model: TableModel,
  options: TableRenderOptions = {},
): TableRenderPlan {
  const rangeFrom = new Map(tableDelimiterRanges(model).map((range) => [range.from, range]));
  const lastRow = model.rows.length - 1;
  return {
    from: model.from,
    to: model.to,
    trackTemplate: trackTemplate(state, model, options.measureCell),
    rows: model.rows.map((row, index) => {
      const edge: TableRowEdge = index === 0 ? "first" : index === lastRow ? "last" : null;
      return {
        kind: row.kind,
        edge,
        lineFrom: state.doc.lineAt(row.from).from,
        className: tableRowClassName(row.kind, edge),
        cells: row.kind === "delimiter" ? [] : renderCells(row, model.columnCount),
        chrome: renderChrome(row, model.columnCount, rangeFrom),
      };
    }),
  };
}
