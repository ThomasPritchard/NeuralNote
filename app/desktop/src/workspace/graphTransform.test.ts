import { describe, expect, it, vi } from "vitest";
import type { LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE } from "./galaxy/graph";
import { degreeVal, toGalaxy } from "./graphTransform";

// nodeChrome (for the HUB_VAL coherence check) pulls in three-spritetext,
// which needs a 2D canvas at construction time — jsdom lacks one.
// eslint-disable-next-line typescript/no-extraneous-class -- minimal constructable stub for the mocked default export; the math under test never touches it.
vi.mock("three-spritetext", () => ({ default: class {} }));
import { HUB_VAL } from "./galaxy/nodeChrome";

const node = (id: string, cluster = "", title = id) => ({ id, title, cluster });
const link = (source: string, target: string, bridge = false) => ({
  source,
  target,
  bridge,
});

/** Node with the backend's cluster contract applied: first path segment. */
const vnode = (id: string) => node(id, id.includes("/") ? id.split("/")[0] : "");
/** Link with the backend's honest bridge flag: top-level folders differ. */
const vlink = (source: string, target: string) =>
  link(source, target, source.split("/")[0] !== target.split("/")[0]);

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
    expect(clusters[""]).toEqual({ label: "My Vault", color: CLUSTER_PALETTE[0], drillable: false });
    expect(clusters["a"]).toEqual({ label: "a", color: CLUSTER_PALETTE[1], drillable: false });
    expect(clusters["b"]).toEqual({ label: "b", color: CLUSTER_PALETTE[2], drillable: false });
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
      outsideLinks: 0,
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

  it("marks a root cluster drillable only when it has sub-folders", () => {
    const g = graph([
      vnode("Areas/Health/diet.md"),
      vnode("Areas/direct.md"),
      vnode("Inbox/loose.md"),
      vnode("root.md"),
    ]);
    const { clusters } = toGalaxy(g, "r");
    expect(clusters["Areas"].drillable).toBe(true); // has Areas/Health/
    expect(clusters["Inbox"].drillable).toBe(false); // files only
    expect(clusters[""].drillable).toBe(false); // the current folder's own notes
  });
});

