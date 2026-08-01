import { ViewPlugin } from "@codemirror/view";

import type { CellPaintPlan, CellPaintRun } from "./sourceEditorCellPaintPlan";

/**
 * CT-4 — the measured advance width of a {@link CellPaintPlan}, in CSS pixels.
 *
 * Table columns were sized by counting monospace character cells
 * (`sourceEditorTableModel.ts`'s `monospaceWidth`). That is exact only while the
 * cell renders in one monospace face at one weight, which stops being true the
 * moment a cell is *painted* rather than shown as source: `**bold**` loses four
 * characters and gains a heavier face, in opposite directions, with no
 * correction factor available. So the width has to be measured.
 *
 * **Measured from the plan, never from the source.** {@link measuredWidth} takes
 * a {@link CellPaintPlan} and builds exactly its runs — the same projection the
 * paint path draws (CT-3, G3). Measuring `state.sliceDoc(cell)` again would put
 * back the divergence P2 removed, and it would show up as column jitter rather
 * than as an error.
 *
 * **Why a DOM probe and not `CanvasRenderingContext2D.measureText`.** The canvas
 * text API is configured through the `font` shorthand, which cannot express
 * `font-variant-numeric`; this app sets `tabular-nums`
 * (`styles.css:634`, `:671`), and it is worth 25px on `2026-04-03 1111 0000` in
 * the editor's sans face — measured, headless Chromium. The same shorthand
 * limitation drops `letter-spacing`, `font-feature-settings` and
 * `font-variation-settings`. A DOM probe honours all of them because the engine
 * lays it out the way it lays out the real thing.
 *
 * **Where the probe lives matters.** Every mark rule in this app is scoped to
 * `.nn-source-editor`, so a probe parked on `document.body` measures a bold run
 * at regular weight and an inline-code run in the wrong family entirely
 * (measured: `soundcheck` 96.0px in the editor's mono face against 102.4px with
 * its code padding, and neither is what body gives). It therefore mounts inside
 * the editor host — but *outside* `.cm-editor`, because CodeMirror rebuilds
 * `.cm-content`'s children and appends its own layers to `.cm-scroller`.
 *
 * **Fonts settle late, and `document.fonts.check()` will not tell you.** A width
 * measured before the webfont lands belongs to the fallback face. The remedy is
 * an epoch: every width is cached under {@link metricsEpoch}, and the epoch moves
 * when anything that changes an advance width does. `loadingdone` bumps it
 * unconditionally, because the computed `font-family` string is identical either
 * side of a webfont swap — no style comparison can see that one.
 */

/** Marks the probe's outermost element. Nothing else in the app carries it. */
export const TEXT_METRICS_PROBE_ATTRIBUTE = "data-nn-text-metrics-probe";

/** The scope every `.nn-lp-*` mark rule is written under (`styles.css`). */
const EDITOR_HOST_SELECTOR = ".nn-source-editor";

/**
 * CT-1's row line classes, minus the edge hooks: a header cell paints at its own
 * weight and that weight is declared on the row, so a probe without the row's
 * classes measures a header at body weight. Pinned to the frozen fixture by
 * `sourceEditorTextMetrics.test.ts`.
 */
const ROW_CLASS_PREFIX = "cm-line nn-lp-table-row nn-lp-table-row-";

/** CT-1's cell class. */
const CELL_CLASS = "nn-lp-cell";

/**
 * The longhands that change an advance width, copied one by one.
 *
 * **Never the `font` shorthand.** It resets `font-variant-numeric` to `normal`
 * and carries neither `letter-spacing` nor `font-feature-settings`, so a probe
 * configured through it measures a different string than the screen shows —
 * silently, and only for the content that happens to use those features.
 */
const COPIED_PROPERTIES: readonly string[] = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-optical-sizing",
  "font-size-adjust",
  "font-kerning",
  "font-synthesis-weight",
  "font-variant-numeric",
  "font-variant-caps",
  "font-variant-ligatures",
  "font-variant-east-asian",
  "font-feature-settings",
  "font-variation-settings",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-rendering",
  "tab-size",
];

/**
 * Imposed on the probe rather than copied.
 *
 * `white-space: pre` and `width: max-content` are the measurement itself: a
 * table cell does not wrap, so its width is the unwrapped advance, and a probe
 * that inherits the editor's `break-spaces` would report the width of whatever
 * box it happened to sit in.
 */
const PROBE_STYLE: Readonly<Record<string, string>> = {
  position: "absolute",
  top: "0",
  left: "0",
  "white-space": "pre",
  width: "max-content",
};

/**
 * A zero-sized clipping box. The probe is wider than the pane by design, and an
 * absolutely positioned descendant still contributes to an ancestor's scrollable
 * overflow — so without this the editor host grows a horizontal scrollbar the
 * moment a wide cell is measured.
 */
const CLIP_STYLE: Readonly<Record<string, string>> = {
  position: "absolute",
  top: "0",
  left: "0",
  width: "0",
  height: "0",
  overflow: "hidden",
  visibility: "hidden",
  "pointer-events": "none",
};

