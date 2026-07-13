import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";
import type { ToastKind } from "./toast-store";

function TimerHarness() {
  const toast = useToast();

  const add = (kind: ToastKind) => toast[kind](`${kind} message`);

  return (
    <>
      <button onClick={() => add("success")}>Success</button>
      <button onClick={() => add("info")}>Info</button>
      <button onClick={() => add("warning")}>Warning</button>
      <button onClick={() => add("error")}>Error</button>
      <button
        onClick={() =>
          toast.success("Actionable message", {
            action: { label: "Open", onClick: vi.fn() },
          })
        }
      >
        Actionable
      </button>
      <button
        onClick={() => {
          toast.error("Persistent one");
          toast.error("Persistent two");
          toast.error("Persistent three");
          toast.success("Queued success");
        }}
      >
        Fill queue
      </button>
    </>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <TimerHarness />
    </ToastProvider>,
  );
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds));
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

describe("ToastProvider dismissal timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it.each([
    ["success", "Success", 4_000],
    ["info", "Info", 6_000],
    ["warning", "Warning", 10_000],
  ] as const)(
    "dismisses %s notifications at the configured duration",
    (kind, triggerName, duration) => {
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: triggerName }));

      advance(duration - 1);
      expect(
        screen.getByLabelText(`${kind} message notification`),
      ).toBeInTheDocument();

      advance(1);
      expect(
        screen.queryByLabelText(`${kind} message notification`),
      ).not.toBeInTheDocument();
    },
  );

  it("keeps errors and actionable notifications until explicitly dismissed", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    fireEvent.click(screen.getByRole("button", { name: "Actionable" }));

    advance(60_000);

    expect(screen.getByRole("alert")).toHaveTextContent("error message");
    expect(
      screen.getByLabelText("Actionable message notification"),
    ).toBeInTheDocument();
  });

  it("pauses and resumes the remaining duration while hovered", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Success" }));
    const notification = screen.getByLabelText("success message notification");

    advance(3_000);
    fireEvent.mouseEnter(notification);
    advance(5_000);
    expect(notification).toBeInTheDocument();

    fireEvent.mouseLeave(notification);
    advance(999);
    expect(notification).toBeInTheDocument();
    advance(1);
    expect(notification).not.toBeInTheDocument();
  });

  it("pauses and resumes the remaining duration while focus is inside", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Success" }));
    const notification = screen.getByLabelText("success message notification");
    const dismiss = within(notification).getByRole("button", {
      name: "Dismiss notification",
    });

    advance(3_000);
    fireEvent.focus(dismiss);
    advance(5_000);
    expect(notification).toBeInTheDocument();

    fireEvent.blur(dismiss);
    advance(999);
    expect(notification).toBeInTheDocument();
    advance(1);
    expect(notification).not.toBeInTheDocument();
  });

  it("pauses and resumes timers while the document is hidden", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Success" }));

    advance(3_000);
    setDocumentHidden(true);
    advance(5_000);
    expect(
      screen.getByLabelText("success message notification"),
    ).toBeInTheDocument();

    setDocumentHidden(false);
    advance(1_000);
    expect(
      screen.queryByLabelText("success message notification"),
    ).not.toBeInTheDocument();
  });

  it("starts a queued notification's timer only after it becomes visible", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Fill queue" }));

    advance(20_000);
    expect(screen.queryByText("Queued success")).not.toBeInTheDocument();

    const first = screen.getByLabelText("Persistent one notification");
    fireEvent.click(
      within(first).getByRole("button", { name: "Dismiss notification" }),
    );
    expect(
      screen.getByLabelText("Queued success notification"),
    ).toBeInTheDocument();

    advance(3_999);
    expect(
      screen.getByLabelText("Queued success notification"),
    ).toBeInTheDocument();
    advance(1);
    expect(
      screen.queryByLabelText("Queued success notification"),
    ).not.toBeInTheDocument();
  });
});
