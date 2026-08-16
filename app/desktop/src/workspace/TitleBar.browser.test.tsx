// Real-browser hit test for the integrated titlebar's drag layer (issue #30).
//
// The jsdom test (`TitleBar.test.tsx`) proves the interactive controls are not
// DOM *descendants* of the `data-tauri-drag-region` layer — a structural check.
// But jsdom has no layout engine: `getBoundingClientRect()` is all-zeros and CSS
// stacking doesn't exist there, so a z-index regression that lifts the drag layer
// OVER the controls (making every titlebar button unclickable — it would drag the
// window instead of firing) stays invisible to jsdom.
//
// This runs the REAL <TitleBar/> in a headless engine (Chromium or WebKit — the
// shipped app is WKWebView, so the WebKit lane is the one that counts) with the
// app's real Tailwind CSS, then asserts the actual rendered geometry: at the
// centre of the navigation toggle, the topmost element is the button — not the
// drag layer — and a real Playwright click (which performs actionability /
// interception checks) reaches the handler. Flip the drag layer's z-index above
// the clusters and both assertions fail. The suite at the bottom of this file
// adds the offset geometry of issue #135 on top of that hit test.
// See vitest.browser.config.ts; runs on macOS and in CI, no native driver.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TitleBar, type TitleBarProps } from "./TitleBar";
import { NAVIGATION_COMPACT_WIDTH } from "./workspaceLayout";
import "../styles.css";

// TitleBar's fullscreen effect calls getCurrentWindow() on macOS-UA runtimes
// (headless Chromium reports "Macintosh" locally). Stub the native window so the
// component mounts without a Tauri host. The drag-layer hit tests below don't
// care what offset comes back; the first-paint geometry suite at the bottom of
// this file does, and drives `isFullscreen` through a promise it resolves by
// hand — hence a controllable mock rather than a fixed literal.
const nativeWindow = vi.hoisted(() => ({
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<(handler: () => void) => Promise<() => void>>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => nativeWindow,
}));

const NAV_TOGGLE_LABEL = "Toggle navigation sidebar";

let root: Root | null = null;
let host: HTMLElement | null = null;
let stopFrameRecorder: (() => void) | null = null;

beforeEach(() => {
  nativeWindow.isFullscreen.mockReset();
  nativeWindow.isFullscreen.mockResolvedValue(false);
  nativeWindow.onResized.mockReset();
  nativeWindow.onResized.mockResolvedValue(() => {});
});

afterEach(() => {
  stopFrameRecorder?.();
  stopFrameRecorder = null;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  // Own userAgent property only exists if a test stubbed one; `delete` on an
  // absent own property is a no-op and leaves the prototype getter in place.
  delete (navigator as { userAgent?: string }).userAgent;
});

function titleBarProps(overrides: Partial<TitleBarProps> = {}): TitleBarProps {
  return {
    navigationExpanded: false,
    onToggleNavigation: () => {},
    chatOpen: false,
    onToggleChat: () => {},
    onOpenSettings: () => {},
    tabs: [],
    activeTabId: null,
    activeView: "note",
    onActivateTab: () => {},
    onCloseTab: () => {},
    onCloseGraph: () => {},
    ...overrides,
  };
}

/** A fixed-width host so the titlebar grid lays out at a realistic window size. */
function createHost(hostVars: Readonly<Record<string, string>> = {}): HTMLElement {
  const element = document.createElement("div");
  element.style.width = "900px";
  element.style.height = "48px";
  for (const [name, value] of Object.entries(hostVars)) {
    element.style.setProperty(name, value);
  }
  document.body.appendChild(element);
  return element;
}

async function mountTitleBar(overrides: Partial<TitleBarProps> = {}): Promise<void> {
  await document.fonts.ready;
  host = createHost();
  root = createRoot(host);
  await act(async () => {
    root!.render(<TitleBar {...titleBarProps(overrides)} />);
  });
  // The button must have real, non-zero geometry before we hit-test it.
  await expect
    .poll(() => document.querySelector<HTMLElement>(`[aria-label="${NAV_TOGGLE_LABEL}"]`)?.getBoundingClientRect().width ?? 0)
    .toBeGreaterThan(0);
}