interface Probe {
  readonly clip: HTMLElement;
  readonly root: HTMLElement;
  readonly row: HTMLElement;
  readonly cell: HTMLElement;
}

interface MetricsState {
  /** The element whose computed style the probe reproduces. */
  readonly source: Element;
  probe: Probe | null;
  detach: (() => void) | null;
  /** Measured widths for the current epoch, keyed by `CellPaintPlan.signature`. */
  readonly widths: Map<string, number>;
  /** The cell box's own inline padding for the current epoch, once measured. */
  padding: number | null;
}

let state: MetricsState | null = null;
let epoch = 0;
/** The copied style values behind the current epoch, joined. */
let styleSignature: string | null = null;
/** Notified after the epoch moves. Module-scoped, because the epoch is. */
const epochListeners = new Set<() => void>();

/**
 * The style generation every cached width belongs to.
 *
 * A consumer holding its own derived geometry should key it on this and discard
 * that geometry when it moves.
 */
export function metricsEpoch(): number {
  return epoch;
}

/**
 * Be told when {@link metricsEpoch} moves, so derived geometry can be rebuilt.
 *
 * A consumer has no other way to learn that the width it is holding is stale:
 * the epoch moves when a webfont settles or the typography changes, and neither
 * is an editor update. Polling cannot see them either — a font arriving after
 * first paint produces no transaction to poll on.
 *
 * @param listener - called once the epoch has moved and the cache is cold.
 *   SYNCHRONOUSLY, and the epoch can move from inside a state update, because
 *   the probe syncs its styles the first time a width is asked for. A listener
 *   that dispatches must defer.
 * @returns a function that unsubscribes
 */
