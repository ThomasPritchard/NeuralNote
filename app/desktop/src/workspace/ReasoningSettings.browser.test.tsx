// Real-browser proof for the effort-substitution notice (amendment E3).
//
// jsdom answers none of this. It has no layout engine, so "the notice is one
// line", "the two sentences are the same height" and "the select still shows the
// stored value" are all trivially true there against the fix AND against a
// control that renders blank with a three-line box under it. Here the real
// Tailwind v4 pipeline resolves the type scale, the wrap and the native
// `<select>` exactly as the shipped webview does.
//
// The width is derived from the tokens rather than guessed. The narrowest this
// pane is ever laid out is the narrowest window the app will open —
// `tauri.conf.json` sets `minWidth: 920` — and the chain from there is:
//
//   dialog    min(920 − 32, max-w-4xl 896) = 888
//   − nav     sm:w-48                      = 192
//   − padding sm:px-6                      =  48
//   = settings column                        648
//   − card    ProviderCard p-4             =  32
//   = 616                                       ← the host width below
//
// and inside the notice its own `px-2.5` (20) plus the glyph and gap (18) leave
// the sentence 578px.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../styles.css";
import type { ReasoningControl, ReasoningEffortOverride } from "../lib/types";
import { ReasoningSettings } from "./ReasoningSettings";

/** The card body's content width in the narrowest window the app will open. */
const CARD_WIDTH = 616;

/** The menu after the model dropped `xhigh` from it — amendment E3's own case. */
const SHRUNK: ReasoningControl = {
  kind: "efforts",
  options: ["high", "low"],
  defaultEffort: "high",
  canDisable: true,
};

const mounted: Array<{ host: HTMLElement; root: Root }> = [];

beforeEach(() => {
  mounted.length = 0;
});

afterEach(() => {
  for (const { host, root } of mounted) {
    act(() => root.unmount());
    host.remove();
  }
  mounted.length = 0;
});

function mount(
  override: ReasoningEffortOverride | null,
  control: ReasoningControl = SHRUNK,
) {
  const host = document.createElement("div");
  host.style.width = `${CARD_WIDTH}px`;
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });

  act(() => {
    root.render(
      <ReasoningSettings
        control={control}
        model="deepseek/deepseek-v4-flash"
        reasoningOn
        effort="xhigh"
        effortOverride={override}
        saving={false}
        rechecking={false}
        error={null}
        onToggle={() => {}}
        onPickEffort={() => {}}
        onRecheck={() => {}}
      />,
    );
  });

  const block = host.firstElementChild as HTMLElement;
  const select = host.querySelector("select")!;
  // Found through the accessibility wiring rather than by class: the notice is
  // the control's first description, so a query that finds it is also a check
  // that a screen reader hears it before the standing hint.
  const described = select.getAttribute("aria-describedby")?.split(" ") ?? [];
  const notice =
    described.length > 1 ? document.getElementById(described[0]) : null;
  return {
    block,
    select,
    /** The notice, or null when nothing is being substituted. */
    notice,
    /** The sentence itself, inside the notice's glyph row. */
    sentence: notice?.querySelector<HTMLElement>(":scope > span") ?? null,
    /** Where something sits inside this mount, not on the page. */
    offsetOf: (el: Element) =>
      el.getBoundingClientRect().top - block.getBoundingClientRect().top,
  };
}

const height = (el: Element) => el.getBoundingClientRect().height;

describe("the substituted effort is visible in the control that owns it", () => {
  it("shows the stored value rather than nothing at all", () => {
    // The bug this fixes, measured in a real engine: a `<select>` whose value
    // matches no option renders BLANK, and every run meanwhile bills for the
    // substitute. jsdom agrees the value is set; only a real browser proves the
    // native control draws a selected option for it.
    const { select } = mount({ stored: "xhigh", sending: "high" });

    expect(select.value).toBe("xhigh");
    expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(select.options[select.selectedIndex].textContent).toBe("xhigh");
    // And it cannot be re-picked — sending it is what the backend refuses.
    expect(select.options[select.selectedIndex].disabled).toBe(true);
  });

  it("renders blank for no one: every variant of the menu keeps a selection", () => {
    // The discrimination check. The same menu with a stored value it DOES carry
    // must still select it, so the fix above cannot be a constant.
    const { select } = mount(null, SHRUNK);

    expect(select.value).toBe("");
    expect(select.options[select.selectedIndex].textContent).toBe(
      "Model default (high)",
    );
  });
});

