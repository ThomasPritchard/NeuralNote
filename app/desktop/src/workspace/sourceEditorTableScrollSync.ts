/**
 * P3d — row-scroll synchronisation for tables drawn as cells (CT-7).
 *
 * A wide table scrolls inside itself instead of dragging the note sideways, and
 * under that decision (G2) every row line is its own scroll container. Three
 * things follow, each measured in P0 rather than assumed:
 *
 * **One offset per table.** Rows scroll independently by default, so this
 * module keeps them on a single offset. A row whose content fits its band
 * cannot follow at all — P0 K6 measured the alignment row sitting at 0 while
 * six rows moved to 193px — which is why every row is forced to the table's
 * full width by CT-2's stamped tracks. That is a producer contract, so the
 * browser spec asserts it rather than this module assuming it.
 *
 * **The drawn caret has to be re-derived.** `drawSelection()`'s cursor and
 * selection layers are appended to `view.scrollDOM`
 * (`@codemirror/view/dist/index.js:9403`), siblings of the content and outside
 * every row, and element `scroll` events do not bubble — so a scrolling row
 * tells CodeMirror nothing and the caret is left behind by the scroll offset
 * (measured: 380.41px). `view.requestMeasure` does not fix it: a `LayerView`
 * re-queues its own measure only when `layer.update()` returns true (`:9417`),
 * and that returns `update.docChanged || update.selectionSet || confChange`
 * (`:9557`). Re-dispatching the selection makes it true, and recovered the
 * drift to -0.59px at a per-frame cost indistinguishable from baseline.
 *
 * **The offset is clamped to keep the caret visible.** CT-7's rule: while the
 * main caret is inside a table, that table's offset stays in the range that
 * keeps the caret's own character inside the row's band. Without it the drawn
 * caret paints outside the row (measured: 369.92px past the inline-end edge)
 * over unrelated text, and clipping CodeMirror's own layers is kill criterion
 * 13. The clamp costs one comparison on coordinates this module already holds.
 *
 * Revealing a cell rides the same clamp. `scrollRectIntoView` is called on
 * `.cm-scroller` (`:3449`) and only ever walks *up*, so it cannot descend into
 * a row: P0 K6 measured the off-screen cell moving 0px. A scroll handler that
 * reads layout inline throws ("Reading the editor layout isn't allowed during
 * an update"), so the read is deferred to `view.requestMeasure`.
 *
 * **Nothing here changes the document.** The only transaction it dispatches
 * carries a selection and nothing else, annotated out of the undo history.
 */

