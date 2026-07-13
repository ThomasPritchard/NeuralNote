import { describe, expect, it } from "vitest";
import { formatMomentPreview, validateTemplateFormat } from "./templateFormat";

describe("template format", () => {
  it("previews the renderer's supported Moment-style tokens and literals", () => {
    const now = new Date(2026, 6, 13, 14, 5, 9);
    expect(formatMomentPreview("dddd, D MMMM YYYY [at] HH:mm:ss", now)).toBe(
      "Monday, 13 July 2026 at 14:05:09",
    );
  });

  it("rejects controls, unclosed literals, and values over 128 characters", () => {
    expect(validateTemplateFormat("YYYY\nMM")).toMatch(/control/i);
    expect(validateTemplateFormat("YYYY [at HH:mm")).toMatch(/unclosed/i);
    expect(validateTemplateFormat("Y".repeat(129))).toMatch(/128/);
    expect(validateTemplateFormat("YYYY-MM-DD")).toBeNull();
  });
});
