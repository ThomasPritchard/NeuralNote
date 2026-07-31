/**
 * CT-1 — the golden DOM contract for a Markdown table drawn as live-preview
 * cells. Frozen at P0 of `specs/in-place-table-cell-editing-plan.md`.
 *
 * **This is a TARGET, not a snapshot.** It describes DOM that a later phase
 * (P3b) will produce. Nothing in the repository renders it today: at HEAD a
 * table is either a read-only `<table>` widget or aligned monospace source with
 * drawn chrome, and neither is a grid. Do not read a mismatch against the
 * running app as a regression — read it as work not yet done.
 *
 * Its job is to stop `coder` (who emits the DOM) and `ui-designer` (who styles
 * it) colliding on selectors they never share a file over. Four clauses carry
 * that weight, and each exists because leaving it implicit was measured to
 * fail:
 *
 * **C1 — every producer-owned child declares its own `grid-column`.** Table
 * rows are `.cm-line` siblings among unrelated paragraph lines, so no CSS
 * selector can infer where a table starts or ends. Nothing here may be placed
 * by `:first-child`, `:last-child`, `:nth-child` or grid auto-flow.
 *
 * **C2 — `cm-widgetBuffer` elements are part of the contract.** CodeMirror
 * brackets every inline widget with `<img class="cm-widgetBuffer">` — one
 * before it (`@codemirror/view/dist/index.js:2338-2340`) and one after
 * (`:2464-2469`) — so two adjacent widget-backed children get *two* buffers
 * between them, not one. They are CodeMirror's elements, so nothing can stamp
 * them inline; in a grid container they are unplaced items that auto-flow into
 * implicit rows. P0's spike measured the cost: a naive grid gave 128.78px rows
 * against a 19.59px line height, 6.4x too tall, and every hit-testing probe
 * still passed (12/12 round-trips, 0 `RangeError`s), so the probes alone would
 * have certified it healthy. Forcing `grid-row: 1` on all direct children and
 * parking the buffers in column 1 returned every row to 19.59px. A fixture
 * without buffers describes DOM that cannot exist.
 *
 * **C3 — the edge hooks are explicit classes.** `nn-lp-table-row-first` and
 * `-last` are stamped, for the reason in C1. A one-row table (header plus
 * alignment row, no body) puts them on two different lines, which is the case
 * the corner radii have to compose over.
 *
 * **C4 — the track template is stamped, never authored in CSS.** TypeScript
 * writes `--nn-table-tracks` on each row line; the stylesheet's only permitted
 * use of it is `grid-template-columns: var(--nn-table-tracks)`. That is CT-2's
 * "TypeScript computes and stamps them" and its "`ui-designer` must not declare
 * `grid-template-columns`" read together: what is forbidden is authoring a
 * literal template, not wiring the custom property through.
 *
 * **Scope.** CT-1 describes a row's *direct children* only. Cell interiors —
 * nested emphasis marks, hidden markers, the buffers around a widget nested
 * inside a cell — are CT-3's contract, and the `text` field below flattens them
 * to the cell's `textContent` on purpose. Only direct children are grid items,
 * so only they can break the row's geometry.
 *
 * **Vocabulary.** The plan and the spec call the `| --- | --- |` line the
 * "alignment row". This module uses `delimiter`, matching the committed
 * `TableRowKind`, the parser's `TableDelimiter` node and
 * `tableDelimiterRanges` — one word per concept. They are the same row.
 *
 * **Not in scope: CT-7.** Whether a row line is a horizontal scroll container
 * is blocked (P0 K1's 1b failed and K6's premise was inverted). This fixture
 * describes the row's children and takes no position on its `overflow`.
 */

import type { TableRowKind } from "./sourceEditorTableModel";

/** What kind of decoration produces a child. Determines buffer bracketing. */
export type ContractDecoration =
  /** `Decoration.mark` over real source. Produces no buffers. */
  | "mark"
  /** `Decoration.replace({ widget })` over a hidden delimiter gap. */
  | "replace"
  /** Zero-length `Decoration.widget`, for a cell with no source to mark. */
  | "widget"
  /** CodeMirror's own `cm-widgetBuffer`. Nothing in this app creates it. */
  | "buffer";

