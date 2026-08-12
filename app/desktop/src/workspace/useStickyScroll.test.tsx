// `useStickyScroll`'s state machine, driven against a stubbed layout.
//
// Read the boundary honestly: jsdom has no layout engine, so `scrollHeight`,
// `clientHeight` and `scrollTop` mean nothing there. Every one of them is
// stubbed below with a small, faithful model (a clamping `scrollTop`, a
// re-clamp when the content shrinks), which is enough to prove the DECISIONS —
// pin, release, re-pin, hold — and proves nothing at all about real geometry.
// The geometry is proven in a real engine by `ChatPaneScroll.browser.test.tsx`,
// which is the test this phase exists for.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickyScroll } from "./useStickyScroll";

const PORT_HEIGHT = 300;

// ── A controllable ResizeObserver (the global stub in test/setup.ts is inert) ──
let observed: ResizeObserverCallback[] = [];

class ControllableResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observed.push(callback);
  }
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {
    observed = observed.filter((cb) => cb !== this.callback);
  };
}

/** Deliver a resize to every live observer, as the browser would after growth. */
function fireResize(): void {
  act(() => {
    for (const callback of observed) {
      callback([], undefined as unknown as ResizeObserver);
    }
  });
}

/** Two animation frames — the window the `<details>` hold spans. */
async function advanceFrames(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

// ── A minimal, clamping layout model for the scroll port ──
interface Layout {
  setScrollHeight: (next: number) => void;
  scrollToCalls: ScrollToOptions[];
}

function installLayout(el: HTMLElement, scrollHeight: number): Layout {
  let height = scrollHeight;
  let top = el.scrollTop;
  const maxTop = () => Math.max(0, height - PORT_HEIGHT);
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => PORT_HEIGHT });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = Math.min(Math.max(0, next), maxTop());
    },
  });
  const scrollToCalls: ScrollToOptions[] = [];
  // jsdom has no Element.scrollTo at all; the smooth path needs one to exist.
  Object.defineProperty(el, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      scrollToCalls.push(options);
      top = Math.min(Math.max(0, options.top ?? 0), maxTop());
    },
  });
  return {
    setScrollHeight: (next: number) => {
      height = next;
      top = Math.min(top, maxTop()); // the browser clamps when content shrinks
    },
    scrollToCalls,
  };
}

function Harness({ turnCount }: Readonly<{ turnCount: number }>) {
  const { containerRef, contentRef, showJump, jumpToLatest } = useStickyScroll({
    turnCount,
  });
  return (
    <div>
      <div ref={containerRef} data-testid="port">
        <div ref={contentRef}>
          <details data-testid="fold">
            <summary>More</summary>
            <p>body</p>
          </details>
        </div>
      </div>
      {showJump && (
        <button type="button" aria-label="Jump to latest" onClick={jumpToLatest}>
          Latest
        </button>
      )}
    </div>
  );
}

/** Mount the harness, install the layout, and settle at the bottom. */
function mountPinned(scrollHeight = 1000) {
  const view = render(<Harness turnCount={1} />);
  const port = screen.getByTestId("port");
  const layout = installLayout(port, scrollHeight);
  fireResize();
  return { view, port, layout };
}

/** A user scroll to `top` — the scroll event the browser would emit. */
function userScrollTo(port: HTMLElement, top: number): void {
  port.scrollTop = top;
  fireEvent.scroll(port);
}

const jumpControl = () => screen.queryByRole("button", { name: "Jump to latest" });

