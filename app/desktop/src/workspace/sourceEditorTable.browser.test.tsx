// Real-browser proof that the drawn table is a grid and that its rows survive
// being one.
//
// Every assertion here is geometric, which is exactly what jsdom cannot answer:
// it has no layout engine, so `getBoundingClientRect()` returns all-zeros and a
// grid assertion made there passes whatever the CSS says. The structural half of
// the same contract — child order, class names, stamped columns — is proved in
// `sourceEditorTableRender.test.ts`, which is cheaper and needs no browser.
//
// The hazard this file exists for was measured at P0 and no analysis had
// anticipated it. CodeMirror brackets every inline widget with
// `<img class="cm-widgetBuffer">` (`@codemirror/view/dist/index.js:2331-2341`,
// `:2464-2469`). In a grid container those are unplaced items that auto-flow
// into implicit rows: measured 128.78px rows against a 19.59px line box, 6.4x
// too tall, while every hit-testing probe still passed. Nothing in TypeScript
// can stamp them, because CodeMirror creates them, so the rules that park them
// are the stylesheet's — CT-1's `REQUIRED_STYLESHEET_RULES`.
//
// Two things follow for how this file is written:
//
//  1. The rules are `ui-designer`'s, in `styles.css`. Until they are there this
//     file injects the contract's own, and it decides which by MEASURING
//     whether the shipped stylesheet already lays the row out as a grid — so it
//     can never mask the shipped rules once they land.
//  2. A row of the right height proves nothing on its own, because a row that
//     never became a grid is also the right height. The auto-flow arm is
//     therefore RUN, not argued: the test forces `grid-row: auto` back on, reads
//     the damage, and restores. An assertion whose failure mode is never
//     exercised in the same run is one nobody has seen fail.

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { SourceNoteEditor } from "./SourceNoteEditor";
import { REQUIRED_STYLESHEET_RULES } from "./sourceEditorTableContractFixture";
import "../styles.css";

const SOURCE = [
  "# Commitments",
  "",
  "One short line.",
  "",
  "| Start date | Commitment | Notes |",
  "| --- | --- | --- |",
  "| 2026-04-03 | DJ gig | soundcheck at six |",
  "| 2026-11-30 | Rehearsal |  |",
].join("\n");

const PANE_WIDTH_PX = 640;

function styleSheet(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.dataset.nnTestRules = "true";
  style.textContent = css;
  document.head.append(style);
  return style;
}

const contractRules = (): string => REQUIRED_STYLESHEET_RULES
  .map((rule) => `${rule.selector} { ${rule.declarations} }`)
  .join("\n");

/**
 * The rendered row lines, scoped to `.cm-content` rather than to the host. CT-4's
 * measurement probe lives inside the editor host and wears CT-1's own row
 * classes — that is how it reproduces a cell's cascade — so an unscoped query
 * counts it as one more row of the table.
 */
const rowLines = (host: Element): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>(".cm-content .cm-line.nn-lp-table-row")];

const cellsOf = (line: Element): HTMLElement[] =>
  [...line.querySelectorAll<HTMLElement>(":scope > .nn-lp-cell")];

const trackCount = (row: Element): number =>
  getComputedStyle(row).gridTemplateRows.split(" ").filter(Boolean).length;

const heightOf = (row: Element): number => row.getBoundingClientRect().height;