/** One direct child of a table row's `.cm-line` element. */
export interface ContractChild {
  readonly tag: "span" | "img";
  /** The full `class` attribute, in the order it is written. */
  readonly className: string;
  readonly decoration: ContractDecoration;
  /** The stamped `grid-column`, or `null` for a buffer, which CSS places. */
  readonly gridColumn: string | null;
  readonly ariaHidden: boolean;
  /** The child's `textContent`. `null` where it has no text node at all. */
  readonly text: string | null;
}

export interface ContractRow {
  readonly kind: TableRowKind;
  /** The full `class` attribute on the `.cm-line`, CodeMirror's own first. */
  readonly lineClassName: string;
  /** The inline `style` the producer stamps on the line. */
  readonly inlineStyle: string;
  readonly children: readonly ContractChild[];
}

export interface ContractTable {
  readonly name: string;
  /** The Markdown that produces this table, so a browser test can drive it. */
  readonly source: string;
  /** The `--nn-table-tracks` value, one track per declared column. */
  readonly trackTemplate: string;
  readonly rows: readonly ContractRow[];
}

/** A rule only `ui-designer` can supply, because nothing can stamp it inline. */
export interface RequiredStylesheetRule {
  readonly selector: string;
  readonly declarations: string;
  readonly why: string;
}

/** A clause deliberately left unfrozen, with what would settle it. */
export interface ContractOpenQuestion {
  readonly id: string;
  readonly question: string;
  readonly whyUnsettled: string;
  readonly blocks: string;
}

/**
 * The track template P0 measured, and where the three cells landed under it.
 * Only the `full-topology` table carries measured numbers; the other fixtures
 * declare illustrative templates, because the shape they freeze is "one stamped
 * track per declared column", not the widths.
 */
export const CONTRACT_TRACK_TEMPLATE = "200px 220px 210px";

/** Measured cell origins under {@link CONTRACT_TRACK_TEMPLATE}, in px. The 6px
 *  offset is CodeMirror's own `.cm-line { padding: 0 2px 0 6px }`
 *  (`@codemirror/view/dist/index.js:6844-6847`), so the tracks start at the
 *  content-box origin and no per-cell padding contributes to alignment. */
export const CONTRACT_TRACK_ORIGINS_PX: readonly number[] = [6, 206, 426];

const buffer = (): ContractChild => ({
  tag: "img",
  className: "cm-widgetBuffer",
  decoration: "buffer",
  gridColumn: null,
  ariaHidden: true,
  text: null,
});

type ChromeKind = "leading" | "divider" | "trailing" | "rule";

const chrome = (kind: ChromeKind, gridColumn: string): ContractChild => ({
  tag: "span",
  className: `nn-lp-cell-chrome nn-lp-cell-chrome-${kind}`,
  decoration: "replace",
  gridColumn,
  ariaHidden: true,
  text: null,
});

/** A cell whose content exists in the source, so a mark can cover it. */
const cell = (column: number, text: string): ContractChild => ({
  tag: "span",
  className: "nn-lp-cell",
  decoration: "mark",
  gridColumn: String(column),
  ariaHidden: false,
  text,
});

/**
 * A cell with nothing to mark. `Decoration.mark` may not be empty, so this can
 * only be a zero-length widget — which is also why it brings its own pair of
 * buffers. `empty` is a cell the source declares and leaves blank; `filler` is
 * a column the row never declared at all.
 */
const emptyCell = (column: number, variant: "empty" | "filler"): ContractChild => ({
  tag: "span",
  className: `nn-lp-cell nn-lp-cell-${variant}`,
  decoration: "widget",
  gridColumn: String(column),
  ariaHidden: false,
  text: "",
});

const isFiller = (child: ContractChild): boolean =>
  child.className === "nn-lp-cell nn-lp-cell-filler";

/**
 * Insert the buffers CodeMirror will inject. One before and one after every
 * widget-backed child (C2); marks get none. Applying the rule rather than
 * listing 60 literals means the whole contract moves together if the rule is
 * ever measured to differ.
 */
function withWidgetBuffers(children: readonly ContractChild[]): ContractChild[] {
  return children.flatMap((child) =>
    child.decoration === "mark" ? [child] : [buffer(), child, buffer()]);
}

function lineClassName(kind: TableRowKind, edge: "first" | "last" | null): string {
  const hooks = ["cm-line", "nn-lp-table-row", `nn-lp-table-row-${kind}`];
  if (edge) hooks.push(`nn-lp-table-row-${edge}`);
  return hooks.join(" ");
}

