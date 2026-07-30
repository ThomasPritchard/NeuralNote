import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

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
      const width = monospaceWidth(state.sliceDoc(slot.from, slot.to));
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
export type TableDelimiterKind = "leading" | "divider" | "trailing" | "rule";

/** A span of source to hide and replace with drawn chrome. */
export interface TableDelimiterRange {
  readonly from: number;
  readonly to: number;
  readonly kind: TableDelimiterKind;
  /**
   * Extra columns this gap renders, to bring its neighbouring cells up to their
   * column width. Folded into the gap rather than emitted as separate padding
   * widgets, because a widget sitting at the boundary of a replaced range is
   * not painted at all.
   */
  readonly padColumns: number;
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
export function tableDelimiterRanges(
  model: TableModel,
  state?: EditorState,
  widths: readonly number[] = [],
): TableDelimiterRange[] {
  const ranges: TableDelimiterRange[] = [];

  /** Columns a cell must gain to reach its column width, split by alignment. */
  const padding = (slot: TableColumnSlot | undefined) => {
    if (!slot || !state) return { before: 0, after: 0 };
    const deficit = (widths[slot.column] ?? 0)
      - monospaceWidth(state.sliceDoc(slot.from, slot.to));
    if (deficit <= 0) return { before: 0, after: 0 };
    switch (model.alignments[slot.column] ?? "none") {
      case "right":
        return { before: deficit, after: 0 };
      case "center": {
        const before = Math.floor(deficit / 2);
        return { before, after: deficit - before };
      }
      default:
        return { before: 0, after: deficit };
    }
  };

  for (const row of model.rows) {
    if (row.kind === "delimiter") {
      if (row.to > row.from) {
        ranges.push({ from: row.from, to: row.to, kind: "rule", padColumns: 0 });
      }
      continue;
    }

    const slots = [...row.slots].sort((left, right) => left.from - right.from);
    if (slots.length === 0) continue;

    // Everything before the first cell's content: `| ` when the row opens with
    // a pipe, nothing when GFM's optional leading pipe was omitted.
    if (slots[0]!.from > row.from) {
      ranges.push({
        from: row.from,
        to: slots[0]!.from,
        kind: "leading",
        padColumns: padding(slots[0]).before,
      });
    }

    for (let index = 0; index < slots.length - 1; index += 1) {
      const gapFrom = slots[index]!.to;
      const gapTo = slots[index + 1]!.from;
      if (gapTo <= gapFrom) continue;
      ranges.push({
        from: gapFrom,
        to: gapTo,
        kind: "divider",
        padColumns: padding(slots[index]).after + padding(slots[index + 1]).before,
      });
    }

    const last = slots.at(-1)!;
    if (row.to > last.to) {
      ranges.push({
        from: last.to,
        to: row.to,
        kind: "trailing",
        padColumns: padding(last).after,
      });
    }
  }

  return ranges;
}

/**
 * Width each column must render at: its widest CONTENT.
 *
 * Under drawn chrome every pipe and the whitespace around it is hidden, so a
 * cell renders as content plus padding and nothing else. Measuring the
 * pipe-to-pipe span would count characters that are no longer painted.
 */
export function tableSegmentWidths(state: EditorState, model: TableModel): number[] {
  const widths = Array.from({ length: model.columnCount }, () => 0);
  for (const row of model.rows) {
    if (row.kind === "delimiter") continue;
    for (const slot of row.slots) {
      const content = monospaceWidth(state.sliceDoc(slot.from, slot.to));
      widths[slot.column] = Math.max(widths[slot.column] ?? 0, content);
    }
  }
  return widths;
}
