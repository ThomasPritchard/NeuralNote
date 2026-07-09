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

import type { GraphLink, GraphNode, LinkGraph } from "../lib/types";
import { CLUSTER_PALETTE, type GalaxyLink, type GalaxyNode } from "./galaxy/graph";

export interface GalaxyView {
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  clusters: Record<string, { label: string; color: string; drillable: boolean }>;
  stats: { notes: number; links: number; crossFolderLinks: number; outsideLinks: number };
  /** Non-null when the node cap trimmed this level: `shown` of `total` notes
   *  are rendered (the most-linked ones). The view surfaces this honestly —
   *  a silently partial galaxy would misread as the whole vault. */
  truncation: { shown: number; total: number } | null;
}

/** Hard ceiling on nodes handed to the 3D force sim per level (PA-006). The
 *  uncapped root view of a several-thousand-note vault is slow to stabilise
 *  and can stutter the whole window; above the cap we keep the most-linked
 *  nodes (the vault's structure) and say so. Drill-down re-derives per level,
 *  so folder views regain their full contents once under the cap. */
export const GALAXY_NODE_CAP = 500;

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

/** Filter to notes under `focusPath` and, per surviving note, derive this
 *  level's cluster. A cluster drills when any of its notes sits deeper than one
 *  level BELOW the cluster itself: at focus "Areas", "Areas/Health/x.md" only
 *  makes "Health" isolatable — "Areas/Health/Deep/x.md" is what makes "Health"
 *  drillable. The "" group (the folder's own notes) never drills. */
function deriveClusters(
  nodes: GraphNode[],
  focusPath: string,
): { clusterById: Map<string, string>; drillable: Map<string, boolean> } {
  const clusterById = new Map<string, string>();
  const drillable = new Map<string, boolean>();
  for (const n of nodes) {
    if (!isUnder(n.id, focusPath)) continue;
    const cluster = clusterAtLevel(n.id, focusPath);
    clusterById.set(n.id, cluster);
    const deeper =
      cluster !== "" && relToFocus(n.id, focusPath).includes("/", cluster.length + 1);
    drillable.set(cluster, (drillable.get(cluster) ?? false) || deeper);
  }
  return { clusterById, drillable };
}

/** Split the graph's links against the focused set: `innerLinks` have both
 *  endpoints inside; `outsideLinks` counts those with exactly one foot in. */
function partitionLinks(
  links: GraphLink[],
  clusterById: Map<string, string>,
): { innerLinks: GraphLink[]; outsideLinks: number } {
  const innerLinks = links.filter(
    (l) => clusterById.has(l.source) && clusterById.has(l.target),
  );
  const outsideLinks = links.filter(
    (l) => clusterById.has(l.source) !== clusterById.has(l.target),
  ).length;
  return { innerLinks, outsideLinks };
}

/** Assign each cluster a palette colour, reassigned per level: "" first, then
 *  folder names in code-unit order (deterministic so colours never flicker). */
function assignPalette(
  drillable: Map<string, boolean>,
  rootLabel: string,
  focusPath: string,
): GalaxyView["clusters"] {
  const names = [...drillable.keys()].sort(byCodeUnit);
  const clusters: GalaxyView["clusters"] = {};
  names.forEach((name, i) => {
    clusters[name] = {
      label: name === "" ? currentFolderLabel(rootLabel, focusPath) : name,
      color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length],
      drillable: drillable.get(name) ?? false,
    };
  });
  return clusters;
}

/** Count each node's degree (endpoints touched) across a set of links. */
function computeDegree(links: GraphLink[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return degree;
}

/** Node cap (PA-006): above `maxNodes`, keep the most-linked nodes and drop
 *  links to the cut ones. Deterministic: degree desc, then id code-unit asc, so
 *  equal-degree ties never flicker between renders. `shownIds` is null when
 *  nothing was trimmed; the clusters record is left UNCUT by design so the
 *  legend keeps every folder navigable and drilling re-derives that level. */
function applyNodeCap(
  clusterById: Map<string, string>,
  degree: Map<string, number>,
  innerLinks: GraphLink[],
  maxNodes: number,
): { shownIds: Set<string> | null; shownLinks: GraphLink[]; total: number } {
  const total = clusterById.size;
  const shownIds =
    total > maxNodes
      ? new Set(
          [...clusterById.keys()]
            .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byCodeUnit(a, b))
            .slice(0, maxNodes),
        )
      : null;
  const shownLinks = shownIds
    ? innerLinks.filter((l) => shownIds.has(l.source) && shownIds.has(l.target))
    : innerLinks;
  return { shownIds, shownLinks, total };
}

/** Decorate each shown node with its cluster, palette colour, and degree-based
 *  size (`degreeVal` over `shownDegree`, i.e. the links actually rendered). */
function buildNodes(
  nodes: GraphNode[],
  clusterById: Map<string, string>,
  shownIds: Set<string> | null,
  shownDegree: Map<string, number>,
  clusters: GalaxyView["clusters"],
): GalaxyNode[] {
  return nodes
    .filter((n) => clusterById.has(n.id) && (shownIds === null || shownIds.has(n.id)))
    .map((n) => {
      const cluster = clusterById.get(n.id) as string;
      return {
        id: n.id,
        title: n.title,
        cluster,
        val: degreeVal(shownDegree.get(n.id) ?? 0),
        color: clusters[cluster].color,
      };
    });
}

/** Map shown links to render edges, flagging bridges that cross the CURRENT
 *  level's cluster boundary (the backend's bridge flag is ignored — see head). */
function buildLinks(shownLinks: GraphLink[], clusterById: Map<string, string>): GalaxyLink[] {
  return shownLinks.map((l) => ({
    source: l.source,
    target: l.target,
    bridge: clusterById.get(l.source) !== clusterById.get(l.target),
  }));
}

/** Roll up the view's counts. `outsideLinks` keeps focus-boundary semantics on
 *  purpose (links leaving the FOLDER, not links to capped-out nodes — the
 *  truncation notice carries the cap story). */
function buildGalaxyStats(
  nodes: GalaxyNode[],
  links: GalaxyLink[],
  outsideLinks: number,
): GalaxyView["stats"] {
  return {
    notes: nodes.length,
    links: links.length,
    crossFolderLinks: links.filter((l) => l.bridge).length,
    outsideLinks,
  };
}

export function toGalaxy(
  graph: LinkGraph,
  rootLabel: string,
  focusPath = "",
  maxNodes = GALAXY_NODE_CAP,
): GalaxyView {
  const { clusterById, drillable } = deriveClusters(graph.nodes, focusPath);
  const { innerLinks, outsideLinks } = partitionLinks(graph.links, clusterById);
  const clusters = assignPalette(drillable, rootLabel, focusPath);

  // Degree ranks the cap pre-cap, over the level's full link structure; a
  // capped view then re-derives it over the surviving links so node sizes match
  // the links actually shown. Uncapped, the first map is reused unchanged.
  const degree = computeDegree(innerLinks);
  const { shownIds, shownLinks, total } = applyNodeCap(clusterById, degree, innerLinks, maxNodes);
  const shownDegree = shownIds ? computeDegree(shownLinks) : degree;

  const nodes = buildNodes(graph.nodes, clusterById, shownIds, shownDegree, clusters);
  const links = buildLinks(shownLinks, clusterById);

  return {
    data: { nodes, links },
    clusters,
    stats: buildGalaxyStats(nodes, links, outsideLinks),
    truncation: shownIds ? { shown: nodes.length, total } : null,
  };
}
