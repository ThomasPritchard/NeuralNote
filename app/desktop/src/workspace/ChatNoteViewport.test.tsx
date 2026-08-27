import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatNoteViewport } from "./ChatNoteViewport";

let resizeCallbacks: ResizeObserverCallback[] = [];

class ControllableResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}

function installLayout(element: HTMLElement, scrollHeight: number): void {
  let scrollTop = 0;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(0, value), Math.max(0, scrollHeight - 200));
      },
    },
    scrollTo: {
      configurable: true,
      value: ({ top = 0 }: ScrollToOptions) => {
        scrollTop = Math.min(Math.max(0, top), Math.max(0, scrollHeight - 200));
      },
    },
  });
}

function fireResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback([], undefined as unknown as ResizeObserver);
    }
  });
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
});

describe("ChatNoteViewport", () => {
  it("renders the complete body as plain text outside live regions", () => {
    const body = "# Full note\n\n<script>not markup</script>\nLast line";
    render(<ChatNoteViewport activityId="write-1" body={body} streaming />);

    const viewport = screen.getByRole("region", { name: "Note draft content" });
    expect(viewport).toHaveTextContent("# Full note");
    expect(viewport).toHaveTextContent("<script>not markup</script>");
    expect(viewport).toHaveTextContent("Last line");
    expect(viewport.querySelector("script")).toBeNull();
    expect(viewport.closest('[aria-live], [role="status"], output')).toBeNull();
    expect(within(viewport).getByTestId("note-tail-cursor")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("is keyboard focusable only while its body genuinely overflows", () => {
    render(<ChatNoteViewport activityId="write-1" body="Short body" streaming />);
    const viewport = screen.getByRole("region", { name: "Note draft content" });
    installLayout(viewport, 200);
    fireResize();
    expect(viewport).not.toHaveAttribute("tabindex");

    installLayout(viewport, 700);
    fireResize();
    expect(viewport).toHaveAttribute("tabindex", "0");
  });

  it("offers Jump to latest only after the reader scrolls upward", () => {
    render(<ChatNoteViewport activityId="write-1" body="Long body" streaming />);
    const viewport = screen.getByRole("region", { name: "Note draft content" });
    installLayout(viewport, 800);
    fireResize();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    viewport.scrollTop = 250;
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(viewport.scrollTop).toBe(600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("upgrades one activity in place without replacing its scroll owner", () => {
    const view = render(
      <ChatNoteViewport activityId="write-1" body="Draft fragment" streaming />,
    );
    const before = screen.getByRole("region", { name: "Note draft content" });

    view.rerender(
      <ChatNoteViewport
        activityId="write-1"
        body="Draft fragment\nCompleted arguments"
        streaming={false}
      />,
    );

    expect(screen.getByRole("region", { name: "Note draft content" })).toBe(before);
    expect(before).toHaveTextContent("Completed arguments");
    expect(screen.getByText("Note preview ready")).toBeInTheDocument();
  });
});