beforeEach(() => {
  observed = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useStickyScroll", () => {
  it("pins to the bottom and follows content as it grows", () => {
    const { port, layout } = mountPinned();
    expect(port.scrollTop).toBe(700);

    layout.setScrollHeight(1600);
    fireResize();

    expect(port.scrollTop).toBe(1300);
    expect(jumpControl()).not.toBeInTheDocument();
  });

  it("re-pins inside the commit, without waiting for the observer", () => {
    const { view, port, layout } = mountPinned();
    expect(port.scrollTop).toBe(700);

    // The transcript grows and re-renders; no resize is delivered. The observer
    // is a frame behind by construction, and a pin that only exists inside it
    // leaves a window the engine can move `scrollTop` in on its own.
    layout.setScrollHeight(1600);
    view.rerender(<Harness turnCount={1} />);

    expect(port.scrollTop).toBe(1300);
    expect(jumpControl()).not.toBeInTheDocument();
  });

  it("does not mistake the engine's own clamp for the user scrolling away", () => {
    const { view, port, layout } = mountPinned();

    // Content ABOVE the viewport is removed — the process rail folding itself
    // away the moment the answer starts. The engine drags `scrollTop` down to
    // the new maximum by itself and queues a scroll event for the next frame;
    // by the time that event is delivered the answer has grown the transcript
    // back, so the position it reports is nowhere near the bottom and has the
    // exact fingerprint of a scroll up.
    layout.setScrollHeight(600);
    view.rerender(<Harness turnCount={1} />);
    layout.setScrollHeight(1600);
    view.rerender(<Harness turnCount={1} />);

    fireEvent.scroll(port); // the deferred event, at last

    // Nobody scrolled. The pane is still following, with nothing to jump to.
    expect(jumpControl()).not.toBeInTheDocument();
    expect(port.scrollTop).toBe(1300);
  });

  it("releases the moment the user scrolls up, and offers the jump control", () => {
    const { port, layout } = mountPinned();

    userScrollTo(port, 300);

    expect(jumpControl()).toBeInTheDocument();

    // Content keeps growing; the viewport must stay exactly where the user left it.
    layout.setScrollHeight(1600);
    fireResize();

    expect(port.scrollTop).toBe(300);
    expect(jumpControl()).toBeInTheDocument();
  });

  it("re-pins and hides the control when the user scrolls back to the bottom", () => {
    const { port } = mountPinned();
    userScrollTo(port, 300);
    expect(jumpControl()).toBeInTheDocument();

    userScrollTo(port, 700);

    expect(jumpControl()).not.toBeInTheDocument();
  });

  it("re-pins on the jump control, scrolling smoothly", async () => {
    const { port, layout } = mountPinned();
    userScrollTo(port, 300);

    await act(async () => {
      fireEvent.click(jumpControl()!);
    });

    expect(port.scrollTop).toBe(700);
    expect(jumpControl()).not.toBeInTheDocument();
    expect(layout.scrollToCalls).toEqual([{ top: 1000, behavior: "smooth" }]);
  });

  it("scrolls instantly under prefers-reduced-motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { port, layout } = mountPinned();
    userScrollTo(port, 300);

    await act(async () => {
      fireEvent.click(jumpControl()!);
    });

    expect(port.scrollTop).toBe(700);
    expect(layout.scrollToCalls).toEqual([]);
  });

  it("re-pins when a new turn starts, even after the user scrolled away", () => {
    const { view, port } = mountPinned();
    userScrollTo(port, 300);
    expect(jumpControl()).toBeInTheDocument();

    view.rerender(<Harness turnCount={2} />);

    expect(port.scrollTop).toBe(700);
    expect(jumpControl()).not.toBeInTheDocument();
  });

  it("does not follow the growth an expanding <details> causes", async () => {
    const { port, layout } = mountPinned();
    expect(port.scrollTop).toBe(700);

    // jsdom reports an all-zero rect for the summary, so the anchor correction
    // is a no-op here — which is exactly the engine-without-scroll-anchoring
    // case. What is proven is that the growth is NOT followed.
    fireEvent.click(screen.getByText("More"));
    layout.setScrollHeight(1600);
    fireResize();

    // The view has not moved: the summary the user clicked is where they left it.
    expect(port.scrollTop).toBe(700);
    // Parked above the bottom by their own gesture, so the pin releases and the
    // way back is offered rather than taken for them.
    expect(jumpControl()).toBeInTheDocument();
  });

  it("keeps following after a disclosure that grows nothing", async () => {
    const { port, layout } = mountPinned();

    fireEvent.click(screen.getByText("More"));
    await advanceFrames(); // the stale anchor is dropped

    layout.setScrollHeight(1800);
    fireResize();

    expect(port.scrollTop).toBe(1500);
    expect(jumpControl()).not.toBeInTheDocument();
  });

  it("keeps the pin when a collapsing fold clamps the scroll position", () => {
    const { port, layout } = mountPinned();

    // A shrink drags scrollTop down, which looks exactly like a scroll up.
    layout.setScrollHeight(600);
    fireEvent.scroll(port);

    expect(port.scrollTop).toBe(300);
    expect(jumpControl()).not.toBeInTheDocument();

    layout.setScrollHeight(1200);
    fireResize();

    expect(port.scrollTop).toBe(900);
  });
});
