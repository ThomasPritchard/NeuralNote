// P3c — the drawn table box, proved in a real layout engine.
//
// jsdom has no layout engine, so every assertion in this file would be vacuous
// there: `getBoundingClientRect()` returns all-zeros and `getComputedStyle`
// resolves no cascade. This is the Tier-1.5 lane (`vitest.browser.config.ts`),
// headless Chromium with the app's real Tailwind pipeline.
//
// NOTHING IN THE REPOSITORY RENDERS THE CONTRACT DOM YET. P3b owns the
// producer and is in flight. So this file builds the CT-1 element tree itself,
// from a real `EditorView` with real decorations, and then PROVES the harness
// is the contract by comparing its stamped children against
// `sourceEditorTableContractFixture.ts` (`describe("harness fidelity")`). If
// that comparison fails, every geometry number below is about something the
// producer will never emit, so it is asserted first and separately.

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { EditorState, Range as CmRange, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

import {
  TABLE_CONTRACT_FIXTURE,
  type ContractChild,
  type ContractTable,
} from "./sourceEditorTableContractFixture";
import "../styles.css";

// ---------------------------------------------------------------------------
// The producer stand-in. It emits CT-1's element tree and nothing else.
// ---------------------------------------------------------------------------

class ChromeWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly gridColumn: string,
  ) {
    super();
  }

  eq(other: ChromeWidget): boolean {
    return other.kind === this.kind && other.gridColumn === this.gridColumn;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `nn-lp-cell-chrome nn-lp-cell-chrome-${this.kind}`;
    span.style.gridColumn = this.gridColumn;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

class EmptyCellWidget extends WidgetType {
  constructor(
    readonly variant: "empty" | "filler",
    readonly gridColumn: string,
  ) {
    super();
  }

  eq(other: EmptyCellWidget): boolean {
    return other.variant === this.variant && other.gridColumn === this.gridColumn;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `nn-lp-cell nn-lp-cell-${this.variant}`;
    span.style.gridColumn = this.gridColumn;
    return span;
  }
}

interface CellSpan {
  readonly start: number;
  readonly end: number;
  readonly empty: boolean;
}

function pipesOf(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") out.push(index);
  }
  return out;
}

function cellSpans(text: string): CellSpan[] {
  const pipes = pipesOf(text);
  const spans: CellSpan[] = [];
  for (let index = 0; index + 1 < pipes.length; index += 1) {
    const open = pipes[index]!;
    const close = pipes[index + 1]!;
    const raw = text.slice(open + 1, close);
    if (raw.trim() === "") {
      spans.push({ start: open + 1, end: open + 1, empty: true });
      continue;
    }
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    spans.push({ start: open + 1 + lead, end: close - trail, empty: false });
  }
  return spans;
}

// A delimiter line needs at least one dash. `[\s:|-]+` alone also matches a row
// of empty cells (`|  |  |`), which would silently render an ordinary body row
// as the header rule.
const isDelimiterLine = (text: string): boolean =>
  /^\s*\|[\s:|-]*-[\s:|-]*$/.test(text);

function contentRowRanges(
  from: number,
  text: string,
  columnCount: number,
): CmRange<Decoration>[] {
  const pipes = pipesOf(text);
  const spans = cellSpans(text);
  const ranges: CmRange<Decoration>[] = [];
  const chrome = (kind: string, column: string, start: number, end: number): void => {
    ranges.push(
      Decoration.replace({ widget: new ChromeWidget(kind, column) }).range(
        from + start,
        from + end,
      ),
    );
  };

  chrome("leading", "1", pipes[0]!, spans[0]!.start);

  spans.forEach((span, index) => {
    if (index > 0) {
      chrome("divider", String(index + 1), spans[index - 1]!.end, span.start);
    }
    if (span.empty) {
      ranges.push(
        Decoration.widget({
          widget: new EmptyCellWidget("empty", String(index + 1)),
          side: -1,
        }).range(from + span.start),
      );
      return;
    }
    ranges.push(
      Decoration.mark({
        class: "nn-lp-cell",
        attributes: { style: `grid-column: ${index + 1}` },
      }).range(from + span.start, from + span.end),
    );
  });

  const lastEnd = spans.at(-1)!.end;
  for (let column = spans.length; column < columnCount; column += 1) {
    ranges.push(
      Decoration.widget({
        widget: new EmptyCellWidget("filler", String(column + 1)),
        side: -1,
      }).range(from + lastEnd),
    );
  }
  chrome("trailing", String(columnCount), lastEnd, pipes.at(-1)! + 1);
  return ranges;
}

/**
 * Build CT-1's decorations for every table in the document.
 *
 * @param state - the editor state to read lines from
 * @param tracks - the `--nn-table-tracks` value stamped on every row
 * @returns the decoration set the producer (P3b) will one day emit
 */
