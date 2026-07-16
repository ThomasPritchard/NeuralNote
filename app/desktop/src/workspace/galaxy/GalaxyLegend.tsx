import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { BRIDGE_PINK } from "./galaxyLinks";
import type { ClusterMap } from "./galaxyTypes";

interface GalaxyLegendProps {
  /** Drill-trail breadcrumb, slotted at the top of the legend card. */
  breadcrumb?: ReactNode;
  clusters: ClusterMap;
  /** Legend-row hover/focus preview: lights the whole cluster (`null` clears). */
  onPreviewCluster: (cluster: string | null) => void;
  /** Legend cluster row clicked — the drill-down entry point. The "" row (the
   *  current folder's own notes) never fires this: it renders as a plain row. */
  onClusterSelect?: (cluster: string) => void;
}

// ── Cluster legend ─────────────────────────────────────────────────────────
// Interactive (spec §Addendum): hover a row → the whole cluster lights via the
// shared focus channel; click a folder row → onClusterSelect drills in. The ""
// row (this folder's own notes) is not a drill target — it's still a native
// button so keyboard focus can drive the same cluster preview, but it has no
// click action; the bridge row stays non-interactive.
export function GalaxyLegend({
  breadcrumb,
  clusters,
  onPreviewCluster,
  onClusterSelect,
}: Readonly<GalaxyLegendProps>) {
  return (
    <div className="absolute bottom-5 left-5 flex flex-col gap-1.5 rounded-lg border border-border bg-card/80 px-4 py-3 backdrop-blur">
      {breadcrumb}
      <div className="nn-mono mb-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">Clusters</div>
      {Object.entries(clusters).map(([key, c]) =>
        key === "" ? (
          <button
            key="c:"
            type="button"
            onMouseEnter={() => onPreviewCluster("")}
            onMouseLeave={() => onPreviewCluster(null)}
            onFocus={() => onPreviewCluster("")}
            onBlur={() => onPreviewCluster(null)}
            className="flex items-center gap-2 text-left text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="size-2.5 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
            {c.label}
          </button>
        ) : (
          <button
            key={`c:${key}`}
            type="button"
            onClick={() => onClusterSelect?.(key)}
            onMouseEnter={() => onPreviewCluster(key)}
            onMouseLeave={() => onPreviewCluster(null)}
            className="flex items-center gap-2 text-left text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="size-2.5 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
            {c.label}
            {/* Drill affordance: this folder has sub-folders to unfold into. */}
            {c.drillable && (
              <ChevronRight aria-hidden className="ml-auto size-3 shrink-0 text-muted-foreground" />
            )}
          </button>
        ),
      )}
      <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-xs text-foreground">
        <span className="h-0.5 w-4 rounded-full" style={{ background: BRIDGE_PINK, boxShadow: `0 0 8px ${BRIDGE_PINK}` }} />
        <span>Cross-folder link</span>
      </div>
    </div>
  );
}
