import { describe, expect, it, vi } from "vitest";
import type { LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE } from "./galaxy/graph";
import { degreeVal, toGalaxy } from "./graphTransform";

// nodeChrome (for the HUB_VAL coherence check) pulls in three-spritetext,
// which needs a 2D canvas at construction time — jsdom lacks one.
vi.mock("three-spritetext", () => ({ default: class {} }));
import { HUB_VAL } from "./galaxy/nodeChrome";

const node = (id: string, cluster = "", title = id) => ({ id, title, cluster });
const link = (source: string, target: string, bridge = false) => ({
  source,
  target,
  bridge,
});

const graph = (
  nodes: LinkGraph["nodes"],
  links: LinkGraph["links"] = [],
  skippedFiles = 0,
): LinkGraph => ({ nodes, links, skippedFiles });

describe("toGalaxy", () => {
  it("assigns palette colours deterministically to sorted clusters, vault root first", () => {
    const g = graph([
      node("b/one.md", "b"),
      node("root.md", ""),
      node("a/two.md", "a"),
    ]);
    const { clusters } = toGalaxy(g, "My Vault");
    expect(Object.keys(clusters)).toEqual(["", "a", "b"]);
    expect(clusters[""]).toEqual({ label: "My Vault", color: CLUSTER_PALETTE[0] });
    expect(clusters["a"]).toEqual({ label: "a", color: CLUSTER_PALETTE[1] });
    expect(clusters["b"]).toEqual({ label: "b", color: CLUSTER_PALETTE[2] });
  });

  it("wraps the palette after five clusters", () => {
    const g = graph(["c1", "c2", "c3", "c4", "c5", "c6"].map((c) => node(`${c}/n.md`, c)));
    const { clusters } = toGalaxy(g, "Vault root");
    expect(clusters["c6"].color).toBe(CLUSTER_PALETTE[0]);
    expect(clusters["c1"].color).toBe(CLUSTER_PALETTE[0]);
    expect(clusters["c5"].color).toBe(CLUSTER_PALETTE[4]);
  });

  it("includes every node's cluster in the clusters record", () => {
    const g = graph([node("x/a.md", "x"), node("y/b.md", "y"), node("c.md", "")]);
    const { data, clusters } = toGalaxy(g, "Vault root");
    for (const n of data.nodes) expect(clusters[n.cluster]).toBeDefined();
  });

  it("sizes nodes by degree: floor 2.5, sub-linear √degree growth, cap 17", () => {
    // Sub-linear so a degree-40 MOC dwarfs a degree-6 note without a linear
    // blowout: val = 2.5 + 2.2·√degree, capped at 17.
    expect(degreeVal(0)).toBe(2.5);
    expect(degreeVal(1)).toBeCloseTo(4.7, 5);
    expect(degreeVal(6)).toBeCloseTo(2.5 + 2.2 * Math.sqrt(6), 5);
    expect(degreeVal(44)).toBe(17); // 2.5 + 2.2·√44 ≈ 17.09 — capped
    expect(degreeVal(100)).toBe(17);
    // Monotonic: more links never shrinks a node.
    for (let d = 1; d <= 60; d++) {
      expect(degreeVal(d)).toBeGreaterThanOrEqual(degreeVal(d - 1));
    }
  });

  it("keeps the mapping coherent with nodeChrome's hub gate: hub text starts at degree 12", () => {
    // "Hub" must mean genuinely top-tier. If either side is retuned, this
    // pins where the big-label tier begins.
    expect(degreeVal(11)).toBeLessThan(HUB_VAL);
    expect(degreeVal(12)).toBeGreaterThanOrEqual(HUB_VAL);
  });

  it("applies the degree mapping to real nodes (orphan floor, spokes, capped mega-hub)", () => {
    const spokes = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const megaSpokes = Array.from({ length: 44 }, (_, i) => `m${i}`);
    const g = graph(
      [
        node("hub.md"),
        node("orphan.md"),
        node("mega.md"),
        ...spokes.map((s) => node(`${s}.md`)),
        ...megaSpokes.map((s) => node(`${s}.md`)),
      ],
      [
        ...spokes.map((s) => link("hub.md", `${s}.md`)),
        ...megaSpokes.map((s) => link("mega.md", `${s}.md`)),
      ],
    );
    const byId = new Map(toGalaxy(g, "r").data.nodes.map((n) => [n.id, n]));
    expect(byId.get("orphan.md")?.val).toBe(2.5);
    expect(byId.get("s1.md")?.val).toBe(degreeVal(1));
    expect(byId.get("hub.md")?.val).toBe(degreeVal(6));
    expect(byId.get("mega.md")?.val).toBe(17); // degree 44 — capped
  });

  it("colours nodes by their cluster and passes bridges through", () => {
    const g = graph(
      [node("a/one.md", "a"), node("b/two.md", "b")],
      [link("a/one.md", "b/two.md", true)],
    );
    const { data, clusters } = toGalaxy(g, "r");
    expect(data.nodes[0].color).toBe(clusters["a"].color);
    expect(data.nodes[1].color).toBe(clusters["b"].color);
    expect(data.links).toEqual([{ source: "a/one.md", target: "b/two.md", bridge: true }]);
  });

  it("computes stats: notes, links, cross-folder links", () => {
    const g = graph(
      [node("a/one.md", "a"), node("b/two.md", "b"), node("a/three.md", "a")],
      [link("a/one.md", "a/three.md"), link("a/one.md", "b/two.md", true)],
    );
    expect(toGalaxy(g, "r").stats).toEqual({
      notes: 3,
      links: 2,
      crossFolderLinks: 1,
    });
  });

  it("emits fresh objects on every call (the sim/morph mutate them)", () => {
    const g = graph([node("a.md")], []);
    const first = toGalaxy(g, "r");
    const second = toGalaxy(g, "r");
    expect(first.data.nodes[0]).not.toBe(second.data.nodes[0]);
    expect(first.data.nodes[0]).not.toBe(g.nodes[0]);
    expect(first.data).not.toBe(second.data);
  });
});
