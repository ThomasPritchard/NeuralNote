// P3a's gate. Every assertion here is about pixels, and jsdom has no layout
// engine — `getBoundingClientRect()` returns all-zeros there, so this whole file
// would pass against a probe that measured nothing at all. It runs in real
// headless Chromium with the app's real Tailwind pipeline
// (`vitest.browser.config.ts`).
//
// Two live arms, because they fail for different reasons:
//
//   Arm A — the probe against a live cell carrying CT-1's own class chain,
//   rendered through the ordinary cascade inside the editor's own
//   `.cm-editor > .cm-scroller > .cm-content` context. This is the phase gate:
//   it covers every fixture cell, digits included, and it is the arm that
//   catches a probe mounted in the wrong place or configured through the `font`
//   shorthand.
//
//   Arm B — the probe against text CodeMirror actually painted, for every
//   fixture cell. It ties the measurement back to real paint rather than to DOM
//   this file built. Its comparand is a PARAGRAPH and the probe measures a
//   CELL, so the painted line is first given the one width-bearing declaration
//   a table row adds over a paragraph — see `alignNumericContext`. Without that
//   the two sides are two different typographic contexts and any agreement is a
//   coincidence, which is exactly how this arm came to pass on macOS and fail
//   on Linux CI.
//
// The negative control runs inside the parity sweep, per the phase's own
// clause: a 0.00px agreement with nothing failing beside it is a probe that
// silently applied no styles at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { SourceNoteEditor } from "./SourceNoteEditor";
import {
  cellPaintPlan,
  type CellPaintContext,
  type CellPaintPlan,
} from "./sourceEditorCellPaintPlan";
import { TABLE_CONTRACT_FIXTURE } from "./sourceEditorTableContractFixture";
import {
  TEXT_METRICS_PROBE_ATTRIBUTE,
  measuredWidth,
  metricsEpoch,
  primeTextMetrics,
  releaseTextMetrics,
} from "./sourceEditorTextMetrics";
import interFontUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
// The app loads these in `main.tsx`; the browser lane has to load them itself or
// every measurement is the fallback face's. Imported by explicit path because a
// bare specifier for a CSS-only package has no type declarations to resolve.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "../styles.css";

/** What the phase asks for: the probe reproduces live rendering to 1px. */
const TOLERANCE_PX = 1;

/** Every cell the CT-1 fixture declares, as the source the cell holds. */
function fixtureCellSources(): string[] {
  const cells = new Set<string>();
  for (const table of TABLE_CONTRACT_FIXTURE) {
    for (const line of table.source.split("\n")) {
      if (/^\|\s*-+/.test(line)) continue;
      for (const cell of line.split("|").slice(1, -1)) {
        if (cell.trim()) cells.add(cell.trim());
      }
    }
  }
  return [...cells];
}

const CELL_SOURCES = fixtureCellSources();

/**
 * The cell sits on its own line with the caret parked two lines above it, so no
 * construct is revealed by the selection — the state the paint layer is in for
 * every cell the caret is not inside.
 */