function row(
  kind: TableRowKind,
  edge: "first" | "last" | null,
  trackTemplate: string,
  children: readonly ContractChild[],
): ContractRow {
  return {
    kind,
    lineClassName: lineClassName(kind, edge),
    inlineStyle: `--nn-table-tracks: ${trackTemplate}`,
    children: withWidgetBuffers(children),
  };
}

/**
 * A content row: leading chrome, then each cell preceded by its divider, then
 * the trailing chrome.
 *
 * **Chrome exists only where the source has a delimiter to hide.** A filler
 * column is one the table declares and this row's source never wrote, so there
 * is no pipe there and no divider chrome — a divider over a range that does not
 * exist is not a decoration anyone could emit.
 *
 * **The trailing chrome is always the last stamped child**, including on a
 * ragged row, so the stylesheet has one dependable anchor for the row's closing
 * edge. That puts the filler ahead of it in DOM order, which the producer
 * expresses as a `side: -1` zero-length widget at the last declared cell's `to`
 * — the same offset the trailing replace starts at. And it is stamped at the
 * table's LAST column, not at the last column the row happens to declare: P0's
 * K7d measured that a ragged row must keep its trailing chrome out of columns 2
 * and up.
 */
function contentRow(
  kind: TableRowKind,
  edge: "first" | "last" | null,
  trackTemplate: string,
  columnCount: number,
  cells: readonly ContractChild[],
): ContractRow {
  const children = cells.flatMap((entry, index) => {
    if (index === 0) return [chrome("leading", "1"), entry];
    if (isFiller(entry)) return [entry];
    return [chrome("divider", String(index + 1)), entry];
  });
  return row(kind, edge, trackTemplate, [
    ...children,
    chrome("trailing", String(columnCount)),
  ]);
}

/** The `| --- | --- |` line: no user content, drawn as the header rule. */
function delimiterRow(edge: "first" | "last" | null, trackTemplate: string): ContractRow {
  return row("delimiter", edge, trackTemplate, [chrome("rule", "1 / -1")]);
}

const FULL_TOPOLOGY: ContractTable = {
  name: "full-topology",
  source: [
    "| Start date | Commitment | Notes |",
    "| --- | --- | --- |",
    "| 2026-04-03 | **DJ gig** at the Bell |  |",
    "| 2026-11-30 | `soundcheck` | [[Roadmap]] |",
  ].join("\n"),
  trackTemplate: CONTRACT_TRACK_TEMPLATE,
  rows: [
    contentRow("header", "first", CONTRACT_TRACK_TEMPLATE, 3, [
      cell(1, "Start date"),
      cell(2, "Commitment"),
      cell(3, "Notes"),
    ]),
    delimiterRow(null, CONTRACT_TRACK_TEMPLATE),
    // Interior body row. The emphasis markers are `Decoration.replace({})` with
    // no widget (`sourceEditorDecorationsPreview.ts:241`), so they leave the
    // DOM entirely and contribute no buffers of their own.
    contentRow("body", null, CONTRACT_TRACK_TEMPLATE, 3, [
      cell(1, "2026-04-03"),
      cell(2, "DJ gig at the Bell"),
      emptyCell(3, "empty"),
    ]),
    // Last body row. `Roadmap` is widget-backed: a `TextWidget` nested INSIDE
    // the cell mark, with its own buffers inside the cell. Those are not direct
    // children of the line, so they are not grid items and not CT-1's business.
    contentRow("body", "last", CONTRACT_TRACK_TEMPLATE, 3, [
      cell(1, "2026-11-30"),
      cell(2, "soundcheck"),
      cell(3, "Roadmap"),
    ]),
  ],
};

const ONE_ROW_TRACKS = "160px 200px";

const ONE_ROW: ContractTable = {
  name: "one-row",
  source: ["| Key | Value |", "| --- | --- |"].join("\n"),
  trackTemplate: ONE_ROW_TRACKS,
  rows: [
    contentRow("header", "first", ONE_ROW_TRACKS, 2, [cell(1, "Key"), cell(2, "Value")]),
    delimiterRow("last", ONE_ROW_TRACKS),
  ],
};

const RAGGED_TRACKS = "180px 140px 120px";

