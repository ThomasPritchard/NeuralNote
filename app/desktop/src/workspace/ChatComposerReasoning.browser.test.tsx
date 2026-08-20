// Real-browser proof that swapping the composer's reasoning affordance between
// its two shapes costs the strip nothing.
//
// The shapes are mutually exclusive and the switch between them is AMBIENT — it
// happens when the model changes underneath the user, not when the user clicks
// something — so a footprint that moved would be a jolt at the bottom edge of a
// pane whose transcript is pinned to it. jsdom cannot see any of that: every
// rect there is zeros, so "the strip is the same height" is trivially true
// against the fix AND against a strip that grew a line.
//
// Measured at the docked pane's own meta-strip width, derived from the tokens:
// `--chat-width` is 25.5rem at this viewport (the ≤1280px tier), the composer
// pads it `px-4` and the strip `px-1`.

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

import "../styles.css";
import { contrastRatio } from "../test/contrast";
import type { AiStatus, ReasoningControl } from "../lib/types";
import { ChatComposer } from "./ChatComposer";

/** 25.5rem (the ≤1280px `--chat-width` tier) − 2×16 (the composer's `px-4`). */
const STRIP_WIDTH = 25.5 * 16 - 32;

const CONTROLS: Record<"toggle" | "locked", ReasoningControl> = {
  toggle: { kind: "toggle", defaultOn: false },
  locked: { kind: "locked" },
};

function status(): AiStatus {
  return {
    activeProvider: "openRouter",
    reasoningSupported: "supported",
    reasoningControl: CONTROLS.toggle,
    openrouter: {
      hasKey: true,
      model: "deepseek/deepseek-v4-flash",
      reasoning: true,
      reasoningEffort: null,
    },
    local: { activeModelTag: null },
    approval: {
      mode: "alwaysAsk",
      toolOverrides: {},
      effectiveModes: {},
      classifierAvailable: true,
      irreversibleActions: [],
    },
  };
}

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

/** The opaque surface the composer actually sits on. The pane is
 *  `<aside class="… bg-sidebar">` and neither the footer nor the strip paints
 *  anything of its own, so `--sidebar` — not `--background` — is the ground
 *  every ratio below composites against. They are 0.29 and 0.277 in oklch
 *  lightness, which is worth 0.2 of a contrast ratio: enough to move a
 *  borderline chip across AA in the wrong direction. */
const pane = () =>
  getComputedStyle(document.body).getPropertyValue("--sidebar").trim();

/** One composer at the docked pane's width, in one of the two reasoning shapes.
 *  The host carries `px-4` itself so the strip gets exactly the width the
 *  shipped pane gives it. */
function mount(locked: boolean, on = true) {
  const host = document.createElement("div");
  host.style.width = `${25.5 * 16}px`;
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ host, root });

  act(() => {
    root.render(
      <ChatComposer
        stopError={null}
        reasoningError={null}
        activeSkills={[]}
        onRemoveSkill={() => {}}
        pickerOpen={false}
        suggestions={[]}
        pickerNotice={null}
        pickerActive={0}
        onPickSkill={() => {}}
        onHoverSkill={() => {}}
        composerRef={createRef()}
        composerActionRef={createRef()}
        input=""
        busy={false}
        stopping={false}
        onInputChange={() => {}}
        onComposerKeyDown={() => {}}
        syncCaret={() => {}}
        onComposerBlur={() => {}}
        onComposerFocus={() => {}}
        onSend={() => {}}
        onCancel={() => {}}
        status={status()}
        onStatusChange={() => {}}
        onOpenSettings={() => {}}
        onToggleReasoning={() => {}}
        savingReasoning={false}
        capability={{ disabled: false, reason: null }}
        reasoningIndicatorOn={on}
        reasoningLocked={locked}
        reasoningReasonId="reason"
      />,
    );
  });

  // The readout has no role and no label to query by — that is the point of it —
  // so it is found through the qualifier that makes it a statement.
  const qualifier = [...host.querySelectorAll("span")].find(
    (span) => span.textContent === ", always on",
  );
  const chip = locked
    ? qualifier!.parentElement!
    : host.querySelector<HTMLElement>("button[aria-label='Show model reasoning']")!;
  return {
    /** The meta strip: the chip's grandparent (chip → left group → strip). */
    strip: chip.parentElement!.parentElement!,
    chip,
    footer: host.firstElementChild as HTMLElement,
  };
}

const height = (el: Element) => el.getBoundingClientRect().height;

/** The colour a Tailwind `ring-*` reaches the DOM as. Tailwind lays a fixed
 *  stack of box-shadow slots and leaves the ones it is not using at
 *  `rgba(0, 0, 0, 0)`, so the ring is the first slot that would actually paint.
 *  If that serialisation ever changes this picks the wrong slot and the caller
 *  goes red, which is the right direction for a probe to fail in. */
function ringColour(el: Element): string {
  const layers =
    getComputedStyle(el).boxShadow.match(/(?:oklch|oklab|rgba?|color)\([^)]*\)/g) ?? [];
  return layers.find((colour) => colour !== "rgba(0, 0, 0, 0)") ?? "";
}

