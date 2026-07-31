// P3d in a real browser. Every assertion here needs a layout engine, a scroll
// position that actually moves, and a caret that is actually painted — jsdom
// has none of the three, so the same tests written there would pass on
// all-zero rectangles and prove nothing.
//
// **The harness is not the app.** P3b (the row DOM) and P3c (the stylesheet)
// are in flight in parallel, so this builds the smallest editor that reproduces
// the *shape* CT-1 and CT-2 freeze: table lines carry `.nn-lp-table-row`, each
// is its own horizontal scroll container, and every row is forced to the
// table's full width. Production stamps that width from the track template;
// here one custom property stands in for it. What the harness must not do is
// hand the module a document where the behaviour is easy — so the fixture keeps
// the genuinely short `| --- |` delimiter row that P0's K6 measured sitting at
// 0 while six rows moved 193px, and the first test proves it is still that row.

import { history, undoDepth } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  type DecorationSet,
} from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  CARET_OFFSCREEN_CLASS,
  SELECTION_OFFSCREEN_CLASS,
  tableScrollSync,
} from "./sourceEditorTableScrollSync";

const SOURCE = [
  "Intro paragraph, long enough that it has to wrap inside the pane.",
  "",
  "| Alpha column heading | Bravo column heading | Charlie column head |",
  "| --- | --- | --- |",
  "| alpha one two three | bravo one two three | charlie one two thr |",
  "| alpha four five six | bravo four five six | charlie four five s |",
  "| alpha seven eight n | bravo seven eight n | charlie seven eight |",
  "",
  "Between the tables.",
  "",
  "| Delta heading | Echo heading |",
  "| --- | --- |",
  "| delta body | echo body |",
  "",
  "Trailing paragraph.",
].join("\n");

/** The same document with the second table pushed well below the fold. */
const DEEP_SOURCE = SOURCE.replace(
  "Between the tables.",
  Array.from({ length: 30 }, (_, index) => `Filler paragraph ${index}.`).join("\n\n"),
);

const HARNESS_STYLE = `
.nn-scroll-harness { width: 400px; height: 260px; }
.nn-scroll-harness .cm-editor { height: 100%; }
.nn-scroll-harness .cm-scroller {
  overflow: auto;
  font-family: monospace;
  font-size: 13px;
  line-height: 20px;
}
/* Load-bearing for G2, not cosmetic: unclamped, .cm-content grows to the widest
   row and no row is narrower than its own content, so nothing can scroll
   (P0 K4b; styles.css:529-539 carries the same rule in production). */
.nn-scroll-harness .cm-content { max-width: 100%; }
.nn-scroll-harness .nn-lp-table-row {
  overflow-x: auto;
  white-space: pre;
  scrollbar-width: none;
}
/* Stands in for CT-2's stamped track template: whatever a row's own text
   measures, its scrollable width is the table's. Without it the delimiter row
   cannot follow the others at all. */
.nn-scroll-harness .nn-lp-table-row::after {
  content: "";
  display: block;
  width: var(--nn-table-width, 1200px);
  height: 0;
}
`;

const ROW_CLASS = "nn-lp-table-row";
const rowLine = Decoration.line({ class: ROW_CLASS });

function tableRowLines(state: EditorState): DecorationSet {
  const lines: Range<Decoration>[] = [];
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (line.text.startsWith("|")) lines.push(rowLine.range(line.from));
  }
  return Decoration.set(lines);
}

/** Stands in for P3b: the one thing this module needs from the producer. */
const tableRowMarks = StateField.define<DecorationSet>({
  create: tableRowLines,
  update: (value, transaction) =>
    transaction.docChanged ? tableRowLines(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
});

interface Harness {
  readonly view: EditorView;
  readonly host: HTMLElement;
  /** Selection-only transactions seen since mount. */
  readonly refreshes: () => number;
}

let mounted: Harness[] = [];
let styleElement: HTMLStyleElement | null = null;

function mount(doc: string, extensions: readonly Extension[] = [tableScrollSync]): Harness {
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.textContent = HARNESS_STYLE;
    document.head.append(styleElement);
  }
  const host = document.createElement("div");
  host.className = "nn-scroll-harness";
  document.body.append(host);

  let refreshes = 0;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        tableRowMarks,
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            if (transaction.selection && !transaction.docChanged) refreshes += 1;
          }
        }),
        ...extensions,
      ],
    }),
  });
  view.focus();
  const harness: Harness = { view, host, refreshes: () => refreshes };
  mounted.push(harness);
  return harness;
}

