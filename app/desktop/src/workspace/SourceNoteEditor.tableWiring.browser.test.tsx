// P4 in a real browser — the three table seams, proved through the shipped
// `SourceNoteEditor` and nothing else.
//
// The jsdom lane next door (`SourceNoteEditor.tableMetrics.test.tsx`) proves the
// wiring: which unit the tracks are stamped in, and that an epoch bump
// re-derives them. It cannot prove the numbers. jsdom answers 0 to every
// measurement, so a column sized from a measured advance and one sized from a
// character count are the same column there. Here they are not: `iiiiiiiiiiii`
// and `WWWWWWWWWWWW` are the same twelve characters and roughly a factor of
// three apart in width.
//
// Four contracts, each with its own failure mode:
//
//  0. THE TRACK IS MEASURED FROM THE PAINTED TEXT. Both arms of the measurement
//     read `cellPaintPlan`, so a marker the editor still PAINTS is invisible to
//     every assertion that compares one arm against the other. It shows up here
//     and only here, as a cell too wide for the track it was stamped into — and
//     the glyph fixture cannot catch it, because its cells paint their own
//     source character for character.
//  1. TRACKS ARE MEASURED. A character-count fallback gives the two columns of
//     the glyph fixture identical tracks. Measured, it cannot.
//  2. THE TRACK CARRIES THE CELL'S OWN PADDING. `measuredWidth` reports the text
//     advance and stops there — under CT-2 the cell's box is whatever the track
//     says, so measuring the box would be circular. The caller adds the
//     `padding-inline` the stylesheet puts inside the cell, and the arithmetic is
//     asserted here as an equality rather than through "nothing clipped", which
//     the gutter would absorb.
//  3. A TYPOGRAPHY CHANGE RE-DERIVES BOTH. The font-scale preference writes the
//     root font size (`preferences.tsx:applyPreferences`), which moves the
//     editor's own `font-size: 1rem` and the cell padding's `0.5rem` together.
//     Nothing re-measures on its own.
//
// And through all of it: not one byte of the document moves.

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { EditorView } from "@codemirror/view";

import { SourceNoteEditor } from "./SourceNoteEditor";
import { CELL_TRACK_GUTTER_PX } from "./sourceEditorTableModel";
// The app loads these in `main.tsx`; without them every measurement here is the
// fallback face's. Imported by explicit path because a bare specifier for a
// CSS-only package has no type declarations to resolve.
import "@fontsource-variable/inter/index.css";
import "../styles.css";

/** P3a's own gate: the probe reproduces live rendering to within a pixel. */
const TOLERANCE_PX = 1;

const PANE_WIDTH_PX = 640;

/**
 * Two columns, twelve characters each. The character fallback stamps them
 * identically; no measurement of real text can.
 */
const GLYPH_TABLE = [
  "# Widths",
  "",
  "| Narrow | Wide |",
  "| --- | --- |",
  "| iiiiiiiiiiii | WWWWWWWWWWWW |",
].join("\n");

/**
 * A cell carrying every construct whose source is longer than what it paints.
 *
 * The glyph fixture above cannot catch a column measured from the wrong string,
 * because its cells paint their own source character for character. This one
 * paints twenty-three characters out of a fifty-two-character cell, so a track
 * sized from the source is more than twice too wide and a cell that still paints
 * its markers is more than twice too wide for its track.
 */
const MARKUP_TABLE = [
  "# Formatting",
  "",
  "| Plain | Formatted |",
  "| --- | --- |",
  "| anchor | **bold** and `code` and [label](https://example.com/a) |",
].join("\n");

/** What {@link MARKUP_TABLE}'s second body cell puts on screen. */
const MARKUP_CELL_PAINTED = "bold and code and label";

/** Wider than the pane, so every row of it is a live scroll container. */
const WIDE_TABLE = [
  "# Commitments",
  "",
  "| Start date | Commitment | Notes |",
  "| --- | --- | --- |",
  "| 2026-04-03 | Soundcheck at the Bell before the doors open"
    + " | bring the long cable, the spare fuse and the tuner |",
  "| 2026-11-30 | Rehearsal in the annexe with the whole band"
    + " | the room with the broken window sill and no heating |",
].join("\n");

/** Unique in {@link WIDE_TABLE}, so the reveal click is unambiguous. */
const WIDE_TABLE_CELL = "bring the long cable, the spare fuse and the tuner";

/**
 * Scoped to `.cm-content` on purpose. The measurement probe wears CT-1's row
 * classes — that is how it reproduces a cell's cascade — so an unscoped
 * `.nn-lp-table-row` query counts it as one more row of the table.
 */
const rowLines = (host: Element): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>(".cm-content .cm-line.nn-lp-table-row")];

const cellsOf = (line: Element): HTMLElement[] =>
  [...line.querySelectorAll<HTMLElement>(":scope > .nn-lp-cell")];

/** The used track sizes, in CSS pixels, whatever unit they were stamped in. */
const tracksOf = (line: Element): number[] =>
  getComputedStyle(line).gridTemplateColumns
    .split(" ")
    .filter(Boolean)
    .map((track) => Number.parseFloat(track));