function tableDecorations(state: EditorState, tracks: string): DecorationSet {
  const ranges: CmRange<Decoration>[] = [];
  const blocks: { from: number; to: number; text: string }[][] = [];
  let block: { from: number; to: number; text: string }[] = [];

  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (line.text.trimStart().startsWith("|")) {
      block.push({ from: line.from, to: line.to, text: line.text });
    } else if (block.length > 0) {
      blocks.push(block);
      block = [];
    }
  }
  if (block.length > 0) blocks.push(block);

  for (const rows of blocks) {
    const columnCount = cellSpans(rows[0]!.text).length;
    rows.forEach((row, index) => {
      const kind = index === 0 ? "header" : isDelimiterLine(row.text) ? "delimiter" : "body";
      const edge = index === 0 ? "first" : index === rows.length - 1 ? "last" : null;
      const classes = ["nn-lp-table-row", `nn-lp-table-row-${kind}`];
      if (edge) classes.push(`nn-lp-table-row-${edge}`);
      ranges.push(
        Decoration.line({
          class: classes.join(" "),
          attributes: { style: `--nn-table-tracks: ${tracks}` },
        }).range(row.from),
      );
      if (kind === "delimiter") {
        ranges.push(
          Decoration.replace({ widget: new ChromeWidget("rule", "1 / -1") }).range(
            row.from,
            row.to,
          ),
        );
        return;
      }
      ranges.push(...contentRowRanges(row.from, row.text, columnCount));
    });
  }
  return Decoration.set(ranges, true);
}

function tableExtension(tracks: string): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => tableDecorations(state, tracks),
    update: (value, transaction) =>
      transaction.docChanged ? tableDecorations(transaction.state, tracks) : value,
    provide: (self) => EditorView.decorations.from(self),
  });
  return field;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly view: EditorView;
  readonly host: HTMLElement;
  destroy(): void;
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

async function mount(doc: string, tracks: string, widthPx = 400): Promise<Harness> {
  const host = document.createElement("div");
  host.className = "nn-source-editor";
  host.style.width = `${widthPx}px`;
  document.body.append(host);

  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [drawSelection(), EditorView.lineWrapping, tableExtension(tracks)],
    }),
    parent: host,
  });

  await document.fonts.ready;
  await nextFrame();
  // The caret blink is the only time-varying pixel in the editor; the paint
  // probe below diffs two screenshots and would otherwise read the blink.
  const cursorLayer = host.querySelector<HTMLElement>(".cm-cursorLayer");
  if (cursorLayer) cursorLayer.style.animation = "none";

  return {
    view,
    host,
    destroy() {
      view.destroy();
      host.remove();
    },
  };
}

const rowsOf = (host: Element): HTMLElement[] => [
  ...host.querySelectorAll<HTMLElement>(".nn-lp-table-row"),
];

/** The next `.nn-lp-cell` after a chrome element, skipping widget buffers. */
/**
 * How far off centre a cell's inline box sits inside its own box: the top gap
 * minus the bottom gap, unsigned. Zero when the block padding centres it.
 */
function asymmetry(target: HTMLElement): number {
  const box = target.getBoundingClientRect();
  const inline = document.createRange();
  inline.selectNodeContents(target);
  const rect = inline.getBoundingClientRect();
  return Math.abs((rect.top - box.top) - (box.bottom - rect.bottom));
}

function cellAfter(chrome: Element): HTMLElement {
  let next = chrome.nextElementSibling;
  while (next && !next.classList.contains("nn-lp-cell")) next = next.nextElementSibling;
  if (!next) throw new Error(`no cell follows ${chrome.className}`);
  return next as HTMLElement;
}

const stampedChildren = (row: Element): HTMLElement[] =>
  [...row.children].filter(
    (child): child is HTMLElement => !child.classList.contains("cm-widgetBuffer"),
  );

/**
 * CT-1 distinguishes `text: null` ("no text node at all", the chrome) from
 * `text: ""` (an empty cell). That distinction is not observable in rendered
 * DOM — `renderContractRow` itself collapses it with `child.text ?? ""` — so
 * both sides are normalised here rather than pretending the DOM can tell them
 * apart.
 */
function describeChild(element: Element): Omit<ContractChild, "decoration"> {
  const style = (element as HTMLElement).style;
  return {
    tag: element.tagName.toLowerCase() as "span" | "img",
    className: element.getAttribute("class") ?? "",
    gridColumn: style.gridColumn === "" ? null : style.gridColumn,
    ariaHidden: element.getAttribute("aria-hidden") === "true",
    text: element.tagName === "IMG" ? null : (element.textContent ?? ""),
  };
}

const stripDecoration = (child: ContractChild): Omit<ContractChild, "decoration"> => ({
  tag: child.tag,
  className: child.className,
  gridColumn: child.gridColumn,
  ariaHidden: child.ariaHidden,
  text: child.tag === "img" ? null : (child.text ?? ""),
});

/**
 * Alpha of a computed colour. `color-mix()` resolves to `color(srgb r g b / a)`
 * in Chromium, not to `rgba()`, so an `rgba`-only parser returns NaN and every
 * comparison against it silently passes.
 */
const px = (value: string): number => Number.parseFloat(value);

const alpha = (colour: string): number => {
  const slashed = /\/\s*([\d.]+)%?\s*\)\s*$/.exec(colour);
  if (slashed) {
    const value = Number.parseFloat(slashed[1]!);
    return colour.includes("%)") ? value / 100 : value;
  }
  const rgba = /rgba?\(([^)]+)\)/.exec(colour);
  if (!rgba) return Number.NaN;
  const parts = rgba[1]!.split(",").map((piece) => Number.parseFloat(piece));
  return parts.length < 4 ? 1 : parts[3]!;
};