function unmount(harness: Harness): void {
  harness.view.destroy();
  harness.host.remove();
  mounted = mounted.filter((entry) => entry !== harness);
}

afterEach(() => {
  while (mounted.length > 0) unmount(mounted[0]!);
});

const frame = (): Promise<void> =>
  new Promise((resolve) => { requestAnimationFrame(() => { resolve(); }); });

/** Long enough for the scroll event, the module's microtask and CodeMirror's
 *  own measure cycle to have all run. */
async function settle(frames = 4): Promise<void> {
  for (let index = 0; index < frames; index += 1) await frame();
}

function rowFor(view: EditorView, pos: number): HTMLElement {
  const node = view.domAtPos(pos).node;
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest<HTMLElement>(`.${ROW_CLASS}`);
  if (!row) throw new Error(`no table row at position ${pos}`);
  return row;
}

/**
 * The rows of the table containing `pos`. Walked here rather than through the
 * module's own grouping, so a module that grouped two tables into one would
 * still be caught by the test that says a second table stays put.
 */
function tableRowsFor(view: EditorView, pos: number): HTMLElement[] {
  const own = rowFor(view, pos);
  const rows = [own];
  let before = own.previousElementSibling;
  while (before) {
    if (!before.classList.contains(ROW_CLASS)) break;
    rows.unshift(before as HTMLElement);
    before = before.previousElementSibling;
  }
  let after = own.nextElementSibling;
  while (after) {
    if (!after.classList.contains(ROW_CLASS)) break;
    rows.push(after as HTMLElement);
    after = after.nextElementSibling;
  }
  return rows;
}

/** A document position's x in its row's own scroll coordinates. */
function contentX(view: EditorView, pos: number): number {
  const row = rowFor(view, pos);
  const coords = view.coordsAtPos(pos);
  if (!coords) throw new Error(`position ${pos} is not rendered`);
  return coords.left - (row.getBoundingClientRect().left + row.clientLeft) + row.scrollLeft;
}

const maxOffset = (row: HTMLElement): number => row.scrollWidth - row.clientWidth;

/** Whether the module is telling the stylesheet not to draw the cursor. */
const caretFlagged = (view: EditorView): boolean =>
  view.dom.classList.contains(CARET_OFFSCREEN_CLASS);

/**
 * The painted cursor. `display: none` until the view has focus, which would
 * otherwise make every comparison below a comparison of zeros.
 *
 * Only ever called with the flag down. Under the flag the stylesheet's own rule
 * takes the cursor out of the layout, so a test that measured it there would
 * start throwing the day that rule lands.
 */
function drawnCaret(view: EditorView): DOMRect {
  const cursor = view.scrollDOM.querySelector(".cm-cursor-primary");
  if (!cursor) throw new Error("no drawn cursor");
  const rect = cursor.getBoundingClientRect();
  if (rect.height === 0) throw new Error("the drawn cursor is not painted");
  return rect;
}

/** Whether the module is telling the stylesheet not to draw the selection. */
const selectionFlagged = (view: EditorView): boolean =>
  view.dom.classList.contains(SELECTION_OFFSCREEN_CLASS);

/**
 * The rectangles `drawSelection` painted, whichever rows they landed on.
 *
 * Unlike the drawn caret these need no focus — the base theme only colours them
 * differently for a focused editor (`@codemirror/view/dist/index.js:6864`) —
 * and unlike the caret they are still painted while the flag is up, because the
 * rule that consumes it is P3c's and this harness deliberately does not carry
 * it. That is what lets the sweep below check the flag against where the
 * rectangles actually are rather than against itself.
 */