/** The advance of what a cell paints — its contents, never its box. */
function advanceOf(cell: HTMLElement): number {
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  return range.getBoundingClientRect().width;
}

/** The inline padding the stylesheet puts inside a cell, start plus end. */
function paddingOf(cell: HTMLElement): number {
  const style = getComputedStyle(cell);
  return Number.parseFloat(style.paddingInlineStart)
    + Number.parseFloat(style.paddingInlineEnd);
}

interface Column {
  readonly track: number;
  readonly advance: number;
  readonly padding: number;
}

/** What each column is stamped at, beside what its widest cell actually needs. */
function columns(host: Element): Column[] {
  const rows = rowLines(host);
  const contentRows = rows.filter((row) => cellsOf(row).length > 0);
  return tracksOf(rows[0]!).map((track, index) => {
    const cells = contentRows.map((row) => cellsOf(row)[index]!);
    return {
      track,
      advance: Math.max(...cells.map(advanceOf)),
      padding: Math.max(...cells.map(paddingOf)),
    };
  });
}

/**
 * Every distinct inline padding in the table.
 *
 * The probe measures ONE padding and caches it for the whole epoch, so a header
 * cell padded differently from a body cell would be sized from the wrong number
 * — quietly, and only for one row band. `styles.css` declares the padding in one
 * place today; this is what would notice if it stopped.
 */
const distinctPaddings = (host: Element): number[] =>
  [...new Set(rowLines(host).flatMap(cellsOf).map(paddingOf))];

/** Cells whose painted text does not fit the track it was given. */
const clippedCells = (host: Element): string[] =>
  rowLines(host)
    .flatMap(cellsOf)
    .filter((cell) => cell.scrollWidth > cell.clientWidth)
    .map((cell) => `${cell.textContent}: ${cell.scrollWidth} > ${cell.clientWidth}`);

const frame = (): Promise<void> =>
  new Promise((resolve) => { requestAnimationFrame(() => { resolve(); }); });

/** Long enough for the scroll event, the sync's microtask and a measure cycle. */
async function settle(frames = 4): Promise<void> {
  for (let index = 0; index < frames; index += 1) await frame();
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let mounts = 0;

/** Mounts the shipped editor and reveals `revealCell`'s table as drawn cells. */
async function mountRevealed(source: string, revealCell: string): Promise<EditorView> {
  mounts += 1;
  host = document.createElement("div");
  host.className = "nn-source-editor";
  host.style.width = `${PANE_WIDTH_PX}px`;
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <SourceNoteEditor
        sessionKey={`table-wiring-${mounts}`}
        loadedHash={`table-wiring-${mounts}`}
        value={source}
        onChange={() => {}}
        onPreservationError={() => {}}
      />,
    );
  });

  // A table is drawn as cells only while the caret is inside it.
  await page.getByRole("cell", { name: revealCell }).click();
  await expect.element(page.getByRole("table", { name: "Markdown table" }))
    .not.toBeInTheDocument();
  await settle();
  return EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
}