describe("TitleBar — real-browser drag-layer hit test", () => {
  it("puts the navigation toggle above the drag layer (topmost at its centre)", async () => {
    await mountTitleBar();

    const button = document.querySelector<HTMLElement>(`[aria-label="${NAV_TOGGLE_LABEL}"]`);
    const dragLayer = document.querySelector<HTMLElement>("[data-tauri-drag-region]");
    expect(button, "navigation toggle should render").not.toBeNull();
    expect(dragLayer, "drag region should render").not.toBeNull();

    const rect = button!.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const topmost = document.elementFromPoint(cx, cy);

    // The element under the pointer at the button's centre must be the button
    // (or its icon), never the drag layer. If the drag layer intercepts here,
    // clicks move the window instead of toggling the sidebar.
    expect(button!.contains(topmost) || topmost === button).toBe(true);
    expect(dragLayer!.contains(topmost)).toBe(false);
    expect(topmost).not.toBe(dragLayer);
  });

  it("delivers a real click to the navigation toggle (Playwright actionability)", async () => {
    const onToggleNavigation = vi.fn();
    await mountTitleBar({ onToggleNavigation });

    // userEvent.click runs Playwright's actionability checks and clicks at the
    // element's centre point — it THROWS "intercepts pointer events" if the drag
    // layer (or anything) covers the button. Reaching the handler proves the
    // control is genuinely hittable in real layout.
    await userEvent.click(page.getByRole("button", { name: NAV_TOGGLE_LABEL }));

    expect(onToggleNavigation).toHaveBeenCalledTimes(1);
  });

  it("keeps note tabs, close, chat, and settings controls above the drag layer", async () => {
    const onActivateTab = vi.fn();
    const onCloseTab = vi.fn();
    const onToggleChat = vi.fn();
    const onOpenSettings = vi.fn();
    await mountTitleBar({
      tabs: [{
        id: "daily",
        title: "Daily",
        path: "/vault/Daily.md",
        dirty: false,
        loading: false,
        error: null,
      }],
      activeTabId: "daily",
      onActivateTab,
      onCloseTab,
      onToggleChat,
      onOpenSettings,
    });

    await userEvent.click(page.getByRole("tab", { name: "Daily" }));
    await userEvent.click(page.getByRole("button", { name: "Close Daily" }));
    await userEvent.click(page.getByRole("button", { name: "Toggle chat panel" }));
    await userEvent.click(page.getByRole("button", { name: "Settings" }));

    expect(onActivateTab).toHaveBeenCalledWith("daily");
    expect(onCloseTab).toHaveBeenCalledWith("daily");
    expect(onToggleChat).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const close = document.querySelector<HTMLElement>('[aria-label="Close Daily"]')!;
    expect(close.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    const keyboardFocused = document.activeElement as HTMLElement;
    expect(document.querySelector(".nn-titlebar")?.contains(keyboardFocused)).toBe(true);
    expect(getComputedStyle(keyboardFocused).boxShadow).not.toBe("none");
  });

  it("leaves the empty chrome above the tab strip available as a drag region", async () => {
    await mountTitleBar();
    const titlebar = document.querySelector<HTMLElement>(".nn-titlebar")!;
    const tabStrip = document.querySelector<HTMLElement>(".nn-tab-strip")!;
    const dragLayer = document.querySelector<HTMLElement>("[data-tauri-drag-region]")!;
    const titlebarRect = titlebar.getBoundingClientRect();
    const tabStripRect = tabStrip.getBoundingClientRect();

    expect(tabStripRect.top).toBeGreaterThan(titlebarRect.top);
    const emptyChrome = document.elementFromPoint(
      tabStripRect.left + tabStripRect.width / 2,
      titlebarRect.top + (tabStripRect.top - titlebarRect.top) / 2,
    );

    expect(emptyChrome).toBe(dragLayer);
  });
});

// ---------------------------------------------------------------------------
// Issue #135 — first-paint geometry of the traffic-light offset.
//
// `TitleBar.test.tsx` covers the same three states in jsdom, but that tier runs
// with `css: false` and has no layout engine: `getBoundingClientRect()` is
// all-zeros and no Tailwind rule is ever parsed, so those assertions are on
// CLASS NAMES. They prove the component chose a class; they cannot prove the
// button ends up 74px or 12px from the window edge, nor that "invisible"
// actually removes it from view. That is what this suite adds — and it is the
// replacement evidence for a hands-on observation of the real first frame,
// which is not obtainable on this machine (macOS does not restore fullscreen on
// relaunch here, and full-display capture is not an acceptable instrument).
//
// The load-bearing invariant, and the reason the frame recorder exists: NOTHING
// IS EVER PAINTED AT AN OFFSET THAT LATER CHANGES. A two-state boolean cannot
// satisfy that in both populations — whichever way it guesses, the other launch
// state paints one offset and then moves to the other — so reverting
// `useMacOSFullscreenState` to `useState(false)` (or `useState(true)`) reddens
// this suite.
// ---------------------------------------------------------------------------

// The two padding values on the offset-dependent left cluster (`pl-[74px]` /
// `pl-[12px]` in TitleBar.tsx), measured from the header's left edge.
const WINDOWED_TOGGLE_OFFSET = 74;
const FULLSCREEN_TOGGLE_OFFSET = 12;
// `--titlebar-toggle-clearance` from the two `.nn-titlebar-toggle-clearance-*`
// classes in styles.css. It is the second term of the `max()` that sizes the
// grid column carrying the cluster, so it is measurable as the tab strip's left
// edge — the class is real geometry, not just a name.
const WINDOWED_CLEARANCE = 122;
const FULLSCREEN_CLEARANCE = 60;

// Navigation compacted, sidebar panel closed — a real shipped state
// (`deriveEffectiveWorkspaceLayout` returns sidebarWidth 0 / splitterWidth 0
// with no panel open). It matters here because it makes the clearance the
// governing term of `max(nav + sidebar + splitter, clearance)`: with the
// defaults from :root the sum is 496px and the clearance could never be seen.
const COMPACT_SHELL_VARS = {
  "--navigation-width": `${NAVIGATION_COMPACT_WIDTH}px`,
  "--sidebar-width": "0px",
  "--splitter-width": "0px",
} as const;

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const NON_MACOS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)";

