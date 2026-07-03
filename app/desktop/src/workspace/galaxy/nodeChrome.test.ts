import { describe, expect, it, vi } from "vitest";

// three-spritetext draws on a 2D canvas context at construction time, which
// jsdom lacks — the pure math under test never touches it.
vi.mock("three-spritetext", () => ({ default: class {} }));

import {
  HIT_FLOOR,
  LABEL_FULL_PX,
  LABEL_REVEAL_PX,
  MIN_HIT_PX,
  hitProxyScale,
  hitRadius,
  labelOpacity,
} from "./nodeChrome";

describe("hitRadius", () => {
  it("floors at HIT_FLOOR so leaf notes stay acquirable", () => {
    expect(hitRadius(1)).toBe(HIT_FLOOR);
    expect(hitRadius(HIT_FLOOR / 2)).toBe(HIT_FLOOR);
  });

  it("is twice the visual radius for large stars", () => {
    expect(hitRadius(12)).toBe(24);
  });
});

describe("labelOpacity (screen-space reveal)", () => {
  const FAR = 10_000; // effective distance where the close-fade is inert

  it("is fully hidden while the star projects at or below the reveal threshold", () => {
    expect(labelOpacity(0, FAR)).toBe(0);
    expect(labelOpacity(LABEL_REVEAL_PX, FAR)).toBe(0);
    expect(labelOpacity(LABEL_REVEAL_PX * 0.5, FAR)).toBe(0);
  });

  it("is fully visible (0.9) once the star projects past the full threshold", () => {
    expect(labelOpacity(LABEL_FULL_PX, FAR)).toBeCloseTo(0.9, 5);
    expect(labelOpacity(LABEL_FULL_PX * 3, FAR)).toBeCloseTo(0.9, 5);
  });

  it("fades in monotonically between reveal and full", () => {
    const steps = 8;
    let prev = 0;
    for (let i = 1; i <= steps; i++) {
      const px = LABEL_REVEAL_PX + ((LABEL_FULL_PX - LABEL_REVEAL_PX) * i) / steps;
      const o = labelOpacity(px, FAR);
      expect(o).toBeGreaterThan(prev);
      prev = o;
    }
    expect(prev).toBeCloseTo(0.9, 5);
  });

  it("yields to the star ultra-close (mirrors the shader's proxAtten)", () => {
    // Camera parked on the node: label dims to the 0.08 floor instead of
    // smearing under bloom, however large it projects.
    expect(labelOpacity(LABEL_FULL_PX * 10, 40)).toBeCloseTo(0.08, 5);
    // Past the attenuation band the close-fade is fully released.
    expect(labelOpacity(LABEL_FULL_PX * 10, 220)).toBeCloseTo(0.9, 5);
  });
});

describe("hitProxyScale (minimum screen-space hit target)", () => {
  // px-per-world-unit at the node's depth = pxPerWorld / dist.
  const pxPerWorld = 2000; // ≈ (900px half-viewport) / tan(fov/2), order of magnitude

  it("leaves the proxy alone when it already projects at or above the minimum", () => {
    // hitR 10 at dist 1000 → 20px projected ≥ MIN_HIT_PX.
    expect(hitProxyScale(10, pxPerWorld, 1000)).toBe(1);
  });

  it("grows a sub-threshold proxy to exactly the minimum projected radius", () => {
    // hitR 9 at dist 10000 → 1.8px projected; scale must land it on MIN_HIT_PX.
    const hitR = 9;
    const dist = 10_000;
    const k = hitProxyScale(hitR, pxPerWorld, dist);
    expect(k).toBeGreaterThan(1);
    expect((hitR * k * pxPerWorld) / dist).toBeCloseTo(MIN_HIT_PX, 5);
  });

  it("never shrinks below the true hit radius", () => {
    for (const dist of [10, 100, 1000, 100_000]) {
      expect(hitProxyScale(20, pxPerWorld, dist)).toBeGreaterThanOrEqual(1);
    }
  });
});