import { Transaction, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

/** The row line CT-1 freezes. P3b stamps it; nothing here creates it. */
export const TABLE_ROW_SELECTOR = ".nn-lp-table-row";

/**
 * Below this, a difference is device-pixel snapping rather than a scroll: a row
 * written to 193 can read back 192.5. Writing anyway would make every sibling's
 * scroll event a fresh correction, and the corrections would never settle.
 */
const SYNC_EPSILON_PX = 1;

/**
 * The drawn cursor is a marker with a `margin-left: -0.6px` of its own, so the
 * caret's character is kept this far inside the band rather than flush with it.
 */
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

/** The offsets a row can actually hold. */
export function scrollableRange(row: RowGeometry): OffsetRange {
  return { min: 0, max: Math.max(0, row.scrollWidth - row.clientWidth) };
}

export function clampOffset(offset: number, range: OffsetRange): number {
  return Math.min(Math.max(offset, range.min), range.max);
}

/**
 * The offsets that keep `span` inside `row`'s visible band. Where the span is
 * wider than the band the two bounds cross; the range then collapses onto the
 * span's start, because showing where you are beats showing where you end.
 */
export function offsetsKeepingVisible(row: RowGeometry, span: Span): OffsetRange {
  const reachable = scrollableRange(row);
  const contentLeft = span.left - row.contentOrigin + row.scrollLeft;
  const contentRight = span.right - row.contentOrigin + row.scrollLeft;
  const max = clampOffset(contentLeft, reachable);
  const min = clampOffset(contentRight - row.clientWidth, reachable);
  return min > max ? { min: max, max } : { min, max };
}

/**
 * The table's own offset: the furthest any row that can scroll still holds. A
 * row rebuilt by a decoration change arrives at 0, and a row that cannot scroll
 * never leaves it — taking the maximum lets neither drag the table back to
 * column one.
 */
export function tableOffset(rows: readonly RowGeometry[]): number {
  let offset = 0;
  for (const row of rows) {
    if (scrollableRange(row).max > 0) offset = Math.max(offset, row.scrollLeft);
  }
  return offset;
}

/**
 * Every row of the table `row` belongs to. Rows of one table are a contiguous
 * run of `.cm-line` siblings — a Markdown table ends at the first line that is
 * not one of its rows — so two tables in a note are two runs, and two scroll
 * regions. Contiguity rather than the `-first` / `-last` edge hooks, because a
 * table taller than the viewport has neither edge rendered.
 */
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
interface RowWrite {
  readonly row: Element;
  readonly offset: number;
}

/** What a table is being asked to scroll to, and what must stay visible. */
interface SyncRequest {
  readonly rows: readonly Element[];
  readonly desired: number;
  /** The document position whose character the offset is clamped around. */
  readonly caret: number;
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

/**
 * CT-7's clamp: the offsets this table may hold while the caret is inside it.
 * Null when the caret is somewhere else, which is what scopes the rule — move
 * the caret out of the table and it scrolls to its full extent again.
 */
function caretClamp(view: EditorView, request: SyncRequest): OffsetRange | null {
  const row = rowAt(view, request.caret);
  if (!row || !request.rows.includes(row)) return null;
  const coords = view.coordsAtPos(request.caret);
  if (!coords) return null;
  return offsetsKeepingVisible(readRow(row), {
    left: coords.left - CARET_MARGIN_PX,
    right: coords.right + CARET_MARGIN_PX,
  });
}

/** Reads layout; writes nothing. Safe inside a `requestMeasure` read phase. */
function planSync(view: EditorView, request: SyncRequest): readonly RowWrite[] {
  const clamp = caretClamp(view, request);
  const target = clamp ? clampOffset(request.desired, clamp) : request.desired;
  const writes: RowWrite[] = [];
  for (const row of request.rows) {
    const geometry = readRow(row);
    const offset = clampOffset(target, scrollableRange(geometry));
    if (Math.abs(geometry.scrollLeft - offset) >= SYNC_EPSILON_PX) writes.push({ row, offset });
  }
  return writes;
}

/** Writes layout; reads nothing. Returns whether anything actually moved. */
function applySync(writes: readonly RowWrite[]): boolean {
  for (const write of writes) write.row.scrollLeft = write.offset;
  return writes.length > 0;
}

/**
 * The three entry points — a row's `scroll` event, an editor update, and a
 * scroll target — all funnel into one plan-then-apply pair, so the clamp is
 * written once. Every one of them fails open: a throw inside a measure callback
 * is caught and reported by CodeMirror (`@codemirror/view/dist/index.js:8167`,
 * `:8195`) and one inside the `scroll` listener never reaches the editor, so
 * the worst outcome is a caret in the wrong place, never a lost keystroke.
 */
class TableScrollSync implements PluginValue {
  /** Distinct keys, so a reveal and a restore never replace each other. */
  private readonly restoreKey = {};
  private readonly revealKey = {};
  private redrawPending = false;
  private stopped = false;

  constructor(private readonly view: EditorView) {
    // Capture, because a `scroll` event on an element does not bubble. Passive,
    // because nothing here cancels it.
    view.scrollDOM.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
  }

  update(update: ViewUpdate): void {
    // Not on a bare selection change: that is what the reveal path is for, and
    // it is also what this module's own refresh transaction looks like.
    if (!update.docChanged && !update.viewportChanged && !update.geometryChanged) return;
    this.view.requestMeasure({
      key: this.restoreKey,
      read: () => this.planTables(),
      write: (writes) => { this.commit(writes); },
    });
  }

  destroy(): void {
    this.stopped = true;
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll, { capture: true });
  }

  /**
   * Bring `range`'s cell into its row's band. The read is deferred because a
   * scroll handler runs inside an update, where reading the editor's layout
   * throws.
   */
  reveal(range: SelectionRange): void {
    this.view.requestMeasure({
      key: this.revealKey,
      read: () => this.planReveal(range.head),
      write: (writes) => { this.commit(writes); },
    });
  }

  private readonly onScroll = (event: Event): void => {
    const { target } = event;
    const row = target instanceof Element ? target.closest(TABLE_ROW_SELECTOR) : null;
    if (!row) return;
    this.commit(planSync(this.view, {
      rows: tableRowsAt(row),
      desired: row.scrollLeft,
      caret: this.view.state.selection.main.head,
    }));
  };

  /** Every table back onto its own offset — the one its rows still agree on. */
  private planTables(): readonly RowWrite[] {
    const caret = this.view.state.selection.main.head;
    return tableRuns(this.view.contentDOM).flatMap((rows) =>
      planSync(this.view, { rows, desired: tableOffset(rows.map(readRow)), caret }));
  }

  private planReveal(pos: number): readonly RowWrite[] {
    const row = rowAt(this.view, pos);
    if (!row) return [];
    const rows = tableRowsAt(row);
    return planSync(this.view, { rows, desired: tableOffset(rows.map(readRow)), caret: pos });
  }

  private commit(writes: readonly RowWrite[]): void {
    if (this.suspended) return;
    if (applySync(writes)) this.scheduleRedraw();
  }

  /**
   * Nothing this module does is worth an aborted composition: re-dispatching
   * the selection beside a composing text node, or moving the layout under it,
   * can end one. The offsets are held and restored on the first update after
   * `compositionend`. `compositionStarted`, not `composing`, because the latter
   * is false for the frame the composing node is created in — the worst frame
   * to touch (`specs/in-place-table-cell-editing.md:435-446`).
   */
  private get suspended(): boolean {
    return this.stopped || this.view.compositionStarted;
  }

  /**
   * Re-derive the drawn caret and selection. Deferred to a microtask because
   * half the callers are inside a measure phase, where dispatching throws; and
   * coalesced, so a row and its five siblings all scrolling in one frame cost
   * one transaction rather than six.
   */
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