// ---------------------------------------------------------------------------
// Pixel probe. `getComputedStyle` cannot answer "does the selection read
// through the fill" — only composited pixels can, because the selection layer
// paints BELOW the row background.
// ---------------------------------------------------------------------------

interface Frame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly scale: number;
}

async function grabFrame(): Promise<Frame> {
  // `save: false` makes `page.screenshot` return the base64 payload itself,
  // which is the only typed overload that yields pixels rather than a path.
  const base64 = await page.screenshot({ save: false });
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: image.data, width: bitmap.width, scale: bitmap.width / window.innerWidth };
}

/** Mean per-channel absolute difference over a CSS-pixel strip, 0..255. */
function stripDelta(a: Frame, b: Frame, x0: number, x1: number, y: number): number {
  const row = Math.round(y * a.scale);
  let total = 0;
  let count = 0;
  for (let x = Math.round(x0 * a.scale); x < Math.round(x1 * a.scale); x += 1) {
    const index = (row * a.width + x) * 4;
    total += Math.abs(a.data[index]! - b.data[index]!);
    total += Math.abs(a.data[index + 1]! - b.data[index + 1]!);
    total += Math.abs(a.data[index + 2]! - b.data[index + 2]!);
    count += 3;
  }
  return count === 0 ? 0 : total / count;
}

/**
 * The strongest scanline in a band below a line's top edge.
 *
 * A single scanline at a hand-picked offset measures the ENGINE, not the fill:
 * Chromium and WebKit start a selection rectangle at different sub-pixel offsets
 * within the line box, so an offset tuned until Chromium went green read 0 on
 * WebKit and reported the control invisible. Scanning a band and keeping the
 * maximum answers "does the selection reach this line at all", which is the
 * actual question, without pinning where either engine chooses to start it.
 */
