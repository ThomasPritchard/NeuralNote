import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphView } from "./GraphView";

describe("GraphView (phase-B skeleton)", () => {
  it("renders the placeholder center pane", () => {
    render(<GraphView onOpenNote={vi.fn()} />);
    expect(screen.getByRole("main", { name: "Graph view" })).toBeInTheDocument();
    expect(screen.getByText(/graph view is coming/i)).toBeInTheDocument();
  });
});
