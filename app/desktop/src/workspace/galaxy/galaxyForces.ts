// ── Galaxy layout physics ────────────────────────────────────────────────
// Layout physics + link visibility per view. Tuned headlessly at real-vault
// scale (~765 notes / ~1435 links) against an "Obsidian-like" bar for the 2D
// map: one cohesive connected web with readable sub-clusters, islands pulled
// near the main mass, and the link web visible at overview. The 3D galaxy
// keeps more spread but must never scatter disconnected islands to infinity.
// Applied on init and re-applied on every 2D↔3D morph (see applyForceProfile).
// Hand-tweak values here — everything layout-physics lives in this module.

// The app background the galaxy scene paints over.
export const BG = "#0a0913";

export type ViewMode = "3d" | "2d";

export const MORPH_MS = 1100;
export const FOV_2D = 20; // narrow lens ≈ orthographic once the dolly-zoom lands

export interface ForceProfile {
  /** forceManyBody repulsion (negative). More negative = airier layout. */
  chargeStrength: number;
  /** Repulsion range cap. Without it, disconnected components repel forever
   *  and drift to the viewport edges; a few hundred units keeps them in orbit. */
  chargeDistanceMax: number;
  /** Link rest length — smaller pulls connected notes into a tighter web. */
  linkDistance: number;
  /** Positional gravity toward the origin (forceX/Y-style, target 0). The only
   *  force that pulls disconnected islands/orphans back toward the mass. The
   *  flat 2D map needs more of it than the 3D galaxy. */
  gravityStrength: number;
  /** Normal (same-folder) link styling. Bridges stay pink in both views. */
  linkAlpha: number;
  linkWidth: number;
  /** Cross-folder bridge width — keep > linkWidth so bridges read stronger. */
  bridgeWidth: number;
}

export const FORCE_PROFILES: Record<ViewMode, ForceProfile> = {
  "3d": {
    chargeStrength: -80,
    chargeDistanceMax: 500,
    linkDistance: 45,
    gravityStrength: 0.04,
    linkAlpha: 0.3,
    linkWidth: 0.5,
    bridgeWidth: 0.8,
  },
  "2d": {
    chargeStrength: -60,
    chargeDistanceMax: 400,
    linkDistance: 36,
    gravityStrength: 0.055,
    linkAlpha: 0.42,
    linkWidth: 0.8,
    bridgeWidth: 1.1,
  },
};

/** Simulation node as d3-force-3d sees it: positions + velocities are live. */
export type SimNode = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
};

// Positional gravity toward the origin — the same math as d3's forceX(0)/
// forceY(0) (+ forceZ in 3D), written as a tiny custom force so we don't
// import the untyped, transitive d3-force-3d package. `d3Force(name, fn)`
// accepts any function force with an `initialize` hook.
export function makeGravity(strength: number, withZ: boolean) {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    const k = strength * alpha;
    for (const n of nodes) {
      n.vx -= n.x * k;
      n.vy -= n.y * k;
      if (withZ) n.vz -= (n.z ?? 0) * k;
    }
  };
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
  };
  return force;
}

/** Point the live simulation at a view's physics (init + every view morph).
 *  z-gravity only exists in 3D: the 2D morph pins fz=0, so a z pull is inert. */
export function applyForceProfile(fg: any, mode: ViewMode) {
  const p = FORCE_PROFILES[mode];
  fg.d3Force("charge")?.strength(p.chargeStrength).distanceMax(p.chargeDistanceMax);
  fg.d3Force("link")?.distance(p.linkDistance);
  fg.d3Force("gravity", makeGravity(p.gravityStrength, mode === "3d"));
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}