function drawnSelection(view: EditorView): DOMRect[] {
  const pieces = [...view.scrollDOM.querySelectorAll(".cm-selectionBackground")];
  if (pieces.length === 0) throw new Error("no drawn selection");
  return pieces.map((piece) => piece.getBoundingClientRect());
}

/** Those of them lying over `row` — in view or not. */
function selectionPiecesOver(view: EditorView, row: HTMLElement): DOMRect[] {
  const box = row.getBoundingClientRect();
  return drawnSelection(view).filter((rect) => rect.top < box.bottom && rect.bottom > box.top);
}

/** Whether any rectangle over `row` is inside the band it is showing. */
function selectionVisibleIn(view: EditorView, row: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  const pieces = selectionPiecesOver(view, row);
  if (pieces.length === 0) throw new Error("nothing is painted over that row");
  // Inclusive, because the module counts a span touching an edge as in band.
  return pieces.some((rect) => rect.right >= box.left && rect.left <= box.right);
}

const at = (text: string): number => SOURCE.indexOf(text);

const FIRST_CELL = at("alpha one two three");
const FIRST_CELL_END = FIRST_CELL + "alpha one two three".length;
const LAST_CELL_END = at("charlie one two thr") + "charlie one two thr".length;
const SECOND_TABLE_CELL = at("delta body");
const OUTSIDE = at("Between the tables.");

describe("table row scroll synchronisation", () => {
  it("puts every row of a table on the offset one row was scrolled to", async () => {
    const { view } = mount(SOURCE);
    const rows = tableRowsFor(view, FIRST_CELL);
    expect(rows).toHaveLength(5);

    // The invariant the producer owes this module, asserted rather than
    // assumed: the delimiter row's own text is far narrower than the band, so
    // only the stamped table width lets it follow the others at all.
    const delimiter = rows[1]!;
    const delimiterLine = view.state.doc.line(4);
    const textWidth = view.coordsAtPos(delimiterLine.to)!.right
      - view.coordsAtPos(delimiterLine.from)!.left;
    expect(textWidth).toBeLessThan(delimiter.clientWidth);
    for (const row of rows) expect(maxOffset(row)).toBeGreaterThan(100);

    rows[3]!.scrollLeft = 193;
    await settle();

    for (const row of rows) expect(row.scrollLeft).toBeCloseTo(193, 0);
  });

  it("leaves a second table where it was", async () => {
    const { view } = mount(SOURCE);
    const first = tableRowsFor(view, FIRST_CELL);
    const second = tableRowsFor(view, SECOND_TABLE_CELL);
    expect(second).toHaveLength(3);
    expect(second).not.toContain(first[0]);

    first[0]!.scrollLeft = 200;
    await settle();

    for (const row of second) expect(row.scrollLeft).toBe(0);
  });

  it("holds the offset across a keystroke elsewhere in the note", async () => {
    const { view } = mount(SOURCE);
    tableRowsFor(view, FIRST_CELL)[2]!.scrollLeft = 150;
    await settle();

    view.dispatch({ changes: { from: at("Intro"), insert: "X" } });
    await settle();

    for (const row of tableRowsFor(view, FIRST_CELL + 1)) {
      expect(row.scrollLeft).toBeCloseTo(150, 0);
    }
  });

  it("holds still while an input method is composing", async () => {
    const harness = mount(SOURCE);
    const { view } = harness;
    view.dispatch({ selection: EditorSelection.cursor(OUTSIDE) });
    await settle();
    const rows = tableRowsFor(view, FIRST_CELL);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(view.compositionStarted).toBe(true);
    const dispatched = harness.refreshes();

    rows[3]!.scrollLeft = 200;
    await settle();

    // Nothing propagated, nothing was dispatched, and the caret signal was not
    // touched either. Re-dispatching the selection beside a composing text node
    // can abort the composition, and a caret briefly in the wrong place — drawn
    // or suppressed — costs less than a lost keystroke.
    for (const row of rows.filter((candidate) => candidate !== rows[3])) {
      expect(row.scrollLeft).toBe(0);
    }
    expect(harness.refreshes()).toBe(dispatched);
    expect(caretFlagged(view)).toBe(false);

    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend"));
    expect(view.compositionStarted).toBe(false);
    view.dispatch({ changes: { from: at("Intro"), insert: "X" } });
    await settle();

    // Held, not abandoned: the table is back on one offset afterwards.
    for (const row of tableRowsFor(view, FIRST_CELL + 1)) {
      expect(row.scrollLeft).toBeCloseTo(200, 0);
    }
  });

  it("brings a row the editor has just built onto the table's offset", async () => {
    const { view } = mount(SOURCE);
    tableRowsFor(view, FIRST_CELL)[2]!.scrollLeft = 150;
    await settle();

    const lastRow = view.state.doc.line(7);
    view.dispatch({
      changes: {
        from: lastRow.to,
        insert: "\n| alpha nine ten one | bravo nine ten one | charlie nine ten o |",
      },
    });
    await settle();

    const grown = tableRowsFor(view, FIRST_CELL);
    expect(grown).toHaveLength(6);
    // The new row is born at 0. Nothing in the browser puts it anywhere else.
    for (const row of grown) expect(row.scrollLeft).toBeCloseTo(150, 0);
  });
});

