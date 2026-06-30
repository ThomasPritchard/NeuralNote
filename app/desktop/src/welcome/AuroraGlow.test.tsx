import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuroraGlow } from "./AuroraGlow";

describe("AuroraGlow", () => {
  it("renders as a purely decorative, non-interactive layer", () => {
    const { container } = render(<AuroraGlow />);
    const root = container.firstElementChild;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root).toHaveClass("pointer-events-none");
  });
});
