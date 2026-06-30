import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandHeader } from "./BrandHeader";

describe("BrandHeader", () => {
  it("renders the wordmark and an honest tagline", () => {
    render(<BrandHeader />);
    expect(screen.getByRole("heading", { name: "NeuralNote" })).toBeInTheDocument();
    expect(
      screen.getByText("Your vault. Plain markdown, yours to keep."),
    ).toBeInTheDocument();
  });

  it("makes no fabricated capture/recall claims", () => {
    render(<BrandHeader />);
    expect(
      screen.queryByText(/fully captured and recalled/i),
    ).not.toBeInTheDocument();
  });
});
