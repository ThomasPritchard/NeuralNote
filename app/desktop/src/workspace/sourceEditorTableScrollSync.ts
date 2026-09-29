/** Synchronize each table's row scrollers without moving the whole note.
 *  Rows must share the table's full track width, including its alignment row.
 *
 *  CodeMirror draws caret/selection layers outside the rows; row scrolling
 *  requires a selection-only redraw and separate offscreen visibility signals.
 *  Partially visible selections stay painted. Navigation reveals a cell once;
 *  ordinary scrolling remains unconstrained.
 *
 *  Layout reads during editor updates use requestMeasure. Redraw dispatches
 *  are deferred and excluded from undo; document bytes are never changed.
 *  Design evidence: specs/in-place-table-cell-editing-plan.md, CT-7 addendum.
 */

import { Transaction, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

/** Selector shared with the table line decorations. */
export const TABLE_ROW_SELECTOR = ".nn-lp-table-row";

/** Stylesheet signal: the main caret is outside its row's visible band. */
export const CARET_OFFSCREEN_CLASS = "nn-table-caret-offscreen";

/** Stylesheet signal: the main selection has no visible painted rectangle.
 *  Separate from caret visibility because a selection can straddle the band. */
export const SELECTION_OFFSCREEN_CLASS = "nn-table-selection-offscreen";

/** Ignore subpixel snapping differences to avoid scroll-event feedback loops. */
const SYNC_EPSILON_PX = 1;

/** Allow for the drawn cursor's border around its zero-width text position. */
const CARET_MARGIN_PX = 1;

/** One row's horizontal scroll geometry, in CSS pixels. */
export interface RowGeometry {
  /** The width of the visible band. */
  readonly clientWidth: number;
  /** The width of the scrollable content. */
  readonly scrollWidth: number;
  readonly scrollLeft: number;
  /** Viewport x of the content box's inline-start edge, at `scrollLeft`. */
  readonly contentOrigin: number;
}

/** An inclusive range of scroll offsets. */
export interface OffsetRange {
  readonly min: number;
  readonly max: number;
}

/** A horizontal span in viewport coordinates. Satisfied by a `DOMRect`. */
export interface Span {
  readonly left: number;
  readonly right: number;
}

/**
 * A `Span` that also knows its vertical extent. Satisfied by a `DOMRect` and by
 * the rectangle `coordsAtPos` returns.
 */
export interface MeasuredRect extends Span {
  readonly top: number;
  readonly bottom: number;
}

/** The two ends of a drawn selection, each measured on the side it lies on. */
export interface SelectionEnds {
  readonly from: MeasuredRect;
  readonly to: MeasuredRect;
}

/** The offsets a row can actually hold. */
export function scrollableRange(row: RowGeometry): OffsetRange {
  return { min: 0, max: Math.max(0, row.scrollWidth - row.clientWidth) };
}

export function clampOffset(offset: number, range: OffsetRange): number {
  return Math.min(Math.max(offset, range.min), range.max);
}

/** Test overlap with the planned band in content coordinates, using the
 *  current scroll position to convert viewport coordinates. Partial overlap
 *  remains visible, including a caret straddling the band's edge. */
export function isSpanInBand(row: RowGeometry, span: Span, offset: number): boolean {
  const left = span.left - row.contentOrigin + row.scrollLeft;
  const right = span.right - row.contentOrigin + row.scrollLeft;
  return right >= offset && left <= offset + row.clientWidth;
}

/** Strict vertical overlap distinguishes one visual line from adjacent lines.
 *  Differently sized spans can share a line; uncertain cases stay painted. */
function sharesVisualLine(from: MeasuredRect, to: MeasuredRect): boolean {
  return from.bottom > to.top && to.bottom > from.top;
}

/** Outermost edges also cover reversed bidi ends, keeping visibility conservative. */
function paintedSpan(ends: SelectionEnds): Span {
  return {
    left: Math.min(ends.from.left, ends.to.left),
    right: Math.max(ends.from.right, ends.to.right),
  };
}

/** A selection is hidden only when its single painted rectangle is offscreen.
 *  Across visual lines, CodeMirror paints to the content edges; those rectangles
 *  remain visible in the row bands even when the endpoint union appears outside. */
export function isSelectionInBand(row: RowGeometry, ends: SelectionEnds, offset: number): boolean {
  if (!sharesVisualLine(ends.from, ends.to)) return true;
  return isSpanInBand(row, paintedSpan(ends), offset);
}

/** Reachable offsets that reveal the span; spans wider than the band align
 *  their start so navigation keeps the active position visible. */
export function offsetsKeepingVisible(row: RowGeometry, span: Span): OffsetRange {
  const reachable = scrollableRange(row);
  const contentLeft = span.left - row.contentOrigin + row.scrollLeft;
  const contentRight = span.right - row.contentOrigin + row.scrollLeft;
  const max = clampOffset(contentLeft, reachable);
  const min = clampOffset(contentRight - row.clientWidth, reachable);
  return min > max ? { min: max, max } : { min, max };
}

/** Furthest scrollable row offset; rebuilt or non-scrolling rows at zero
 *  must not drag the rest of the table back to its first column. */
export function tableOffset(rows: readonly RowGeometry[]): number {
  let offset = 0;
  for (const row of rows) {
    if (scrollableRange(row).max > 0) offset = Math.max(offset, row.scrollLeft);
  }
  return offset;
}

/** Table rows are contiguous .cm-line siblings. Find the visible run without
 *  relying on first/last markers, which may be outside the viewport. */
export function tableRowsAt(row: Element): readonly Element[] {
  const rows = [row];
  let before = row.previousElementSibling;
  while (before) {
    if (!before.matches(TABLE_ROW_SELECTOR)) break;
    rows.unshift(before);
    before = before.previousElementSibling;
  }
  let after = row.nextElementSibling;
  while (after) {
    if (!after.matches(TABLE_ROW_SELECTOR)) break;
    rows.push(after);
    after = after.nextElementSibling;
  }
  return rows;
}

/** Every table rendered in `content`, each as its own run of row lines. */
function tableRuns(content: Element): (readonly Element[])[] {
  const children = [...content.children];
  const runs: (readonly Element[])[] = [];
  for (let index = 0; index < children.length; index += 1) {
    if (!children[index]!.matches(TABLE_ROW_SELECTOR)) continue;
    const run = tableRowsAt(children[index]!);
    runs.push(run);
    index += run.length - 1;
  }
  return runs;
}

/** One row that is not where its table wants it, and where that is. */
export interface RowWrite {
  readonly row: Element;
  readonly offset: number;
}

/** Row writes and visibility share one plan: visibility must use the pending
 *  offsets, with independent caret and selection signals. */
interface SyncPlan {
  readonly writes: readonly RowWrite[];
  readonly caretOffscreen: boolean;
  readonly selectionOffscreen: boolean;
}

function readRow(row: Element): RowGeometry {
  return {
    clientWidth: row.clientWidth,
    scrollWidth: row.scrollWidth,
    scrollLeft: row.scrollLeft,
    contentOrigin: row.getBoundingClientRect().left + row.clientLeft,
  };
}

/** The row line rendering `pos`, or null when `pos` is not inside a table. */
function rowAt(view: EditorView, pos: number): Element | null {
  const { from, to } = view.viewport;
  if (pos < from || pos > to) return null;
  const { node } = view.domAtPos(pos);
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(TABLE_ROW_SELECTOR) ?? null;
}

/** The span the drawn cursor occupies around a caret position. */
function caretSpan(coords: Span): Span {
  return { left: coords.left - CARET_MARGIN_PX, right: coords.right + CARET_MARGIN_PX };
}

/** Read the pending offset so visibility agrees with the same frame's writes. */
export function offsetAfter(row: Element, writes: readonly RowWrite[]): number {
  return writes.find((write) => write.row === row)?.offset ?? row.scrollLeft;
}

/**
 * Put every row of one table on `desired`, as far as each can reach. Reads
 * layout; writes nothing, so it is safe inside a `requestMeasure` read phase.
 */
function planSync(rows: readonly Element[], desired: number): readonly RowWrite[] {
  const writes: RowWrite[] = [];
  for (const row of rows) {
    const geometry = readRow(row);
    const offset = clampOffset(desired, scrollableRange(geometry));
    if (Math.abs(geometry.scrollLeft - offset) >= SYNC_EPSILON_PX) writes.push({ row, offset });
  }
  return writes;
}

/** Writes layout; reads nothing. Returns whether anything actually moved. */
function applySync(writes: readonly RowWrite[]): boolean {
  for (const write of writes) write.row.scrollLeft = write.offset;
  return writes.length > 0;
}

/** Scroll, editor updates, caret moves, and navigation share a read/write plan.
 *  This plugin changes only scroll positions, visibility classes, and selection. */
class TableScrollSync implements PluginValue {
  /** Distinct keys, so a reveal and a restore never replace each other. */
  private readonly restoreKey = {};
  private readonly revealKey = {};
  private readonly caretKey = {};
  private redrawPending = false;
  private stopped = false;
  private caretOffscreen = false;
  private selectionOffscreen = false;

  constructor(private readonly view: EditorView) {
    // Capture, because a `scroll` event on an element does not bubble. Passive,
    // because nothing here cancels it.
    view.scrollDOM.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.measure(this.restoreKey, () => this.planTables());
      return;
    }
    // Selection can leave the visible band without scrolling. Focus changes
    // can replace the DOM class attribute; our own redraw leaves selection equal.
    if (update.focusChanged || !update.state.selection.eq(update.startState.selection)) {
      this.measure(this.caretKey, () => this.plan([]));
    }
  }

  destroy(): void {
    this.stopped = true;
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll, { capture: true });
    // The view outlives this plugin across a reconfiguration. A flag left
    // behind on it is a cursor, or a selection, that never comes back.
    this.caretOffscreen = false;
    this.selectionOffscreen = false;
    this.stampSignals();
  }

  /**
   * Bring `range`'s cell into its row's band. The read is deferred because a
   * scroll handler runs inside an update, where reading the editor's layout
   * throws.
   */
  reveal(range: SelectionRange): void {
    this.measure(this.revealKey, () => this.planReveal(range.head));
  }

  private measure(key: object, read: () => SyncPlan): void {
    this.view.requestMeasure({ key, read, write: (plan) => { this.commit(plan); } });
  }

  private readonly onScroll = (event: Event): void => {
    const { target } = event;
    const row = target instanceof Element ? target.closest(TABLE_ROW_SELECTOR) : null;
    if (!row) return;
    this.commit(this.plan(planSync(tableRowsAt(row), row.scrollLeft)));
  };

  /** Every table back onto its own offset — the one its rows still agree on. */
  private planTables(): SyncPlan {
    return this.plan(tableRuns(this.view.contentDOM)
      .flatMap((rows) => planSync(rows, tableOffset(rows.map(readRow)))));
  }

  /** Reveal the navigation target once; never constrain subsequent user scrolling. */
  private planReveal(pos: number): SyncPlan {
    const row = rowAt(this.view, pos);
    if (!row) return this.plan([]);
    const rows = tableRowsAt(row);
    const current = tableOffset(rows.map(readRow));
    const coords = this.view.coordsAtPos(pos);
    const desired = coords
      ? clampOffset(current, offsetsKeepingVisible(readRow(row), caretSpan(coords)))
      : current;
    return this.plan(planSync(rows, desired));
  }

  /** `writes`, plus the two questions the offsets they carry imply. */
  private plan(writes: readonly RowWrite[]): SyncPlan {
    return {
      writes,
      caretOffscreen: this.isCaretOffscreen(writes),
      selectionOffscreen: this.isSelectionOffscreen(writes),
    };
  }

  /** Hide only a measured main caret outside its row's planned band. Missing
 *  coordinates keep it visible rather than making an uncertain cursor vanish. */
  private isCaretOffscreen(writes: readonly RowWrite[]): boolean {
    const caret = this.view.state.selection.main.head;
    const row = rowAt(this.view, caret);
    if (!row) return false;
    const coords = this.view.coordsAtPos(caret);
    if (!coords) return false;
    return !isSpanInBand(readRow(row), caretSpan(coords), offsetAfter(row, writes));
  }

  /** Hide only the measured main selection when fully outside its planned band.
 *  Empty, unmeasurable, or non-table selections remain visible. Secondary ranges
 *  cannot hide the shared layer while the main range is still visible. */
  private isSelectionOffscreen(writes: readonly RowWrite[]): boolean {
    const { main } = this.view.state.selection;
    if (main.empty) return false;
    const row = rowAt(this.view, main.from);
    if (!row) return false;
    // Measure each endpoint on the side occupied by the selected text.
    const from = this.view.coordsAtPos(main.from, 1);
    const to = this.view.coordsAtPos(main.to, -1);
    if (!from || !to) return false;
    return !isSelectionInBand(readRow(row), { from, to }, offsetAfter(row, writes));
  }

  private commit(plan: SyncPlan): void {
    if (this.suspended) return;
    this.caretOffscreen = plan.caretOffscreen;
    this.selectionOffscreen = plan.selectionOffscreen;
    this.stampSignals();
    if (applySync(plan.writes)) this.scheduleRedraw();
  }

  /** Stamp after the editor update: CodeMirror can replace view.dom's class
 *  attribute after plugin updates, so measure callbacks restore our flags. */
  private stampSignals(): void {
    const { classList } = this.view.dom;
    classList.toggle(CARET_OFFSCREEN_CLASS, this.caretOffscreen);
    classList.toggle(SELECTION_OFFSCREEN_CLASS, this.selectionOffscreen);
  }

  /** Avoid layout changes and selection redispatch during IME composition.
 *  compositionStarted covers its initial frame, before composing becomes true;
 *  restore offsets on the first update after composition ends. */
  private get suspended(): boolean {
    return this.stopped || this.view.compositionStarted;
  }

  /** Defer dispatch out of measure phases and coalesce sibling scroll events. */
  private scheduleRedraw(): void {
    if (this.redrawPending || this.suspended) return;
    this.redrawPending = true;
    queueMicrotask(() => {
      this.redrawPending = false;
      if (this.suspended) return;
      this.view.dispatch({
        selection: this.view.state.selection,
        annotations: Transaction.addToHistory.of(false),
      });
    });
  }
}

const tableScrollSyncPlugin = ViewPlugin.fromClass(TableScrollSync);

/**
 * Register alongside the other source-editor extensions. It needs the row
 * lines P3b stamps and the scroll containers P3c declares; with neither, every
 * path here finds no rows and does nothing.
 */
export const tableScrollSync: Extension = [
  tableScrollSyncPlugin,
  EditorView.scrollHandler.of((view, range) => {
    view.plugin(tableScrollSyncPlugin)?.reveal(range);
    // False, not true: the block axis is still CodeMirror's to handle, and a
    // handler cannot read layout to find out whether it is needed. Claiming
    // the whole scroll here would strand a table below the fold.
    return false;
  }),
];