// ── Cluster drill-down: toGalaxy(graph, rootLabel, focusPath) ──────────────
describe("toGalaxy with a focusPath", () => {
  // Two-level fixture: Areas has sub-folders (Health, Gym), Inbox is flat.
  const drillGraph = () =>
    graph(
      [
        vnode("Areas/overview.md"),
        vnode("Areas/Health/diet.md"),
        vnode("Areas/Health/sleep.md"),
        vnode("Areas/Health/Deep/protocols.md"),
        vnode("Areas/Gym/plan.md"),
        vnode("AreasX/decoy.md"),
        vnode("Inbox/loose.md"),
        vnode("root.md"),
      ],
      [
        vlink("Areas/Health/diet.md", "Areas/Health/sleep.md"),
        vlink("Areas/Health/diet.md", "Areas/Gym/plan.md"),
        vlink("Areas/overview.md", "Areas/Health/diet.md"),
        vlink("Areas/Health/sleep.md", "Inbox/loose.md"),
        vlink("root.md", "AreasX/decoy.md"),
      ],
    );

  it("filters to nodes strictly under the focus path — segment-aligned, no false prefixes", () => {
    const { data } = toGalaxy(drillGraph(), "r", "Areas");
    expect(data.nodes.map((n) => n.id).sort()).toEqual([
      "Areas/Gym/plan.md",
      "Areas/Health/Deep/protocols.md",
      "Areas/Health/diet.md",
      "Areas/Health/sleep.md",
      "Areas/overview.md",
    ]); // AreasX/decoy.md must NOT ride in on the string prefix
    // Only links with both endpoints inside survive.
    expect(data.links).toHaveLength(3);
    expect(data.links.map((l) => `${l.source}→${l.target}`).sort()).toEqual([
      "Areas/Health/diet.md→Areas/Gym/plan.md",
      "Areas/Health/diet.md→Areas/Health/sleep.md",
      "Areas/overview.md→Areas/Health/diet.md",
    ]);
  });

  it("clusters by the NEXT path segment; direct notes get '' labeled with the folder's name", () => {
    const { data, clusters } = toGalaxy(drillGraph(), "My Vault", "Areas");
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    expect(byId.get("Areas/overview.md")?.cluster).toBe("");
    expect(byId.get("Areas/Health/diet.md")?.cluster).toBe("Health");
    expect(byId.get("Areas/Health/Deep/protocols.md")?.cluster).toBe("Health");
    expect(byId.get("Areas/Gym/plan.md")?.cluster).toBe("Gym");
    // "" is labeled by the focused folder's display name, not the vault root.
    expect(clusters[""].label).toBe("Areas");
    expect(clusters["Health"].label).toBe("Health");
  });

  it("labels '' with the LAST segment of a nested focus path", () => {
    const { clusters } = toGalaxy(drillGraph(), "My Vault", "Areas/Health");
    expect(clusters[""].label).toBe("Health");
  });

  it("reassigns the palette per level: '' first, then folder names in code-unit order", () => {
    const { clusters } = toGalaxy(drillGraph(), "r", "Areas");
    expect(Object.keys(clusters)).toEqual(["", "Gym", "Health"]);
    expect(clusters[""].color).toBe(CLUSTER_PALETTE[0]);
    expect(clusters["Gym"].color).toBe(CLUSTER_PALETTE[1]);
    expect(clusters["Health"].color).toBe(CLUSTER_PALETTE[2]);
  });

  it("recomputes bridges at the current level: root output equals the backend flag", () => {
    const g = drillGraph();
    const { data } = toGalaxy(g, "r");
    const backendBridge = new Map(g.links.map((l) => [`${l.source}→${l.target}`, l.bridge]));
    for (const l of data.links) {
      expect(l.bridge).toBe(backendBridge.get(`${l.source}→${l.target}`));
    }
  });

  it("ignores the backend bridge flag — a bogus flag is corrected by the recompute", () => {
    const g = graph(
      [vnode("a/one.md"), vnode("a/two.md")],
      [link("a/one.md", "a/two.md", true)], // backend lied: same folder
    );
    expect(toGalaxy(g, "r").data.links[0].bridge).toBe(false);
  });

  it("flips bridges at a deeper level: same top folder, different sub-folders", () => {
    const { data, stats } = toGalaxy(drillGraph(), "r", "Areas");
    const byPair = new Map(data.links.map((l) => [`${l.source}→${l.target}`, l.bridge]));
    // Health↔Gym crosses the CURRENT boundary — a bridge here, not at root.
    expect(byPair.get("Areas/Health/diet.md→Areas/Gym/plan.md")).toBe(true);
    // Intra-Health stays a normal link.
    expect(byPair.get("Areas/Health/diet.md→Areas/Health/sleep.md")).toBe(false);
    // Direct note ("") ↔ Health crosses the boundary too.
    expect(byPair.get("Areas/overview.md→Areas/Health/diet.md")).toBe(true);
    expect(stats.crossFolderLinks).toBe(2);
  });

  it("counts outsideLinks: links with exactly ONE endpoint inside the filtered set", () => {
    const { stats } = toGalaxy(drillGraph(), "r", "Areas");
    // Areas/Health/sleep.md → Inbox/loose.md is the only one-foot-in link.
    expect(stats.outsideLinks).toBe(1);
    expect(stats.notes).toBe(5);
    expect(stats.links).toBe(3);
    // At root nothing is outside.
    expect(toGalaxy(drillGraph(), "r").stats.outsideLinks).toBe(0);
  });

  it("flags drillability per level: sub-sub-folders drill, flat sub-folders don't", () => {
    const { clusters } = toGalaxy(drillGraph(), "r", "Areas");
    expect(clusters["Health"].drillable).toBe(true); // has Health/Deep/
    expect(clusters["Gym"].drillable).toBe(false); // files only
    expect(clusters[""].drillable).toBe(false);
  });

  it("sizes nodes by their degree WITHIN the filtered view, not the global graph", () => {
    // sleep.md has 2 links globally but only 1 inside Areas — the isolated
    // view's sizes must match the links it actually shows.
    const { data } = toGalaxy(drillGraph(), "r", "Areas");
    const sleep = data.nodes.find((n) => n.id === "Areas/Health/sleep.md");
    expect(sleep?.val).toBe(degreeVal(1));
    const diet = data.nodes.find((n) => n.id === "Areas/Health/diet.md");
    expect(diet?.val).toBe(degreeVal(3));
  });

  it("returns the empty shape for a focus path with no notes under it", () => {
    expect(toGalaxy(drillGraph(), "r", "Nope")).toEqual({
      data: { nodes: [], links: [] },
      clusters: {},
      stats: { notes: 0, links: 0, crossFolderLinks: 0, outsideLinks: 0 },
      truncation: null,
    });
  });
});