function planFor(source: string, context: CellPaintContext = "body"): CellPaintPlan {
  const state = EditorState.create({
    doc: `.\n\n${source}`,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return cellPaintPlan(state, { from: 3, to: 3 + source.length }, { context, index: [] });
}

interface Measurement {
  readonly cell: string;
  readonly live: number;
  readonly probe: number;
  readonly delta: number;
}

/**
 * The cells the probe and live rendering disagree about, as printable rows.
 * A bare `expect(delta).toBeLessThan(1)` reports a number with no cell attached,
 * which is unreadable the moment a sweep of 30 cells fails on one of them.
 */
function disagreements(measured: readonly Measurement[]): string[] {
  return measured
    .filter((entry) => entry.delta > TOLERANCE_PX)
    .map((entry) => `${entry.cell}: live ${entry.live} vs probe ${entry.probe}`);
}

/** Mark classes in `styles.css` that declare a family of their own (`:584`). */
const FAMILY_DECLARING_CLASSES = new Set([
  "nn-lp-inline-code", "nn-lp-fenced-code", "nn-lp-marker-active",
  "nn-lp-task-active", "nn-lp-block-id",
]);

/** Whether any of a plan's runs takes its family from the probe's own styles. */
function inheritsFamily(plan: CellPaintPlan): boolean {
  return plan.runs.some((run) =>
    run.text.trim() !== ""
    && !run.classNames.some((className) => FAMILY_DECLARING_CLASSES.has(className)));
}

function widthOfContents(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect().width;
}

/**
 * Put a painted PARAGRAPH line into the numeric context a table row paints a
 * cell in, so Arm B compares a cell's width against a cell's width.
 *
 * `.cm-line.nn-lp-table-row` declares `font-variant-numeric: tabular-nums`
 * (`styles.css:773`) and an ordinary paragraph does not. The probe carries it
 * because it measures a CELL, so without this the two sides are two different
 * typographic contexts. It is the WHOLE of the difference between them: aligned,
 * the residual over every fixture cell is exactly 0.0000px rather than merely
 * inside the tolerance — which is also why the agreement survives whatever face
 * a platform resolves and however it rounds advances.
 *
 * The effect is not confined to digits, and assuming it was is what made this
 * arm flaky. Measured, headless Chromium: `2026-04-03` moves 9.1px, but `Start
 * date` moves 0.20px, and the two runs of `**DJ gig** at the Bell` move +0.52px
 * and -0.61px — in OPPOSITE directions, so here they cancel to 0.09px and the
 * arm passed on a coincidence. CI reported that cell as `live 128 vs probe 125`:
 * whole pixels, where macOS reports 128.55 and 128.45. That is the signature of
 * a runner rounding glyph advances to integers, and there the two errors stop
 * cancelling.
 *
 * Aligning rather than skipping the affected cells is what lets this arm sweep
 * the whole fixture, and the digit-bearing cells it used to exclude are what
 * keep the alignment honest: drop this call and `2026-11-30` disagrees by
 * 16.7px on any platform.
 */
function alignNumericContext(line: HTMLElement): void {
  line.style.setProperty("font-variant-numeric", "tabular-nums");
}

/**
 * The track stamped on Arm A's live row, deliberately far narrower than any
 * cell's text: if the measurement came from the cell's BOX rather than from its
 * text, both arms would agree on this constant and prove nothing.
 */
const NARROW_TRACK_PX = 4;

/** The editor's own cascade, without CodeMirror behind it. */
function liveCascade(host: Element): HTMLElement {
  const editor = document.createElement("div");
  editor.className = "cm-editor";
  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  const content = document.createElement("div");
  content.className = "cm-content";
  scroller.append(content);
  editor.append(scroller);
  host.append(editor);
  return content;
}

/** A cell rendered the way P3b will render it, from the same plan. */
function renderLiveCell(
  content: Element,
  plan: CellPaintPlan,
  context: CellPaintContext,
): HTMLElement {
  const row = document.createElement("div");
  row.className = `cm-line nn-lp-table-row nn-lp-table-row-${context}`;
  row.style.setProperty("--nn-table-tracks", `${NARROW_TRACK_PX}px`);
  const cell = document.createElement("span");
  cell.className = "nn-lp-cell";
  for (const run of plan.runs) {
    const element = document.createElement("span");
    if (run.classNames.length > 0) element.className = run.classNames.join(" ");
    element.textContent = run.text;
    cell.append(element);
  }
  row.append(cell);
  content.replaceChildren(row);
  return cell;
}

/** A paragraph line CodeMirror painted, found by what it put on screen. */
function paintedLine(host: Element, text: string): HTMLElement | null {
  return [...host.querySelectorAll<HTMLElement>(".cm-content > .cm-line")]
    .find((line) => line.textContent === text) ?? null;
}

/** A 200-row table, for the budget the phase's kill criterion names. */
function wideTableSource(rows: number, edits: readonly string[]): string {
  const lines = ["| Start date | Commitment | Notes |", "| --- | --- | --- |"];
  for (let row = 0; row < rows; row += 1) {
    lines.push(`| 2026-04-${row} | Commitment ${row}${edits[row] ?? ""} | Note ${row} |`);
  }
  return lines.join("\n");
}

interface CellSlot {
  readonly from: number;
  readonly to: number;
  readonly context: CellPaintContext;
}

/** Every pipe-to-pipe span in a table source, at document offsets. */
function cellSlots(doc: string): CellSlot[] {
  const slots: CellSlot[] = [];
  let lineStart = 0;
  for (const [index, line] of doc.split("\n").entries()) {
    if (!/^\|\s*-+/.test(line)) {
      const pipes = [...line.matchAll(/\|/g)].map((match) => match.index);
      for (let pipe = 0; pipe + 1 < pipes.length; pipe += 1) {
        slots.push({
          from: lineStart + pipes[pipe]! + 1,
          to: lineStart + pipes[pipe + 1]!,
          context: index === 0 ? "header" : "body",
        });
      }
    }
    lineStart += line.length + 1;
  }
  return slots;
}

describe("sourceEditorTextMetrics in a real browser", () => {
  let host: HTMLElement;
  let root: Root | null = null;
  // `SourceNoteEditor` keeps its editor session per `sessionKey`, so reusing one
  // key across mounts restores the PREVIOUS test's document — measured: the
  // second mount rendered the first test's table.
  let mounts = 0;

  async function mountEditor(source: string): Promise<void> {
    mounts += 1;
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <SourceNoteEditor
          sessionKey={`text-metrics-${mounts}`}
          loadedHash={`text-metrics-${mounts}`}
          value={source}
          onChange={() => {}}
          onPreservationError={() => {}}
        />,
      );
    });
    await document.fonts.ready;
    // `act()` is not wired up in the browser lane ("not configured to support
    // act(...)"), so returning from it does not mean the effect that builds the
    // EditorView has run. Measured: with fonts already loaded from an earlier
    // test the await costs nothing and the content DOM is still empty of lines.
    await vi.waitFor(() => {
      if (host.querySelectorAll(".cm-content > .cm-line").length === 0) {
        throw new Error("the editor has not painted a line yet");
      }
    });
  }

  beforeEach(() => {
    host = document.createElement("div");
    host.className = "nn-source-editor";
    document.body.append(host);
  });

  afterEach(() => {
    releaseTextMetrics();
    root?.unmount();
    root = null;
    host.remove();
    vi.restoreAllMocks();
  });

  it("reproduces the live rendered width of every fixture cell, and a wrong font does not", async () => {
    await mountEditor(TABLE_CONTRACT_FIXTURE[0]!.source);
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    const liveContent = liveCascade(host);
    primeTextMetrics(content);

    const measured: { cell: string; live: number; probe: number; delta: number }[] = [];
    for (const source of CELL_SOURCES) {
      for (const context of ["header", "body"] as const) {
        const plan = planFor(source, context);
        const live = widthOfContents(renderLiveCell(liveContent, plan, context));
        const probe = measuredWidth(plan)!;
        measured.push({ cell: `${context}:${source}`, live, probe, delta: Math.abs(live - probe) });
      }
    }

    expect(measured).toHaveLength(CELL_SOURCES.length * 2);
    // The cell's box is 4px wide; a number anywhere near it would mean the
    // measurement came from the track rather than from the text.
    expect(Math.min(...measured.map((entry) => entry.live)))
      .toBeGreaterThan(NARROW_TRACK_PX * 3);

    expect(disagreements(measured)).toEqual([]);

    // Negative control, in the same run: re-prime from an element whose only
    // difference is a monospace family. Every cell must move, or the probe is
    // not applying the styles it copies and the agreement above is luck.
    const control = document.createElement("div");
    control.style.setProperty("font-family", "monospace");
    liveContent.append(control);
    primeTextMetrics(control);

    const moved: string[] = [];
    const held: string[] = [];
    for (const entry of measured.filter((row) => row.cell.startsWith("body:"))) {
      const source = entry.cell.slice("body:".length);
      const delta = Math.abs(measuredWidth(planFor(source))! - entry.probe);
      (delta === 0 ? held : moved).push(source);
    }

    // Every cell whose painted text INHERITS the copied family has to move. A
    // cell whose every run declares its own family — `.nn-lp-inline-code` sets
    // `font-family: var(--font-mono)` (styles.css:584) — must not, and that is
    // the stronger half: it proves a run's class beats the copied root style
    // rather than being overwritten by it.
    expect(moved).toEqual(CELL_SOURCES.filter((cell) => inheritsFamily(planFor(cell))));
    expect(held).toEqual(CELL_SOURCES.filter((cell) => !inheritsFamily(planFor(cell))));
    expect(moved.length).toBeGreaterThan(0);
  });

  it("reproduces the width of text CodeMirror actually painted", async () => {
    // One cell per paragraph, so the preview collector paints the same
    // projection `cellPaintPlan` describes: markers hidden, marks applied,
    // wikilinks replaced by their drawn label. The lead line holds the caret so
    // nothing is revealed by the selection.
    await mountEditor(["Fixture cells", ...CELL_SOURCES].join("\n\n"));
    // The preview decorations are built from `view.visibleRanges`, which is
    // empty until CodeMirror's first measure cycle — so a freshly mounted editor
    // paints the raw source for a frame, markers and all. Wait for the
    // projection itself rather than for a timeout.
    //
    // Wait for EVERY cell, not for one of them. Waiting on a single line and
    // then reading all of them assumes the whole document paints in one cycle;
    // it does not, and the loop below `continue`s past whatever is still
    // missing, so a slow cell leaves the sweep quietly comparing less than it
    // claims. That is not hypothetical: the WebKit CI leg failed exactly here
    // with `` `soundcheck` `` — an inline-code cell — absent from `compared`,
    // caught only by the guard at the end of this test. Naming the stragglers in
    // the error keeps that diagnosis in the failure message rather than in a
    // deep-equal diff of two long arrays.
    const projections = CELL_SOURCES.map((cell) => ({ cell, text: planFor(cell).visibleText }));
    await vi.waitFor(() => {
      const unpainted = projections.filter(({ text }) => !paintedLine(host, text));
      if (unpainted.length > 0) {
        throw new Error(
          `the preview decorations have not painted yet: ${unpainted.map(({ cell }) => cell).join(", ")}`,
        );
      }
    });
    primeTextMetrics(host.querySelector(".cm-content")!);

    const compared: string[] = [];
    const painted: Measurement[] = [];
    for (const source of CELL_SOURCES) {
      const plan = planFor(source);
      const line = paintedLine(host, plan.visibleText);
      if (!line) continue;
      compared.push(source);
      alignNumericContext(line);
      const live = widthOfContents(line);
      const probe = measuredWidth(plan)!;
      painted.push({ cell: source, live, probe, delta: Math.abs(live - probe) });
    }
    expect(disagreements(painted)).toEqual([]);

    // A sweep that silently compared nothing would pass every assertion above.
    expect(compared).toEqual(CELL_SOURCES);
  });

  it("measures a header cell at the weight the header rule gives it", async () => {
    await mountEditor(TABLE_CONTRACT_FIXTURE[0]!.source);
    primeTextMetrics(host.querySelector(".cm-content")!);

    const text = "Commitment";
    const header = measuredWidth(planFor(text, "header"))!;
    const body = measuredWidth(planFor(text, "body"))!;

    // `.cm-line.nn-lp-table-row-header .nn-lp-cell { font-weight: 600 }`
    // (styles.css). CT-3 puts the context in the signature precisely so these
    // cannot collapse into one number.
    expect(`header ${header > body ? ">" : "<="} body`).toBe("header > body");
  });

  it("honours the longhands the `font` shorthand would drop", async () => {
    await mountEditor("placeholder");
    const liveContent = liveCascade(host);

    // A context the shorthand cannot express: it resets font-variant-numeric to
    // `normal` and carries no letter-spacing at all.
    const source = document.createElement("div");
    source.style.setProperty("font-variant-numeric", "tabular-nums");
    source.style.setProperty("letter-spacing", "0.06em");
    source.style.setProperty("font-family", "'Inter Variable', system-ui, sans-serif");
    liveContent.append(source);

    const plan = planFor("2026-04-03 1111 0000");
    const live = document.createElement("span");
    live.textContent = plan.visibleText;
    live.style.setProperty("white-space", "pre");
    source.append(live);

    primeTextMetrics(source);
    const liveWidth = widthOfContents(live);
    const probeWidth = measuredWidth(plan)!;

    expect(disagreements([
      { cell: "tabular-nums + letter-spacing", live: liveWidth, probe: probeWidth,
        delta: Math.abs(liveWidth - probeWidth) },
    ])).toEqual([]);
  });

  it("re-measures once the webfont settles, because the fallback face is not it", async () => {
    await mountEditor("placeholder");
    const liveContent = liveCascade(host);

    // A family nothing has loaded yet, so the first measurement is the
    // monospace fallback's — the case that produced a double-digit error.
    const source = document.createElement("div");
    source.style.setProperty("font-family", "LateArrival, monospace");
    liveContent.append(source);
    primeTextMetrics(source);

    const plan = planFor("Commitment 2026-04-03");
    const beforeLoad = measuredWidth(plan)!;
    const epochBefore = metricsEpoch();

    const face = new FontFace("LateArrival", `url(${interFontUrl})`);
    document.fonts.add(face);
    await face.load();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const epochAfter = metricsEpoch();
    const afterLoad = measuredWidth(plan)!;
    document.fonts.delete(face);

    expect(epochAfter).toBeGreaterThan(epochBefore);
    // Without the bump the cached fallback width would be served forever, so
    // this difference is the entire point of the epoch.
    const moved = Math.abs(afterLoad - beforeLoad);
    expect(moved > TOLERANCE_PX ? [] : [`fallback ${beforeLoad} vs loaded ${afterLoad}`]).toEqual([]);
  });

  it("does not give the page a scrollbar, however wide the cell is", async () => {
    await mountEditor(TABLE_CONTRACT_FIXTURE[0]!.source);
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    const before = document.documentElement.scrollWidth;

    primeTextMetrics(content);
    const wide = measuredWidth(planFor("x".repeat(4000)))!;

    expect(document.querySelector(`[${TEXT_METRICS_PROBE_ATTRIBUTE}]`)).not.toBeNull();
    expect(wide).toBeGreaterThan(document.documentElement.clientWidth);
    expect(document.documentElement.scrollWidth).toBe(before);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  });

  it("stays inside the 50ms budget for 20 single-character edits on a 200-row table", async () => {
    await mountEditor("placeholder");
    primeTextMetrics(host.querySelector(".cm-content")!);

    const rows = 200;
    const edits: string[] = [];
    const measureTable = (): number => {
      const doc = wideTableSource(rows, edits);
      const state = EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage })],
      });
      const slots = cellSlots(doc);
      for (const slot of slots) {
        measuredWidth(cellPaintPlan(state, slot, { context: slot.context, index: [] }));
      }
      return slots.length;
    };

    const layouts = vi.spyOn(Range.prototype, "getBoundingClientRect");
    const coldStarted = performance.now();
    const cells = measureTable();
    const coldMs = performance.now() - coldStarted;
    const coldLayouts = layouts.mock.calls.length;
    layouts.mockClear();

    const durations: number[] = [];
    for (let edit = 0; edit < 20; edit += 1) {
      // One character into one cell, exactly as a keystroke would.
      edits[edit] = "z";
      const started = performance.now();
      measureTable();
      durations.push(performance.now() - started);
    }
    const warmLayouts = layouts.mock.calls.length;

    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    const evidence = `cells ${cells}, cold ${coldMs.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, `
      + `median ${durations[Math.floor(durations.length / 2)]!.toFixed(1)}ms, `
      + `cold layouts ${coldLayouts}, warm layouts ${warmLayouts}`;

    expect(cells).toBeGreaterThanOrEqual(600);
    expect(p95 < 50 ? [] : [evidence]).toEqual([]);
    // Without memoisation the warm loop would lay out 12,000 times. This is
    // what makes the budget a statement about the cache rather than about the
    // machine it ran on.
    expect(coldLayouts > 500 ? [] : [evidence]).toEqual([]);
    expect(warmLayouts <= 20 ? [] : [evidence]).toEqual([]);
  });
});
