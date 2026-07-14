import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PaneSplitter } from "./PaneSplitter";

function ControlledSplitter({ initial = 296 }: Readonly<{ initial?: number }>) {
  const [width, setWidth] = useState(initial);
  return (
    <>
      <output data-testid="width">{width}</output>
      <PaneSplitter
        paneId="nn-primary-sidebar"
        width={width}
        minWidth={192}
        maxWidth={420}
        onResize={setWidth}
      />
    </>
  );
}

describe("PaneSplitter", () => {
  it("exposes the primary pane relationship and current range", () => {
    render(<ControlledSplitter />);
    const splitter = screen.getByRole("separator", {
      name: "Resize files and search pane",
    });

    expect(splitter).toHaveAttribute("aria-orientation", "vertical");
    expect(splitter).toHaveAttribute("aria-controls", "nn-primary-sidebar");
    expect(splitter).toHaveAttribute("aria-valuemin", "192");
    expect(splitter).toHaveAttribute("aria-valuenow", "296");
    expect(splitter).toHaveAttribute("aria-valuemax", "420");
    expect(splitter).toHaveAttribute("tabindex", "0");
  });

  it("captures the pointer and resizes from the drag origin", () => {
    const onResize = vi.fn();
    render(
      <PaneSplitter
        paneId="nn-primary-sidebar"
        width={296}
        minWidth={192}
        maxWidth={420}
        onResize={onResize}
      />,
    );
    const splitter = screen.getByRole("separator");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(splitter, { setPointerCapture, releasePointerCapture });

    fireEvent.pointerDown(splitter, { pointerId: 7, clientX: 300, button: 0 });
    fireEvent.pointerMove(splitter, { pointerId: 7, clientX: 348 });
    fireEvent.pointerUp(splitter, { pointerId: 7 });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(onResize).toHaveBeenCalledWith(344);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("supports fine and coarse arrow-key resizing within bounds", () => {
    render(<ControlledSplitter initial={200} />);
    const splitter = screen.getByRole("separator");

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(screen.getByTestId("width")).toHaveTextContent("208");
    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByTestId("width")).toHaveTextContent("240");
    fireEvent.keyDown(splitter, { key: "ArrowLeft", shiftKey: true });
    expect(screen.getByTestId("width")).toHaveTextContent("208");
  });

  it("moves to the minimum and maximum with Home and End", () => {
    render(<ControlledSplitter />);
    const splitter = screen.getByRole("separator");

    fireEvent.keyDown(splitter, { key: "Home" });
    expect(screen.getByTestId("width")).toHaveTextContent("192");
    fireEvent.keyDown(splitter, { key: "End" });
    expect(screen.getByTestId("width")).toHaveTextContent("420");
  });

  it("collapses to minimum with Enter and restores the previous width", () => {
    render(<ControlledSplitter initial={336} />);
    const splitter = screen.getByRole("separator");

    fireEvent.keyDown(splitter, { key: "Enter" });
    expect(screen.getByTestId("width")).toHaveTextContent("192");
    fireEvent.keyDown(splitter, { key: "Enter" });
    expect(screen.getByTestId("width")).toHaveTextContent("336");
  });

  it("keeps the previous width when responsive space limits an Enter restore", () => {
    const onResize = vi.fn();
    const { rerender } = render(
      <PaneSplitter
        paneId="nn-primary-sidebar"
        width={336}
        minWidth={192}
        maxWidth={420}
        onResize={onResize}
      />,
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Enter" });
    expect(onResize).toHaveBeenLastCalledWith(192);

    rerender(
      <PaneSplitter
        paneId="nn-primary-sidebar"
        width={192}
        minWidth={192}
        maxWidth={260}
        onResize={onResize}
      />,
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Enter" });

    expect(onResize).toHaveBeenLastCalledWith(336);
  });

  it("clamps pointer and keyboard requests to the current responsive maximum", () => {
    const onResize = vi.fn();
    render(
      <PaneSplitter
        paneId="nn-primary-sidebar"
        width={240}
        minWidth={192}
        maxWidth={260}
        onResize={onResize}
      />,
    );
    const splitter = screen.getByRole("separator");
    Object.assign(splitter, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(splitter, { pointerId: 2, clientX: 100, button: 0 });
    fireEvent.pointerMove(splitter, { pointerId: 2, clientX: 500 });
    fireEvent.keyDown(splitter, { key: "End" });

    expect(onResize).toHaveBeenNthCalledWith(1, 260);
    expect(onResize).toHaveBeenNthCalledWith(2, 260);
  });
});