function bandDelta(a: Frame, b: Frame, x0: number, x1: number, top: number, depth: number): number {
  let strongest = 0;
  for (let offset = 1; offset <= depth; offset += 1) {
    strongest = Math.max(strongest, stripDelta(a, b, x0, x1, top + offset));
  }
  return strongest;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WIDE_TRACKS = "200px 220px 210px";

const WIDE_NOTE = [
  "A control paragraph long enough that it must wrap several times over at the",
  "",
  "| Start date | Commitment | Notes |",
  "| --- | --- | --- |",
  "| 2026-04-03 | DJ gig at the Bell | first |",
  "| 2026-11-30 | soundcheck | second |",
  "| 2027-01-09 | rehearsal in the hall | third |",
  "| 2027-02-14 | load in |  |",
  "",
  "A trailing control paragraph, also long enough to wrap more than once at the same pane width as the table above it.",
].join("\n");

// Deliberately narrower tracks than the cell text needs, so a cell that is
// allowed to wrap WILL wrap. Without that, a no-wrap assertion reads the same
// number whether or not the rule is present.
const TIGHT_TRACKS = "110px 110px";

const TIGHT_NOTE = [
  "A control paragraph long enough that it must wrap several times over at this pane width, which is what makes the table's single line box meaningful.",
  "",
  "| Column heading one | Column heading two |",
  "| --- | --- |",
  "| a cell whose text is much wider than its own track | another wide cell of prose |",
].join("\n");

// ---------------------------------------------------------------------------

describe("harness fidelity — the DOM under test is CT-1's", () => {
  it("reproduces the frozen contract's stamped children for the plain-text tables", async () => {
    // FULL_TOPOLOGY carries emphasis, code and a wikilink, whose hidden ranges
    // and nested widgets are CT-3's contract and P2's work, not P3c's. The two
    // plain-text tables exercise every clause CT-1 freezes about a row's DIRECT
    // children: edges, kinds, chrome, marks, empty cells and ragged fillers.
    const plain: ContractTable[] = TABLE_CONTRACT_FIXTURE.filter((table) =>
      ["one-row", "ragged"].includes(table.name),
    );
    expect(plain).toHaveLength(2);

    for (const table of plain) {
      const harness = await mount(table.source, table.trackTemplate);
      try {
        const rows = rowsOf(harness.host);
        expect([table.name, rows.length]).toEqual([table.name, table.rows.length]);

        rows.forEach((row, index) => {
          const contract = table.rows[index]!;
          const label = `${table.name} row ${index}`;
          expect([label, row.getAttribute("class")]).toEqual([
            label,
            contract.lineClassName,
          ]);
          expect([label, row.style.getPropertyValue("--nn-table-tracks").trim()]).toEqual([
            label,
            table.trackTemplate,
          ]);
          expect([label, stampedChildren(row).map(describeChild)]).toEqual([
            label,
            contract.children
              .filter((child) => child.decoration !== "buffer")
              .map(stripDecoration),
          ]);
          // C2: the buffers are part of the contract, and the grid rules exist
          // for them. A row with no buffers would not exercise them at all.
          expect(
            row.querySelectorAll(":scope > img.cm-widgetBuffer").length > 0,
          ).toBe(true);
        });
      } finally {
        harness.destroy();
      }
    }
  });
});

describe("the drawn box — edges, seams and height", () => {
  it("joins consecutive rows at a 0px seam with exactly one rule between them", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      expect(rows).toHaveLength(6);

      const seams: number[] = [];
      const rules: number[] = [];
      for (let index = 0; index + 1 < rows.length; index += 1) {
        const upper = rows[index]!.getBoundingClientRect();
        const lower = rows[index + 1]!.getBoundingClientRect();
        seams.push(lower.top - upper.bottom);
        rules.push(
          Number.parseFloat(getComputedStyle(rows[index]!).borderBlockEndWidth) +
            Number.parseFloat(getComputedStyle(rows[index + 1]!).borderBlockStartWidth),
        );
      }

      // Seam: no gap and no overlap, to four decimal places.
      for (const seam of seams) expect(seam).toBeCloseTo(0, 4);
      // No join ever draws two rules — at a 0px seam that reads as a 2px band.
      expect(rules.filter((rule) => rule > 1)).toEqual([]);
      // Every join below the header block draws exactly one. (The header ->
      // alignment-row join is deliberately open: the two share a fill and read
      // as one block, and the alignment row's own bottom edge closes it.)
      expect(rules.slice(1)).toEqual(rules.slice(1).map(() => 1));
      // ...and the header block IS closed off from the body, once.
      expect(
        Number.parseFloat(getComputedStyle(rows[1]!).borderBlockEndWidth),
      ).toBe(1);

      // The box is closed on all four sides, in a real colour, not currentcolor.
      const first = getComputedStyle(rows[0]!);
      const last = getComputedStyle(rows.at(-1)!);
      expect(Number.parseFloat(first.borderBlockStartWidth)).toBe(1);
      expect(Number.parseFloat(last.borderBlockEndWidth)).toBe(1);
      expect(Number.parseFloat(first.borderInlineStartWidth)).toBe(1);
      expect(Number.parseFloat(first.borderInlineEndWidth)).toBe(1);
      expect(alpha(first.borderBlockStartColor)).toBeGreaterThan(0);
      expect(alpha(last.borderBlockEndColor)).toBeGreaterThan(0);
    } finally {
      harness.destroy();
    }
  });

  it("gives every row an integer border-box height", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const heights = rowsOf(harness.host).map(
        (row) => row.getBoundingClientRect().height,
      );
      // CodeMirror measures the border box, so a fraction here stacks into a
      // visible sub-pixel gap between rows and drifts every position below.
      for (const height of heights) expect(Number.isInteger(height), `${height}px`).toBe(true);

      // CT-5's other half: a table line never carries a margin. CodeMirror
      // measures the border box, so a margin is invisible to the height map and
      // every position below it drifts by that amount. Asserted as an invariant
      // on the rendered row, not as the presence of a `margin: 0` declaration —
      // the risk is something upstream introducing one.
      for (const row of rowsOf(harness.host)) {
        const style = getComputedStyle(row);
        expect([
          row.className,
          style.marginTop,
          style.marginBottom,
          style.marginLeft,
          style.marginRight,
        ]).toEqual([row.className, "0px", "0px", "0px", "0px"]);
      }
      // ...and the budget is the declared one: 8 + 24 + 8 of content, plus one
      // pixel per drawn edge. Header: 1px top + 40, its bottom edge suppressed.
      // Alignment row: a 16px skirt plus the rule that closes the header block.
      // Body rows: 40 plus their own bottom edge.
      expect(heights).toEqual([41, 17, 41, 41, 41, 41]);

      // The alignment row shares its floor with CodeMirror's widget buffers,
      // which are `height: 1em`. Take the buffers out of the running and the
      // row must hold its height anyway, or the design's skirt is really
      // CodeMirror's implementation detail wearing a comment.
      const delimiter = rowsOf(harness.host)[1]!;
      const buffers = [
        ...delimiter.querySelectorAll<HTMLElement>(":scope > .cm-widgetBuffer"),
      ];
      expect(buffers.length).toBeGreaterThan(0);
      for (const buffer of buffers) {
        expect(buffer.getBoundingClientRect().height).toBe(16);
        buffer.style.blockSize = "0";
      }
      // ...and the skirt survives without them.
      expect(delimiter.getBoundingClientRect().height).toBe(17);
    } finally {
      harness.destroy();
    }
  });

  it("composes the corner radii on the stamped edges, including a one-row table", async () => {
    const oneRow = TABLE_CONTRACT_FIXTURE.find((table) => table.name === "one-row")!;
    const harness = await mount(oneRow.source, oneRow.trackTemplate);
    try {
      const rows = rowsOf(harness.host);
      // The one-row case is the one the radii have to compose over: first and
      // last land on two DIFFERENT lines.
      expect(rows).toHaveLength(2);
      expect(rows[0]!.className).toContain("nn-lp-table-row-first");
      expect(rows[1]!.className).toContain("nn-lp-table-row-last");

      const top = getComputedStyle(rows[0]!);
      const bottom = getComputedStyle(rows[1]!);
      expect(px(top.borderStartStartRadius)).toBeGreaterThan(0);
      expect(px(top.borderStartEndRadius)).toBeGreaterThan(0);
      expect(px(top.borderEndStartRadius)).toBe(0);
      expect(px(top.borderEndEndRadius)).toBe(0);

      expect(px(bottom.borderEndStartRadius)).toBeGreaterThan(0);
      expect(px(bottom.borderEndEndRadius)).toBeGreaterThan(0);
      expect(px(bottom.borderStartStartRadius)).toBe(0);
      expect(px(bottom.borderStartEndRadius)).toBe(0);
    } finally {
      harness.destroy();
    }
  });

  it("holds the row budget when every cell in a row is empty", async () => {
    // The cells' own block padding is what makes an ordinary row 40px, so a row
    // whose cells are all zero-length widgets has no content to size it. This
    // is the case the row's own `min-block-size` exists for; without it the row
    // collapses to the widget buffers.
    const note = ["| A | B |", "| --- | --- |", "|  |  |", "| x | y |"].join("\n");
    const harness = await mount(note, "120px 120px");
    try {
      const rows = rowsOf(harness.host);
      const empties = [...rows[2]!.querySelectorAll(".nn-lp-cell-empty")];
      // The row under test must actually be all-empty, or this proves nothing.
      expect(empties).toHaveLength(2);
      expect(rows[2]!.getBoundingClientRect().height).toBe(41);
      expect(rows[3]!.getBoundingClientRect().height).toBe(41);
    } finally {
      harness.destroy();
    }
  });

  it("draws each column rule one pixel wide, on the track origin, full height", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const row = rowsOf(harness.host)[2]!;
      const rowRect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const contentHeight =
        rowRect.height -
        Number.parseFloat(style.borderBlockStartWidth) -
        Number.parseFloat(style.borderBlockEndWidth);

      const dividers = [
        ...row.querySelectorAll<HTMLElement>(".nn-lp-cell-chrome-divider"),
      ];
      expect(dividers).toHaveLength(2);

      for (const divider of dividers) {
        const rect = divider.getBoundingClientRect();
        // One hairline, not a stretched box with a border somewhere inside it.
        expect(rect.width).toBe(1);
        // Full height of the row's content box: a rule that only spanned the
        // cell's line box would leave 8px gaps top and bottom.
        expect(rect.height).toBe(contentHeight);
        // On the track origin, which is where its cell begins. CodeMirror puts
        // a buffer between the chrome widget and the following mark, so the
        // cell is not simply `nextElementSibling`.
        const cell = cellAfter(divider);
        expect(rect.left).toBeCloseTo(cell.getBoundingClientRect().left, 4);
      }

      // And the cell's text clears the rule by the declared inline padding,
      // rather than sitting on top of it — and sits on the row's centre line
      // rather than hard against the cell's top edge.
      const cell = cellAfter(dividers[0]!);
      const cellRect = cell.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(cell);
      const textRect = text.getBoundingClientRect();
      expect(textRect.left - cellRect.left).toBeCloseTo(8, 1);
      // Vertically: a `Range` rect is the inline box, not the line box, so the
      // absolute gap carries the font's half-leading. What the block padding
      // owns is the SYMMETRY — with no padding the single line box sits hard
      // against the top of the cell and the two gaps diverge by 16px.
      //
      // Measured against the SAME cell unpadded, in the same run, rather than
      // against an absolute. Half-leading is a property of the resolved face,
      // so a fixed 1px tolerance measures whichever font the platform picked:
      // this assertion held on macOS and failed on Linux CI while the padding
      // it claims to test was identical on both.
      const topGap = textRect.top - cellRect.top;
      const padded = asymmetry(cell);
      const declared = cell.style.paddingBlock;
      cell.style.paddingBlock = "0";
      const unpadded = asymmetry(cell);
      cell.style.paddingBlock = declared;

      expect({
        topGap: topGap >= 8,
        // Non-vacuity: strip the padding and the gaps MUST diverge. If they do
        // not, the comparison below is not measuring the padding at all and
        // would hold whatever the stylesheet declared.
        paddingMovesIt: unpadded > 4,
        centred: padded < unpadded / 2,
      }).toEqual({ topGap: true, paddingMovesIt: true, centred: true });
    } finally {
      harness.destroy();
    }
  });

  it("parks the widget buffers out of the content tracks", async () => {
    // C2 again, and the half of it `grid-row: 1` does not cover: with a row
    // pinned but no column, a buffer auto-places into the next free slot and
    // can land in an implicit column past the last track, widening the row's
    // scrollable area with invisible boxes.
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      for (const row of rowsOf(harness.host)) {
        const rowRect = row.getBoundingClientRect();
        const trackOrigin =
          rowRect.left + Number.parseFloat(getComputedStyle(row).borderInlineStartWidth);
        const buffers = [
          ...row.querySelectorAll<HTMLElement>(":scope > .cm-widgetBuffer"),
        ];
        expect([row.className, buffers.length > 0]).toEqual([row.className, true]);
        const strays = buffers.filter(
          (buffer) => Math.abs(buffer.getBoundingClientRect().left - trackOrigin) > 0.0001,
        );
        expect([row.className, strays.length]).toEqual([row.className, 0]);
      }
    } finally {
      harness.destroy();
    }
  });

  it("shades the header band apart from the body, translucently", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      const header = getComputedStyle(rows[0]!).backgroundColor;
      const skirt = getComputedStyle(rows[1]!).backgroundColor;
      const body = getComputedStyle(rows[2]!).backgroundColor;

      // The header and its alignment-row skirt read as one band...
      expect(skirt).toBe(header);
      // ...and that band is distinguishable from the body rows.
      expect(header).not.toBe(body);
      // ...without either giving up the translucency the selection needs.
      expect(alpha(header)).toBeGreaterThan(0);
      expect(alpha(header)).toBeLessThan(1);
      // The rule that closes the header band is drawn a shade stronger than an
      // ordinary row separator, so the header reads as a header.
      expect(getComputedStyle(rows[1]!).borderBlockEndColor).not.toBe(
        getComputedStyle(rows[2]!).borderBlockEndColor,
      );
      // Header cells carry the weight the read-only table widget uses.
      const headerCell = cellAfter(rows[0]!.querySelector(".nn-lp-cell-chrome-leading")!);
      expect(getComputedStyle(headerCell).fontWeight).toBe("600");
      expect(getComputedStyle(cellAfter(
        rows[2]!.querySelector(".nn-lp-cell-chrome-leading")!,
      )).fontWeight).not.toBe("600");
    } finally {
      harness.destroy();
    }
  });

  it("draws chrome borders only where a column rule belongs", async () => {
    // The aligned-monospace path gives the leading and trailing chrome their
    // own borders, which under the grid would draw a second vertical line a few
    // pixels inside the row's own inline edges. Only the dividers draw.
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const row = rowsOf(harness.host)[2]!;
      for (const kind of ["leading", "trailing"]) {
        const chrome = row.querySelector<HTMLElement>(`.nn-lp-cell-chrome-${kind}`)!;
        const style = getComputedStyle(chrome);
        expect([
          kind,
          style.borderInlineStartWidth,
          style.borderInlineEndWidth,
          style.borderBlockStartWidth,
        ]).toEqual([kind, "0px", "0px", "0px"]);
      }
      const divider = row.querySelector<HTMLElement>(".nn-lp-cell-chrome-divider")!;
      expect(getComputedStyle(divider).borderInlineStartWidth).toBe("1px");
    } finally {
      harness.destroy();
    }
  });

  it("declares the styles the producer and the measurement probe depend on", async () => {
    // These are cross-file contracts, not taste. CT-4's probe reproduces a
    // cell's rendered width from a primed element, so anything here that
    // changes glyph advance or the usable track width has to be known to it;
    // and the scroll chrome is what CT-7's row scroller assumes.
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const row = rowsOf(harness.host)[2]!;
      const rowStyle = getComputedStyle(row);
      expect(rowStyle.fontVariantNumeric).toBe("tabular-nums");
      expect(rowStyle.lineHeight).toBe("24px");
      expect(rowStyle.fontSize).toBe("16px");
      // The row scrolls in the inline axis only, and never chains that scroll
      // out to the note. A trackpad gesture cannot be driven headlessly, so
      // the chaining guard is pinned by its computed value.
      expect(rowStyle.overflowY).toBe("hidden");
      expect(rowStyle.overscrollBehaviorInline).toBe("contain");

      const cell = cellAfter(row.querySelector(".nn-lp-cell-chrome-leading")!);
      const cellStyle = getComputedStyle(cell);
      expect(cellStyle.paddingInlineStart).toBe("8px");
      expect(cellStyle.paddingInlineEnd).toBe("8px");
      // Table ink is the full foreground token; ordinary editor body text is
      // deliberately a shade softer, so a cell must not simply inherit it.
      const ordinary = [...harness.host.querySelectorAll<HTMLElement>(".cm-line")].find(
        (line) => !line.classList.contains("nn-lp-table-row"),
      )!;
      expect(cellStyle.color).not.toBe(getComputedStyle(ordinary).color);
    } finally {
      harness.destroy();
    }
  });

  it("leaves interior rows square so the radii never appear mid-table", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const interior = rowsOf(harness.host).slice(1, -1);
      expect(interior).toHaveLength(4);
      for (const row of interior) {
        const style = getComputedStyle(row);
        expect(Number.parseFloat(style.borderStartStartRadius)).toBe(0);
        expect(Number.parseFloat(style.borderEndEndRadius)).toBe(0);
      }
    } finally {
      harness.destroy();
    }
  });
});