describe("the two reasoning shapes share one footprint", () => {
  it("does not move the composer when the model turns out to be mandatory", () => {
    // The model can change underneath the user (a menu picked elsewhere, a
    // status poll), so this transition is not one anybody clicked for.
    const optional = mount(false);
    const mandatory = mount(true);

    expect(height(mandatory.chip)).toBe(height(optional.chip));
    expect(height(mandatory.strip)).toBe(height(optional.strip));
    expect(height(mandatory.footer)).toBe(height(optional.footer));
  });

  it("costs the strip no width at the docked pane", () => {
    // The strip is full: 376px already holds the model menu, the chip and a
    // keyboard hint. A readout even one word wider does not push its neighbours
    // aside, it wraps its own pill onto three lines — measured at 49px against
    // the chip's 19px, which is why this shape says what it says in the
    // accessible name instead.
    const { strip, chip } = mount(true);

    expect(strip.getBoundingClientRect().width).toBeCloseTo(STRIP_WIDTH, 0);
    expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
    // One line of the readout's own type, not three. (The strip itself is 24.5px
    // in both shapes — the model menu's `py-1` governs it, not this.)
    expect(height(chip)).toBeLessThan(2 * 10 * 1.5);
  });
});

describe("the readout is a state, and looks like one", () => {
  it("takes no tab stop and offers no hover response", () => {
    const { chip } = mount(true);

    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("tabindex")).toBeNull();
    expect(getComputedStyle(chip).cursor).toBe("default");
    // The other half of that sentence, which was not true until the control
    // asked for the cursor: Tailwind v4 gives a `<button>` `cursor: default`
    // too, so "no hand cursor" drew no distinction at all on its own.
    expect(getComputedStyle(mount(false, true).chip).cursor).toBe("pointer");
    // The hover and focus-visible rules belong to the control; a readout that
    // kept them would still answer the pointer like something pressable.
    expect(chip.className).not.toMatch(/hover:|focus-visible:/);
  });

  it("keeps the on colour and drops the mark that reads as a button", () => {
    // "Reasoning is on" must not look like two different facts depending on
    // whether the user chose it or the model gives no choice — so the accent
    // stays. What goes is the ring, which is the app's own way of saying
    // "state" (Settings renders this same fact the same way).
    const optional = mount(false);
    const mandatory = mount(true);

    expect(getComputedStyle(mandatory.chip).color).toBe(
      getComputedStyle(optional.chip).color,
    );
    expect(getComputedStyle(optional.chip).boxShadow).not.toBe("none");
    expect(getComputedStyle(mandatory.chip).boxShadow).toBe("none");
  });
});

describe("the accent is legible in every shape the strip renders", () => {
  // The defect this pins: the on chip used to sit on a `bg-primary/10` tint,
  // which lifted the ground under 10px `text-primary` to 4.18:1 — under AA, and
  // measured against the pane rather than the nominal page background, which is
  // how it read 4.37:1 and got waved through twice.
  it("clears AA in all three states", () => {
    const off = mount(false, false);
    const on = mount(false, true);
    const mandatory = mount(true);

    // off 7.30:1, on 4.82:1, readout 4.82:1 — measured against `--sidebar`.
    expect(contrastRatio(off.chip, pane())).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(on.chip, pane())).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mandatory.chip, pane())).toBeGreaterThanOrEqual(4.5);
  });

  it("puts no fill under the accent in any state", () => {
    // The mechanism, not the symptom. A fill is the only thing that can change
    // the ground under this text, so "there is no fill" is what keeps the
    // ratios above from needing a re-measurement every time someone restyles
    // the chip. The off chip may fill on hover; its text lightens with it.
    for (const chip of [mount(false, false), mount(false, true), mount(true)]) {
      expect(getComputedStyle(chip.chip).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
  });

  it("keeps AA with the pointer on the on chip", async () => {
    // A hover ground is a ground, and the rest-state assertions above cannot
    // see it. `hover:bg-muted` — what the off chip and the model menu beside it
    // both use — measures 4.36:1 under this accent, so the on chip darkens
    // rather than lightening.
    const on = mount(false, true);
    const rest = contrastRatio(on.chip, pane());
    // `transition-colors` means the first frame after the pointer arrives still
    // holds the START value, and it does not serialise as the rest value either
    // — it comes back `oklab(0 0 0 / 0)` where the rest state is
    // `rgba(0, 0, 0, 0)`. Reading it live measured a transparent ground and
    // called the chip legible with `hover:bg-muted` underneath it. Take the
    // rule's target instead of racing the animation.
    on.chip.style.transition = "none";
    await userEvent.hover(on.chip);

    // Not a string comparison against a serialisation: a ground that moved is
    // a ground that painted, which is the only proof that the utility emits CSS
    // at all. A Tailwind v4 class that resolves to nothing looks exactly like
    // one that resolves to the right thing.
    expect(contrastRatio(on.chip, pane())).not.toBeCloseTo(rest, 2);
    expect(contrastRatio(on.chip, pane())).toBeGreaterThanOrEqual(4.5);
  });

  it("draws the control's boundary in the same accent as the word", () => {
    // A boundary is non-text information (WCAG 1.4.11, 3:1). Rather than assert
    // a second number, tie the ring to the text: same colour, so the 4.82:1
    // above IS the ring's ratio. It goes red on any re-alpha — `ring-primary/30`
    // measured 1.63:1 and `/60` 2.66:1 against this pane.
    const on = mount(false, true);

    expect(ringColour(on.chip)).toBe(getComputedStyle(on.chip).color);
  });
});