describe("the drawn caret under a scrolling row", () => {
  it("stays on its character when the row scrolls under it", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(LAST_CELL_END) });
    await settle();
    expect(view.hasFocus).toBe(true);
    const before = view.state.doc.toString();

    const rows = tableRowsFor(view, LAST_CELL_END);
    rows[0]!.scrollLeft = 250;
    await settle();

    expect(rows[2]!.scrollLeft).toBeGreaterThan(100);
    // Left to itself the drawn caret is stranded by the whole scroll offset —
    // 380.41px in P0's K1. What is left is the cursor marker's own
    // `margin-left: -0.6px`, which is the -0.59px K1 measured after the rescue.
    const drift = drawnCaret(view).left - view.coordsAtPos(LAST_CELL_END)!.left;
    expect(Math.abs(drift)).toBeLessThanOrEqual(1);
    // In band, so nothing is suppressed: the rescue is what keeps the caret
    // honest here, and it has to survive the clamp's removal intact.
    expect(caretFlagged(view)).toBe(false);
    // Byte fidelity, and an undo stack that never saw the refresh.
    expect(view.state.doc.toString()).toBe(before);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("runs to the full extent with the caret inside the table", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();

    const rows = tableRowsFor(view, FIRST_CELL);
    // Neither half of this is vacuous: the fixture genuinely overflows, and the
    // caret sits in column one. That is the configuration the withdrawn clamp
    // pinned at ~21px, leaving ~780px of the table unreachable.
    const extent = maxOffset(rows[3]!);
    expect(extent).toBeGreaterThan(400);
    expect(contentX(view, FIRST_CELL)).toBeLessThan(50);

    rows[3]!.scrollLeft = 9999;
    await settle();

    // Reached the end, not merely moved.
    for (const row of rows) expect(row.scrollLeft).toBeCloseTo(maxOffset(row), 0);

    rows[3]!.scrollLeft = 0;
    await settle();

    for (const row of rows) expect(row.scrollLeft).toBeCloseTo(0, 0);
  });

  it("flags the caret out of band and clears the flag when it comes back", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    expect(caretFlagged(view)).toBe(false);

    const rows = tableRowsFor(view, FIRST_CELL);
    rows[3]!.scrollLeft = 9999;
    await settle();

    expect(caretFlagged(view)).toBe(true);

    rows[3]!.scrollLeft = 0;
    await settle();

    expect(caretFlagged(view)).toBe(false);
  });

  it("never paints the drawn caret outside its row", async () => {
    // The property the clamp used to buy, and the reason it can go: at every
    // offset the row can hold, either the caret is inside the row it belongs to
    // or the stylesheet has been told not to draw it. Nothing in between.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    const row = rowFor(view, FIRST_CELL);
    const extent = maxOffset(row);
    expect(extent).toBeGreaterThan(400);

    let suppressed = 0;
    let painted = 0;
    for (const offset of [0, 60, 200, extent / 2, extent, 200, 0]) {
      row.scrollLeft = offset;
      await settle();
      if (caretFlagged(view)) {
        suppressed += 1;
        continue;
      }
      painted += 1;
      const caret = drawnCaret(view);
      const box = row.getBoundingClientRect();
      expect(caret.left).toBeGreaterThanOrEqual(box.left - 1);
      expect(caret.right).toBeLessThanOrEqual(box.right + 1);
    }
    // A sweep that never suppressed, or never painted, proves half of nothing.
    expect(suppressed).toBeGreaterThan(0);
    expect(painted).toBeGreaterThan(0);
  });

  it("clears the flag when the caret leaves the table", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    const rows = tableRowsFor(view, FIRST_CELL);
    rows[3]!.scrollLeft = 9999;
    await settle();
    expect(caretFlagged(view)).toBe(true);

    // A bare selection change: no row moves and no byte changes, so this is the
    // only path that can notice. The table stays where the user left it.
    view.dispatch({ selection: EditorSelection.cursor(OUTSIDE) });
    await settle();

    expect(caretFlagged(view)).toBe(false);
    expect(rows[3]!.scrollLeft).toBeGreaterThan(300);
  });

  it("clears the flag when the caret moves to a cell still in band", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    const rows = tableRowsFor(view, FIRST_CELL);
    const target = contentX(view, LAST_CELL_END);

    rows[3]!.scrollLeft = target - 100;
    await settle();

    // Column one has left the band; the cell the caret is about to move to is
    // inside it. Both stated, so a fixture that drifted would say so.
    expect(caretFlagged(view)).toBe(true);
    expect(target).toBeGreaterThan(rows[3]!.scrollLeft);
    expect(target).toBeLessThan(rows[3]!.scrollLeft + rows[3]!.clientWidth);

    view.dispatch({ selection: EditorSelection.cursor(LAST_CELL_END) });
    await settle();

    expect(caretFlagged(view)).toBe(false);
  });

  it("re-stamps the flag after a focus round trip", async () => {
    // CodeMirror rewrites `view.dom`'s whole class attribute whenever its own
    // editor attributes change, and focus is one of them
    // (`@codemirror/view/dist/index.js:8250`). That rewrite runs *after* the
    // plugin's own update (`:8005`), so the flag cannot be restored from there
    // — it has to be re-stamped from a measure.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    tableRowsFor(view, FIRST_CELL)[3]!.scrollLeft = 9999;
    await settle();
    expect(caretFlagged(view)).toBe(true);

    view.contentDOM.blur();
    await settle();
    view.focus();
    await settle();

    expect(view.hasFocus).toBe(true);
    expect(caretFlagged(view)).toBe(true);
  });

  it("drops the flag when the view is torn down", async () => {
    const harness = mount(SOURCE);
    const { view } = harness;
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    tableRowsFor(view, FIRST_CELL)[3]!.scrollLeft = 9999;
    await settle();
    expect(caretFlagged(view)).toBe(true);

    // A reconfiguration destroys and rebuilds this plugin around the same
    // `view.dom`. A flag left behind there is a cursor that never comes back.
    unmount(harness);

    expect(caretFlagged(view)).toBe(false);
  });
});

