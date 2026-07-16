// ── Galaxy link styling ──────────────────────────────────────────────────
// Colour + fade rules for the link web. Kept as literals, not var(--…):
// three.js / force-graph materials can't resolve CSS custom properties. All
// derivations share the one bridge hue — #f4aaff = rgb(244,170,255).
import { FORCE_PROFILES, type ViewMode } from "./galaxyForces";

// The bridge (cross-folder link) pink.
export const BRIDGE_PINK = "#f4aaff";
export const BRIDGE_COLOR = "rgba(244,170,255,0.85)";
export const PARTICLE_COLOR = () => BRIDGE_PINK;

// ── Hover-focus (Obsidian-style) ─────────────────────────────────────────
// Hovering a node keeps it + its direct neighbours + their shared links at
// full styling while everything else fades back, so the local cluster pops.
// Node brightness dims GPU-side via the registry (starNode's DIM_FACTOR);
// links fade through these accessor constants. While a node is selected and
// nothing is hovered, the selection's neighbourhood is the lit set.
/** Multiplier on a normal link's alpha when it falls outside the lit set. */
export const LINK_FADE = 0.12;
/** Faded bridge styling — a dimmed bridge must stop drawing the eye. */
export const BRIDGE_FADED_COLOR = "rgba(244,170,255,0.08)";

/** Links may hold raw id strings or (post-simulation) node object refs. */
export function endpointId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string);
}

// Link colour is view-aware (FORCE_PROFILES): the flat 2D map needs a clearly
// visible web at overview; the 3D galaxy stays more subdued. Under an active
// hover-focus, links outside the lit neighbourhood fade well back (alpha only
// — widths keep their objects stable).
export function computeLinkColor(l: any, view: ViewMode, lit: boolean): string {
  if (!lit) {
    return l.bridge
      ? BRIDGE_FADED_COLOR
      : `rgba(150,150,200,${+(FORCE_PROFILES[view].linkAlpha * LINK_FADE).toFixed(3)})`;
  }
  return l.bridge ? BRIDGE_COLOR : `rgba(150,150,200,${FORCE_PROFILES[view].linkAlpha})`;
}
