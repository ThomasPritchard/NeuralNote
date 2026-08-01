// P4 — the table-measurement seams, proved through the shipped
// `SourceNoteEditor` rather than through a harness.
//
// Three pieces arrived fully tested and connected to nothing: the probe primer
// (CT-4), the facet that feeds measured widths to the render plan (CT-2), and
// the refresh that re-derives a table's tracks when the metrics epoch moves.
// Each is registered in exactly one place — `SourceNoteEditor.tsx`'s extension
// array — and no other lane can catch its removal, because every other lane
// builds its own extension list. Unregister any one of them and something here
// goes red.
//
// jsdom has no layout engine, so every measurement it answers is zero. That is
// what this lane is for: the WIRING — whether the tracks are stamped in the
// measured unit at all, and whether an epoch bump re-derives them. The numbers
// are `SourceNoteEditor.tableWiring.browser.test.tsx`, where `iiii` and `WWWW`
// are the same four characters and very different widths.

import { render, waitFor } from "@testing-library/react";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  onMenu: vi.fn(() => Promise.resolve(() => {})),
}));

import { SourceNoteEditor } from "./SourceNoteEditor";
import { cellPaintPlan, type CellPaintPlan } from "./sourceEditorCellPaintPlan";
import { clearSourceEditorSessions } from "./sourceEditorSession";
import { CELL_TRACK_GUTTER_PX } from "./sourceEditorTableModel";
import { measuredWidth, releaseTextMetrics } from "./sourceEditorTextMetrics";

const NOTE = [
  "# Commitments",
  "",
  "| Start date | Commitment |",
  "| --- | --- |",
  "| 2026-04-03 | DJ gig |",
].join("\n");

/** Every measured advance jsdom is made to report while the mock is installed. */
const MOCK_ADVANCE_PX = 40;
const MOCK_ADVANCE_AFTER_EPOCH_PX = 90;

/** MutationObserver records are delivered on a microtask, never synchronously. */
const flushObservers = (): Promise<unknown> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Long enough for every measure cycle CodeMirror already had in flight to have
 * landed. Load-bearing rather than tidy: `sourceEditorTableViewport` dispatches
 * its first viewport effect from a `requestAnimationFrame` measure, and that one
 * re-derives the table for free — measured, it arrives late enough to make an
 * epoch test pass with the refresh under test deleted.
 */
