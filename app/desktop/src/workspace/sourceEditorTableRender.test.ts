// The runtime element tree the table decorations build, measured against CT-1
// (`sourceEditorTableContractFixture.ts`).
//
// jsdom has no layout engine, so nothing here asserts geometry — that is
// `sourceEditorTableRender.browser.test.tsx`. What jsdom DOES build is the full
// CodeMirror tile tree, `cm-widgetBuffer` elements included, so the part of CT-1
// that is structure — direct-child order, class names, `grid-column` values,
// edge hooks — is provable here and is provable nowhere cheaper.
//
// One clause of CT-1 is knowingly NOT asserted as equality, because it was
// measured to be wrong rather than unimplemented:
//
//   BUFFER COUNTS. CT-1 applies "one buffer before and one after every
//   widget-backed child" uniformly. CodeMirror does not: `addInlineWidget`
//   (`@codemirror/view/dist/index.js:2331-2341`) suppresses the leading buffer
//   of a `Before`-facing point widget and, via `flushBuffer` (`:2464-2469`),
//   suppresses the trailing buffer of an `After`-facing one — and elides both
//   between two adjacent same-facing point widgets. Measured for
//   `[divider replace][zero-length cell][trailing replace]`: 1 buffer then 2
//   for `side <= 0`, 2 then 1 for `side > 0`, never CT-1's 2 and 2. Adjacent
//   fillers get none at all, which answers CT1-Q2.
//
// CELL TEXT used to be a second such clause: the collector refused to descend
// into a `Table`, so `**DJ gig**` painted its markers on screen while
// `cellPaintPlan` — and therefore the track the column was stamped at —
// projected `DJ gig`. The collector descends now, and every fixture table's own
// text is asserted below.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { obsidianLivePreview } from "./obsidianLivePreview";
import { sourceEditorDecorations } from "./sourceEditorDecorations";
import {
  TABLE_CONTRACT_FIXTURE,
  type ContractChild,
  type ContractTable,
} from "./sourceEditorTableContractFixture";

interface StampedChild {
  readonly tag: string;
  readonly className: string;
  readonly gridColumn: string | null;
}

const mounted: EditorView[] = [];

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

/**
 * Finish the Markdown parse before anything below reads the DOM.
 *
 * `LanguageState.init` gives the parser 20 ms of WALL CLOCK and hands back
 * whatever tree it holds when that runs out
 * (`@codemirror/language/dist/index.js:540-545`). The budget is checked with
 * `Date.now()` between two `advance()` calls, so a machine busy enough to
 * deschedule this process for 20 ms can leave even a three-line table with no
 * `Table` node — and every assertion in this file would then be measuring the
 * scheduler rather than the decorations.
 *
 * Resumed, never slept on: each pass is CPU-bound parse work picked up where the
 * last left off, so a busy machine makes this slower and never wrong. It leans
 * on `sourceEditorDecorations` recomputing when the tree changes — without that
 * the parse would settle and the decorations would not, and these tests would
 * fail rather than quietly pass.
 *
 * The condition is the span of the tree the decorations READ, not
 * `syntaxTreeAvailable`: that one reports on the parse context, which
 * `ensureSyntaxTree` can advance without any transaction carrying the result
 * into the state.
 */
function settleParse(view: EditorView): void {
  const parsedToEnd = () => syntaxTree(view.state).length >= view.state.doc.length;
  for (let pass = 0; pass < 50 && !parsedToEnd(); pass += 1) {
    forceParsing(view, view.state.doc.length, 1_000);
  }
  if (!parsedToEnd()) {
    throw new Error(
      `Markdown parse settled at ${syntaxTree(view.state).length} of ${view.state.doc.length} characters`,
    );
  }
}

function mount(doc: string, caretAt: number, extra: readonly Extension[] = []): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caretAt },
      extensions: [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        sourceEditorDecorations(() => {}),
        ...extra,
      ],
    }),
    parent: host,
  });
  mounted.push(view);
  settleParse(view);
  return view;
}

const rowLines = (view: EditorView): HTMLElement[] =>
  [...view.dom.querySelectorAll<HTMLElement>(".cm-line.nn-lp-table-row")];

const isBuffer = (element: Element): boolean => element.classList.contains("cm-widgetBuffer");

/**
 * The stamped `grid-column`, read off the style attribute rather than
 * `element.style`: jsdom's CSS object model does not implement the `grid-column`
 * shorthand, so `getPropertyValue` returns "" for a value the attribute holds.
 */
function gridColumnOf(element: Element): string | null {
  return /grid-column:\s*([^;]+)/.exec(element.getAttribute("style") ?? "")?.[1]?.trim() ?? null;
}

