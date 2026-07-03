// Pure transform: backend link graph → the decorated shape NeuralGalaxy
// renders (cluster palette, degree-based node size, cross-folder bridges).
// Emits FRESH plain objects on every call — the force simulation and the 2D
// morph mutate node objects in place, so a payload must never be shared
// between mounts (see galaxy/graph.ts).
//
// Cluster drill-down (spec §Addendum): `focusPath` narrows the view to one
// folder. Clusters, bridges, degree-based sizes, and stats all re-derive at
// that level — a "bridge" always means "crosses the CURRENT boundary". The
// backend's `cluster`/`bridge` fields are therefore ignored here (they stay
// on the wire for other consumers); at root the derivation matches them by
// construction, which graphTransform.test.ts pins.

import type { LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE, type GalaxyLink, type GalaxyNode } from "./galaxy/graph";

export interface GalaxyView {
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  clusters: Record<string, { label: string; color: string; drillable: boolean }>;
  stats: { notes: number; links: number; crossFolderLinks: number; outsideLinks: number };
}

// val = 2.5 + 2.2·√degree, capped at 17. Sub-linear so a well-linked note
// grows steadily but a degree-40 MOC still dwarfs a degree-6 note (the old
// linear cap-8 mapping squashed them to nearly the same size). Degree 12
// crosses the HUB_VAL=10 hub-text gate in galaxy/nodeChrome.ts — pinned by
// graphTransform.test.ts so neither side drifts alone.
const VAL_FLOOR = 2.5;
const VAL_PER_SQRT_LINK = 2.2;
const VAL_CAP = 17;

/** Degree → render size. Pure seam so the galaxy's size story is testable. */
export function degreeVal(degree: number): number {
  return Math.min(VAL_FLOOR + VAL_PER_SQRT_LINK * Math.sqrt(degree), VAL_CAP);
}

/** Code-unit comparator matching the default `.sort()` ordering — NOT
 *  localeCompare, which is locale-dependent and would unpin the deterministic
 *  palette assignment below. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** True when `id` lives strictly under `focusPath` — segment-aligned, so
 *  "Areas/x.md" is under "Areas" but "AreasX/y.md" is not. "" = vault root. */
function isUnder(id: string, focusPath: string): boolean {
  return focusPath === "" || id.startsWith(`${focusPath}/`);
}

/** The id's path relative to the focused folder ("" = whole id at root). */
function relToFocus(id: string, focusPath: string): string {
  return focusPath === "" ? id : id.slice(focusPath.length + 1);
}

/** Cluster at the current level = the NEXT path segment under the focus;
 *  "" for notes sitting directly in the focused folder (or vault root). */
function clusterAtLevel(id: string, focusPath: string): string {
  const rest = relToFocus(id, focusPath);
  const slash = rest.indexOf("/");
  return slash === -1 ? "" : rest.slice(0, slash);
}

/** What the "" cluster is called: the vault at root, else the focused folder. */
function currentFolderLabel(rootLabel: string, focusPath: string): string {
  return focusPath === "" ? rootLabel : focusPath.slice(focusPath.lastIndexOf("/") + 1);
}

export function toGalaxy(graph: LinkGraph, rootLabel: string, focusPath = ""): GalaxyView {
  // ── Filter to the focused folder + derive this level's cluster per node ──
  const clusterById = new Map<string, string>();
  const drillable = new Map<string, boolean>();
  for (const n of graph.nodes) {
    if (!isUnder(n.id, focusPath)) continue;
    const cluster = clusterAtLevel(n.id, focusPath);
    clusterById.set(n.id, cluster);
    // A cluster drills when any of its notes sits deeper than one level —
    // "Areas/Health/x.md" makes "Health" drillable at focus "Areas"; the ""
    // group (the folder's own notes) never drills.
    const deeper =
      cluster !== "" && relToFocus(n.id, focusPath).includes("/", cluster.length + 1);
    drillable.set(cluster, (drillable.get(cluster) ?? false) || deeper);
  }

  const innerLinks = graph.links.filter(
    (l) => clusterById.has(l.source) && clusterById.has(l.target),
  );
  const outsideLinks = graph.links.filter(
    (l) => clusterById.has(l.source) !== clusterById.has(l.target),
  ).length;

  // ── Palette reassigns per level: "" first, then folders in code-unit order.
  const names = [...drillable.keys()].sort(byCodeUnit);
  const clusters: GalaxyView["clusters"] = {};
  names.forEach((name, i) => {
    clusters[name] = {
      label: name === "" ? currentFolderLabel(rootLabel, focusPath) : name,
      color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length],
      drillable: drillable.get(name) ?? false,
    };
  });

  // ── Degree within the view: node sizes match the links actually shown.
  const degree = new Map<string, number>();
  for (const l of innerLinks) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const nodes: GalaxyNode[] = graph.nodes
    .filter((n) => clusterById.has(n.id))
    .map((n) => {
      const cluster = clusterById.get(n.id) as string;
      return {
        id: n.id,
        title: n.title,
        cluster,
        val: degreeVal(degree.get(n.id) ?? 0),
        color: clusters[cluster].color,
      };
    });

  // Bridge = crosses the current level's cluster boundary (backend flag ignored).
  const links: GalaxyLink[] = innerLinks.map((l) => ({
    source: l.source,
    target: l.target,
    bridge: clusterById.get(l.source) !== clusterById.get(l.target),
  }));

  return {
    data: { nodes, links },
    clusters,
    stats: {
      notes: nodes.length,
      links: links.length,
      crossFolderLinks: links.filter((l) => l.bridge).length,
      outsideLinks,
    },
  };
}
