// Vitest runs these built-ins in Node; the renderer tsconfig deliberately omits
// Node ambient types from production modules.
// @ts-expect-error -- test-only Node built-in
import { readFileSync } from "node:fs";
// @ts-expect-error -- test-only Node built-in
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");

describe("Neural Violet Dark theme", () => {
  it("uses the lighter charcoal hierarchy from the approved workspace reference", () => {
    expect(styles).toContain("--nn-bg: oklch(0.277 0.006 285)");
    expect(styles).toContain("--nn-titlebar: oklch(0.387 0.007 285)");
    expect(styles).toContain("--nn-sidebar: oklch(0.29 0.006 285)");
    expect(styles).toContain("--nn-card: oklch(0.333 0.007 285)");
    expect(styles).toContain("--nn-muted-fg: oklch(0.79 0.01 285)");
  });
});