describe("a drawn table as a grid", () => {
  let root: Root | null = null;

  // A stylesheet this file injects must never outlive it. A failed assertion
  // skips every line after it, so tearing the rules down at the end of the test
  // body would leave `grid-row: auto` in the document for whatever runs next.
  afterEach(() => {
    for (const style of document.querySelectorAll("style[data-nn-test-rules]")) style.remove();
    root?.unmount();
    root = null;
    document.querySelector(".nn-source-editor")?.remove();
  });

  it("keeps every row a single grid row, with its columns where they were stamped", async () => {
    const host = document.createElement("div");
    host.className = "nn-source-editor";
    host.style.width = `${PANE_WIDTH_PX}px`;
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <SourceNoteEditor
          sessionKey="browser-table"
          loadedHash="browser-table-hash"
          value={SOURCE}
          onChange={() => {}}
          onPreservationError={() => {}}
        />,
      );
    });

    // Reveal the source by putting the caret in the table.
    await page.getByRole("cell", { name: "DJ gig" }).click();
    await expect.element(page.getByRole("table", { name: "Markdown table" })).not.toBeInTheDocument();

    const rows = rowLines(host);
    expect(rows).toHaveLength(4);

    const shipped = getComputedStyle(rows[0]!).display === "grid";
    const injected = shipped ? null : styleSheet(contractRules());
    for (const row of rows) expect(getComputedStyle(row).display).toBe("grid");

    // No pipe is painted anywhere, though every one is still in the document.
    expect(host.querySelector(".cm-content")?.textContent ?? "").not.toContain("|");

    // 1. One grid row per line. Nine stacked tracks is what the buffers do
    //    unparked, and it is invisible to every hit-testing probe.
    expect(rows.map(trackCount)).toEqual([1, 1, 1, 1]);
    const heights = rows.map(heightOf);

    // 1b. The same measurement with the parking removed, so the assertion above
    //     is one that has been seen to fail.
    const unparked = styleSheet(".nn-source-editor .nn-lp-table-row > * { grid-row: auto }");
    expect(rows.map(trackCount).every((count) => count > 1)).toBe(true);
    expect(heightOf(rows[0]!)).toBeGreaterThan(heights[0]! * 2);
    unparked.remove();
    expect(rows.map(trackCount)).toEqual([1, 1, 1, 1]);
    expect(rows.map(heightOf)).toEqual(heights);

    // 2. Rows do not shear: every content row is the same height. (The
    //    alignment row is deliberately a slim band and is excluded.)
    const contentRows = rows.filter((row) => cellsOf(row).length > 0);
    expect(contentRows).toHaveLength(3);
    expect(new Set(contentRows.map(heightOf)).size).toBe(1);

    // 3. Columns. Every row's cell for a column starts at the same x, and the
    //    three columns are at three DIFFERENT x positions — without which a
    //    table collapsed into one column would satisfy the first half.
    const origins = contentRows.map((row) =>
      cellsOf(row).map((cell) => cell.getBoundingClientRect().left));
    for (const row of origins) expect(row).toHaveLength(3);
    for (let column = 0; column < 3; column += 1) {
      const xs = origins.map((row) => row[column]!);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.5);
    }
    const first = origins[0]!;
    expect(new Set(first).size).toBe(3);
    expect(first[1]! - first[0]!).toBeGreaterThan(0);
    expect(first[2]! - first[1]!).toBeGreaterThan(0);

    // 4. Track sizing, measured against the real font rather than argued. The
    //    producer's track has to cover the painted text AND the inline padding
    //    the stylesheet puts inside the cell; too narrow and the text is clipped
    //    at the column edge. This is the inline axis on purpose — reading
    //    `clientHeight < scrollHeight` here would answer a question about the
    //    block axis that nobody asked.
    const clipped = contentRows
      .flatMap(cellsOf)
      .filter((cell) => cell.scrollWidth > cell.clientWidth)
      .map((cell) => `${cell.textContent}: ${cell.scrollWidth} > ${cell.clientWidth}`);
    expect(clipped).toEqual([]);

    // 5. CT-1 stamps every child into an explicit grid column, alternating the
    //    app's own chrome widget with CodeMirror's cell mark.
    //
    //    The COLUMN is the invariant; the bytes are not. Where this app writes
    //    the DOM itself (`setAttribute` in a `WidgetType.toDOM`) the attribute is
    //    exactly what we passed. Where CodeMirror writes it for us it applies the
    //    decoration's `style` as `dom.style.cssText = value`
    //    (`@codemirror/view/dist/index.js:94-95`), and assigning `cssText`
    //    re-serialises — engine-dependently. Chromium keeps the shorthand
    //    (`grid-column: 1;`); WebKit expands it to
    //    `grid-column-start: 1; grid-column-end: auto;`. Pinning either spelling
    //    asserts a CSSOM implementation detail and reds the other engine's lane
    //    while the layout is identical, so read the resolved column instead.
    const stampedChildren = [...contentRows[0]!.children]
      .filter((child) => !child.classList.contains("cm-widgetBuffer"));
    expect(stampedChildren.map((child) => getComputedStyle(child).gridColumnStart))
      .toEqual(["1", "1", "2", "2", "3", "3", "3"]);
    // The app's own widgets are the ones we hand-write, so their bytes ARE
    // deterministic and stay frozen — that is the half CT-1 actually owns.
    expect(stampedChildren.filter((_, index) => index % 2 === 0).map((c) => c.getAttribute("style")))
      .toEqual(["grid-column: 1", "grid-column: 2", "grid-column: 3", "grid-column: 3"]);
    expect(contentRows[0]!.getAttribute("style")).toMatch(/^--nn-table-tracks: .+;$/);

    injected?.remove();
  });
});
