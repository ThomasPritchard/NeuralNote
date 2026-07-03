import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

// three-spritetext draws on a 2D canvas context at construction time, which
// jsdom lacks — mock with just the surface starNode touches. Must be a real
// Object3D or group.add() rejects it and the label never joins the children.
vi.mock("three-spritetext", async () => {
  const { Object3D } = await import("three");
  return {
    default: class extends Object3D {
      material = { transparent: false, opacity: 1 };
      fontFace = "";
      fontWeight = "";
    },
  };
});

import { applyFocus, resetRegistry, updateAll } from "./nodeRegistry";
import { DIM_FACTOR, makeStarNode } from "./starNode";

const NODE = { id: "note.md", title: "Note", cluster: "", val: 4, color: "#7d6fe0" };

function starIntensity(group: THREE.Object3D): number {
  const mesh = group.children[0] as THREE.Mesh;
  return (mesh.material as THREE.ShaderMaterial).uniforms.uIntensity.value;
}

/** Label ctx that projects the star far past LABEL_FULL_PX at a mid distance,
 *  so labelOpacity sits at its 0.9 ceiling and dim is the only variable. */
const LABEL_CTX = { camPos: { x: 0, y: 0, z: 500 }, fovScale: 1, pxPerWorld: 50_000 };

function tick(times: number, withLabels = false): void {
  for (let i = 0; i < times; i++) updateAll(0, withLabels ? LABEL_CTX : undefined);
}

describe("star node dim easing", () => {
  beforeEach(() => resetRegistry());

  it("eases brightness toward DIM_FACTOR when dimmed — no pop", () => {
    const group = makeStarNode(NODE);
    tick(1);
    expect(starIntensity(group)).toBeCloseTo(1, 5);

    applyFocus(new Set()); // nothing lit — this node dims
    tick(1);
    const afterOne = starIntensity(group);
    expect(afterOne).toBeLessThan(1); // moving…
    expect(afterOne).toBeGreaterThan(DIM_FACTOR + 0.3); // …but eased, not snapped

    tick(120);
    expect(starIntensity(group)).toBeCloseTo(DIM_FACTOR, 2);
  });

  it("eases back to full brightness when the dim clears", () => {
    const group = makeStarNode(NODE);
    applyFocus(new Set());
    tick(120);

    applyFocus(null);
    tick(120);
    expect(starIntensity(group)).toBeCloseTo(1, 2);
  });

  it("multiplies the dim factor into the label opacity", () => {
    const group = makeStarNode(NODE);
    const label = group.children[3] as unknown as { material: { opacity: number } };
    tick(2, true);
    expect(label.material.opacity).toBeCloseTo(0.9, 3); // fully revealed baseline

    applyFocus(new Set());
    tick(120, true);
    expect(label.material.opacity).toBeCloseTo(0.9 * DIM_FACTOR, 2);
  });
});
