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

/** One composer at the docked pane's width, in one of the two reasoning shapes.
 *  The host carries `px-4` itself so the strip gets exactly the width the
 *  shipped pane gives it. */
function mount(locked: boolean) {
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
        reasoningIndicatorOn
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
    // The hover and focus-visible rules belong to the control; a readout that
    // kept them would still answer the pointer like something pressable.
    expect(chip.className).not.toMatch(/hover:|focus-visible:/);
  });

  it("keeps the on colour and drops the two marks that read as a button", () => {
    // "Reasoning is on" must not look like two different facts depending on
    // whether the user chose it or the model gives no choice — so the accent
    // stays. What goes is the pill's fill and its ring, which is the app's own
    // way of saying "state" (Settings renders this same fact the same way).
    const optional = mount(false);
    const mandatory = mount(true);

    expect(getComputedStyle(mandatory.chip).color).toBe(
      getComputedStyle(optional.chip).color,
    );
    expect(getComputedStyle(optional.chip).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(mandatory.chip).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(optional.chip).boxShadow).not.toBe("none");
    expect(getComputedStyle(mandatory.chip).boxShadow).toBe("none");
  });

  it("carries the accent at AA on the pane it sits on", () => {
    // Dropping the pill also drops the fill this text used to sit on, so the
    // ground changed and the ratio has to be re-measured rather than inherited
    // from the chip's.
    const { chip } = mount(true);
    const pane = getComputedStyle(document.body)
      .getPropertyValue("--background")
      .trim();

    expect(contrastRatio(chip, pane)).toBeGreaterThanOrEqual(4.5);
  });
});
