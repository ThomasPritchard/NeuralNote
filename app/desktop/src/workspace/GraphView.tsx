// Center-pane link-graph view: fetches the vault link graph, transforms it to
// the galaxy shape (cluster palette, degree-based node size, cross-folder
// bridges), and renders the ported 3D NeuralGalaxy sized to this container.
// Refetch-on-entry is the natural remount — Workspace unmounts GraphView when
// leaving graph view. The prop contract is FROZEN (see
// specs/search-and-graph-view.md §Frontend): `onOpenNote` takes a GraphNode id
// (vault-relative path) and routes "Open in reader" through Workspace's
// guarded open.
//
// Cluster drill-down (spec §Addendum): this component owns the focus trail.
// Clicking a legend cluster pushes its folder segment; the breadcrumb (slotted
// into the galaxy's legend card) jumps back up. Each level re-transforms the
// SAME fetched graph and remounts NeuralGalaxy via `key` — the immutable-data-
// per-mount contract — so the force layout re-runs and the engine-stop framing
// zooms to fit the isolated cluster.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { errorMessage, readLinkGraph } from "../lib/api";
import type { LinkGraph } from "../lib/types";
import { useVault } from "../lib/store";
import {
  GALAXY_COMPACT_TOOLBAR_WIDTH,
  NeuralGalaxy,
} from "./galaxy/NeuralGalaxy";
import { toGalaxy } from "./graphTransform";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; graph: LinkGraph };

export function GraphView({
  onOpenNote,
}: Readonly<{
  onOpenNote: (relPath: string) => void;
}>) {
  const { vault } = useVault();
  const vaultName = vault?.name ?? "Vault root";
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [focusTrail, setFocusTrail] = useState<string[]>([]);
  const containerRef = useRef<HTMLElement | null>(null);

  // No stale-fetch token on purpose: leaving graph view (or swapping vaults)
  // unmounts this component, and setState after unmount is a React 18/19
  // no-op — there's no overlapping-fetch path to guard.
  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState({ phase: "ready", graph: await readLinkGraph() });
    } catch (e) {
      // Never silently render an empty galaxy on failure.
      setState({ phase: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, vaultName]);

  // The rendered level: the fetched graph transformed at the focus trail. A
  // trail can go stale (a refetch dropped the folder) — fall back to root in
  // the SAME render rather than ever showing an empty galaxy.
  const view = useMemo(() => {
    if (state.phase !== "ready") return null;
    const focused = toGalaxy(state.graph, vaultName, focusTrail.join("/"));
    if (focusTrail.length > 0 && focused.data.nodes.length === 0) {
      return { trail: [] as string[], galaxy: toGalaxy(state.graph, vaultName) };
    }
    return { trail: focusTrail, galaxy: focused };
  }, [state, vaultName, focusTrail]);

  // Keep the trail state honest when the memo had to fall back (otherwise the
  // stale trail would resurface if a later refetch restored the folder).
  useEffect(() => {
    if (view && view.trail !== focusTrail) setFocusTrail(view.trail);
  }, [view, focusTrail]);

  // Drill down one level. "" is the current folder's own notes — the legend
  // renders that row inert, so this guard is belt-and-braces.
  const drillInto = useCallback((cluster: string) => {
    if (cluster !== "") setFocusTrail((trail) => [...trail, cluster]);
  }, []);

  // Size the galaxy to this pane (the renderer needs pixel dimensions). The
  // observer fires once on observe with the current size, then on resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const last = entries.at(-1);
      if (!last) return; // never fires — the callback always has entries
      const { width, height } = last.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sized = size.width > 0 && size.height > 0;
  const trail = view?.trail ?? [];

  // Breadcrumb for the legend card: `All notes / Areas / Health` — ancestors
  // jump to their level, the current level is inert. Root shows no breadcrumb
  // (the quieter option). Typography reuses the legend heading's classes.
  const breadcrumb =
    trail.length > 0 ? (
      <nav
        aria-label="Folder breadcrumb"
        className="nn-mono text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        <button
          type="button"
          onClick={() => setFocusTrail([])}
          className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          All notes
        </button>
        {trail.map((segment, i) => (
          <span key={trail.slice(0, i + 1).join("/")}>
            {" / "}
            {i === trail.length - 1 ? (
              <span className="text-foreground">{segment}</span>
            ) : (
              <button
                type="button"
                onClick={() => setFocusTrail(trail.slice(0, i + 1))}
                className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {segment}
              </button>
            )}
          </span>
        ))}
      </nav>
    ) : undefined;

  const skippedFiles = state.phase === "ready" ? state.graph.skippedFiles : 0;

  return (
    <main
      ref={containerRef}
      aria-label="Graph view"
      className="relative flex-1 overflow-hidden bg-background"
    >
      {/* The spinner also covers ready-but-unsized: the galaxy needs pixel
          dimensions, and a blank pane while the first ResizeObserver tick
          lands would read as a failure. */}
      {(state.phase === "loading" ||
        (view && view.galaxy.data.nodes.length > 0 && !sized)) && (
        <div className="grid h-full place-items-center">
          <Loader2
            className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-label="Loading graph"
          />
        </div>
      )}

      {state.phase === "error" && (
        <div className="grid h-full place-items-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <AlertTriangle className="size-6 text-destructive" aria-hidden />
            <p className="text-[13px] leading-relaxed text-muted-foreground">{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RotateCw className="size-3.5" aria-hidden /> Retry
            </button>
          </div>
        </div>
      )}

      {view?.galaxy.data.nodes.length === 0 && (
        <div className="grid h-full place-items-center">
          <p className="text-[13px] leading-relaxed text-muted-foreground">No notes yet</p>
        </div>
      )}

      {view && view.galaxy.data.nodes.length > 0 && sized && (
        <>
          <NeuralGalaxy
            // Remount per drill level: layout re-runs on the filtered payload
            // and the engine-stop framing zooms to fit (data-per-mount
            // contract — the sim mutates node objects in place).
            key={trail.join("/")}
            data={view.galaxy.data}
            clusters={view.galaxy.clusters}
            stats={view.galaxy.stats}
            width={size.width}
            height={size.height}
            onOpenNote={onOpenNote}
            onClusterSelect={drillInto}
            breadcrumb={breadcrumb}
          />
          {(view.galaxy.truncation !== null || skippedFiles > 0) && (
            // Non-blocking degradation notices, kept near the stats/top area.
            <div
              data-layout={
                size.width < GALAXY_COMPACT_TOOLBAR_WIDTH ? "compact" : "wide"
              }
              className={`pointer-events-none absolute left-5 flex flex-col gap-1 ${
                size.width < GALAXY_COMPACT_TOOLBAR_WIDTH ? "top-32" : "top-16"
              }`}
            >
              {view.galaxy.truncation !== null && (
                // The node cap trimmed this level (PA-006) — never let a
                // partial galaxy pass silently as the whole vault.
                <p className="nn-mono text-[11px] text-muted-foreground">
                  Showing the {view.galaxy.truncation.shown} most-linked of{" "}
                  {view.galaxy.truncation.total} notes — open a cluster to see more
                </p>
              )}
              {skippedFiles > 0 && (
                <p className="nn-mono text-[11px] text-muted-foreground">
                  {skippedFiles} file(s) couldn't be read
                </p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
