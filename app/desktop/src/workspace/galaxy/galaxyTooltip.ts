// ── Galaxy node tooltip ──────────────────────────────────────────────────
// nodeLabel is the ONE raw-innerHTML sink (float-tooltip renders the returned
// string unescaped): titles and folder names are untrusted vault content, so
// both text interpolations MUST go through escapeHtml, and the colour MUST go
// through safeHex (strict hex, palette fallback). Everything else in the galaxy
// renders through JSX (React escapes it).
import { CLUSTER_PALETTE } from "./graph";

// For strings interpolated into the raw-HTML tooltip. Single quotes are
// escaped too, so an escaped value stays inert even if a refactor moves it
// into a single-quoted attribute position.
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

// The tooltip also interpolates a colour into a style attribute. Today it is
// always a CLUSTER_PALETTE hex (assigned by cluster index, never note data),
// but the sink is raw HTML — pin it to a strict hex form so a future
// data-driven colour can never become a style/attribute injection. Anything
// off-form falls back to the first palette colour.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const safeHex = (color: string) => (HEX_COLOR.test(color) ? color : CLUSTER_PALETTE[0]);

/** Build the float-tooltip's raw-HTML string for a hovered node. Both text
 *  interpolations go through escapeHtml; the accent colour through safeHex. */
export function nodeLabelHtml(
  n: any,
  clusters: Record<string, { label: string; color: string; drillable: boolean }>,
): string {
  return `<div style="font:600 12px Inter,sans-serif;color:#fff;background:rgba(20,18,32,.92);border:1px solid rgba(255,255,255,.12);padding:5px 9px;border-radius:8px">${escapeHtml(n.title)}<span style="color:${safeHex(n.color)};margin-left:8px;font-weight:500">${escapeHtml(clusters[n.cluster]?.label ?? n.cluster)}</span></div>`;
}