describe("the drawn box — a selection reads through every row", () => {
  it("keeps the row fills translucent enough for a live selection", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);

      // A fill that is absent reads alpha 0 and a fill that is opaque reads 1;
      // both bounds have to hold or the check passes on a missing rule.
      for (const row of rows) {
        const fill = alpha(getComputedStyle(row).backgroundColor);
        expect([row.className, fill > 0, fill < 1]).toEqual([row.className, true, true]);
      }
      // The mechanism this constraint exists for: the selection layer paints
      // below every in-flow line background.
      const selectionLayer = harness.host.querySelector<HTMLElement>(".cm-selectionLayer")!;
      expect(getComputedStyle(selectionLayer).zIndex).toBe("-2");

      // Now the only instrument that can actually answer it: composited pixels.
      const bodyRow = rows[2]!;
      const bodyRect = bodyRow.getBoundingClientRect();
      const control = [...harness.host.querySelectorAll<HTMLElement>(".cm-line")].find(
        (line) => !line.classList.contains("nn-lp-table-row") && line.textContent!.length > 40,
      )!;
      const controlRect = control.getBoundingClientRect();

      harness.view.focus();
      const before = await grabFrame();

      const rowLine = harness.view.state.doc.lineAt(
        harness.view.posAtDOM(bodyRow.querySelector(".nn-lp-cell")!),
      );
      const controlLine = harness.view.state.doc.lineAt(harness.view.posAtDOM(control));
      harness.view.dispatch({
        selection: { anchor: rowLine.from, head: rowLine.to },
      });
      await nextFrame();
      const rowSelected = await grabFrame();

      harness.view.dispatch({
        selection: { anchor: controlLine.from, head: controlLine.to },
      });
      await nextFrame();
      const controlSelected = await grabFrame();

      // Scan a band below each line's top edge rather than one hand-picked
      // scanline, and read both the row and the control by the SAME rule — the
      // asymmetry that used to be here (+12 against +3) was two different
      // instruments being compared as if they were one.
      const rowDelta = bandDelta(
        before,
        rowSelected,
        bodyRect.left + 4,
        bodyRect.left + 150,
        bodyRect.top,
        14,
      );
      const controlDelta = bandDelta(
        before,
        controlSelected,
        controlRect.left + 4,
        controlRect.left + 150,
        controlRect.top,
        14,
      );

      // The control has no fill above the selection layer at all, so it is the
      // ceiling. A fully opaque row fill drives the row's delta to 0.
      expect({
        // The control has no fill above the selection layer, so it is the
        // ceiling; a fully opaque row fill drives the row's delta to 0.
        controlVisible: controlDelta > 4,
        rowVisible: rowDelta > 3,
        // `controlDelta > 0` is not redundant with `controlVisible`: without it
        // a dead control divides to Infinity and this reads TRUE precisely when
        // the reference it is measured against has stopped working.
        rowReadsAgainstControl: controlDelta > 0 && rowDelta / controlDelta > 0.3,
        measured: { rowDelta, controlDelta },
      }).toEqual({
        controlVisible: true,
        rowVisible: true,
        rowReadsAgainstControl: true,
        measured: { rowDelta, controlDelta },
      });
    } finally {
      harness.destroy();
    }
  });
});

