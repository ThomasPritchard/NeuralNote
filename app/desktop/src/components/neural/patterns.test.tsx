import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineNotice } from "./patterns";

describe("NeuralNote composed patterns", () => {
  it("uses the native output status semantics for non-error notices", () => {
    render(<InlineNotice>Indexing vault…</InlineNotice>);

    const notice = screen.getByRole("status");
    expect(notice.tagName).toBe("OUTPUT");
    expect(notice).not.toHaveAttribute("role");
  });
});
