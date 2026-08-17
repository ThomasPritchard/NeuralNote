// Real-browser proof that the welcome card stops growing as recent vaults
// accumulate (issue #164).
//
// This has to be measured, and jsdom cannot measure: every
// `getBoundingClientRect()` there is a rect of zeros, so "the card is taller
// than the window" and "the card fits the window" are the same reading, and a
// jsdom spec for this defect is green against the broken layout AND green
// against the fix. Here the real `Welcome` renders in headless Chromium through
// the app's own Tailwind pipeline and the question that settles it is asked
// directly: how tall is the card, and how much of that came from the recents?
//
// What is deliberately NOT asserted anywhere: a `max-height` value, a class
// name, or a row count that fits. The requirement is that the list scrolls
// instead of pushing the card past the window; a test pinned to `max-h-56`
// would rot the first time the cap was tuned and would still pass for a card
// that had merely traded the overflow for cropped padding.
//
// `lib/store` is mocked the same way `Welcome.test.tsx` mocks it — this screen
// reads everything it renders from `useVault`, and there is no Tauri here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));
vi.mock("../lib/store", () => ({ useVault: mockUseVault }));

import type { VaultContextValue } from "../lib/store";
import type { RecentVault } from "../lib/types";
import { Welcome } from "./Welcome";
import "../styles.css";

const POLL = { timeout: 5000, interval: 50 } as const;

/** The backend's own ceiling on this list, mirrored here as the worst case the
 *  view can ever be handed: `crates/neuralnote-core/src/recents.rs:11` declares
 *  `const MAX: usize = 12` and `:34` enforces it with `list.truncate(MAX)`. The
 *  defect reproduces INSIDE that cap, which is why the fix is a bounded,
 *  scrolling list and not a second cap in the view. */
const BACKEND_RECENTS_CAP = 12;

/** The count the "before" measurement is taken at — few enough that the list is
 *  nowhere near any ceiling, so the growth this test measures is the cost of the
 *  ten rows added on top of it. */
const A_FEW_RECENTS = 2;

/** How much of the ten added rows the card is allowed to absorb.
 *
 *  A share of what those rows actually measure, not a pixel count: what is under
 *  test is that the list stops growing the card, not that the cap is one
 *  particular value, and pinning the number would turn every future adjustment
 *  of it into a test edit. It is also the assertion that stops a fix which
 *  merely tightened the card's padding from counting — that card still pays for
 *  all ten rows and lands near 1.0 here. */
const MAX_SHARE_OF_ADDED_ROWS = 0.5;

/** `RecentList.tsx:58` draws the row's focus indicator with
 *  `focus-visible:ring-2`, and a Tailwind ring is painted OUTSIDE the button's
 *  border box. A scroll container flush against its own rows therefore clips
 *  that ring on the first and last row — which is a WCAG 2.4.11 failure that
 *  looks like nothing at all in a screenshot of an unfocused list. Measured as
 *  clearance, never read off a class name, so any way of buying the room
 *  (padding on the well, a padded wrapper) satisfies it. */
const FOCUS_RING_PX = 2;

/** `styles.css:1289` opens a `@media (max-height: 700px)` branch that reshapes
 *  the card's padding and gaps. Every measurement below is taken in the TALL
 *  branch on purpose; if the configured viewport ever drops under this, the
 *  numbers stop describing the window the bug was reported against. */
const SHORT_WINDOW_BRANCH_PX = 700;