afterEach(() => {
  document.documentElement.style.removeProperty("font-size");
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

describe("the composed editor's measured table tracks", () => {
  it("sizes each column from the text it paints, not from a character count", async () => {
    await mountRevealed(GLYPH_TABLE, "WWWWWWWWWWWW");
    const [narrow, wide] = columns(host!);

    // The fixture's own premise, asserted rather than trusted: identical
    // character counts, so `ch` tracks would be equal to the pixel.
    expect("iiiiiiiiiiii".length).toBe("WWWWWWWWWWWW".length);
    expect(wide!.track).toBeGreaterThan(narrow!.track * 1.5);
  });

  it("stamps each track at the widest cell's advance plus that cell's own padding", async () => {
    await mountRevealed(GLYPH_TABLE, "WWWWWWWWWWWW");

    // Stated as the arithmetic rather than as "nothing is clipped": the gutter
    // happens to equal the padding at the default font scale, so a track that
    // dropped the padding entirely would still land within a pixel of fitting.
    const off = columns(host!)
      .filter((column) =>
        Math.abs(column.track - (column.advance + column.padding + CELL_TRACK_GUTTER_PX))
          > TOLERANCE_PX)
      .map((column) =>
        `track ${column.track} vs advance ${column.advance} + padding ${column.padding}`
        + ` + gutter ${CELL_TRACK_GUTTER_PX}`);

    expect(off).toEqual([]);
    expect(clippedCells(host!)).toEqual([]);
    expect(distinctPaddings(host!)).toHaveLength(1);
  });

  it("sizes a column of inline markup from the painted text, not the source", async () => {
    // The gap the glyph fixture above cannot see. Both arms of the measurement
    // read `cellPaintPlan`, so a marker the editor still PAINTS is invisible to
    // every assertion that compares one arm against the other — it shows up only
    // here, as a cell wider than the track it was stamped into, spilling over
    // the column rule into its neighbour.
    const view = await mountRevealed(MARKUP_TABLE, "anchor");
    const body = rowLines(host!).at(-1)!;

    // The premise, asserted rather than trusted. If the markers were painted,
    // the equality below would still hold for a track measured from the source —
    // it is the disagreement between the two that this test exists to catch, and
    // it needs the two to be genuinely different strings.
    expect(cellsOf(body)[1]!.textContent).toBe(MARKUP_CELL_PAINTED);
    expect(MARKUP_CELL_PAINTED.length).toBeLessThan(
      "**bold** and `code` and [label](https://example.com/a)".length / 2,
    );

    const off = columns(host!)
      .filter((column) =>
        Math.abs(column.track - (column.advance + column.padding + CELL_TRACK_GUTTER_PX))
          > TOLERANCE_PX)
      .map((column) =>
        `track ${column.track} vs advance ${column.advance} + padding ${column.padding}`
        + ` + gutter ${CELL_TRACK_GUTTER_PX}`);

    expect(off).toEqual([]);
    expect(clippedCells(host!)).toEqual([]);
    expect(view.state.doc.toString()).toBe(MARKUP_TABLE);
  });

  it("re-derives every track when the font scale changes, and moves no byte", async () => {
    const view = await mountRevealed(GLYPH_TABLE, "WWWWWWWWWWWW");
    const before = columns(host!).map((column) => column.track);
    expect(before).toHaveLength(2);

    // Exactly what the Appearance setting does (`preferences.tsx`). It moves the
    // editor's `font-size: 1rem` and the cell's `0.5rem` padding together, so a
    // track re-derived from a stale measurement or a hard-coded padding lands
    // visibly short rather than marginally.
    document.documentElement.style.setProperty("font-size", "200%");
    await expect.poll(() => columns(host!)[1]!.track).toBeGreaterThan(before[1]! * 1.5);

    const off = columns(host!)
      .filter((column) =>
        Math.abs(column.track - (column.advance + column.padding + CELL_TRACK_GUTTER_PX))
          > TOLERANCE_PX)
      .map((column) =>
        `track ${column.track} vs advance ${column.advance} + padding ${column.padding}`);

    expect(off).toEqual([]);
    expect(clippedCells(host!)).toEqual([]);
    expect(view.state.doc.toString()).toBe(GLYPH_TABLE);
  });
});

describe("the composed editor's table row scrolling", () => {
  it("puts every row of a table on the offset one row was scrolled to", async () => {
    const view = await mountRevealed(WIDE_TABLE, WIDE_TABLE_CELL);
    const rows = rowLines(host!);
    expect(rows).toHaveLength(4);

    // The premise: without a table wider than its pane there is nothing to
    // synchronise and every assertion below would pass on four zeros.
    for (const row of rows) expect(row.scrollWidth - row.clientWidth).toBeGreaterThan(20);

    rows[0]!.scrollLeft = rows[0]!.scrollWidth;
    await settle();

    const offsets = rows.map((row) => Math.round(row.scrollLeft));
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets).toEqual([offsets[0], offsets[0], offsets[0], offsets[0]]);
    expect(view.state.doc.toString()).toBe(WIDE_TABLE);
  });

  // `sourceEditorTableScrollSync` stamps the class; `styles.css` is the whole of
  // its effect. Both halves are asserted here because either alone is only a
  // claim: a class nothing consumes hides no caret, and a rule nothing stamps
  // never fires. The module's own suite proves the stamping happens; this
  // proves the stamping does something.
  it("stops drawing the caret once its character scrolls out of the row", async () => {
    // The FIRST column deliberately. Revealing a last-column cell and then
    // scrolling right brings the caret INTO view, so the flag never raises and
    // the test passes while proving nothing.
    const view = await mountRevealed(WIDE_TABLE, "2026-04-03");
    const editor = host!.querySelector<HTMLElement>(".cm-editor")!;
    const cursorLayer = editor.querySelector<HTMLElement>(".cm-cursorLayer")!;

    // The premise, asserted rather than assumed. If the layer were already
    // hidden — unfocused, or never built — every assertion below would pass
    // against a caret that was never drawn in the first place.
    expect(editor.classList.contains("nn-table-caret-offscreen")).toBe(false);
    expect(getComputedStyle(cursorLayer).display).not.toBe("none");

    const rows = [...host!.querySelectorAll<HTMLElement>(".cm-content .nn-lp-table-row")];
    expect(rows[0]!.scrollWidth - rows[0]!.clientWidth).toBeGreaterThan(20);

    rows[0]!.scrollLeft = rows[0]!.scrollWidth;
    await settle();

    expect(editor.classList.contains("nn-table-caret-offscreen")).toBe(true);
    expect(getComputedStyle(cursorLayer).display).toBe("none");

    rows[0]!.scrollLeft = 0;
    await settle();

    expect(editor.classList.contains("nn-table-caret-offscreen")).toBe(false);
    expect(getComputedStyle(cursorLayer).display).not.toBe("none");
    expect(view.state.doc.toString()).toBe(WIDE_TABLE);
  });
});
