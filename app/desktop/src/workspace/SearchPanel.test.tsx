import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";

describe("SearchPanel (phase-B skeleton)", () => {
  it("renders the placeholder sidebar panel", () => {
    render(<SearchPanel focusSignal={0} onOpen={vi.fn()} />);
    expect(
      screen.getByRole("complementary", { name: "Search" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/search is coming/i)).toBeInTheDocument();
  });
});