/** Every direct child of a row line that this app stamps — buffers excluded. */
function stampedChildren(line: Element): StampedChild[] {
  return [...line.children].filter((child) => !isBuffer(child)).map((child) => ({
    tag: child.tagName.toLowerCase(),
    className: child.getAttribute("class") ?? "",
    gridColumn: gridColumnOf(child),
  }));
}

const contractStamped = (children: readonly ContractChild[]): StampedChild[] =>
  children.filter((child) => child.decoration !== "buffer").map((child) => ({
    tag: child.tag,
    className: child.className,
    gridColumn: child.gridColumn,
  }));

const fixture = (name: string): ContractTable => {
  const table = TABLE_CONTRACT_FIXTURE.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`No fixture table named ${name}`);
  return table;
};

const cellsOf = (line: Element): HTMLElement[] =>
  [...line.querySelectorAll<HTMLElement>(":scope > .nn-lp-cell")];

describe("table row structure", () => {
  it("draws exactly one cell per column on every row, at its declared column", () => {
    // P3b's gate. `**b**` is the case a split mark breaks: an inner mark
    // boundary would cut the cell element in two and the column would hold two
    // grid items rather than one.
    const doc = "| a **b** c | x | y |\n| --- | --- | --- |\n| p | q | r |";
    const view = mount(doc, doc.indexOf("| p"));
    const lines = rowLines(view);

    expect(lines).toHaveLength(3);
    for (const line of [lines[0]!, lines[2]!]) {
      expect(cellsOf(line).map(gridColumnOf)).toEqual(["1", "2", "3"]);
    }
    expect(cellsOf(lines[1]!)).toEqual([]);
  });

  it("places every child it owns in a column, leaving only buffers unplaced", () => {
    // The bug this phase exists to remove: the boundary chrome used to sort
    // OUTSIDE the table-wide mark, so it became an item in a column of its own.
    // Buffers are CodeMirror's and are placed by the stylesheet (CT-1 C2).
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const view = mount(doc, doc.indexOf("| x"));

    for (const line of rowLines(view)) {
      const unplaced = [...line.children]
        .filter((child) => !isBuffer(child) && gridColumnOf(child) === null)
        .map((child) => child.outerHTML);

      expect(unplaced).toEqual([]);
    }
  });

  it("stamps the track template on every row line, not only the first", () => {
    const doc = "| a | bb |\n| --- | --- |\n| ccc | d |";
    const view = mount(doc, doc.indexOf("| ccc"));
    const stamps = rowLines(view).map((line) => line.getAttribute("style"));

    expect(stamps).toHaveLength(3);
    for (const stamp of stamps) expect(stamp).toContain("--nn-table-tracks: 5ch 4ch");
  });

  it("names each row's kind and marks the table's two edges", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const view = mount(doc, doc.indexOf("| x"));

    expect(rowLines(view).map((line) => line.getAttribute("class"))).toEqual([
      "cm-line nn-lp-table-row nn-lp-table-row-header nn-lp-table-row-first",
      "cm-line nn-lp-table-row nn-lp-table-row-delimiter",
      "cm-line nn-lp-table-row nn-lp-table-row-body nn-lp-table-row-last",
    ]);
  });

  it("collapses the alignment row to one rule spanning every column", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const view = mount(doc, doc.indexOf("| x"));

    expect(stampedChildren(rowLines(view)[1]!)).toEqual([{
      tag: "span",
      className: "nn-lp-cell-chrome nn-lp-cell-chrome-rule",
      gridColumn: "1 / -1",
    }]);
  });
});