describe("the drawn box — table lines do not wrap, ordinary paragraphs still do", () => {
  it("keeps every cell on one line box while a control paragraph takes several", async () => {
    const harness = await mount(TIGHT_NOTE, TIGHT_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      const cells = [...harness.host.querySelectorAll<HTMLElement>(".nn-lp-cell")];
      expect(cells.length).toBe(4);

      // One 24px line box plus 2 x 8px of block padding. A wrapped cell is 64px.
      for (const cell of cells) {
        expect([cell.textContent, cell.getBoundingClientRect().height]).toEqual([
          cell.textContent,
          40,
        ]);
      }
      for (const row of rows) {
        expect(Number.isInteger(row.getBoundingClientRect().height)).toBe(true);
      }

      // The control, in the same run, at the same pane width. Measured in line
      // boxes: `.cm-line` is `display: block`, so `getClientRects().length` is
      // 1 whether or not it wrapped and proves nothing.
      const control = [...harness.host.querySelectorAll<HTMLElement>(".cm-line")].find(
        (line) => !line.classList.contains("nn-lp-table-row") && line.textContent!.length > 60,
      )!;
      const controlLineBox = Number.parseFloat(getComputedStyle(control).lineHeight);
      const controlBoxes = control.getBoundingClientRect().height / controlLineBox;
      expect(controlBoxes).toBeGreaterThanOrEqual(2);
    } finally {
      harness.destroy();
    }
  });
});

