// Pins CT-1, the golden DOM contract for a live-preview Markdown table.
//
// The fixture module is the contract; this file is what goes red when it
// drifts. Three groups of assertions:
//
//   1. Literal golden HTML for one row of each kind, so class names, attribute
//      set and child order are pinned character for character.
//   2. Structural invariants that hold for EVERY row of EVERY fixture table —
//      explicit grid columns, widget-buffer bracketing, edge hooks. These are
//      the clauses a later phase would otherwise rediscover by measuring.
//   3. That the unresolved parts are recorded as open questions rather than
//      quietly frozen.

import { describe, expect, it } from "vitest";

import {
  CONTRACT_OPEN_QUESTIONS,
  CONTRACT_TRACK_ORIGINS_PX,
  CONTRACT_TRACK_TEMPLATE,
  REQUIRED_STYLESHEET_RULES,
  TABLE_CONTRACT_FIXTURE,
  renderContractRow,
  type ContractChild,
  type ContractRow,
  type ContractTable,
} from "./sourceEditorTableContractFixture";

const tables = TABLE_CONTRACT_FIXTURE;
const rowsOf = (table: ContractTable): readonly ContractRow[] => table.rows;
const allRows = (): ContractRow[] => tables.flatMap(rowsOf);

const isBuffer = (child: ContractChild): boolean => child.decoration === "buffer";
const isWidgetBacked = (child: ContractChild): boolean =>
  child.decoration === "replace" || child.decoration === "widget";
/** Whole class tokens, so `nn-lp-cell` never matches `nn-lp-cell-chrome`. */
const classTokens = (child: ContractChild): string[] => child.className.split(" ");

function tableNamed(name: string): ContractTable {
  const table = tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`No fixture table named ${name}`);
  return table;
}

function rowOfKind(table: ContractTable, kind: ContractRow["kind"], index = 0): ContractRow {
  const matching = table.rows.filter((row) => row.kind === kind);
  const row = matching[index];
  if (!row) throw new Error(`No ${kind} row at index ${index} in ${table.name}`);
  return row;
}

const BUFFER_HTML = '<img class="cm-widgetBuffer" aria-hidden="true">';
const chromeHtml = (kind: string, column: string): string =>
  `<span class="nn-lp-cell-chrome nn-lp-cell-chrome-${kind}" style="grid-column: ${column}"`
  + ' aria-hidden="true"></span>';
const cellHtml = (column: string, text: string, extra = ""): string =>
  `<span class="nn-lp-cell${extra}" style="grid-column: ${column}">${text}</span>`;

describe("CT-1 golden DOM contract — literal rendering", () => {
  it("renders the header row exactly, buffers included", () => {
    const header = rowOfKind(tableNamed("full-topology"), "header");

    expect(renderContractRow(header)).toBe([
      '<div class="cm-line nn-lp-table-row nn-lp-table-row-header nn-lp-table-row-first"',
      ' style="--nn-table-tracks: 200px 220px 210px">',
      BUFFER_HTML,
      chromeHtml("leading", "1"),
      BUFFER_HTML,
      cellHtml("1", "Start date"),
      BUFFER_HTML,
      chromeHtml("divider", "2"),
      BUFFER_HTML,
      cellHtml("2", "Commitment"),
      BUFFER_HTML,
      chromeHtml("divider", "3"),
      BUFFER_HTML,
      cellHtml("3", "Notes"),
      BUFFER_HTML,
      chromeHtml("trailing", "3"),
      BUFFER_HTML,
      "</div>",
    ].join(""));
  });

  it("collapses the alignment row to a single full-width rule", () => {
    const delimiter = rowOfKind(tableNamed("full-topology"), "delimiter");

    expect(renderContractRow(delimiter)).toBe([
      '<div class="cm-line nn-lp-table-row nn-lp-table-row-delimiter"',
      ' style="--nn-table-tracks: 200px 220px 210px">',
      BUFFER_HTML,
      chromeHtml("rule", "1 / -1"),
      BUFFER_HTML,
      "</div>",
    ].join(""));
  });

  // The doubled buffers around the empty cell are the whole reason this row is
  // pinned literally: two adjacent widget-backed children get the previous
  // one's trailing buffer AND the next one's leading buffer, so the count is
  // not "one per gap".
  it("renders an empty cell as a zero-length widget with doubled buffers either side", () => {
    const body = rowOfKind(tableNamed("full-topology"), "body");

    expect(renderContractRow(body)).toBe([
      '<div class="cm-line nn-lp-table-row nn-lp-table-row-body"',
      ' style="--nn-table-tracks: 200px 220px 210px">',
      BUFFER_HTML,
      chromeHtml("leading", "1"),
      BUFFER_HTML,
      cellHtml("1", "2026-04-03"),
      BUFFER_HTML,
      chromeHtml("divider", "2"),
      BUFFER_HTML,
      cellHtml("2", "DJ gig at the Bell"),
      BUFFER_HTML,
      chromeHtml("divider", "3"),
      BUFFER_HTML,
      BUFFER_HTML,
      cellHtml("3", "", " nn-lp-cell-empty"),
      BUFFER_HTML,
      BUFFER_HTML,
      chromeHtml("trailing", "3"),
      BUFFER_HTML,
      "</div>",
    ].join(""));
  });
});