// ── Node cap (PA-006): the first (root) render must never hand the 3D force
// sim an unbounded vault — above the cap only the most-linked nodes render,
// and the view is told so via `truncation`. ────────────────────────────────
describe("toGalaxy node cap", () => {
  it("reports no truncation while at or under the cap", () => {
    const g = graph([node("a.md"), node("b.md")], [link("a.md", "b.md")]);
    expect(toGalaxy(g, "r").truncation).toBeNull();
    // Exactly at the cap is still the full view.
    expect(toGalaxy(g, "r", "", 2).truncation).toBeNull();
  });

  it("keeps the top-N nodes by degree and reports shown/total", () => {
    // hub links to three spokes; two isolates carry no links at all.
    const g = graph(
      [node("hub.md"), node("s1.md"), node("s2.md"), node("s3.md"), node("iso1.md"), node("iso2.md")],
      [link("hub.md", "s1.md"), link("hub.md", "s2.md"), link("hub.md", "s3.md")],
    );
    const view = toGalaxy(g, "r", "", 4);
    expect(view.data.nodes.map((n) => n.id).sort()).toEqual([
      "hub.md",
      "s1.md",
      "s2.md",
      "s3.md",
    ]);
    expect(view.data.links).toHaveLength(3);
    expect(view.truncation).toEqual({ shown: 4, total: 6 });
    expect(view.stats.notes).toBe(4);
    expect(view.stats.links).toBe(3);
  });

  it("breaks degree ties deterministically by id (code-unit order)", () => {
    const g = graph([node("c.md"), node("a.md"), node("b.md")]);
    const view = toGalaxy(g, "r", "", 2);
    expect(view.data.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md"]);
  });

  it("drops links to capped-out nodes and re-derives vals from the shown links", () => {
    // hub: degree 3 (s1, s2, s3); s1–s2 link raises those two above s3.
    const g = graph(
      [node("hub.md"), node("s1.md"), node("s2.md"), node("s3.md")],
      [
        link("hub.md", "s1.md"),
        link("hub.md", "s2.md"),
        link("hub.md", "s3.md"),
        link("s1.md", "s2.md"),
      ],
    );
    const view = toGalaxy(g, "r", "", 3);
    expect(view.data.nodes.map((n) => n.id).sort()).toEqual(["hub.md", "s1.md", "s2.md"]);
    // hub–s3 vanished with s3; sizes match the links actually shown.
    expect(view.data.links).toHaveLength(3);
    const hub = view.data.nodes.find((n) => n.id === "hub.md");
    expect(hub?.val).toBe(degreeVal(2));
    expect(view.truncation).toEqual({ shown: 3, total: 4 });
  });

  it("keeps the FULL clusters record so every folder stays navigable", () => {
    // Cap cuts all of y/'s notes (degree 0) — its legend entry must survive,
    // since drilling re-derives that level uncapped-then-capped.
    const g = graph(
      [node("x/one.md", "x"), node("x/two.md", "x"), node("y/three.md", "y")],
      [link("x/one.md", "x/two.md")],
    );
    const view = toGalaxy(g, "r", "", 2);
    expect(view.data.nodes.map((n) => n.id).sort()).toEqual(["x/one.md", "x/two.md"]);
    expect(Object.keys(view.clusters)).toContain("y");
  });
});
