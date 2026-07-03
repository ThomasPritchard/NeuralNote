// Render-layer graph types for the 3D neural galaxy. The backend link graph
// (lib/types.ts GraphNode/GraphLink) is transformed into these decorated
// shapes by workspace/graphTransform.ts before it reaches NeuralGalaxy.
//
// IMPORTANT: a `{ nodes, links }` payload of these types is treated as
// IMMUTABLE for the lifetime of a NeuralGalaxy mount, but the d3 force
// simulation and the 2D morph MUTATE the node objects in place (positions,
// pins, `__z3d`). Never share node objects across mounts — refetch/re-transform
// means remount (graphTransform emits fresh objects on every call).

export interface GalaxyNode {
  /** Vault-relative path — the stable id shared with TreeNode.relPath. */
  id: string;
  title: string;
  /** Top-level folder name; "" for vault-root notes. */
  cluster: string;
  /** Relative size (degree-derived; >= HUB_VAL reads as a cluster hub). */
  val: number;
  color: string;
  // Written by the force simulation / 2D morph at runtime — never by callers.
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  /** 3D z stashed while the 2D morph flattens the layout (see animateMorph). */
  __z3d?: number;
}

export interface GalaxyLink {
  source: string;
  target: string;
  /** Cross-folder link: endpoints live in different clusters. */
  bridge?: boolean;
}

// Cluster accent colours (assigned round-robin by graphTransform).
// Colours tuned for even luminance so no cluster blows out to white under
// bloom (cyan / green / amber were intrinsically brighter than violet / pink).
export const CLUSTER_PALETTE = ["#7d6fe0", "#2f9d93", "#d83f86", "#cc8533", "#4ba87c"];