describe("the drawn box — per-row scrolling", () => {
  it("scrolls each row inside itself, in step, without the note moving sideways", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      const scroller = harness.host.querySelector<HTMLElement>(".cm-scroller")!;

      // The note does not scroll sideways: that is what the `.cm-content`
      // clamp buys, and it is the discontinuity this feature exists to remove.
      expect(scroller.scrollWidth).toBe(scroller.clientWidth);

      // Every row is genuinely a scroll container. `scrollWidth > clientWidth`
      // is true of any overflowing block, scroll container or not — only an
      // accepted `scrollLeft` proves the overflow is scrollable.
      for (const row of rows) {
        row.scrollLeft = 9999;
        expect([row.className, row.scrollLeft > 0]).toEqual([row.className, true]);
      }

      // No shear: the alignment row is naturally the narrowest and sat at 0
      // while six rows moved 193px in the spike. Every row must reach the same
      // maximum or the columns tear apart as the table scrolls.
      const extents = rows.map((row) => row.scrollWidth - row.clientWidth);
      expect(extents).toEqual(extents.map(() => extents[0]));
      expect(extents[0]).toBeGreaterThan(100);

      const offsets = rows.map((row) => row.scrollLeft);
      expect(offsets).toEqual(offsets.map(() => offsets[0]));
    } finally {
      harness.destroy();
    }
  });

  it("keeps the closing edge and the last column's trailing gap reachable at maximum scroll", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      for (const row of rows) row.scrollLeft = 9999;
      await nextFrame();

      for (const row of rows) {
        const rowRect = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        const clientRight =
          rowRect.right - Number.parseFloat(style.borderInlineEndWidth);
        const trailing = row.querySelector<HTMLElement>(
          ".nn-lp-cell-chrome-trailing, .nn-lp-cell-chrome-rule",
        )!;
        const gap = clientRight - trailing.getBoundingClientRect().right;

        // Grid items in a scroll container classically lose the container's
        // end padding. If that happened the gap would be 0 and the last column
        // would sit hard against the closing border.
        expect([row.className, gap > 7 && gap < 9]).toEqual([row.className, true]);
        // The closing edge is inside the visible band, not scrolled past.
        expect(trailing.getBoundingClientRect().right).toBeLessThanOrEqual(clientRight + 0.5);
      }
    } finally {
      harness.destroy();
    }
  });

  it("shows exactly one scroll affordance per table, owned by the last row", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const rows = rowsOf(harness.host);
      const affordances = rows.filter(
        (row) => getComputedStyle(row).scrollbarWidth !== "none",
      );
      expect(affordances).toHaveLength(1);
      expect(affordances[0]!.className).toContain("nn-lp-table-row-last");

      // And it costs nothing in layout, which is the only reason one row may
      // differ from the others: the engine uses overlay scrollbars.
      const gutters = rows.map((row) => row.offsetHeight - row.clientHeight);
      const borders = rows.map((row) =>
        Number.parseFloat(getComputedStyle(row).borderBlockStartWidth) +
        Number.parseFloat(getComputedStyle(row).borderBlockEndWidth),
      );
      expect(gutters).toEqual(borders);
    } finally {
      harness.destroy();
    }
  });
});

