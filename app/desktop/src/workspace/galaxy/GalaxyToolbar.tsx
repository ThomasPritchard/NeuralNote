import { Search, Sparkles, X } from "lucide-react";
import type { GalaxyNode } from "./graph";
import type { ViewMode } from "./galaxyForces";
import type { ClusterMap } from "./galaxyTypes";
import { plural } from "./galaxyText";

interface GalaxyToolbarProps {
  /** Stacks the toolbar vertically at the narrow native pane width. */
  compact: boolean;
  stats: { notes: number; links: number; crossFolderLinks: number; outsideLinks: number };
  view: ViewMode;
  onChangeView: (v: ViewMode) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** `null` while the search box is empty; otherwise the filtered matches. */
  results: GalaxyNode[] | null;
  onPickResult: (node: GalaxyNode) => void;
  clusters: ClusterMap;
}

/** Top bar: title + stats line + 2D/3D toggle + search box with a results
 *  dropdown. Purely presentational — search/selection state lives in the
 *  parent (NeuralGalaxy). */
export function GalaxyToolbar({
  compact,
  stats,
  view,
  onChangeView,
  query,
  onQueryChange,
  results,
  onPickResult,
  clusters,
}: Readonly<GalaxyToolbarProps>) {
  return (
    <div
      data-testid="galaxy-toolbar"
      data-layout={compact ? "compact" : "wide"}
      className={`pointer-events-none absolute inset-x-0 top-0 flex p-5 ${
        compact ? "flex-col gap-3" : "items-start justify-between"
      }`}
    >
      <div
        className={`pointer-events-auto flex items-center ${
          compact ? "w-full gap-2" : "gap-3"
        }`}
      >
        <div>
          <div className="nn-heading flex items-center gap-2 text-lg font-semibold text-foreground">
            <Sparkles className="size-4 text-primary" /> Neural galaxy
          </div>
          <div className="nn-mono text-[0.6875rem] text-muted-foreground">
            {plural(stats.notes, "note")} · {plural(stats.links, "link")} ·{" "}
            {plural(stats.crossFolderLinks, "cross-folder link")}
            {/* Only an isolated folder has links leaving the view (0 at root). */}
            {stats.outsideLinks > 0 && (
              <>
                {" "}
                · {plural(stats.outsideLinks, "link")} lead
                {stats.outsideLinks === 1 ? "s" : ""} outside
              </>
            )}
          </div>
        </div>
      </div>

      <div className="pointer-events-auto flex items-center gap-3">
        {/* 2D map ↔ 3D galaxy morph */}
        <fieldset className="m-0 flex min-w-0 items-center gap-1 rounded-lg border border-border bg-card/80 p-1 text-xs backdrop-blur">
          <legend className="sr-only">Graph dimension</legend>
          {(["3d", "2d"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onChangeView(v)}
              className={`rounded-md px-2.5 py-1 uppercase transition ${
                view === v
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {v}
            </button>
          ))}
        </fieldset>

        <div className={`relative ${compact ? "min-w-0 flex-1" : "w-72"}`}>
          <label className="flex items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-sm text-muted-foreground backdrop-blur focus-within:border-primary/60">
            <Search className="size-4 shrink-0" />
            <input
              type="search"
              aria-label="Search the galaxy"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && results?.length) onPickResult(results[0]);
                if (e.key === "Escape") onQueryChange("");
              }}
              placeholder="Search the galaxy…"
              className="w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />
            {query && (
              <button type="button" onClick={() => onQueryChange("")} aria-label="Clear">
                <X className="size-3.5 hover:text-foreground" />
              </button>
            )}
          </label>

          {/* Results dropdown — pick a note instead of auto-flying to it */}
          {results && (
            <div className="absolute inset-x-0 top-full mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-card/95 py-1 backdrop-blur">
              {results.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">No notes match “{query}”</div>
              )}
              {results.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onPickResult(n)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-primary/10"
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: n.color }} />
                  <span className="truncate">{n.title}</span>
                  <span className="nn-mono ml-auto shrink-0 text-[0.625rem] text-muted-foreground">
                    {clusters[n.cluster]?.label ?? n.cluster}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