export function onMetricsEpochChange(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

/**
 * Point the probe at the element whose typography a cell inherits — the editor's
 * content DOM, or a line inside the table, whichever the caller paints into.
 *
 * Safe to call repeatedly; priming from the same element re-syncs the copied
 * styles instead of rebuilding. An element that is not in the document yet is
 * remembered and primed on first use, which is the ordinary case for a view
 * plugin constructed before its editor is attached.
 */
export function primeTextMetrics(from: Element): void {
  if (state?.source === from) {
    if (syncStyles()) bumpEpoch();
    return;
  }
  releaseTextMetrics();
  state = { source: from, probe: null, detach: null, widths: new Map(), padding: null };
  ensureProbe();
}

/**
 * Tear the probe out of the document and stop listening. Measurement returns to
 * "not primed" — {@link measuredWidth} answers `null` again.
 */
export function releaseTextMetrics(): void {
  state?.detach?.();
  state?.probe?.clip.remove();
  state = null;
}

/**
 * The width the paint layer would put on screen for this plan, in CSS pixels.
 *
 * @param plan - the cell's canonical projection (CT-3)
 * @returns the measured width, or `null` while nothing is primed — the normal
 *   first frame, not an error
 */
export function measuredWidth(plan: CellPaintPlan): number | null {
  const probe = ensureProbe();
  if (!probe || !state) return null;

  const cached = state.widths.get(plan.signature);
  if (cached !== undefined) return cached;

  const width = layOut(probe, plan);
  state.widths.set(plan.signature, width);
  return width;
}

/**
 * The inline padding a drawn cell's own box adds around the advance
 * {@link measuredWidth} reports, in CSS pixels.
 *
 * Measured rather than read from `--nn-table-cell-pad` (`styles.css`): the value
 * is authored in `rem` and the font-scale preference moves the root font size
 * (`preferences.tsx:applyPreferences`), so the only dependable answer is the one
 * the engine computes for this cell at this epoch. Taken as the difference
 * between the cell's box and its contents — an inline box holding nothing is its
 * padding and nothing else — so it needs no knowledge of which longhands the
 * stylesheet happened to use.
 *
 * @returns the start plus end padding, or `null` while nothing is primed — the
 *   same "not primed yet" {@link measuredWidth} reports, for the same reason
 */
export function measuredCellPadding(): number | null {
  const probe = ensureProbe();
  if (!probe || !state) return null;

  state.padding ??= layOutPadding(probe);
  return state.padding;
}

/**
 * Keeps the probe primed for the lifetime of an editor view, and nothing else —
 * it reads no updates and produces no decorations. Measurement is called
 * synchronously by whoever is building the render plan.
 */
export const textMetricsPrimer = ViewPlugin.define((view) => {
  primeTextMetrics(view.contentDOM);
  return {
    destroy() {
      // Only if this view is still the one being measured: a second editor
      // mounting re-primes, and this view's teardown must not take its probe.
      if (state?.source === view.contentDOM) releaseTextMetrics();
    },
  };
});

function ensureProbe(): Probe | null {
  if (!state) return null;
  // A detached probe measures zero for everything, which is a wrong answer
  // rather than a missing one — so a probe whose host has been torn out is
  // rebuilt rather than reused.
  if (state.probe?.clip.isConnected) return state.probe;
  state.probe = null;
  if (!state.source.isConnected) return null;

  const host = state.source.closest(EDITOR_HOST_SELECTOR)
    ?? state.source.ownerDocument.body;
  if (!host) return null;

  state.probe = buildProbe(state.source.ownerDocument, host);
  state.detach = attachTriggers(state);
  if (syncStyles()) bumpEpoch();
  return state.probe;
}

function buildProbe(document: Document, host: Element): Probe {
  const clip = applyStyle(document.createElement("div"), CLIP_STYLE);
  clip.setAttribute(TEXT_METRICS_PROBE_ATTRIBUTE, "");
  clip.setAttribute("aria-hidden", "true");

  const root = applyStyle(document.createElement("div"), PROBE_STYLE);
  const row = document.createElement("div");
  // Never class-less, even before the first `layOut`. A cell takes its inline
  // padding from a custom property the ROW declares, so a probe measured with a
  // bare row would report a cell that has no padding at all.
  row.className = `${ROW_CLASS_PREFIX}body`;
  const cell = document.createElement("span");
  cell.className = CELL_CLASS;

  row.append(cell);
  root.append(row);
  clip.append(root);
  host.append(clip);
  return { clip, root, row, cell };
}

function applyStyle(element: HTMLElement, style: Readonly<Record<string, string>>): HTMLElement {
  for (const [property, value] of Object.entries(style)) {
    element.style.setProperty(property, value);
  }
  return element;
}

/** @returns whether anything that changes an advance width moved */
function syncStyles(): boolean {
  const probe = state?.probe;
  if (!state || !probe) return false;

  const computed = getComputedStyle(state.source);
  const values = COPIED_PROPERTIES.map((property) => computed.getPropertyValue(property));
  for (const [index, property] of COPIED_PROPERTIES.entries()) {
    const value = values[index];
    if (value) probe.root.style.setProperty(property, value);
  }

  const next = values.join(" ");
  const changed = next !== styleSignature;
  styleSignature = next;
  return changed;
}

function bumpEpoch(): void {
  epoch += 1;
  if (state) {
    state.widths.clear();
    state.padding = null;
  }
  for (const listener of epochListeners) listener();
}

/**
 * The epoch's trigger list. Font loading is the one that cannot be detected by
 * comparing styles, so it bumps on its own; everything else re-reads the source
 * element and bumps only if a width-bearing value actually moved, which keeps a
 * window resize from throwing away every measured column.
 */
function attachTriggers(owner: MetricsState): () => void {
  const document = owner.source.ownerDocument;
  const view = document.defaultView;
  const current = () => (state === owner ? owner : null);

  const onFontsSettled = () => {
    if (!current()) return;
    syncStyles();
    bumpEpoch();
  };
  const onStyleMayHaveMoved = () => {
    if (current() && syncStyles()) bumpEpoch();
  };

  // Typeface preference, font scale and theme are all attribute writes on the
  // root element (`preferences.tsx:applyPreferences`); browser zoom surfaces as
  // a resize.
  const observer = new MutationObserver(onStyleMayHaveMoved);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-font-family"],
  });
  document.fonts?.addEventListener("loadingdone", onFontsSettled);
  // Only when something is actually in flight: `ready` on an already-settled
  // set resolves immediately and would move the epoch for no reason. Note this
  // reads `status`, not `check()` — `check()` reports a family as present while
  // its face is still loading.
  if (document.fonts?.status === "loading") void document.fonts.ready.then(onFontsSettled);
  view?.addEventListener("resize", onStyleMayHaveMoved);

  return () => {
    observer.disconnect();
    document.fonts?.removeEventListener("loadingdone", onFontsSettled);
    view?.removeEventListener("resize", onStyleMayHaveMoved);
  };
}

function layOut(probe: Probe, plan: CellPaintPlan): number {
  probe.row.className = `${ROW_CLASS_PREFIX}${plan.context}`;
  probe.cell.replaceChildren(
    ...plan.runs.map((run) => runElement(probe.cell.ownerDocument, run)),
  );
  return contentsWidth(probe.cell);
}

/**
 * The cell's CONTENTS, not its box: under CT-2 the cell is a grid item whose
 * track is sized by the caller, so its box says what the track says rather than
 * what the text needs. A range over the runs also keeps each run's own padding —
 * inline code is 6.4px of it — which the screen shows too.
 */
function contentsWidth(cell: HTMLElement): number {
  const range = cell.ownerDocument.createRange();
  range.selectNodeContents(cell);
  return range.getBoundingClientRect().width;
}

/** The one thing the cell's box adds that its contents do not: its padding. */
function layOutPadding(probe: Probe): number {
  // Clamped: an engine with no layout answers zero to both, and sub-pixel noise
  // must never take width away from a track.
  return Math.max(0, probe.cell.getBoundingClientRect().width - contentsWidth(probe.cell));
}

function runElement(document: Document, run: CellPaintRun): HTMLElement {
  const element = document.createElement("span");
  if (run.classNames.length > 0) element.className = run.classNames.join(" ");
  // textContent, never innerHTML: a cell holds arbitrary user text.
  element.textContent = run.text;
  return element;
}