describe("CT-1 golden DOM contract — structural invariants", () => {
  it("stamps an explicit grid column on every child the producer owns", () => {
    const unplaced = allRows()
      .flatMap((row) => row.children)
      .filter((child) => !isBuffer(child) && child.gridColumn === null);

    expect(unplaced).toEqual([]);
  });

  // CodeMirror creates the buffers, so nothing can stamp them inline. If the
  // stylesheet does not place them they auto-flow into implicit grid rows and
  // the row measures 128.78px instead of 19.59px.
  it("leaves the buffers unstamped and places them from the stylesheet instead", () => {
    const stamped = allRows()
      .flatMap((row) => row.children)
      .filter((child) => isBuffer(child) && child.gridColumn !== null);

    expect(stamped).toEqual([]);
    expect(REQUIRED_STYLESHEET_RULES.map((rule) => rule.selector))
      .toContain(".nn-lp-table-row > .cm-widgetBuffer");
  });

  it("brackets every widget-backed child with a buffer on both sides", () => {
    for (const row of allRows()) {
      const { children } = row;
      const unbracketed = children.filter((child, index) =>
        isWidgetBacked(child)
        && !(isBuffer(children[index - 1]!) && isBuffer(children[index + 1]!)));

      expect({ row: row.lineClassName, unbracketed }).toEqual({
        row: row.lineClassName,
        unbracketed: [],
      });
    }
  });

  it("never places a mark-backed cell next to a buffer it did not earn", () => {
    // A `Decoration.mark` produces no buffer. If one appears beside a cell
    // mark it can only have come from the neighbouring widget, so the count
    // per row must equal twice the widget-backed child count.
    for (const row of allRows()) {
      const widgets = row.children.filter(isWidgetBacked).length;
      const buffers = row.children.filter(isBuffer).length;

      expect(buffers).toBe(widgets * 2);
    }
  });

  it("closes every content row with the trailing chrome as its last stamped child", () => {
    const contentRows = allRows().filter((row) => row.kind !== "delimiter");
    expect(contentRows.length).toBeGreaterThan(0);

    for (const row of contentRows) {
      const stamped = row.children.filter((child) => !isBuffer(child));
      expect(stamped.at(-1)?.className).toBe("nn-lp-cell-chrome nn-lp-cell-chrome-trailing");
    }
  });

  it("names the table edges explicitly, exactly once each", () => {
    for (const table of tables) {
      const first = table.rows.filter((row) => row.lineClassName.includes("nn-lp-table-row-first"));
      const last = table.rows.filter((row) => row.lineClassName.includes("nn-lp-table-row-last"));

      expect({ table: table.name, first: first.length, last: last.length })
        .toEqual({ table: table.name, first: 1, last: 1 });
    }
  });

  it("puts first and last on different lines even for a one-row table", () => {
    const oneRow = tableNamed("one-row");

    expect(oneRow.rows).toHaveLength(2);
    expect(oneRow.rows[0]?.lineClassName).toContain("nn-lp-table-row-first");
    expect(oneRow.rows[1]?.lineClassName).toContain("nn-lp-table-row-last");
  });

  it("agrees between each row's kind and its kind hook", () => {
    for (const row of allRows()) {
      expect(row.lineClassName).toContain(`nn-lp-table-row-${row.kind}`);
    }
  });

  it("stamps the track template on every row of a table, not just the first", () => {
    for (const table of tables) {
      for (const row of table.rows) {
        expect(row.inlineStyle).toBe(`--nn-table-tracks: ${table.trackTemplate}`);
      }
    }
  });

  it("gives a ragged row a filler cell for every column it never declared", () => {
    const body = rowOfKind(tableNamed("ragged"), "body");
    const cells = body.children.filter((child) => classTokens(child).includes("nn-lp-cell"));

    // Two cells in the source, three columns in the table: one filler.
    expect(cells.map((child) => child.gridColumn)).toEqual(["1", "2", "3"]);
    expect(cells.filter((child) => child.decoration === "widget")).toHaveLength(1);
    expect(cells.at(-1)?.className).toBe("nn-lp-cell nn-lp-cell-filler");
  });
});

describe("CT-1 golden DOM contract — what it does not settle", () => {
  it("carries the K7a measurement it was derived from", () => {
    expect(CONTRACT_TRACK_TEMPLATE).toBe("200px 220px 210px");
    expect(CONTRACT_TRACK_ORIGINS_PX).toEqual([6, 206, 426]);
  });

  it("names the stylesheet rules the producer cannot stamp", () => {
    const declarations = REQUIRED_STYLESHEET_RULES.map((rule) => rule.declarations).join(" ");

    expect(declarations).toContain("grid-row: 1");
    expect(declarations).toContain("grid-column: 1");
    expect(declarations).toContain("var(--nn-table-tracks)");
    for (const rule of REQUIRED_STYLESHEET_RULES) {
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });

  it("records every unsettled clause with a reason rather than freezing it", () => {
    expect(CONTRACT_OPEN_QUESTIONS.length).toBeGreaterThan(0);

    const ids = CONTRACT_OPEN_QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const question of CONTRACT_OPEN_QUESTIONS) {
      expect(question.whyUnsettled.length).toBeGreaterThan(20);
      expect(question.blocks.length).toBeGreaterThan(0);
    }
  });
});
