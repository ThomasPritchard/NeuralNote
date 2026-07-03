import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE } from "./galaxy/graph";
import { toGalaxy } from "./graphTransform";

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

  it("sizes nodes by degree: floor 2.5, hub threshold at degree 6, cap 8", () => {
    // hub has degree 6 (crosses HUB_VAL=7 in nodeChrome); near has degree 5;
    // orphan has degree 0; mega has degree 8 (capped at 8).
    const spokes = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const megaSpokes = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    const g = graph(
      [
        node("hub.md"),
        node("near.md"),
        node("orphan.md"),
        node("mega.md"),
        ...spokes.map((s) => node(`${s}.md`)),
        ...megaSpokes.map((s) => node(`${s}.md`)),
      ],
      [
        ...spokes.map((s) => link("hub.md", `${s}.md`)),
        ...spokes.slice(0, 5).map((s) => link("near.md", `${s}.md`)),
        ...megaSpokes.map((s) => link("mega.md", `${s}.md`)),
      ],
    );
    const byId = new Map(toGalaxy(g, "r").data.nodes.map((n) => [n.id, n]));
    expect(byId.get("orphan.md")?.val).toBe(2.5);
    expect(byId.get("near.md")?.val).toBe(6.25); // degree 5 — below the hub cut
    expect(byId.get("hub.md")?.val).toBe(7); // degree 6 — exactly HUB_VAL
    expect(byId.get("mega.md")?.val).toBe(8); // degree 8 — capped
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
