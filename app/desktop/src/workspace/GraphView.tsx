// Center-pane link-graph view: fetches the vault link graph, transforms it to
// the galaxy shape (cluster palette, degree-based node size, cross-folder
// bridges), and renders the ported 3D NeuralGalaxy sized to this container.
// Refetch-on-entry is the natural remount — Workspace unmounts GraphView when
// leaving graph view. The prop contract is FROZEN (see
// specs/search-and-graph-view.md §Frontend): `onOpenNote` takes a GraphNode id
// (vault-relative path) and routes "Open in reader" through Workspace's
// guarded open.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { errorMessage, readLinkGraph } from "../lib/api";
import { useVault } from "../lib/store";
import { NeuralGalaxy } from "./galaxy/NeuralGalaxy";
import { toGalaxy, type GalaxyView } from "./graphTransform";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; galaxy: GalaxyView; skippedFiles: number };

export function GraphView({
  onOpenNote,
}: {
  onOpenNote: (relPath: string) => void;
}) {
  const { vault } = useVault();
  const vaultName = vault?.name ?? "Vault root";
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLElement | null>(null);

  // No stale-fetch token on purpose: leaving graph view (or swapping vaults)
  // unmounts this component, and setState after unmount is a React 18/19
  // no-op — there's no overlapping-fetch path to guard.
  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const graph = await readLinkGraph();
      setState({
        phase: "ready",
        galaxy: toGalaxy(graph, vaultName),
        skippedFiles: graph.skippedFiles,
      });
    } catch (e) {
      // Never silently render an empty galaxy on failure.
      setState({ phase: "error", message: errorMessage(e) });
    }
  }, [vaultName]);

  useEffect(() => {
    void load();
  }, [load]);

  // Size the galaxy to this pane (the renderer needs pixel dimensions). The
  // observer fires once on observe with the current size, then on resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sized = size.width > 0 && size.height > 0;

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
        (state.phase === "ready" && state.galaxy.data.nodes.length > 0 && !sized)) && (
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

      {state.phase === "ready" && state.galaxy.data.nodes.length === 0 && (
        <div className="grid h-full place-items-center">
          <p className="text-[13px] leading-relaxed text-muted-foreground">No notes yet</p>
        </div>
      )}

      {state.phase === "ready" && state.galaxy.data.nodes.length > 0 && sized && (
        <>
          <NeuralGalaxy
            data={state.galaxy.data}
            clusters={state.galaxy.clusters}
            stats={state.galaxy.stats}
            width={size.width}
            height={size.height}
            onOpenNote={onOpenNote}
          />
          {state.skippedFiles > 0 && (
            // Non-blocking degradation notice, kept near the stats/top area.
            <p className="nn-mono pointer-events-none absolute left-5 top-16 text-[11px] text-muted-foreground">
              {state.skippedFiles} file(s) couldn't be read
            </p>
          )}
        </>
      )}
    </main>
  );
}