// `isMacOSRuntime()` is a plain UA regex, so the platform branch is selectable.
// Stub it explicitly rather than inheriting the runner's own UA: headless
// Chromium reports "Macintosh" on this machine but not on a Linux CI lane, and
// a suite whose branch depends on where it runs proves nothing on either.
function stubUserAgent(value: string): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value });
}

function navToggle(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${NAV_TOGGLE_LABEL}"]`);
}

function titlebarElement(): HTMLElement {
  return document.querySelector<HTMLElement>(".nn-titlebar")!;
}

/** The toggle's left edge relative to the header's — i.e. the rendered offset. */
function toggleOffset(): number {
  return navToggle()!.getBoundingClientRect().left - titlebarElement().getBoundingClientRect().left;
}

/** The tab strip's left edge — the width the clearance gave the first grid column. */
function clearanceColumnWidth(): number {
  const strip = document.querySelector<HTMLElement>(".nn-tab-strip")!;
  return strip.getBoundingClientRect().left - titlebarElement().getBoundingClientRect().left;
}

// Which property "not visible" is asserted on, and why:
//
//   `visibility` — because the held state is `visibility: hidden` (Tailwind's
//   `invisible`), which DELIBERATELY keeps the layout box. Asserting a zero
//   width or a missing element would be asserting the wrong design: the box has
//   to stay, so `getBoundingClientRect()` is non-zero in exactly the state we
//   are calling "not visible". Computed visibility is the property the design
//   actually turns, and unlike jsdom (`css: false`) this tier has parsed the
//   real stylesheet, so `getComputedStyle` has a rule to resolve.
//
//   Backed by a hit test — `document.elementFromPoint` at the toggle's own
//   centre must not land on the toggle. A `visibility: hidden` subtree is
//   skipped for hit-testing, so this is an independent, engine-level check that
//   the user cannot reach the control, not a second read of the same string.
function toggleVisibility(): string {
  return getComputedStyle(navToggle()!).visibility;
}

function toggleIsHitTestable(): boolean {
  const toggle = navToggle()!;
  const rect = toggle.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit === toggle || toggle.contains(hit);
}

interface OffsetFrame {
  visibility: string;
  offset: number;
}

/**
 * Samples the toggle once per animation frame. A rAF callback runs after style
 * and layout are settled for the frame that is about to paint, so every sample
 * is a frame the user could have seen. Start it BEFORE mounting: it is the only
 * instrument here that can see frames the test never explicitly stopped at.
 */
function recordOffsetFrames(): OffsetFrame[] {
  const frames: OffsetFrame[] = [];
  let running = true;
  const tick = () => {
    if (!running) return;
    if (navToggle()) {
      frames.push({ visibility: toggleVisibility(), offset: Math.round(toggleOffset()) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  stopFrameRecorder = () => {
    running = false;
  };
  return frames;
}

/** Every distinct offset the toggle was ever PAINTED at, in the order first seen. */
function paintedOffsets(frames: readonly OffsetFrame[]): number[] {
  return [
    ...new Set(frames.filter((frame) => frame.visibility === "visible").map((frame) => frame.offset)),
  ];
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleFrames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) await nextFrame();
}

/**
 * Renders with a SYNCHRONOUS `act`, so the statement after it observes the
 * first committed frame. `await act(async …)` — what `mountTitleBar` above uses
 * — flushes the microtask that resolves the native query, which is precisely
 * the frame these tests exist to look at.
 */
async function mountTitleBarAtFirstPaint(
  hostVars: Readonly<Record<string, string>> = COMPACT_SHELL_VARS,
): Promise<void> {
  await document.fonts.ready;
  host = createHost(hostVars);
  root = createRoot(host);
  act(() => {
    root!.render(<TitleBar {...titleBarProps()} />);
  });
}

/** Holds `isFullscreen()` open until the returned function is called. */
function deferFullscreenQuery(): (value: boolean) => void {
  let resolveQuery!: (value: boolean) => void;
  nativeWindow.isFullscreen.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      resolveQuery = resolve;
    }),
  );
  return (value) => resolveQuery(value);
}