function ctx(over: Partial<VaultContextValue> = {}): VaultContextValue {
  return {
    status: "welcome",
    vault: null,
    loaded: new Map(),
    expanded: new Set(),
    recents: [],
    error: null,
    clearError: vi.fn(),
    reportError: vi.fn(),
    refreshRecents: vi.fn().mockResolvedValue(undefined),
    openExisting: vi.fn().mockResolvedValue(undefined),
    openByPath: vi.fn().mockResolvedValue(undefined),
    pickNewLocation: vi.fn().mockResolvedValue(null),
    createVault: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue(undefined),
    toggle: vi.fn(),
    refreshDir: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

/** Recents at the shape the backend actually stores: a folder name and the
 *  absolute path it was opened from. The paths are long on purpose — the row
 *  truncates them, and a short fixture would quietly measure a row height the
 *  app never renders. */
function recentsOfLength(count: number): RecentVault[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Second Brain ${i + 1}`,
    path: `/Users/tom/Documents/Vaults/Second Brain ${i + 1}/notes`,
    lastOpened: count - i,
  }));
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  unmountWelcome();
});

function unmountWelcome(): void {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

/** `Welcome.tsx:70` is `h-full`, so it needs an ancestor with a definite height
 *  or the whole screen collapses and every rect below reads zero. Pinned to the
 *  window rather than a literal: the card fitting "the window" is the property
 *  under test, and a host sized independently of it would be measuring a
 *  viewport the app never runs at. */
async function mountWelcome(recents: RecentVault[]): Promise<void> {
  await document.fonts.ready;
  mockUseVault.mockReturnValue(ctx({ recents }));
  host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Welcome />);
  });
  await expect.poll(renderedRecentCount, POLL).toBe(recents.length);
}

/** A rect, with the vacuity guard attached: an element that rendered with no
 *  area fits inside anything, so every bound downstream of it would pass for the
 *  wrong reason. */
function rectOf(element: Element | null, what: string): DOMRect {
  if (element === null) throw new Error(`${what} did not render`);
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`${what} rendered with no area (${rect.width}x${rect.height})`);
  }
  return rect;
}

function describeRect(rect: DOMRect): string {
  return `[${Math.round(rect.left)},${Math.round(rect.top)} → ${Math.round(rect.right)},${Math.round(rect.bottom)}]`;
}

/** The card itself — the surface the issue says grows without bound. */
function cardRect(): DOMRect {
  return rectOf(host!.querySelector("main"), "the welcome card");
}

/** The recent-vault list, reached through its own heading rather than a class or
 *  a test id, so this keeps working through any restyling that leaves the
 *  section intact. */
function recentListElement(): HTMLElement | null {
  const heading = [...(host?.querySelectorAll("h2") ?? [])].find(
    (element) => element.textContent === "Recent",
  );
  return heading?.closest("section")?.querySelector("ul") ?? null;
}

function recentListRect(): DOMRect {
  return rectOf(recentListElement(), "the recent-vault list");
}

/** Every row, in DOM order. `aria-label="Open <name>"` is the row's own
 *  contract (`RecentList.tsx:57`) and what the jsdom suite already selects on. */
function recentRows(): HTMLElement[] {
  return [...(recentListElement()?.querySelectorAll<HTMLElement>('li > button[aria-label^="Open "]') ?? [])];
}

function renderedRecentCount(): number {
  return recentRows().length;
}

function rowRect(index: number): DOMRect {
  return rectOf(recentRows()[index] ?? null, `recent-vault row ${index + 1}`);
}

/** What one more remembered vault costs in height, taken from the rendered rows
 *  rather than assumed: row box plus the gap to the next one. */
function rowPitch(): number {
  const rows = recentRows();
  if (rows.length < 2) throw new Error("row pitch needs at least two rows");
  return rowRect(1).top - rowRect(0).top;
}

/** The premise every measurement here rests on. Asserted before anything is
 *  measured so that a fix which silently DROPPED recents — the thing the issue
 *  text wrongly suggests, given the backend already caps at 12 — fails loudly
 *  instead of sailing through the height bounds it would trivially satisfy. */
function expectTheFullListRendered(expected: number): void {
  expect(
    renderedRecentCount(),
    `the card must still render all ${expected} remembered vaults, not trim them`,
  ).toBe(expected);
  expect(window.innerHeight, "measured in the tall-window branch").toBeGreaterThan(
    SHORT_WINDOW_BRANCH_PX,
  );
}

describe("the welcome card with a full history of recent vaults", () => {
  it("fits the window at the backend's cap of remembered vaults", async () => {
    await mountWelcome(recentsOfLength(BACKEND_RECENTS_CAP));
    expectTheFullListRendered(BACKEND_RECENTS_CAP);

    const card = cardRect();
    expect(
      card.height,
      `the card is ${Math.round(card.height)}px in a ${window.innerHeight}px window`,
    ).toBeLessThanOrEqual(window.innerHeight);

    // The same statement from the side the user experiences. `Welcome.tsx:70`
    // centres the card in a scroll container, and a flex item centred inside a
    // container it overflows loses its top edge ABOVE the scroll origin — where
    // no gesture can reach it. Height alone would not see that.
    expect(card.top, `the card ${describeRect(card)} starts above the window`).toBeGreaterThanOrEqual(-1);
    expect(
      card.bottom,
      `the card ${describeRect(card)} ends below the ${window.innerHeight}px window`,
    ).toBeLessThanOrEqual(window.innerHeight + 1);
  });

  it("does not pay for every extra vault it remembers", async () => {
    await mountWelcome(recentsOfLength(A_FEW_RECENTS));
    expectTheFullListRendered(A_FEW_RECENTS);
    const shortCard = cardRect().height;
    unmountWelcome();

    await mountWelcome(recentsOfLength(BACKEND_RECENTS_CAP));
    expectTheFullListRendered(BACKEND_RECENTS_CAP);
    const fullCard = cardRect().height;

    // What the ten added rows measure on their own, read off the rendered list.
    // Anchoring the budget to this rather than to a pixel count is what makes
    // the assertion survive a change to the row's own padding or type scale.
    const addedRows = (BACKEND_RECENTS_CAP - A_FEW_RECENTS) * rowPitch();
    const growth = fullCard - shortCard;
    expect(
      growth,
      `${A_FEW_RECENTS} → ${BACKEND_RECENTS_CAP} vaults grew the card by ${Math.round(growth)}px, and the ten added rows measure ${Math.round(addedRows)}px`,
    ).toBeLessThanOrEqual(addedRows * MAX_SHARE_OF_ADDED_ROWS);
  });

  it("scrolls the list rather than the page, and loses no vault to the fold", async () => {
    await mountWelcome(recentsOfLength(BACKEND_RECENTS_CAP));
    expectTheFullListRendered(BACKEND_RECENTS_CAP);

    const list = recentListElement()!;
    // A ceiling that merely CLIPPED would satisfy every height bound above while
    // swallowing the vaults below the fold. The one that does not is a scroll
    // port: taller content than box, reachable by scrolling.
    expect(
      list.scrollHeight,
      "the recent list is not a scroll port, so vaults past its ceiling are cropped rather than reachable",
    ).toBeGreaterThan(list.clientHeight);

    // At rest it sits at the top, showing the most recently opened vault first —
    // a list that opened already scrolled would hide the one the user wants most
    // behind a gesture.
    const atRest = recentListRect();
    const first = rowRect(0);
    expect(
      first.top,
      `the newest vault ${describeRect(first)} starts above the list ${describeRect(atRest)}`,
    ).toBeGreaterThanOrEqual(atRest.top - 1);

    // Room for the row's focus ring at the head of the well.
    expect(
      first.top - atRest.top,
      `the first row leaves ${(first.top - atRest.top).toFixed(1)}px above it, less than the ${FOCUS_RING_PX}px focus ring`,
    ).toBeGreaterThanOrEqual(FOCUS_RING_PX);
    expect(first.left - atRest.left, "no room for the focus ring left of a row").toBeGreaterThanOrEqual(
      FOCUS_RING_PX,
    );
    expect(atRest.right - first.right, "no room for the focus ring right of a row").toBeGreaterThanOrEqual(
      FOCUS_RING_PX,
    );

    list.scrollTop = list.scrollHeight;
    await expect.poll(() => list.scrollTop, POLL).toBeGreaterThan(0);

    const scrolled = recentListRect();
    const last = rowRect(BACKEND_RECENTS_CAP - 1);
    expect(
      last.bottom,
      `the oldest vault ${describeRect(last)} stays below the scrolled list ${describeRect(scrolled)}`,
    ).toBeLessThanOrEqual(scrolled.bottom + 1);
    expect(
      scrolled.bottom - last.bottom,
      `the last row leaves ${(scrolled.bottom - last.bottom).toFixed(1)}px below it, less than the ${FOCUS_RING_PX}px focus ring`,
    ).toBeGreaterThanOrEqual(FOCUS_RING_PX);
  });

  it("brings a row below the fold into view when focus lands on it", async () => {
    await mountWelcome(recentsOfLength(BACKEND_RECENTS_CAP));
    expectTheFullListRendered(BACKEND_RECENTS_CAP);

    const rows = recentRows();
    const list = recentListElement()!;

    // Half the guarantee, stated structurally: every row is a native button
    // that nothing has taken out of the tab order. Deliberately NOT driven with
    // a real Tab press — whether Tab traverses buttons at all is a platform
    // preference rather than a property of this list. WebKit honours macOS
    // "Keyboard navigation", which is off by default, and a Tab from a focused
    // row lands on `<body>` there; measured on this file with the fix reverted,
    // it lands on `<body>` exactly the same way, so a Tab-driven spec would
    // report the engine's setting and never see a regression here.
    for (const [i, row] of rows.entries()) {
      expect(row.tagName, `recent-vault row ${i + 1} is not a native button`).toBe("BUTTON");
      expect(row.hasAttribute("tabindex"), `row ${i + 1} overrides the tab order`).toBe(false);
      expect(row.hasAttribute("disabled"), `row ${i + 1} is disabled`).toBe(false);
    }

    // The other half, which IS this list's to get wrong: once focus reaches a
    // row past the fold, the well brings it into view. A ceiling built with
    // `overflow: hidden` satisfies every height bound in this file and leaves a
    // keyboard user focused on a row nobody can see.
    rows.at(-1)!.focus();
    expect(document.activeElement, "the last row did not take focus").toBe(rows.at(-1));
    await expect
      .poll(() => {
        const listBox = recentListRect();
        const focused = rowRect(BACKEND_RECENTS_CAP - 1);
        return focused.top >= listBox.top - 1 && focused.bottom <= listBox.bottom + 1;
      }, POLL)
      .toBe(true);
    expect(list.scrollTop, "the list never scrolled to reveal the focused row").toBeGreaterThan(0);
  });
});
