// Deterministic synthetic LinkGraph fixtures for the graph-view perf budget
// (issue #39). No randomness: the graph is constructed structurally, so a
// benchmark over it is reproducible run-to-run and machine-to-machine.
//
// Shape mirrors a real Obsidian vault: notes live in top-level folders
// (clusters), each folder has a "map of content" hub every note links to
// (so degree is skewed — hubs high, leaves low, exactly what the node cap
// ranks on), and a deterministic subset of notes bridge to the next folder's
// hub (cross-folder links). The hub ring adds structural cross-cluster degree.

import type { GraphLink, GraphNode, LinkGraph } from "../lib/types";

/** Folders in the default large fixture. Zero-padded so code-unit sort order
 *  (the transform's deterministic tie-break) matches numeric order. */
export const LARGE_VAULT_CLUSTERS = 20;
/** Notes per folder (1 hub + the rest leaves). 20 × 120 = 2,400 notes, safely
 *  over the issue's ≥2,000 bar and over the 500-node `GALAXY_NODE_CAP`. */
export const LARGE_VAULT_NOTES_PER_CLUSTER = 120;
/** Every Nth leaf bridges to the next folder's hub — the cross-folder links. */
const BRIDGE_EVERY = 10;

const folderName = (cluster: number): string => `folder-${String(cluster).padStart(2, "0")}`;
/** Hub id sorts first in its folder ("00-map"), so ties in the fixture are
 *  stable regardless of how many leaves precede it. */
const hubId = (cluster: number): string => `${folderName(cluster)}/00-map.md`;
const leafId = (cluster: number, leaf: number): string =>
  `${folderName(cluster)}/note-${String(leaf).padStart(3, "0")}.md`;

/** First path segment = cluster, matching the backend `GraphNode.cluster`
 *  contract the real read_link_graph emits. */
const toNode = (id: string): GraphNode => ({ id, title: id, cluster: id.slice(0, id.indexOf("/")) });

const toLink = (source: string, target: string): GraphLink => ({
  source,
  target,
  bridge: source.slice(0, source.indexOf("/")) !== target.slice(0, target.indexOf("/")),
});

/**
 * Build a deterministic synthetic vault link graph.
 *
 * @param clusters - number of top-level folders (each a cluster)
 * @param notesPerCluster - notes per folder, including its hub
 * @returns a {@link LinkGraph} with `clusters × notesPerCluster` nodes, hub-and-
 *   spoke intra-folder links, a hub ring, and periodic cross-folder bridges
 */
export function buildSyntheticVault(
  clusters = LARGE_VAULT_CLUSTERS,
  notesPerCluster = LARGE_VAULT_NOTES_PER_CLUSTER,
): LinkGraph {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  for (let cluster = 0; cluster < clusters; cluster += 1) {
    nodes.push(toNode(hubId(cluster)));
    // Hub ring: each folder's hub links to the next folder's hub (wraps).
    links.push(toLink(hubId(cluster), hubId((cluster + 1) % clusters)));

    for (let leaf = 1; leaf < notesPerCluster; leaf += 1) {
      const id = leafId(cluster, leaf);
      nodes.push(toNode(id));
      links.push(toLink(id, hubId(cluster)));
      if (leaf % BRIDGE_EVERY === 0) {
        links.push(toLink(id, hubId((cluster + 1) % clusters)));
      }
    }
  }

  return { nodes, links, skippedFiles: 0 };
}

/** The reproducible ≥2,000-note fixture used by the perf budget test. */
export const largeVault = (): LinkGraph => buildSyntheticVault();
