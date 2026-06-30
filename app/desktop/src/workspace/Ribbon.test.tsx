import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Ribbon } from "./Ribbon";

describe("Ribbon", () => {
  it("marks Files as the only live view", () => {
    render(<Ribbon />);
    const files = screen.getByRole("button", { name: "Files" });
    expect(files).toBeInTheDocument();
    expect(files).not.toHaveAttribute("aria-disabled");
  });

  it("labels the not-yet-built views as coming soon and aria-disabled", () => {
    render(<Ribbon />);
    for (const label of ["Search", "Capture", "Graph view", "Settings"]) {
      const btn = screen.getByRole("button", { name: `${label} (coming soon)` });
      expect(btn).toHaveAttribute("aria-disabled", "true");
    }
  });
});