describe("the drawn selection under a scrolling row", () => {
  /** One cell's text: narrow enough to fit the band, and to leave it whole. */
  const ONE_CELL = EditorSelection.range(FIRST_CELL, FIRST_CELL_END);

  it("flags a selection its row has scrolled past, and clears it coming back", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: ONE_CELL });
    await settle();
    const rows = tableRowsFor(view, FIRST_CELL);
    const row = rowFor(view, FIRST_CELL);
    // Neither half vacuous: the fixture genuinely overflows, and the selection
    // starts inside the band it is about to be scrolled out of.
    expect(maxOffset(row)).toBeGreaterThan(400);
    expect(selectionVisibleIn(view, row)).toBe(true);
    expect(selectionFlagged(view)).toBe(false);

    rows[3]!.scrollLeft = 9999;
    await settle();

    expect(selectionFlagged(view)).toBe(true);
    // The defect the flag exists for, measured rather than inferred: with the
    // row's box at [0, 400] and the table at full scroll the rectangle painted
    // at left -786.41px — a block of highlight over whatever is there instead.
    const box = row.getBoundingClientRect();
    const pieces = selectionPiecesOver(view, row);
    expect(pieces).not.toHaveLength(0);
    for (const rect of pieces) expect(rect.right).toBeLessThan(box.left);

    rows[3]!.scrollLeft = 0;
    await settle();

    expect(selectionFlagged(view)).toBe(false);
  });

  it("never leaves a selection painted outside its row unflagged", async () => {
    // The caret's sweep, for the other layer: at every offset the row can hold,
    // either a rectangle is in the row or the stylesheet has been told not to
    // draw the layer. The two are asserted as one biconditional, so a flag
    // raised too eagerly fails it just as loudly as one never raised.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: ONE_CELL });
    await settle();
    const row = rowFor(view, FIRST_CELL);
    const extent = maxOffset(row);
    expect(extent).toBeGreaterThan(400);

    let suppressed = 0;
    let painted = 0;
    for (const offset of [0, 60, 200, extent / 2, extent, 200, 0]) {
      row.scrollLeft = offset;
      await settle();
      const flagged = selectionFlagged(view);
      expect(selectionVisibleIn(view, row)).toBe(!flagged);
      if (flagged) suppressed += 1;
      else painted += 1;
    }
    // A sweep that never suppressed, or never painted, proves half of nothing.
    expect(suppressed).toBeGreaterThan(0);
    expect(painted).toBeGreaterThan(0);
  });

  it("leaves a selection straddling the band's edges painted", async () => {
    // The trap. A selection can be half in the band and half scrolled away, and
    // suppressing it there erases something the user can see — a worse defect
    // than the one being fixed. So this is the case the flag must decline.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.range(FIRST_CELL, LAST_CELL_END) });
    await settle();
    const row = rowFor(view, FIRST_CELL);
    const start = contentX(view, FIRST_CELL);
    const finish = contentX(view, LAST_CELL_END);
    // The selection has to outrun the band for both of its ends to sit outside
    // it. A fixture where it did not would satisfy the next two vacuously.
    expect(finish - start).toBeGreaterThan(row.clientWidth);

    // Centre the band inside the selection: both ends out, the middle in.
    row.scrollLeft = start + (finish - start - row.clientWidth) / 2;
    await settle();

    expect(start).toBeLessThan(row.scrollLeft);
    expect(finish).toBeGreaterThan(row.scrollLeft + row.clientWidth);
    expect(selectionFlagged(view)).toBe(false);
    // And there is something there to protect.
    expect(selectionVisibleIn(view, row)).toBe(true);
    // The caret sits at the head, which is out of band, so the two signals
    // disagree here. That disagreement is the whole reason there are two.
    expect(caretFlagged(view)).toBe(true);
  });

  it("leaves a selection spanning two rows painted", async () => {
    // Past one visual line the painter stops drawing the text's own width and
    // anchors a piece to each content edge, so something stays in view however
    // far the rows are scrolled. That is the whole reason a selection crossing
    // a row boundary is left alone, and it is asserted here rather than taken
    // from the reading — both ends sit in column one, so anything that measured
    // this selection as one rectangle would find it far out of band.
    const { view } = mount(SOURCE);
    const secondRowCell = at("alpha four five six");
    view.dispatch({ selection: EditorSelection.range(FIRST_CELL, secondRowCell + 5) });
    await settle();
    const first = rowFor(view, FIRST_CELL);
    const second = rowFor(view, secondRowCell);
    expect(second).not.toBe(first);

    first.scrollLeft = maxOffset(first);
    await settle();

    // Both ends have genuinely scrolled away, and both rows still show part of
    // the selection: the first piece runs to the content's right edge, the last
    // starts at its left one.
    expect(contentX(view, FIRST_CELL)).toBeLessThan(first.scrollLeft);
    expect(contentX(view, secondRowCell)).toBeLessThan(second.scrollLeft);
    expect(selectionFlagged(view)).toBe(false);
    expect(selectionVisibleIn(view, first)).toBe(true);
    expect(selectionVisibleIn(view, second)).toBe(true);
  });

  it("leaves a selection running out of the table painted", async () => {
    // The other half of the row-boundary case: a selection covering rows that
    // scroll and lines that cannot. Nothing outside a row is clipped by one, so
    // the answer is the same.
    const { view } = mount(SOURCE);
    view.dispatch({
      selection: EditorSelection.range(FIRST_CELL, OUTSIDE + "Between".length),
    });
    await settle();
    const row = rowFor(view, FIRST_CELL);
    row.scrollLeft = maxOffset(row);
    await settle();

    // The in-table end of it has genuinely scrolled away.
    expect(contentX(view, FIRST_CELL)).toBeLessThan(row.scrollLeft);
    expect(selectionFlagged(view)).toBe(false);
    expect(selectionVisibleIn(view, row)).toBe(true);
  });

  it("says nothing about a bare caret", async () => {
    // An empty range paints no background at all (`:9570-9575`), so there is
    // nothing here to suppress — and the caret's own signal is untouched.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    tableRowsFor(view, FIRST_CELL)[3]!.scrollLeft = 9999;
    await settle();

    expect(caretFlagged(view)).toBe(true);
    expect(selectionFlagged(view)).toBe(false);
  });

  it("says nothing about a selection outside a table", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.range(at("Intro"), at("Intro") + 5) });
    await settle();
    const rows = tableRowsFor(view, FIRST_CELL);
    rows[3]!.scrollLeft = 9999;
    await settle();

    // The table really is scrolled away. The selection is simply not in it, and
    // nothing outside a row can be clipped by one.
    expect(rows[3]!.scrollLeft).toBeGreaterThan(300);
    expect(selectionFlagged(view)).toBe(false);
  });

  it("re-stamps the flag after a focus round trip", async () => {
    // Same rewrite that takes the caret's flag off `view.dom` (`:8250`) takes
    // this one, and it runs after the plugin's own update.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: ONE_CELL });
    await settle();
    tableRowsFor(view, FIRST_CELL)[3]!.scrollLeft = 9999;
    await settle();
    expect(selectionFlagged(view)).toBe(true);

    view.contentDOM.blur();
    await settle();
    view.focus();
    await settle();

    expect(view.hasFocus).toBe(true);
    expect(selectionFlagged(view)).toBe(true);
  });

  it("drops the flag when the view is torn down", async () => {
    const harness = mount(SOURCE);
    harness.view.dispatch({ selection: ONE_CELL });
    await settle();
    tableRowsFor(harness.view, FIRST_CELL)[3]!.scrollLeft = 9999;
    await settle();
    expect(selectionFlagged(harness.view)).toBe(true);

    // A reconfiguration rebuilds this plugin around the same `view.dom`. A flag
    // left behind there is a selection that never comes back.
    unmount(harness);

    expect(selectionFlagged(harness.view)).toBe(false);
  });
});