describe("degenerate cells", () => {
  it("renders a genuinely empty cell as one element at its own column", () => {
    // CT1-Q1, which P0 could not settle: `| x |  | z |`'s middle cell is a
    // zero-length range, so it cannot be a mark at all.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |  | z |";
    const view = mount(doc, doc.indexOf("| x"));
    const body = rowLines(view).at(-1)!;

    expect(cellsOf(body).map((cell) => [cell.getAttribute("class"), gridColumnOf(cell)])).toEqual([
      ["nn-lp-cell", "1"],
      ["nn-lp-cell nn-lp-cell-empty", "2"],
      ["nn-lp-cell", "3"],
    ]);
  });

  it("holds a ragged row's missing column open, ahead of the closing chrome", () => {
    // K7d: the trailing chrome stays the row's last stamped child and stays at
    // the table's last column, so the stylesheet has one dependable anchor.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| only |";
    const view = mount(doc, doc.indexOf("| only"));

    expect(stampedChildren(rowLines(view).at(-1)!)).toEqual([
      { tag: "span", className: "nn-lp-cell-chrome nn-lp-cell-chrome-leading", gridColumn: "1" },
      { tag: "span", className: "nn-lp-cell", gridColumn: "1" },
      { tag: "span", className: "nn-lp-cell nn-lp-cell-filler", gridColumn: "2" },
      { tag: "span", className: "nn-lp-cell nn-lp-cell-filler", gridColumn: "3" },
      { tag: "span", className: "nn-lp-cell-chrome nn-lp-cell-chrome-trailing", gridColumn: "3" },
    ]);
  });

  it("keeps a widget that fills a whole cell inside that cell's element", () => {
    // Measured, not assumed: with a non-inclusive cell mark a replacement
    // covering the cell sorts BEFORE the mark opens, the cell element is never
    // built, and the widget becomes an unplaced grid item of its own. This is
    // the same boundary-sorting bug as the table-wide mark, one level down, and
    // `[[Roadmap]]` reaches it today through `obsidianLivePreview`.
    const doc = "| a | b |\n| --- | --- |\n| x | [[Roadmap]] |";
    const view = mount(doc, doc.indexOf("| x"), [
      obsidianLivePreview([], () => {}, () => {}),
    ]);
    const body = rowLines(view).at(-1)!;
    const cells = cellsOf(body);

    expect(cells.map(gridColumnOf)).toEqual(["1", "2"]);
    expect(cells[1]!.textContent).toBe("Roadmap");
    expect(cells[1]!.querySelector(".nn-lp-wikilink-unresolved")).not.toBeNull();
  });
});

