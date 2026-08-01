// jsdom lane for CT-4. jsdom has no layout engine, so EVERY number here is
// zero and every geometric assertion would be vacuous — the pixels are proved in
// `sourceEditorTextMetrics.browser.test.tsx`, which is P3a's gate. What this lane
// can prove is the part that is pure wiring: what the probe is built from, where
// it is mounted, which styles are copied, when the epoch moves, and that the
// cache is keyed on the RENDERED signature rather than on the source text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { cellPaintPlan, type CellPaintPlan } from "./sourceEditorCellPaintPlan";
import { TABLE_CONTRACT_FIXTURE } from "./sourceEditorTableContractFixture";
import {
  TEXT_METRICS_PROBE_ATTRIBUTE,
  measuredWidth,
  metricsEpoch,
  primeTextMetrics,
  releaseTextMetrics,
  textMetricsPrimer,
} from "./sourceEditorTextMetrics";

function planFor(source: string, cell: string, context: "header" | "body" = "body"): CellPaintPlan {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const from = source.indexOf(cell);
  expect(from).toBeGreaterThanOrEqual(0);
  return cellPaintPlan(state, { from, to: from + cell.length }, { context, index: [] });
}

function editorHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "nn-source-editor";
  const content = document.createElement("div");
  content.className = "cm-content";
  host.append(content);
  document.body.append(host);
  return host;
}

function probeElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TEXT_METRICS_PROBE_ATTRIBUTE}]`);
}

/** MutationObserver records are delivered on a microtask, never synchronously. */
const flushObservers = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The element the runs are built into: the probe's cell. */
function probeCell(): HTMLElement {
  const cell = probeElement()?.querySelector<HTMLElement>(".nn-lp-cell");
  expect(cell).not.toBeNull();
  return cell!;
}

describe("sourceEditorTextMetrics", () => {
  let host: HTMLElement;
  const views: EditorView[] = [];

  function editorView(): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc: "| a |", extensions: [textMetricsPrimer] }),
      parent: host,
    });
    views.push(view);
    return view;
  }

  beforeEach(() => {
    host = editorHost();
  });

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    releaseTextMetrics();
    host.remove();
    document.documentElement.removeAttribute("data-font-family");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("font-size");
    Reflect.deleteProperty(document, "fonts");
    vi.restoreAllMocks();
  });

  it("is primed for the lifetime of an editor view and released with it", () => {
    const view = editorView();

    expect(probeElement()).not.toBeNull();
    expect(measuredWidth(planFor("| ab |", "ab"))).not.toBeNull();

    view.destroy();

    expect(probeElement()).toBeNull();
    expect(measuredWidth(planFor("| ab |", "ab"))).toBeNull();
  });

  it("does not let a closing view take the probe a second view has primed", () => {
    const first = editorView();
    const second = editorView();
    expect(second.contentDOM.isConnected).toBe(true);

    first.destroy();

    // Two editors on screen at once is not today's shape, but a teardown that
    // silently unprimes the live one would show up as columns collapsing to
    // their unmeasured fallback, not as an error.
    expect(probeElement()).not.toBeNull();
    expect(measuredWidth(planFor("| ab |", "ab"))).not.toBeNull();
  });

  it("reports no width until it is primed, which is the normal first frame", () => {
    expect(measuredWidth(planFor("| ab |", "ab"))).toBeNull();
  });

  it("measures once primed", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    expect(measuredWidth(planFor("| ab |", "ab"))).not.toBeNull();
  });

  it("stops measuring once released, and takes its probe out of the DOM", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    expect(probeElement()).not.toBeNull();

    releaseTextMetrics();

    expect(probeElement()).toBeNull();
    expect(measuredWidth(planFor("| ab |", "ab"))).toBeNull();
  });

  it("rebuilds a probe whose host was torn out, rather than measuring a detached zero", () => {
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    primeTextMetrics(content);
    const first = probeElement()!;

    first.remove();
    measuredWidth(planFor("| ab |", "ab"));

    const rebuilt = probeElement();
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt!.isConnected).toBe(true);
  });

  it("mounts the probe inside the editor host, where the mark rules can reach it", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);

    // `.nn-source-editor .nn-lp-strong` and friends are host-scoped: a probe at
    // document.body would silently measure every mark at its unstyled weight.
    expect(probeElement()?.closest(".nn-source-editor")).toBe(host);
  });

  it("builds the probe from the plan's runs, not from the cell's source text", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const plan = planFor("| **DJ gig** |", "**DJ gig**");

    measuredWidth(plan);

    // Four asterisks in the source, none of them painted.
    expect(plan.visibleText).toBe("DJ gig");
    expect(probeCell().textContent).toBe("DJ gig");
    expect(probeCell().textContent).not.toContain("*");
  });

  it("gives every run the classes the paint layer gives it", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const plan = planFor("| a **b** `c` |", "a **b** `c`");

    measuredWidth(plan);

    const rendered = [...probeCell().children].map((run) => ({
      text: run.textContent,
      className: run.className,
    }));
    expect(rendered).toEqual(
      plan.runs.map((run) => ({ text: run.text, className: run.classNames.join(" ") })),
    );
    expect(rendered.map((run) => run.className)).toContain("nn-lp-strong");
  });

  it("renders a widget run as its drawn label", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const plan = planFor("| [[Roadmap]] |", "[[Roadmap]]");

    measuredWidth(plan);

    expect(probeCell().textContent).toBe("Roadmap");
    expect(probeCell().querySelector(".nn-lp-wikilink-unresolved")).not.toBeNull();
  });

  it("carries the plan's header/body context on the row, matching CT-1's line classes", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);

    measuredWidth(planFor("| Start date |", "Start date", "header"));
    const rowClassName = probeCell().parentElement!.className;

    // A header cell paints at its own weight, and that weight is declared on the
    // ROW in CT-1 — so a probe carrying the wrong row classes measures the wrong
    // width. Pinned against the frozen fixture rather than a literal.
    const headerRow = TABLE_CONTRACT_FIXTURE[0]!.rows.find((row) => row.kind === "header")!;
    expect(headerRow.lineClassName.startsWith(rowClassName)).toBe(true);

    measuredWidth(planFor("| 2026-04-03 |", "2026-04-03", "body"));
    expect(probeCell().parentElement!.className).not.toBe(rowClassName);
  });

  it("copies font longhands rather than the `font` shorthand", () => {
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    content.style.setProperty("font-variant-numeric", "tabular-nums");
    content.style.setProperty("letter-spacing", "0.05em");

    primeTextMetrics(content);

    // The shorthand resets font-variant-numeric to `normal` and does not carry
    // letter-spacing at all; both change the advance width, measurably.
    const probeStyle = probeElement()!.firstElementChild as HTMLElement;
    expect(probeStyle.style.getPropertyValue("font-variant-numeric")).toBe("tabular-nums");
    expect(probeStyle.style.getPropertyValue("letter-spacing")).toBe("0.05em");
    expect(probeStyle.style.getPropertyValue("font")).toBe("");
  });

  it("measures a signature once and serves every later call from the cache", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const measure = vi.spyOn(Range.prototype, "getBoundingClientRect");

    const first = measuredWidth(planFor("| **b** |", "**b**"));
    const second = measuredWidth(planFor("| **b** |", "**b**"));

    expect(second).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("keys the cache on the rendered signature, never on the source text", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const measure = vi.spyOn(Range.prototype, "getBoundingClientRect");

    // Different source, identical painted result: one bold `b`.
    const asterisks = planFor("| **b** |", "**b**");
    const underscores = planFor("| __b__ |", "__b__");
    expect(asterisks.signature).toBe(underscores.signature);

    measuredWidth(asterisks);
    measuredWidth(underscores);

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("does not confuse two cells whose painted text differs only in its classes", () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const measure = vi.spyOn(Range.prototype, "getBoundingClientRect");

    const bold = planFor("| **b** |", "**b**");
    const plain = planFor("| b |", "b");
    expect(bold.visibleText).toBe(plain.visibleText);
    expect(bold.signature).not.toBe(plain.signature);

    measuredWidth(bold);
    measuredWidth(plain);

    // A cache keyed on the painted TEXT would serve the plain cell the bold
    // cell's width — the same class of silent wrong answer as keying on the raw
    // source, and just as invisible: a column that is quietly too wide.
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("bumps the epoch when fonts finish loading, and drops the widths it measured", () => {
    // jsdom ships no FontFaceSet, so this proves the wiring only. That a real
    // font load moves a real width is proved in the browser lane, where the
    // fallback face measures 12% narrow until the webfont lands.
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

    primeTextMetrics(host.querySelector(".cm-content")!);
    const before = metricsEpoch();
    const measure = vi.spyOn(Range.prototype, "getBoundingClientRect");
    measuredWidth(planFor("| ab |", "ab"));

    // The family name is identical either side of a webfont swap, so no style
    // comparison can catch this one: it has to bump unconditionally.
    fonts.dispatchEvent(new Event("loadingdone"));

    expect(metricsEpoch()).toBeGreaterThan(before);
    measuredWidth(planFor("| ab |", "ab"));
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("bumps the epoch from `loading` alone, because WebKit never sends loadingdone", async () => {
    // Measured, not assumed: on WebKit `loading` fires and `loadingdone` does
    // not — for `add()` + `FontFace.load()` AND for a CSS-driven layout-demanded
    // load — while `status` still reaches "loaded". Every macOS build runs on
    // WKWebView, so a `loadingdone`-only subscription leaves the epoch pinned to
    // the fallback face's widths for the life of the document. `loading` + the
    // `ready` promise is the pair that holds on both engines.
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => { settle = resolve; });
    const fonts = Object.assign(new EventTarget(), { ready, status: "loaded" });
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

    primeTextMetrics(host.querySelector(".cm-content")!);
    const before = metricsEpoch();

    fonts.dispatchEvent(new Event("loading"));
    // Still nothing: the faces are in flight, and bumping now would cache widths
    // measured against the very fallback this exists to replace.
    expect(metricsEpoch()).toBe(before);

    settle();
    await ready;
    await Promise.resolve();

    expect(metricsEpoch()).toBeGreaterThan(before);
  });

  it("bumps the epoch when the font scale changes the measured styles", async () => {
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    primeTextMetrics(content);
    const before = metricsEpoch();

    content.style.setProperty("font-size", "24px");
    document.documentElement.style.setProperty("font-size", "112.5%");
    await flushObservers();

    expect(metricsEpoch()).toBeGreaterThan(before);
  });

  it("leaves the epoch alone when a trigger fires and nothing that changes width moved", async () => {
    primeTextMetrics(host.querySelector(".cm-content")!);
    const before = metricsEpoch();

    document.documentElement.dataset.theme = "someOtherTheme";
    window.dispatchEvent(new Event("resize"));
    await flushObservers();

    expect(metricsEpoch()).toBe(before);
  });
});
