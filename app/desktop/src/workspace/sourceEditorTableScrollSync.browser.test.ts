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

import { tableScrollSync } from "./sourceEditorTableScrollSync";

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

/** The painted cursor. `display: none` until the view has focus, which would
 *  otherwise make every comparison below a comparison of zeros. */
function drawnCaret(view: EditorView): DOMRect {
  const cursor = view.scrollDOM.querySelector(".cm-cursor-primary");
  if (!cursor) throw new Error("no drawn cursor");
  const rect = cursor.getBoundingClientRect();
  if (rect.height === 0) throw new Error("the drawn cursor is not painted");
  return rect;
}

const at = (text: string): number => SOURCE.indexOf(text);

const FIRST_CELL = at("alpha one two three");
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

    // Nothing propagated and nothing was dispatched. Re-dispatching the
    // selection beside a composing text node can abort the composition, and a
    // caret briefly in the wrong place costs less than a lost keystroke.
    for (const row of rows.filter((candidate) => candidate !== rows[3])) {
      expect(row.scrollLeft).toBe(0);
    }
    expect(harness.refreshes()).toBe(dispatched);

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
    // Byte fidelity, and an undo stack that never saw the refresh.
    expect(view.state.doc.toString()).toBe(before);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("holds the offset where the caret would leave the row's inline end", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(FIRST_CELL) });
    await settle();

    const rows = tableRowsFor(view, FIRST_CELL);
    const caretX = contentX(view, FIRST_CELL);
    rows[3]!.scrollLeft = 9999;
    await settle();

    // The clamp stopped it, not the row's own extent: those are different
    // numbers, and only the first of them tracks the caret.
    expect(maxOffset(rows[3]!)).toBeGreaterThan(caretX + 50);
    for (const row of rows) {
      expect(row.scrollLeft).toBeLessThan(maxOffset(row) - 50);
      // Within the caret marker's own width of the bound the clamp names.
      expect(Math.abs(row.scrollLeft - caretX)).toBeLessThanOrEqual(2);
    }
  });

  it("holds the offset where the caret would leave the row's inline start", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(LAST_CELL_END) });
    await settle();

    const rows = tableRowsFor(view, LAST_CELL_END);
    rows[2]!.scrollLeft = 9999;
    await settle();
    const caretX = contentX(view, LAST_CELL_END);
    const band = rows[2]!.clientWidth;

    rows[2]!.scrollLeft = 0;
    await settle();

    // Scrolling back to column one would take the caret off the inline start.
    for (const row of rows) {
      expect(row.scrollLeft).toBeGreaterThan(0);
      expect(Math.abs(row.scrollLeft - (caretX - band))).toBeLessThanOrEqual(2);
    }
  });

  it("keeps the drawn cursor inside the row it belongs to", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(LAST_CELL_END) });
    await settle();
    const row = rowFor(view, LAST_CELL_END);

    for (const attempt of [9999, 0, 9999]) {
      row.scrollLeft = attempt;
      await settle();
      const caret = drawnCaret(view);
      const box = row.getBoundingClientRect();
      expect(caret.left).toBeGreaterThanOrEqual(box.left - 1);
      expect(caret.right).toBeLessThanOrEqual(box.right + 1);
    }
  });

  it("runs to the full extent when the caret is outside the table", async () => {
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(OUTSIDE) });
    await settle();

    const rows = tableRowsFor(view, FIRST_CELL);
    rows[0]!.scrollLeft = 9999;
    await settle();

    expect(maxOffset(rows[0]!)).toBeGreaterThan(400);
    for (const row of rows) expect(row.scrollLeft).toBeCloseTo(maxOffset(row), 0);
  });

  it("runs to the full extent when the caret is in a different table", async () => {
    // The clamp is per table, not per editor. A caret two tables away has no
    // claim on this one's offset, and the caret it does own has not moved.
    const { view } = mount(SOURCE);
    view.dispatch({ selection: EditorSelection.cursor(SECOND_TABLE_CELL) });
    await settle();

    const rows = tableRowsFor(view, FIRST_CELL);
    rows[0]!.scrollLeft = 9999;
    await settle();

    for (const row of rows) expect(row.scrollLeft).toBeCloseTo(maxOffset(row), 0);
    for (const row of tableRowsFor(view, SECOND_TABLE_CELL)) expect(row.scrollLeft).toBe(0);
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
});