const settle = async (): Promise<void> => {
  for (let cycle = 0; cycle < 4; cycle += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

function planFor(cell: string): CellPaintPlan {
  const doc = `| ${cell} |`;
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const from = doc.indexOf(cell);
  return cellPaintPlan(state, { from, to: from + cell.length }, {
    context: "body",
    index: [],
  });
}

interface Mounted {
  readonly container: HTMLElement;
  readonly view: EditorView;
  readonly onChange: ReturnType<typeof vi.fn>;
}

/** Sessions are keyed globally, so a reused key restores the previous doc. */
let mounts = 0;

function mount(value: string): Mounted {
  mounts += 1;
  const onChange = vi.fn();
  const { container } = render(
    <SourceNoteEditor
      sessionKey={`table-metrics-${mounts}`}
      loadedHash={`table-metrics-${mounts}`}
      value={value}
      onChange={onChange}
      onPreservationError={vi.fn()}
    />,
  );
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { container, view, onChange };
}

/**
 * Scoped to `.cm-content` on purpose. The measurement probe carries CT-1's own
 * row classes — that is how it reproduces a cell's cascade — so an unscoped
 * `.nn-lp-table-row` query counts it as a fourth row of the table.
 */
const rowLines = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(".cm-content .cm-line.nn-lp-table-row")];

const trackStamp = (line: Element): string =>
  /--nn-table-tracks:\s*([^;]+)/.exec(line.getAttribute("style") ?? "")?.[1]?.trim() ?? "";

/** A table is drawn as cells only while the caret is inside it. */
async function revealTable(mounted: Mounted): Promise<void> {
  mounted.view.dispatch({ selection: { anchor: NOTE.indexOf("DJ gig") } });
  await waitFor(() => {
    expect(rowLines(mounted.container)).toHaveLength(3);
  });
}

/** jsdom ships no FontFaceSet, and the epoch's one unconditional trigger needs one. */
const fontSet = Object.assign(new EventTarget(), { ready: Promise.resolve() });

/**
 * A webfont settling after first paint.
 *
 * Deliberately this trigger and not one of the style-change triggers. Those all
 * move a longhand on an element inside `.cm-content`, and CodeMirror observes
 * that subtree with `attributes: true` (`@codemirror/view/dist/index.js:7073`)
 * — it reacts by re-deriving the view, which re-derives the table field, which
 * is exactly the thing under test. Measured: a font-scale-shaped bump left this
 * suite green with the refresh deleted. `loadingdone` touches nothing CodeMirror
 * is watching, so a green here can only be the refresh.
 */
async function moveTheEpoch(): Promise<void> {
  fontSet.dispatchEvent(new Event("loadingdone"));
  await flushObservers();
}

beforeEach(() => {
  Object.defineProperty(document, "fonts", { value: fontSet, configurable: true });
});

afterEach(() => {
  clearSourceEditorSessions();
  releaseTextMetrics();
  Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
});

describe("the composed editor's measurement probe", () => {
  it("primes the probe from the editor it mounts", () => {
    releaseTextMetrics();
    expect(measuredWidth(planFor("ab"))).toBeNull();

    mount("plain paragraph");

    // Unregistered, nothing ever primes and every cell measures `null` — which
    // CT-4 defines as "first frame" and the render plan answers with character
    // tracks. Silently, and for the rest of the session.
    expect(measuredWidth(planFor("ab"))).not.toBeNull();
  });
});

describe("the composed editor's table tracks", () => {
  it("stamps tracks in the measured unit, not the character fallback", async () => {
    const mounted = mount(NOTE);
    await revealTable(mounted);

    const stamps = rowLines(mounted.container).map(trackStamp);

    expect(stamps).toHaveLength(3);
    // With no provider on `tableCellMetrics` every column measures `null` and
    // every track is stamped in `ch`.
    for (const stamp of stamps) expect(stamp).toMatch(/^\d[\d.]*px( \d[\d.]*px)*$/);
  });

  it("re-derives the tracks when the metrics epoch moves, without changing a byte", async () => {
    let advance = MOCK_ADVANCE_PX;
    vi.spyOn(Range.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width: advance }) as DOMRect);
    const mounted = mount(NOTE);
    await revealTable(mounted);
    await settle();
    const before = `${MOCK_ADVANCE_PX + CELL_TRACK_GUTTER_PX}px`;
    const after = `${MOCK_ADVANCE_AFTER_EPOCH_PX + CELL_TRACK_GUTTER_PX}px`;
    expect(trackStamp(rowLines(mounted.container)[0]!)).toBe(`${before} ${before}`);

    // The control, and the reason this test is trustworthy at all: a wider
    // measurement is now available and NOTHING is allowed to pick it up on its
    // own. Without this step the assertion below passes on whatever measure
    // cycle happens to land next.
    advance = MOCK_ADVANCE_AFTER_EPOCH_PX;
    await settle();
    expect(trackStamp(rowLines(mounted.container)[0]!)).toBe(`${before} ${before}`);

    await moveTheEpoch();
    await settle();

    // A webfont settling after first paint: the widths cached under the old
    // epoch are dropped, and without the refresh nothing asks for new ones
    // until the next keystroke.
    expect(rowLines(mounted.container).map(trackStamp))
      .toEqual([`${after} ${after}`, `${after} ${after}`, `${after} ${after}`]);
    expect(mounted.view.state.doc.toString()).toBe(NOTE);
    expect(mounted.onChange).not.toHaveBeenCalled();
  });
});

describe("byte fidelity through the composed editor", () => {
  it("changes nothing on open, on a caret walk, or across an epoch bump", async () => {
    const mounted = mount(NOTE);
    await revealTable(mounted);
    const drifted: number[] = [];

    for (let anchor = 0; anchor <= NOTE.length; anchor += 1) {
      mounted.view.dispatch({ selection: { anchor } });
      if (mounted.view.state.doc.toString() !== NOTE) drifted.push(anchor);
    }
    await moveTheEpoch();
    await flushObservers();

    expect(drifted).toEqual([]);
    expect(mounted.view.state.doc.toString()).toBe(NOTE);
    expect(mounted.onChange).not.toHaveBeenCalled();
  });
});
