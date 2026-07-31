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
 * **A caret that scrolls out of its row is suppressed, not chased.** Because
 * the layers sit outside the row, no overflow can clip them, and the caret
 * paints outside the row (measured: 369.92px past the inline-end edge) over
 * unrelated text; clipping or reparenting CodeMirror's layers is kill criterion
 * 13. The first answer was to clamp the table's offset to whatever kept the
 * caret's character in band, and the arithmetic killed it: with the caret in
 * column one of a 1200px table in a 400px pane the clamp pins the table at
 * ~21px against an ~808px extent (measured), leaving ~780px unreachable. That
 * reads as a frozen table, not as a protected caret.
 *
 * So the table scrolls freely and the *caret* gives way instead: while the main
 * caret's character is outside its row's band, `CARET_OFFSCREEN_CLASS` is
 * stamped on `view.dom` and the stylesheet declines to draw the cursor layer.
 * That is what an editor does when your cursor scrolls off screen anywhere
 * else, and CodeMirror's own cursor already hides itself when the view loses
 * focus (`@codemirror/view/dist/index.js:8250` rewrites the class attribute
 * that does it) — hiding is a state the cursor has, not a hack.
 *
 * Revealing a cell is the one path that still computes where the caret would be
 * visible, as a one-shot scroll on navigation rather than a standing rule.
 * `scrollRectIntoView` is called on `.cm-scroller` (`:3449`) and only ever
 * walks *up*, so it cannot descend into a row: P0 K6 measured the off-screen
 * cell moving 0px. A scroll handler that reads layout inline throws ("Reading
 * the editor layout isn't allowed during an update"), so the read is deferred
 * to `view.requestMeasure`.
 *
 * **Nothing here changes the document.** The only transaction it dispatches
 * carries a selection and nothing else, annotated out of the undo history.
 */

import { Transaction, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

/** The row line CT-1 freezes. P3b stamps it; nothing here creates it. */
export const TABLE_ROW_SELECTOR = ".nn-lp-table-row";

/**
 * Stamped on `view.dom` while the main caret's character sits outside its row's
 * visible band. P3c's stylesheet hides the cursor layer under it, so this
 * string is a contract with the stylesheet rather than an internal detail —
 * which is why the arithmetic test pins the literal.
 */
export const CARET_OFFSCREEN_CLASS = "nn-table-caret-offscreen";

/**
 * Below this, a difference is device-pixel snapping rather than a scroll: a row
 * written to 193 can read back 192.5. Writing anyway would make every sibling's
 * scroll event a fresh correction, and the corrections would never settle.
 */
const SYNC_EPSILON_PX = 1;

/**
 * `coordsAtPos` flattens a caret to a zero-width point (`:514`), but the drawn
 * cursor is a marker with a border and a `margin-left: -0.6px` of its own. This
 * is the half-width handed to that marker: enough that revealing a cell leaves
 * the caret inside the band rather than flush with it, and enough that a caret
 * straddling an edge counts as inside rather than blinking away over a pixel.
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
 * Whether `span` still falls inside the band `row` shows once it sits at
 * `offset`. Both are taken into the row's content coordinates, where `span` is
 * read at the row's *current* `scrollLeft` — so a caller can ask about an
 * offset it has planned but not yet written, and does not have to re-measure
 * after writing it.
 *
 * Overlap rather than containment: a caret half over an edge draws half a
 * caret, which is what an editor does everywhere else.
 */
export function isSpanInBand(row: RowGeometry, span: Span, offset: number): boolean {
  const left = span.left - row.contentOrigin + row.scrollLeft;
  const right = span.right - row.contentOrigin + row.scrollLeft;
  return right >= offset && left <= offset + row.clientWidth;
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
export interface RowWrite {
  readonly row: Element;
  readonly offset: number;
}

/**
 * What one measure pass decided: where the rows go, and whether the drawn caret
 * has left the row it belongs to. The two travel together because the second is
 * a question about the offsets in the first — asked before they are written.
 */
interface SyncPlan {
  readonly writes: readonly RowWrite[];
  readonly caretOffscreen: boolean;
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

/**
 * The offset `row` holds once `writes` are applied — which is not where it sits
 * while the plan is being made. Asking about the pending offset keeps one plan
 * internally consistent: without it a pass can stamp "the caret is in band" in
 * the same write phase that scrolls the caret's row out of band.
 *
 * Worth one frame, not more. Writing a row's `scrollLeft` fires its own scroll
 * event, which re-plans against the settled position — so the browser lane
 * cannot tell the two apart and this is pinned by unit test instead.
 */
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

/**
 * The four entry points — a row's `scroll` event, an editor update, a bare
 * caret move, and a scroll target — all funnel into one plan-then-apply pair,
 * so the caret question is answered in one place. Every one of them fails open:
 * a throw inside a measure callback is caught and reported by CodeMirror
 * (`@codemirror/view/dist/index.js:8167`, `:8195`) and one inside the `scroll`
 * listener never reaches the editor, so the worst outcome is a caret drawn in
 * the wrong place, never a lost keystroke.
 */
class TableScrollSync implements PluginValue {
  /** Distinct keys, so a reveal and a restore never replace each other. */
  private readonly restoreKey = {};
  private readonly revealKey = {};
  private readonly caretKey = {};
  private redrawPending = false;
  private stopped = false;
  private caretOffscreen = false;

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
    // A caret crosses its row's edge with no row moving at all — clicking a
    // cell that is off band — and CodeMirror rewrites `view.dom`'s whole class
    // attribute on a focus change (`:8250`), taking the flag with it. Neither
    // plans a write, so this asks the caret question alone. Skipped when the
    // selection did not move, which is what this module's own refresh
    // transaction looks like.
    if (update.focusChanged || !update.state.selection.eq(update.startState.selection)) {
      this.measure(this.caretKey, () => this.plan([]));
    }
  }

  destroy(): void {
    this.stopped = true;
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll, { capture: true });
    // The view outlives this plugin across a reconfiguration. A flag left
    // behind on it is a cursor that never comes back.
    this.caretOffscreen = false;
    this.stampCaret();
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

  /**
   * Bring `pos` into its row's band. The only path that still asks which
   * offsets keep a position visible, and it asks once, on navigation — rather
   * than standing over every scroll the way the withdrawn clamp did.
   */
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

  /** `writes`, plus the caret question the offsets they carry imply. */
  private plan(writes: readonly RowWrite[]): SyncPlan {
    return { writes, caretOffscreen: this.isCaretOffscreen(writes) };
  }

  /**
   * Whether the main caret's character sits outside its row's band, once
   * `writes` are applied. False whenever the question cannot be answered — the
   * caret is not in a table, or its position has no coordinates — because a
   * caret drawn in the wrong place is recoverable and a cursor nobody can find
   * is not.
   */
  private isCaretOffscreen(writes: readonly RowWrite[]): boolean {
    const caret = this.view.state.selection.main.head;
    const row = rowAt(this.view, caret);
    if (!row) return false;
    const coords = this.view.coordsAtPos(caret);
    if (!coords) return false;
    return !isSpanInBand(readRow(row), caretSpan(coords), offsetAfter(row, writes));
  }

  private commit(plan: SyncPlan): void {
    if (this.suspended) return;
    this.caretOffscreen = plan.caretOffscreen;
    this.stampCaret();
    if (applySync(plan.writes)) this.scheduleRedraw();
  }

  /**
   * Write the signal onto the editor. Separate from deciding it because
   * CodeMirror reassigns `view.dom`'s class attribute wholesale (`:8250`), and
   * it does so *after* this plugin's own `update` (`:8005`) — so the flag has
   * to be re-stamped from a measure, which runs later still.
   */
  private stampCaret(): void {
    this.view.dom.classList.toggle(CARET_OFFSCREEN_CLASS, this.caretOffscreen);
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
