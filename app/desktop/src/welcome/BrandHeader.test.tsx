import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandHeader } from "./BrandHeader";

describe("BrandHeader", () => {
  it("renders the wordmark and an honest tagline", () => {
    const { container } = render(<BrandHeader />);
    expect(screen.getByRole("heading", { name: "NeuralNote" })).toBeInTheDocument();
    expect(
      screen.getByText("Your vault. Plain markdown, yours to keep."),
    ).toBeInTheDocument();
    const mark = container.querySelector("img");
    expect(mark?.getAttribute("src")).toContain("neuralnote-mark-128");
    expect(mark).toHaveAttribute("alt", "");
    expect(mark).toHaveClass("object-contain");
  });

  it("makes no fabricated capture/recall claims", () => {
    render(<BrandHeader />);
    expect(
      screen.queryByText(/fully captured and recalled/i),
    ).not.toBeInTheDocument();
  });
});