const RAGGED: ContractTable = {
  name: "ragged",
  source: [
    "| Task | Owner | Due |",
    "| --- | --- | --- |",
    "| Ship v0.3 | Tom |",
  ].join("\n"),
  trackTemplate: RAGGED_TRACKS,
  rows: [
    contentRow("header", "first", RAGGED_TRACKS, 3, [
      cell(1, "Task"),
      cell(2, "Owner"),
      cell(3, "Due"),
    ]),
    delimiterRow(null, RAGGED_TRACKS),
    // Two declared cells against three declared columns. The filler holds
    // column 3 open so the row's grid still spans the table.
    contentRow("body", "last", RAGGED_TRACKS, 3, [
      cell(1, "Ship v0.3"),
      cell(2, "Tom"),
      emptyCell(3, "filler"),
    ]),
  ],
};

export const TABLE_CONTRACT_FIXTURE: readonly ContractTable[] = [
  FULL_TOPOLOGY,
  ONE_ROW,
  RAGGED,
];

export const REQUIRED_STYLESHEET_RULES: readonly RequiredStylesheetRule[] = [
  {
    selector: ".nn-lp-table-row",
    declarations: "display: grid; grid-template-columns: var(--nn-table-tracks);",
    why: "CT-2: TypeScript stamps the track list; the stylesheet may only wire the "
      + "custom property through. Authoring a literal template here fights the "
      + "inline style and desynchronises the columns from the measured widths.",
  },
  {
    selector: ".nn-lp-table-row > *",
    declarations: "grid-row: 1;",
    why: "Without it the widget buffers auto-flow into implicit rows: measured "
      + "128.78px rows against a 19.59px line height, 6.4x too tall, while every "
      + "hit-testing probe still passed. Nothing can stamp this per element, "
      + "because CodeMirror creates the buffers.",
  },
  {
    selector: ".nn-lp-table-row > .cm-widgetBuffer",
    declarations: "grid-column: 1;",
    why: "Parks the buffers out of the content tracks. With the rule above it "
      + "returned all five measured rows to exactly 19.59px.",
  },
];

export const CONTRACT_OPEN_QUESTIONS: readonly ContractOpenQuestion[] = [
  {
    id: "CT1-Q1",
    question: "Does a genuinely zero-length cell (`||`, no space between the pipes) "
      + "render as one grid item at its stamped column?",
    whyUnsettled: "P0's K7c passed against `| x |  | z |`, whose middle cell is two "
      + "spaces — a non-empty range. The zero-length case cannot use a "
      + "`Decoration.mark` at all, since a mark may not be empty, so it exercises "
      + "the widget path this fixture assumes but nothing has measured.",
    blocks: "P3b — the empty-cell arm of the render plan.",
  },
  {
    id: "CT1-Q2",
    question: "How many buffers appear between two ADJACENT zero-length cell widgets, "
      + "as in a row declaring one cell against three columns?",
    whyUnsettled: "CodeMirror elides the buffer between adjacent same-side-facing "
      + "point widgets (`@codemirror/view/dist/index.js:2333-2336`). The fixture "
      + "only freezes rows where no two zero-length widgets are neighbours, so the "
      + "elision never fires in it and nothing has measured a row where it would.",
    blocks: "P3b — a ragged row missing two or more columns.",
  },
  {
    id: "CT1-Q3",
    question: "Is the row line a horizontal scroll container, and who owns its "
      + "`overflow`?",
    whyUnsettled: "CT-7 is not frozen. P0's K1 recovered the drawn caret's position "
      + "but not its clipping (it painted 369.92px past the row's inline-end edge, "
      + "and the layers are siblings of `.cm-content` so no row `overflow` can clip "
      + "them), and K6's premise was inverted. The mechanism is a decision for Tom.",
    blocks: "P3c and P3d, both of which are gated on CT-7.",
  },
];

/** Serialise a child to the exact HTML the contract expects. */
function renderContractChild(child: ContractChild): string {
  const style = child.gridColumn === null ? "" : ` style="grid-column: ${child.gridColumn}"`;
  const hidden = child.ariaHidden ? ' aria-hidden="true"' : "";
  return child.tag === "img"
    ? `<img class="${child.className}"${hidden}>`
    : `<span class="${child.className}"${style}${hidden}>${child.text ?? ""}</span>`;
}

/**
 * The committed HTML snapshot CT-1 calls for, rendered from the data above so
 * the two can never disagree.
 *
 * @param contractRow - one row of a {@link ContractTable}
 * @returns the row's `.cm-line` element and every direct child, in order
 */
export function renderContractRow(contractRow: ContractRow): string {
  const children = contractRow.children.map(renderContractChild).join("");
  return `<div class="${contractRow.lineClassName}" style="${contractRow.inlineStyle}">`
    + `${children}</div>`;
}