describe("the notice holds a declared footprint", () => {
  /** Two lines of the notice's own type: 0.6875rem at `leading-snug`. The
   *  one-line figure is NOT 15.125 — a run of `nn-mono` on the same line has its
   *  own ascent and descent, and aligning two fonts on one baseline grows the
   *  line box to a measured 16.125. That is why this is a line-COUNT bound and
   *  not an equality: what matters is that neither sentence takes a second
   *  line. */
  const TWO_LINES = 2 * 11 * 1.375;

  it("is one line, and the same line whichever substitution is in force", () => {
    // The two sentences differ only by whether the model publishes a default —
    // nothing the user did — so they must not lay out differently. 85 and 88
    // characters, measured at the 578px the sentence actually gets.
    const named = mount({ stored: "xhigh", sending: "high" });
    const defaulted = mount(
      { stored: "xhigh", sending: null },
      { ...SHRUNK, defaultEffort: null },
    );

    expect(height(named.sentence!)).toBeLessThan(TWO_LINES);
    expect(height(defaulted.sentence!)).toBe(height(named.sentence!));
    expect(height(defaulted.notice!)).toBe(height(named.notice!));
  });

  it("never pushes the pane sideways, whatever the model called the effort", () => {
    // A provider token is a string we do not control, so the sentence has to
    // survive one longer than the column. `break-words` is what keeps that a
    // wrap rather than a scrollbar.
    const { notice, sentence } = mount({
      stored: "reasoning-effort-that-a-provider-published-without-asking-us",
      sending: "high",
    });

    expect(notice!.scrollWidth).toBeLessThanOrEqual(notice!.clientWidth);
    expect(sentence!.scrollWidth).toBeLessThanOrEqual(sentence!.clientWidth);
  });
});

describe("the absent case costs nothing, and the present one moves nothing", () => {
  it("renders no notice at all when nothing is being substituted", () => {
    const { notice } = mount(null);

    // Not an empty reserved slot — no element, no line, no height.
    expect(notice).toBeNull();
  });

  it("leaves every control where it was when the notice appears", () => {
    // The one thing an explanation must not do is move the thing it explains.
    // The notice sits under the control and above the standing hint, so the
    // block grows downward and nothing operable shifts.
    const quiet = mount(null);
    const substituted = mount({ stored: "xhigh", sending: "high" });

    // Each offset is taken inside its OWN mount, so this compares layout rather
    // than where two hosts happened to land on the page.
    expect(substituted.offsetOf(substituted.select)).toBe(
      quiet.offsetOf(quiet.select),
    );
    expect(height(substituted.select)).toBe(height(quiet.select));

    // And the growth is exactly the notice plus the block's own `gap-1.5`, so
    // nothing else silently changed size to make room for it.
    const grew = height(substituted.block) - height(quiet.block);
    expect(grew).toBeCloseTo(height(substituted.notice!) + 6, 1);
  });
});

/** One sRGB channel, linearised for WCAG's relative-luminance formula. */
function linearise(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Composite one element's text colour over the grounds behind it and return the
 *  WCAG contrast ratio.
 *
 *  Painted through a canvas rather than parsed by hand: a Tailwind alpha
 *  modifier resolves to `color-mix(in oklab, …)`, and `getComputedStyle` hands
 *  back an `oklab()` string whose components are 0–1 — read as 0–255 that is a
 *  wildly wrong ratio that can fake either verdict. Letting the engine both
 *  parse and composite it removes the arithmetic entirely. */
function contrast(el: HTMLElement, backdrop: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;

  const paint = (colours: string[], x: number) => {
    for (const colour of colours) {
      ctx.fillStyle = "#ff00ff";
      ctx.fillStyle = colour;
      // A colour the canvas could not parse leaves fillStyle untouched, which
      // would silently measure the sentinel instead. Catch that here.
      expect(ctx.fillStyle).not.toBe("#ff00ff");
      ctx.fillRect(x, 0, 1, 1);
    }
  };

  const grounds = [backdrop, getComputedStyle(el).backgroundColor];
  paint(grounds, 0);
  paint([...grounds, getComputedStyle(el).color], 1);

  const [ground, text] = [0, 1].map((x) => {
    const [r, g, b] = ctx.getImageData(x, 0, 1, 1).data;
    return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
  });
  const [light, dark] = text > ground ? [text, ground] : [ground, text];
  return (light + 0.05) / (dark + 0.05);
}

describe("the notice reads as prose, not as a failure", () => {
  it("meets AA on the card it sits in, body and values alike", () => {
    const { notice, sentence } = mount({ stored: "xhigh", sending: "high" });
    // The provider card's own ground: `bg-background/40` over the settings card.
    const card = getComputedStyle(document.body).getPropertyValue("--card").trim();

    expect(contrast(sentence!, card)).toBeGreaterThanOrEqual(4.5);
    const value = notice!.querySelector<HTMLElement>(".nn-mono")!;
    expect(contrast(value, card)).toBeGreaterThanOrEqual(4.5);
  });

  it("borrows no failure colour: the destructive channel stays unused", () => {
    const { notice } = mount({ stored: "xhigh", sending: "high" });

    // Tone is carried by the ground and by the type, never by hue. A user whose
    // model changed its menu has nothing to fix.
    expect(notice!.className).not.toMatch(/destructive|warning/);
    expect(notice!.getAttribute("role")).toBeNull();
  });
});