describe("the states a table is NOT drawn as cells in", () => {
  it("keeps the block table widget for a table the caret is outside", () => {
    // K7b: the cell provider is demoted below the preview plugin, and a demoted
    // provider must not cost the block widget. Block decorations may not come
    // from a plugin, so both providers read one StateField.
    const doc = "# Heading\n\n| a | b |\n| --- | --- |\n| x | y |";
    const view = mount(doc, 0);

    expect(view.dom.querySelectorAll("table.nn-lp-table")).toHaveLength(1);
    expect(view.dom.querySelectorAll(".nn-lp-cell")).toHaveLength(0);
    expect(rowLines(view)).toEqual([]);
  });

  it("keeps that widget when the parser gives up on its first slice", () => {
    // The gate on `settleParse`, and the reason this file's flake was never a
    // decoration bug. `LanguageState.init` compares `Date.now()` against a 20 ms
    // deadline between two `advance()` calls, so a machine that deschedules this
    // process mid-parse yields a tree with no `Table` node at all. A clock that
    // jumps is exactly what that looks like from inside the parser — measured,
    // this leaves the tree at `Document@0-10` and the DOM with zero tables.
    const doc = "# Heading\n\n| a | b |\n| --- | --- |\n| x | y |";
    const realNow = Date.now.bind(Date);
    let deadlineTaken = false;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      // The parser's first read sets its deadline; every read after it is a
      // process that has been off the CPU for ten seconds.
      if (deadlineTaken) return realNow() + 10_000;
      deadlineTaken = true;
      return realNow();
    });
    try {
      const view = mount(doc, 0);
      expect(view.dom.querySelectorAll("table.nn-lp-table")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("leaves an oversized table as literal source with its pipes painted", () => {
    const doc = [
      "| Key | Value |",
      "| --- | --- |",
      ...Array.from({ length: 260 }, (_, index) => `| ${index} | v |`),
    ].join("\n");
    const view = mount(doc, doc.indexOf("| 3 |") + 3);

    expect(view.dom.querySelector(".nn-lp-table-source")).not.toBeNull();
    expect(view.dom.querySelectorAll(".nn-lp-cell")).toHaveLength(0);
    expect(view.dom.querySelector(".cm-content")?.textContent).toContain("|");
  });
});

describe("CT-1 conformance", () => {
  it.each(TABLE_CONTRACT_FIXTURE.map((table) => table.name))(
    "matches the contract's stamped children for the %s table",
    (name) => {
      const table = fixture(name);
      const view = mount(table.source, table.source.indexOf("|") + 1, [
        obsidianLivePreview([], () => {}, () => {}),
      ]);
      const lines = rowLines(view);

      expect(lines).toHaveLength(table.rows.length);
      expect(lines.map(stampedChildren)).toEqual(table.rows.map((row) => contractStamped(row.children)));
      expect(lines.map((line) => line.getAttribute("class")))
        .toEqual(table.rows.map((row) => row.lineClassName));
    },
  );

  it("carries one buffer fewer per zero-length cell than the contract predicts", () => {
    // CT1-Q1 and CT1-Q2, both open in the fixture, now measured. CT-1 applies
    // "a buffer before and after every widget-backed child" uniformly;
    // CodeMirror suppresses the trailing buffer of an `After`-facing point
    // widget (`flushBuffer`, `@codemirror/view/dist/index.js:2464-2469`) and
    // elides both between two adjacent same-facing ones (`:2331-2336`). So a
    // row is one buffer lighter per zero-length cell, and a row with two
    // adjacent fillers is lighter still. The count matters because every buffer
    // is an unplaced grid item that the stylesheet has to park.
    const census = TABLE_CONTRACT_FIXTURE.map((table) => {
      const view = mount(table.source, table.source.indexOf("|") + 1, [
        obsidianLivePreview([], () => {}, () => {}),
      ]);
      return {
        name: table.name,
        runtime: rowLines(view).map((line) =>
          [...line.children].filter(isBuffer).length),
        contract: table.rows.map((row) =>
          row.children.filter((child) => child.decoration === "buffer").length),
      };
    });

    expect(census).toEqual([
      { name: "full-topology", runtime: [8, 2, 9, 8], contract: [8, 2, 10, 8] },
      { name: "one-row", runtime: [6, 2], contract: [6, 2] },
      { name: "ragged", runtime: [8, 2, 7], contract: [8, 2, 8] },
    ]);
  });

  it("elides every buffer between two adjacent zero-length cells", () => {
    // CT1-Q2's own shape, which no fixture table contains.
    const doc = "| a | b | c |\n| --- | --- | --- |\n| only |";
    const view = mount(doc, doc.indexOf("| only"));
    const body = rowLines(view).at(-1)!;
    const fillers = [...body.children].filter((child) =>
      child.classList.contains("nn-lp-cell-filler"));

    expect(fillers).toHaveLength(2);
    expect(fillers[0]!.nextElementSibling).toBe(fillers[1]!);
    expect([...body.children].filter(isBuffer)).toHaveLength(5);
  });

  it("shows the contract's cell text on every fixture table", () => {
    // `full-topology` is the one that earns this assertion. Its `**DJ gig**`,
    // `` `soundcheck` `` and `[[Roadmap]]` cells each put fewer characters on
    // screen than they hold in the source, and the track each is given is
    // measured from exactly that projection — so a marker still painted here is
    // a cell wider than its column, spilling over the rule into its neighbour.
    for (const table of TABLE_CONTRACT_FIXTURE) {
      const view = mount(table.source, table.source.indexOf("|") + 1, [
        obsidianLivePreview([], () => {}, () => {}),
      ]);

      const text = rowLines(view).map((line) =>
        cellsOf(line).map((cell) => cell.textContent ?? ""));
      const expected = table.rows.map((row) =>
        row.children.filter((child) => child.className.startsWith("nn-lp-cell") && child.tag === "span"
          && !child.className.includes("chrome"))
          .map((child) => child.text ?? ""));

      expect({ name: table.name, text }).toEqual({ name: table.name, text: expected });
    }
  });
});

describe("byte fidelity", () => {
  it("changes nothing on open, and nothing on a caret walk through every cell", () => {
    const doc = "| a | b | c |\n| --- | --- | --- |\n| x |  | z |\n| only |";
    const view = mount(doc, 0);
    const changed: boolean[] = [];

    for (let anchor = 0; anchor <= doc.length; anchor += 1) {
      view.dispatch({ selection: { anchor } });
      changed.push(view.state.doc.toString() !== doc);
    }

    expect(changed.filter(Boolean)).toEqual([]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("re-derives the same tree after a no-op refresh, so nothing accretes", () => {
    const doc = "| a | b |\n| --- | --- |\n| x | y |";
    const view = mount(doc, doc.indexOf("| x"));
    const before = rowLines(view).map((line) => line.outerHTML);

    view.dispatch({ selection: { anchor: view.state.selection.main.head } });

    expect(rowLines(view).map((line) => line.outerHTML)).toEqual(before);
  });
});

describe("decoration precedence", () => {
  it("keeps one cell element when a higher-precedence mark covers the same text", () => {
    // The cell mark must be the OUTERMOST element or it is split at every inner
    // mark boundary, which is how one column comes to hold two grid items.
    const doc = "| abc | d |\n| --- | --- |\n| x | y |";
    const inner = EditorView.decorations.of(Decoration.set([
      Decoration.mark({ class: "probe-inner" })
        .range(doc.indexOf("abc") + 1, doc.indexOf("abc") + 2),
    ]));
    const view = mount(doc, doc.indexOf("| x"), [inner]);
    const header = rowLines(view)[0]!;

    expect(cellsOf(header)).toHaveLength(2);
    expect(header.querySelector(".nn-lp-cell > .probe-inner")).not.toBeNull();
  });
});
