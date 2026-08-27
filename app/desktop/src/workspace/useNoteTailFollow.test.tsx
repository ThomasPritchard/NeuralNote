import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoteTailFollow } from "./useNoteTailFollow";

const PORT_HEIGHT = 200;
let resizeCallbacks: ResizeObserverCallback[] = [];

class ControllableResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }

  observe = () => {};
  unobserve = () => {};
  disconnect = () => {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
  };
}

interface Layout {
  readonly scrollToCalls: ScrollToOptions[];
  setScrollHeight: (height: number) => void;
}

function installLayout(element: HTMLElement, initialHeight: number): Layout {
  let scrollHeight = initialHeight;
  let scrollTop = 0;
  const maximum = () => Math.max(0, scrollHeight - PORT_HEIGHT);
  const scrollToCalls: ScrollToOptions[] = [];

  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => PORT_HEIGHT },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(maximum(), Math.max(0, value));
      },
    },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        scrollToCalls.push(options);
        scrollTop = Math.min(maximum(), Math.max(0, options.top ?? 0));
      },
    },
  });

  return {
    scrollToCalls,
    setScrollHeight: (height: number) => {
      scrollHeight = height;
      scrollTop = Math.min(scrollTop, maximum());
    },
  };
}

function fireResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback([], undefined as unknown as ResizeObserver);
    }
  });
}

function Harness({
  activityId,
  body,
}: Readonly<{ activityId: string; body: string }>) {
  const follow = useNoteTailFollow({ activityId, content: body });
  return (
    <div>
      <div ref={follow.viewportRef} data-testid="viewport">
        <pre ref={follow.contentRef}>{body}</pre>
      </div>
      <output data-testid="overflowing">{String(follow.overflowing)}</output>
      {follow.paused && (
        <button type="button" onClick={follow.jumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  );
}

function userScroll(viewport: HTMLElement, top: number): void {
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
}

function mount(body = "first", activityId = "activity-a", height = 800) {
  const view = render(<Harness activityId={activityId} body={body} />);
  const viewport = screen.getByTestId("viewport");
  const layout = installLayout(viewport, height);
  fireResize();
  return { ...view, layout, viewport };
}

const jumpButton = () => screen.queryByRole("button", { name: "Jump to latest" });

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNoteTailFollow", () => {
  it("follows growth until an upward scroll pauses it", () => {
    const { layout, rerender, viewport } = mount();
    expect(viewport.scrollTop).toBe(600);

    layout.setScrollHeight(1_100);
    rerender(<Harness activityId="activity-a" body="first\nsecond" />);
    expect(viewport.scrollTop).toBe(900);

    userScroll(viewport, 400);
    expect(jumpButton()).toBeInTheDocument();

    layout.setScrollHeight(1_400);
    rerender(<Harness activityId="activity-a" body="first\nsecond\nthird" />);
    expect(viewport.scrollTop).toBe(400);
  });

  it("resumes follow when the user manually returns to the bottom", () => {
    const { layout, rerender, viewport } = mount();
    userScroll(viewport, 300);
    expect(jumpButton()).toBeInTheDocument();

    userScroll(viewport, 600);
    expect(jumpButton()).not.toBeInTheDocument();

    layout.setScrollHeight(1_000);
    rerender(<Harness activityId="activity-a" body="first\nsecond" />);
    expect(viewport.scrollTop).toBe(800);
  });

  it("jumps to the tail smoothly without reduced motion", () => {
    const { layout, viewport } = mount();
    userScroll(viewport, 300);

    fireEvent.click(jumpButton()!);

    expect(viewport.scrollTop).toBe(600);
    expect(jumpButton()).not.toBeInTheDocument();
    expect(layout.scrollToCalls).toEqual([{ top: 800, behavior: "smooth" }]);
  });

  it("jumps without animation when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { layout, viewport } = mount();
    userScroll(viewport, 300);

    fireEvent.click(jumpButton()!);

    expect(viewport.scrollTop).toBe(600);
    expect(layout.scrollToCalls).toEqual([]);
  });

  it("restores each activity's paused position when selection changes", () => {
    const { layout, rerender, viewport } = mount("alpha", "activity-a", 800);
    userScroll(viewport, 210);

    layout.setScrollHeight(1_000);
    rerender(<Harness activityId="activity-b" body="beta" />);
    expect(viewport.scrollTop).toBe(800);
    userScroll(viewport, 360);

    layout.setScrollHeight(800);
    rerender(<Harness activityId="activity-a" body="alpha expanded" />);
    expect(viewport.scrollTop).toBe(210);
    expect(jumpButton()).toBeInTheDocument();

    layout.setScrollHeight(1_000);
    rerender(<Harness activityId="activity-b" body="beta expanded" />);
    expect(viewport.scrollTop).toBe(360);
  });

  it("reports overflow only when the content is taller than the viewport", () => {
    const { layout } = mount("short", "activity-a", PORT_HEIGHT);
    expect(screen.getByTestId("overflowing")).toHaveTextContent("false");

    layout.setScrollHeight(PORT_HEIGHT + 1);
    fireResize();

    expect(screen.getByTestId("overflowing")).toHaveTextContent("true");
  });

});
