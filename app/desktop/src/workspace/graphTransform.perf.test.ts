import { describe, expect, it } from "vitest";

import { GALAXY_NODE_CAP, toGalaxy } from "./graphTransform";
import {
  LARGE_VAULT_CLUSTERS,
  LARGE_VAULT_NOTES_PER_CLUSTER,
  buildSyntheticVault,
  largeVault,
} from "./graphTransform.fixture";

// Perf budget for the graph transform on a very large vault (issue #39).
//
// The real 3D galaxy (WebGL + force layout) can't be benchmarked headlessly in
// jsdom, so we bound what we CONTROL and what feeds the renderer:
//   1. Structural cap (the HARD gate): `toGalaxy` never hands the renderer more
//      than GALAXY_NODE_CAP nodes, whatever the vault size. Render cost is thus
//      bounded BY CONSTRUCTION — the interaction-responsiveness guarantee.
//   2. Transform time (informational, GENEROUS ceiling): the pure transform
//      stays well under a budget that only trips on a catastrophic regression.
//      A tight wall-clock p95 would flake in CI (cf. sourceEditorPerformance),
//      so the cap invariant is the gate; timing is a smoke ceiling.
const EXPECTED_NODES = LARGE_VAULT_CLUSTERS * LARGE_VAULT_NOTES_PER_CLUSTER;
const TRANSFORM_BUDGET_MS = 100;

describe("graph transform perf budget (large vault)", () => {
  it("builds a reproducible ≥2,000-note fixture, identical run-to-run", () => {
    expect(EXPECTED_NODES).toBeGreaterThanOrEqual(2_000);
    const first = largeVault();
    const second = largeVault();
    expect(first.nodes).toHaveLength(EXPECTED_NODES);
    expect(first).toEqual(second);
    expect(first.nodes.length).toBeGreaterThan(GALAXY_NODE_CAP);
  });

  it("never hands the renderer more than GALAXY_NODE_CAP nodes, and says so honestly", () => {
    const view = toGalaxy(largeVault(), "Huge Vault");

    expect(view.data.nodes.length).toBeLessThanOrEqual(GALAXY_NODE_CAP);
    expect(view.data.nodes).toHaveLength(GALAXY_NODE_CAP);
    expect(view.truncation).toEqual({ shown: GALAXY_NODE_CAP, total: EXPECTED_NODES });
    expect(view.stats.notes).toBe(GALAXY_NODE_CAP);
  });

  it("keeps every rendered link between two rendered nodes after the cap", () => {
    const view = toGalaxy(largeVault(), "Huge Vault");
    const shown = new Set(view.data.nodes.map((n) => n.id));
    for (const link of view.data.links) {
      expect(shown.has(link.source)).toBe(true);
      expect(shown.has(link.target)).toBe(true);
    }
    expect(view.data.links.length).toBeLessThanOrEqual(view.stats.links);
  });

  it("bounds the input regardless of vault size (cap is size-independent)", () => {
    const huge = toGalaxy(buildSyntheticVault(40, 200), "Huger Vault");
    expect(huge.data.nodes).toHaveLength(GALAXY_NODE_CAP);
    expect(huge.truncation).toEqual({ shown: GALAXY_NODE_CAP, total: 40 * 200 });
  });

  it("transforms the large fixture within a generous smoke budget", () => {
    const graph = largeVault();
    const samples: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const started = performance.now();
      toGalaxy(graph, "Huge Vault");
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThanOrEqual(TRANSFORM_BUDGET_MS);
  });
});
