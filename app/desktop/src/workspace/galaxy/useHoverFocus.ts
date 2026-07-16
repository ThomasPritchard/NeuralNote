import { useCallback, useEffect, useReducer, useRef } from "react";
import type { GalaxyLink, GalaxyNode } from "./graph";
import { endpointId } from "./galaxyLinks";
import { applyFocus, setHover } from "./nodeRegistry";

/** A node's direct neighbours (both directions) with the cross-folder flag. */
export type Adjacency = Map<string, { id: string; bridge: boolean }[]>;

interface HoverFocusArgs {
  adjacency: Adjacency;
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  selected: GalaxyNode | null;
}

export interface HoverFocus {
  /** Legend-row hover preview: lights the whole cluster, dims the rest.
   *  `null` (pointer leave) falls back to the node-hover/selection focus. */
  previewCluster: (cluster: string | null) => void;
  /** Node focus: a link keeps full styling only while it touches the origin
   *  (the hovered↔neighbour links, not neighbour↔neighbour strays). Cluster
   *  preview: lit while BOTH endpoints sit inside the cluster. */
  isLinkLit: (l: any) => boolean;
  /** Hover-glow + hover-focus retarget for the hovered node (or null on leave). */
  onNodeHover: (node: any) => void;
}

// ── Hover-focus (Obsidian-style) ─────────────────────────────────────────
// ONE focus channel, last event wins. Two kinds of focus feed it:
//  · node focus  — origin = the hovered node, else the selected node; the
//    lit set is the origin + its direct neighbours.
//  · cluster preview — hovering a legend row; NO single origin, the lit set
//    is the whole cluster (origin: null).
// Node dims retarget GPU-side through the registry — no React work per node.
// The epoch bump exists ONLY for the links: a re-render hands the library a
// fresh linkColor accessor identity, which re-runs its link digest (recolour
// in place). fg.refresh() is NOT used — it flushes the node data mapper, which
// would rebuild every star object and snap the eased dims.
export function useHoverFocus({ adjacency, data, selected }: HoverFocusArgs): HoverFocus {
  const hoveredRef = useRef<Set<string>>(new Set());
  const hoverOriginRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const previewClusterRef = useRef<string | null>(null);
  const focusRef = useRef<{ key: string; origin: string | null; lit: Set<string> } | null>(null);
  // The canonical React force-update idiom: the counter's value is never read
  // (dispatch just schedules the re-render the comment above explains).
  const [, bumpFocusEpoch] = useReducer((n: number) => n + 1, 0);

  const refreshFocus = useCallback(() => {
    const preview = previewClusterRef.current;
    const origin = preview === null ? (hoverOriginRef.current ?? selectedIdRef.current) : null;
    // "cluster:"/"node:" prefixes keep the two focus kinds from colliding.
    let key: string | null;
    if (preview === null) {
      key = origin === null ? null : `node:${origin}`;
    } else {
      key = `cluster:${preview}`;
    }
    if ((focusRef.current?.key ?? null) === key) return;
    if (key === null) {
      focusRef.current = null;
    } else if (preview === null) {
      const o = origin as string;
      focusRef.current = {
        key,
        origin: o,
        lit: new Set([o, ...(adjacency.get(o) ?? []).map((nb) => nb.id)]),
      };
    } else {
      focusRef.current = {
        key,
        origin: null,
        lit: new Set(data.nodes.filter((n) => n.cluster === preview).map((n) => n.id)),
      };
    }
    applyFocus(focusRef.current?.lit ?? null);
    bumpFocusEpoch();
  }, [adjacency, data]);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    refreshFocus();
  }, [selected, refreshFocus]);

  const previewCluster = useCallback(
    (cluster: string | null) => {
      previewClusterRef.current = cluster;
      refreshFocus();
    },
    [refreshFocus],
  );

  const isLinkLit = useCallback((l: any) => {
    const f = focusRef.current;
    if (!f) return true;
    if (f.origin !== null) {
      return endpointId(l.source) === f.origin || endpointId(l.target) === f.origin;
    }
    return f.lit.has(endpointId(l.source)) && f.lit.has(endpointId(l.target));
  }, []);

  // Hover-glow + hover-focus: brighten the hovered node and its direct
  // neighbours, and retarget the focus dim (everything else fades back).
  const onNodeHover = useCallback(
    (node: any) => {
      hoveredRef.current.forEach((id) => setHover(id, false));
      hoveredRef.current.clear();
      if (node) {
        setHover(node.id, true);
        hoveredRef.current.add(node.id);
        for (const nb of adjacency.get(node.id) ?? []) {
          setHover(nb.id, true);
          hoveredRef.current.add(nb.id);
        }
      }
      hoverOriginRef.current = node ? node.id : null;
      // Shared focus channel: a real node hover takes over from a legend
      // preview — but a spurious onHover(null) (the sim drifting a node out
      // from under the last raycast position) must not wipe an active preview.
      if (node) previewClusterRef.current = null;
      refreshFocus();
    },
    [adjacency, refreshFocus],
  );

  return { previewCluster, isLinkLit, onNodeHover };
}