describe("the `.cm-content` clamp", () => {
  it("is what makes a row a scroll container at all, and leaves ordinary lines alone", async () => {
    const harness = await mount(WIDE_NOTE, WIDE_TRACKS);
    try {
      const content = harness.host.querySelector<HTMLElement>(".cm-content")!;
      const scroller = harness.host.querySelector<HTMLElement>(".cm-scroller")!;
      const control = [...harness.host.querySelectorAll<HTMLElement>(".cm-line")].find(
        (line) => !line.classList.contains("nn-lp-table-row") && line.textContent!.length > 60,
      )!;
      const rows = rowsOf(harness.host);

      const clamped = {
        content: content.getBoundingClientRect().width,
        noteScroll: scroller.scrollWidth - scroller.clientWidth,
        overflowing: rows.filter((row) => row.scrollWidth > row.clientWidth).length,
        controlHeight: control.getBoundingClientRect().height,
      };

      // The unclamped arm, measured rather than argued.
      content.style.maxWidth = "none";
      await nextFrame();
      const unclamped = {
        content: content.getBoundingClientRect().width,
        noteScroll: scroller.scrollWidth - scroller.clientWidth,
        overflowing: rowsOf(harness.host).filter((row) => row.scrollWidth > row.clientWidth)
          .length,
        controlHeight: control.getBoundingClientRect().height,
      };
      content.style.maxWidth = "";
      await nextFrame();

      expect({
        contentFillsPane: clamped.content === scroller.clientWidth,
        noNoteScroll: clamped.noteScroll === 0,
        everyRowOverflows: clamped.overflowing === rows.length,
        unclampedContentGrows: unclamped.content > clamped.content,
        unclampedRowsCannotScroll: unclamped.overflowing === 0,
        unclampedControlStopsWrapping: unclamped.controlHeight < clamped.controlHeight,
        measured: { clamped, unclamped },
      }).toEqual({
        contentFillsPane: true,
        noNoteScroll: true,
        everyRowOverflows: true,
        unclampedContentGrows: true,
        unclampedRowsCannotScroll: true,
        unclampedControlStopsWrapping: true,
        measured: { clamped, unclamped },
      });
    } finally {
      harness.destroy();
    }
  });

  it("leaves every other editor construct inside the content box", async () => {
    const note = [
      "# A heading that is quite long and would otherwise run past the pane",
      "",
      "A paragraph with a very long unbroken token https://example.com/a/very/long/path/that/never/breaks/anywhere in the middle of it.",
      "",
      "- [ ] a task item with enough words in it to need wrapping at this pane width",
      "",
      "> a blockquote that also has to wrap because it is long enough to need more than one line",
      "",
      "Some `inline code that is quite long indeed` and a #tag and a [[Wikilink]].",
    ].join("\n");
    const harness = await mount(note, WIDE_TRACKS);
    try {
      const content = harness.host.querySelector<HTMLElement>(".cm-content")!;
      const scroller = harness.host.querySelector<HTMLElement>(".cm-scroller")!;
      const contentRight = content.getBoundingClientRect().right;

      expect(scroller.scrollWidth - scroller.clientWidth).toBe(0);

      // Every rendered line, and every decorated span inside one, stays within
      // the clamped content box. A construct that ignored the clamp would push
      // its own right edge past it.
      const overflowing = [...content.querySelectorAll<HTMLElement>(".cm-line, .cm-line span")]
        .filter((element) => element.getBoundingClientRect().right > contentRight + 0.5)
        .map((element) => `${element.className}:${element.textContent?.slice(0, 24)}`);
      expect(overflowing).toEqual([]);

      // The long unbroken URL is the case the clamp would break if wrapping
      // were not already `overflow-wrap: anywhere`: it must still fit.
      const urlLine = [...content.querySelectorAll<HTMLElement>(".cm-line")].find((line) =>
        line.textContent!.includes("https://example.com"),
      )!;
      expect(urlLine.getBoundingClientRect().right).toBeLessThanOrEqual(contentRight + 0.5);
    } finally {
      harness.destroy();
    }
  });
});