describe("revealing a cell the caret moves to", () => {
  it("scrolls the row rather than the note", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    const row = rowFor(view, LAST_CELL_END);
    expect(row.scrollLeft).toBe(0);
    // The target starts outside the band — otherwise there is nothing to reveal.
    expect(contentX(view, LAST_CELL_END)).toBeGreaterThan(row.clientWidth);

    view.dispatch({
      selection: EditorSelection.cursor(LAST_CELL_END),
      scrollIntoView: true,
    });
    await settle();

    const coords = view.coordsAtPos(LAST_CELL_END)!;
    const box = row.getBoundingClientRect();
    expect(coords.left).toBeGreaterThanOrEqual(box.left - 1);
    expect(coords.right).toBeLessThanOrEqual(box.right + 1);
    // And the caret is drawn where it landed. A refresh dispatched from inside
    // the measure phase rather than deferred out of it throws, and the throw is
    // swallowed by CodeMirror's own handler — so this is what notices.
    expect(Math.abs(drawnCaret(view).left - coords.left)).toBeLessThanOrEqual(1);
    for (const other of tableRowsFor(view, LAST_CELL_END)) {
      expect(other.scrollLeft).toBeCloseTo(row.scrollLeft, 0);
    }
  });

  it("leaves the block axis to CodeMirror", async () => {
    const { view } = mount(DEEP_SOURCE);
    const target = DEEP_SOURCE.indexOf("delta body");
    expect(view.scrollDOM.scrollTop).toBe(0);

    view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
    await settle();

    // A handler that claimed the whole scroll would strand the caret's line
    // below the fold; this module only owns the inline axis inside a row.
    expect(view.scrollDOM.scrollTop).toBeGreaterThan(0);
  });
});

