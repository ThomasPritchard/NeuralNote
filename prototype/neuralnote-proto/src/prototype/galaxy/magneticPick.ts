// Magnetic (screen-space) picking — experimental, behind ?pick=magnet.
//
// Instead of raycasting geometry, every pointer move projects all node
// positions to screen space and snaps hover to the best candidate near the
// cursor. This is how canvas graph tools (Figma, map apps) feel: you stop
// aiming at pixels and the target comes to you. It replaces the library's
// raycast picking entirely while the flag is on.

export interface PickCandidate {
  node: any; //  graph node carrying live x/y/z from the simulation
  px: number; // screen-space distance from the cursor, in pixels
  depth: number; // NDC depth, -1 (near) .. 1 (far) — smaller is closer
}

// Nodes farther than this from the cursor are never candidates. Generous on
// purpose: pickNode decides the actual snap feel inside this envelope.
export const PREFILTER_PX = 80;

// ── TODO(Tom): the snap decision ─────────────────────────────────────────
// Given every node within PREFILTER_PX of the cursor, decide which (if any)
// wins the hover. This function IS the feel of magnetic picking. Things to
// weigh:
//   - pure nearest is precise but can flicker between two equidistant nodes;
//   - weighting by node.val favours hubs (what you usually want to hit), at
//     the cost of leaf notes right next to a hub;
//   - a depth tiebreak (prefer smaller `depth`) only matters in 3D — in the
//     flattened 2D view all depths converge;
//   - the snap radius: too small feels like the old raycast, too large feels
//     haunted. 24–32px is the usual sweet spot.
// Return null when nothing should be hovered.
export function pickNode(candidates: PickCandidate[]): any | null {
  // Placeholder so the flag works today: pure nearest within 28px.
  let best: PickCandidate | null = null;
  for (const c of candidates) {
    if (c.px < 28 && (!best || c.px < best.px)) best = c;
  }
  return best?.node ?? null;
}
