// Real-browser hit test for the integrated titlebar's drag layer (issue #30).
//
// The jsdom test (`TitleBar.test.tsx`) proves the interactive controls are not
// DOM *descendants* of the `data-tauri-drag-region` layer — a structural check.
// But jsdom has no layout engine: `getBoundingClientRect()` is all-zeros and CSS
// stacking doesn't exist there, so a z-index regression that lifts the drag layer
// OVER the controls (making every titlebar button unclickable — it would drag the
// window instead of firing) stays invisible to jsdom.
//
// This runs the REAL <TitleBar/> in headless Chromium with the app's real Tailwind
// CSS, then asserts the actual rendered geometry: at the centre of the navigation
// toggle, the topmost element is the button — not the drag layer — and a real
// Playwright click (which performs actionability/interception checks) reaches the
// handler. Flip the drag layer's z-index above the clusters and both assertions
// fail. See vitest.browser.config.ts; runs on macOS and in CI, no native driver.

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TitleBar, type TitleBarProps } from "./TitleBar";
import "../styles.css";

// TitleBar's fullscreen effect calls getCurrentWindow() on macOS-UA runtimes
// (headless Chromium reports "Macintosh" locally). Stub the native window so the
// component mounts without a Tauri host; the returned chrome offset is irrelevant
// to the hit test.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => false,
    onResized: async () => () => {},
  }),
}));

const NAV_TOGGLE_LABEL = "Toggle navigation sidebar";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mountTitleBar(overrides: Partial<TitleBarProps> = {}): Promise<void> {
  const props: TitleBarProps = {
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

  // A fixed-width host so the titlebar grid lays out at a realistic window size.
  host = document.createElement("div");
  host.style.width = "900px";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<TitleBar {...props} />);
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
});