const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ]!;

describe("what the synchronisation costs", () => {
  async function scrollFrames(view: EditorView, count: number): Promise<number[]> {
    const row = tableRowsFor(view, FIRST_CELL)[0]!;
    const intervals: number[] = [];
    let previous = performance.now();
    for (let step = 0; step < count; step += 1) {
      row.scrollLeft = 20 + (step % 12) * 30;
      await frame();
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
    }
    return intervals;
  }

  it("stays within a frame of an editor without it, refreshing once per frame", async () => {
    const baseline = mount(SOURCE, []);
    const baselineFrames = await scrollFrames(baseline.view, 60);
    unmount(baseline);

    const synced = mount(SOURCE);
    synced.view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();
    const before = synced.refreshes();
    const syncedFrames = await scrollFrames(synced.view, 60);
    const refreshesPerFrame = (synced.refreshes() - before) / syncedFrames.length;

    console.log("p3d frame intervals ms", JSON.stringify({
      baseline: [0.5, 0.95, 1].map((p) => percentile(baselineFrames, p).toFixed(2)),
      synced: [0.5, 0.95, 1].map((p) => percentile(syncedFrames, p).toFixed(2)),
      refreshesPerFrame,
    }));

    // One frame of grace: the claim is "indistinguishable at frame level", and
    // a dispatch storm would be nowhere near this bound.
    expect(percentile(syncedFrames, 0.95))
      .toBeLessThan(percentile(baselineFrames, 0.95) + 16);
    // One selection refresh per scrolled frame. More than that is a loop
    // feeding itself; the microtask coalescing is what prevents it.
    expect(refreshesPerFrame).toBeLessThanOrEqual(1.1);
  });

  it("stays within a frame of one without it with a selection to measure too", async () => {
    // The frame above carries a bare caret, which costs one comparison to rule
    // out of the selection question. This one carries a range wider than the
    // band, so every scrolled frame measures both signals in full: two
    // `coordsAtPos` reads and a row rectangle on top of the caret's own.
    const baseline = mount(SOURCE, []);
    const baselineFrames = await scrollFrames(baseline.view, 60);
    unmount(baseline);

    const synced = mount(SOURCE);
    synced.view.dispatch({ selection: EditorSelection.range(FIRST_CELL, LAST_CELL_END) });
    await settle();
    const before = synced.refreshes();
    const syncedFrames = await scrollFrames(synced.view, 60);
    const refreshesPerFrame = (synced.refreshes() - before) / syncedFrames.length;

    console.log("p3d frame intervals ms, selection measured", JSON.stringify({
      baseline: [0.5, 0.95, 1].map((p) => percentile(baselineFrames, p).toFixed(2)),
      synced: [0.5, 0.95, 1].map((p) => percentile(syncedFrames, p).toFixed(2)),
      refreshesPerFrame,
    }));

    expect(percentile(syncedFrames, 0.95))
      .toBeLessThan(percentile(baselineFrames, 0.95) + 16);
    expect(refreshesPerFrame).toBeLessThanOrEqual(1.1);
  });
});
