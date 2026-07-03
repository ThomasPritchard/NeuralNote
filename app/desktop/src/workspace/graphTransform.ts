// Pure transform: backend link graph → the decorated shape NeuralGalaxy
// renders (cluster palette, degree-based node size, cross-folder bridges).
// Emits FRESH plain objects on every call — the force simulation and the 2D
// morph mutate node objects in place, so a payload must never be shared
// between mounts (see galaxy/graph.ts).

import type { LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE, type GalaxyLink, type GalaxyNode } from "./galaxy/graph";

export interface GalaxyView {
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  clusters: Record<string, { label: string; color: string }>;
  stats: { notes: number; links: number; crossFolderLinks: number };
}

// val = 2.5 + 0.75·degree, capped: degree 6 lands exactly on the HUB_VAL=7
// hub-label threshold in galaxy/nodeChrome.ts, so ≥6 links reads as a hub.
const VAL_FLOOR = 2.5;
const VAL_PER_LINK = 0.75;
const VAL_CAP = 8;

/** Code-unit comparator matching the default `.sort()` ordering — NOT
 *  localeCompare, which is locale-dependent and would unpin the deterministic
 *  palette assignment below. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Cluster keys sorted with the vault root ("") first, then folder names. */
function clusterRecord(
  graph: LinkGraph,
  rootLabel: string,
): Record<string, { label: string; color: string }> {
  const names = [...new Set(graph.nodes.map((n) => n.cluster))].sort(byCodeUnit);
  const clusters: Record<string, { label: string; color: string }> = {};
  names.forEach((name, i) => {
    clusters[name] = {
      label: name === "" ? rootLabel : name,
      color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length],
    };
  });
  return clusters;
}

export function toGalaxy(graph: LinkGraph, rootLabel: string): GalaxyView {
  const clusters = clusterRecord(graph, rootLabel);

  const degree = new Map<string, number>();
  for (const l of graph.links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const nodes: GalaxyNode[] = graph.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    cluster: n.cluster,
    val: Math.min(VAL_FLOOR + VAL_PER_LINK * (degree.get(n.id) ?? 0), VAL_CAP),
    color: clusters[n.cluster].color,
  }));

  const links: GalaxyLink[] = graph.links.map((l) => ({
    source: l.source,
    target: l.target,
    bridge: l.bridge,
  }));

  return {
    data: { nodes, links },
    clusters,
    stats: {
      notes: graph.nodes.length,
      links: graph.links.length,
      crossFolderLinks: graph.links.filter((l) => l.bridge).length,
    },
  };
}
