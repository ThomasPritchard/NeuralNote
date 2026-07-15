import { describe, expect, it } from "vitest";

import { playfulProgressCopy } from "./ChatMessages";

describe("playfulProgressCopy", () => {
  it("is deterministic for a given prompt", () => {
    expect(playfulProgressCopy("Summarise my notes")).toBe(
      playfulProgressCopy("Summarise my notes"),
    );
  });

  it("returns a defined copy pair for BMP text", () => {
    const copy = playfulProgressCopy("What did I capture yesterday?");
    expect(copy.sending).toBeTruthy();
    expect(copy.thinking).toBeTruthy();
  });

  it("inspects supplementary-plane code points safely", () => {
    // Astral characters (e.g. U+1F600) occupy two UTF-16 code units, so a
    // charCodeAt-based hash would fold each half separately. Code-point-safe
    // iteration must treat them as a single unit and never index out of range.
    const astral = "😀🧠🚀 recap my week";
    const copy = playfulProgressCopy(astral);
    expect(copy.sending).toBeTruthy();
    expect(copy.thinking).toBeTruthy();

    // A trailing astral character must change the selection space just like any
    // other code point would, without throwing on the surrogate boundary.
    expect(() => playfulProgressCopy("🧠")).not.toThrow();
    expect(playfulProgressCopy("🧠")).toBe(playfulProgressCopy("🧠"));
  });
});