describe("TitleBar — first-paint traffic-light offset (measured geometry)", () => {
  it("paints no toggle at all while the native fullscreen query is still pending", async () => {
    stubUserAgent(MACOS_USER_AGENT);
    const resolveQuery = deferFullscreenQuery();
    const frames = recordOffsetFrames();
    await mountTitleBarAtFirstPaint();

    // Frame one. Nothing has been awaited that could settle the query, and the
    // promise is ours, so the component is still in "unknown".
    expect(nativeWindow.isFullscreen).toHaveBeenCalledOnce();
    expect(toggleVisibility()).toBe("hidden");
    expect(toggleIsHitTestable()).toBe(false);

    // The layout box is still reserved — this is the design, so assert it
    // rather than assert a zero width the fix deliberately does not produce.
    const rect = navToggle()!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);

    await settleFrames();
    stopFrameRecorder?.();

    // The instrument ran (a recorder that never fired would pass vacuously)…
    expect(frames.length).toBeGreaterThan(0);
    // …and across every frame it saw, the toggle was never painted anywhere.
    expect(paintedOffsets(frames)).toEqual([]);

    resolveQuery(false);
  });

  it("reveals the toggle at the tight fullscreen offset, never at the wide one", async () => {
    stubUserAgent(MACOS_USER_AGENT);
    const resolveQuery = deferFullscreenQuery();
    const frames = recordOffsetFrames();
    await mountTitleBarAtFirstPaint();

    expect(toggleVisibility()).toBe("hidden");
    await settleFrames();

    await act(async () => {
      resolveQuery(true);
    });
    await expect.poll(toggleVisibility).toBe("visible");
    await settleFrames();
    stopFrameRecorder?.();

    expect(toggleOffset()).toBe(FULLSCREEN_TOGGLE_OFFSET);
    expect(clearanceColumnWidth()).toBe(FULLSCREEN_CLEARANCE);
    expect(toggleIsHitTestable()).toBe(true);

    // The whole point: the ONLY offset ever painted is the final one. A boolean
    // defaulting to windowed would put 74 in this list before 12.
    expect(frames.length).toBeGreaterThan(0);
    expect(paintedOffsets(frames)).toEqual([FULLSCREEN_TOGGLE_OFFSET]);
  });

  it("reveals the toggle at the wide windowed offset, and nothing moves when it does", async () => {
    stubUserAgent(MACOS_USER_AGENT);
    const resolveQuery = deferFullscreenQuery();
    const frames = recordOffsetFrames();
    await mountTitleBarAtFirstPaint();

    expect(toggleVisibility()).toBe("hidden");
    // The held box already sits where the answer will put it, and the header's
    // clearance is pinned to windowed throughout "unknown" — so this launch
    // state resolves with zero movement, only a reveal.
    const heldOffset = toggleOffset();
    const heldColumn = clearanceColumnWidth();
    await settleFrames();

    await act(async () => {
      resolveQuery(false);
    });
    await expect.poll(toggleVisibility).toBe("visible");
    await settleFrames();
    stopFrameRecorder?.();

    expect(toggleOffset()).toBe(WINDOWED_TOGGLE_OFFSET);
    expect(clearanceColumnWidth()).toBe(WINDOWED_CLEARANCE);
    expect(toggleOffset()).toBe(heldOffset);
    expect(clearanceColumnWidth()).toBe(heldColumn);
    expect(toggleIsHitTestable()).toBe(true);

    expect(frames.length).toBeGreaterThan(0);
    expect(paintedOffsets(frames)).toEqual([WINDOWED_TOGGLE_OFFSET]);
  });

  it("paints the toggle immediately at the wide offset off macOS, with no held frame", async () => {
    stubUserAgent(NON_MACOS_USER_AGENT);
    const frames = recordOffsetFrames();
    await mountTitleBarAtFirstPaint();

    // Frame one, and there is no async path to wait for: `isMacOSRuntime()` is
    // false, so the state initialises to "windowed" during render and no IPC is
    // attempted at all.
    expect(nativeWindow.isFullscreen).not.toHaveBeenCalled();
    expect(toggleVisibility()).toBe("visible");
    expect(toggleOffset()).toBe(WINDOWED_TOGGLE_OFFSET);
    expect(clearanceColumnWidth()).toBe(WINDOWED_CLEARANCE);
    expect(toggleIsHitTestable()).toBe(true);

    await settleFrames();
    stopFrameRecorder?.();

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.visibility === "hidden")).toBe(false);
    expect(paintedOffsets(frames)).toEqual([WINDOWED_TOGGLE_OFFSET]);
  });
});
