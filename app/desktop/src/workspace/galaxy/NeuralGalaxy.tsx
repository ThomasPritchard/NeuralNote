import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ForceGraph3D from "react-force-graph-3d";
import type { GalaxyLink, GalaxyNode } from "./graph";
import { makeStarNode } from "./starNode";
import { BG } from "./galaxyForces";
import { computeLinkColor, PARTICLE_COLOR } from "./galaxyLinks";
import { nodeLabelHtml } from "./galaxyTooltip";
import type { ClusterMap } from "./galaxyTypes";
import { useHoverFocus, type Adjacency } from "./useHoverFocus";
import { useGalaxyScene } from "./useGalaxyScene";
import { useGalaxyCamera } from "./useGalaxyCamera";
import { GalaxyToolbar } from "./GalaxyToolbar";
import { GalaxyLegend } from "./GalaxyLegend";
import { GalaxyNotePreview } from "./GalaxyNotePreview";
import {
  GALAXY_COMPACT_TOOLBAR_WIDTH,
  notePreviewFocusScreenX,
  notePreviewMetrics,
  notePreviewPlacement,
} from "./notePreviewModel";

// ── NeuralGalaxy ──────────────────────────────────────────────────────────
// A 3D "neural map" of the vault: notes are nodes, wikilinks are edges,
// cross-folder BRIDGES glow brighter. Drag to orbit, scroll to zoom, click a
// node to fly to it, search to find one. Ported faithfully from the locked
// prototype design; data/sizing/navigation arrive via props instead of
// module-level mocks and window globals.
//
// Nodes render in the ReactBits-galaxy idiom (twinkling stars) over the app
// background. The cursor gives subtle life (node hover-glow) — never the
// galaxy's "everything warps to the pointer".
//
// This file is the composition shell. The cohesive pieces live in siblings:
//  · galaxyForces / galaxyLinks / galaxyTooltip — pure styling + physics
//  · useHoverFocus / useGalaxyScene / useGalaxyCamera — stateful lifecycles
//  · GalaxyToolbar / GalaxyLegend / GalaxyNotePreview — the DOM overlays

// Re-exported for tests + importers that resolve these from this module: the
// definitions moved to focused siblings, the public import path did not.
export { FORCE_PROFILES, type ForceProfile } from "./galaxyForces";
export { BRIDGE_FADED_COLOR, LINK_FADE } from "./galaxyLinks";

/** Shared with GraphView so notices clear the stacked compact toolbar. */
export { GALAXY_COMPACT_TOOLBAR_WIDTH } from "./notePreviewModel";

export interface NeuralGalaxyProps {
  /** Pre-decorated render graph. IMMUTABLE per mount: the force simulation
   *  and the 2D morph mutate the node objects in place, so a refetch means a
   *  remount with a fresh payload (see galaxy/graph.ts + graphTransform). */
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  /** Legend/label metadata — every node.cluster key must be present.
   *  `drillable` marks clusters with sub-folders (they get the chevron). */
  clusters: ClusterMap;
  /** `outsideLinks` > 0 only when a drill-down isolates a folder — the stats
   *  line then appends the muted "N links lead outside" segment. */
  stats: { notes: number; links: number; crossFolderLinks: number; outsideLinks: number };
  width: number;
  height: number;
  onOpenNote: (id: string) => void;
  /** Legend cluster row clicked — the drill-down entry point. The "" row (the
   *  current folder's own notes) never fires this: it renders as a plain row. */
  onClusterSelect?: (cluster: string) => void;
  /** Drill-trail breadcrumb, slotted at the top of the legend card. GraphView
   *  owns the trail; this component stays agnostic of drill semantics. */
  breadcrumb?: ReactNode;
}

export function NeuralGalaxy({
  data,
  clusters,
  stats,
  width,
  height,
  onOpenNote,
  onClusterSelect,
  breadcrumb,
}: Readonly<NeuralGalaxyProps>) {
  const fgRef = useRef<any>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reducedRef = useRef(
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  );

  const [selected, setSelected] = useState<GalaxyNode | null>(null);
  const [query, setQuery] = useState("");
  const previewMetrics = useMemo(() => notePreviewMetrics(width, height), [width, height]);
  const previewFocusScreenX = useMemo(
    () => notePreviewFocusScreenX(width, previewMetrics),
    [previewMetrics, width],
  );
  const compactToolbar = width < GALAXY_COMPACT_TOOLBAR_WIDTH;

  // Adjacency for hover-glow and the panel's neighbour list: a node's direct
  // neighbours (with the bridge flag) in both directions. Links may be raw
  // id strings or (post-simulation) node refs — handle both.
  const adjacency = useMemo<Adjacency>(() => {
    const m: Adjacency = new Map();
    const add = (a: string, b: string, bridge: boolean) =>
      m.set(a, [...(m.get(a) ?? []), { id: b, bridge }]);
    for (const l of data.links as any[]) {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      add(s, t, !!l.bridge);
      add(t, s, !!l.bridge);
    }
    return m;
  }, [data]);

  const nodeById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);

  // The selected node's neighbours, resolved against nodeById up front so the
  // panel's count and its rows can never disagree (a link id missing from the
  // render graph is dropped from both).
  const neighbours = useMemo(() => {
    if (!selected) return [];
    return (adjacency.get(selected.id) ?? []).flatMap(({ id, bridge }) => {
      const node = nodeById.get(id);
      return node ? [{ node, bridge }] : [];
    });
  }, [selected, adjacency, nodeById]);

  // Hover-focus / dimming state machine (node hover, legend preview, links).
  const { previewCluster, isLinkLit, onNodeHover } = useHoverFocus({ adjacency, data, selected });

  // Scene lifecycle: bloom pass, the per-frame twinkle loop, and auto-framing.
  const { frameOnce } = useGalaxyScene({
    fgRef,
    rootRef,
    width,
    height,
    reducedRef,
  });

  // The preview bubble is ordinary, accessible DOM, but it belongs to a moving
  // WebGL node. Project that node into viewport coordinates on the graph's
  // existing animation cadence and drive the overlay with CSS properties. This
  // avoids React renders while the camera flies or orbits.
  useEffect(() => {
    const root = rootRef.current;
    if (!selected || !root) return;

    let raf = 0;
    let lastProjection = -Infinity;
    const project = (now: number) => {
      if (now - lastProjection >= 32) {
        const fg = fgRef.current;
        const nodeX = Number.isFinite(selected.x) ? selected.x! : 0;
        const nodeY = Number.isFinite(selected.y) ? selected.y! : 0;
        const nodeZ = Number.isFinite(selected.z) ? selected.z! : 0;
        const projected = fg?.graph2ScreenCoords?.(nodeX, nodeY, nodeZ) ?? {
          x: width / 2,
          y: height / 2,
        };
        const layer = root.querySelector<HTMLElement>(".nn-graph-preview-layer");
        const surface = root.querySelector<HTMLElement>(".nn-graph-preview");
        const liveMetrics = surface
          ? {
              ...previewMetrics,
              width: surface.offsetWidth,
              height: surface.offsetHeight,
            }
          : previewMetrics;
        const dragX = Number.parseFloat(layer?.dataset.dragX ?? "");
        const dragY = Number.parseFloat(layer?.dataset.dragY ?? "");
        const draggedPosition =
          Number.isFinite(dragX) && Number.isFinite(dragY) ? { x: dragX, y: dragY } : null;
        const placement = notePreviewPlacement(
          projected,
          liveMetrics,
          width,
          height,
          draggedPosition,
        );
        root.style.setProperty("--nn-graph-preview-anchor-x", `${placement.anchorX}px`);
        root.style.setProperty("--nn-graph-preview-anchor-y", `${placement.anchorY}px`);
        root.style.setProperty("--nn-graph-preview-bubble-x", `${placement.bubbleX}px`);
        root.style.setProperty("--nn-graph-preview-bubble-y", `${placement.bubbleY}px`);
        root.style.setProperty("--nn-graph-preview-tether-length", `${placement.tetherLength}px`);
        root.style.setProperty("--nn-graph-preview-tether-angle", `${placement.tetherAngle}rad`);
        lastProjection = now;
      }
      raf = requestAnimationFrame(project);
    };
    project(performance.now());

    return () => {
      cancelAnimationFrame(raf);
      for (const property of [
        "--nn-graph-preview-anchor-x",
        "--nn-graph-preview-anchor-y",
        "--nn-graph-preview-bubble-x",
        "--nn-graph-preview-bubble-y",
        "--nn-graph-preview-tether-length",
        "--nn-graph-preview-tether-angle",
      ]) {
        root.style.removeProperty(property);
      }
    };
  }, [height, previewMetrics, selected, width]);

  // Camera navigation + 2D↔3D morph; owns the view mode and selection flights.
  const { view, onNodeClick, dismissSelected, closeSelectedAndReturn, changeView, linkWidth } =
    useGalaxyCamera({
      fgRef,
      reducedRef,
      viewportWidth: width,
      viewportHeight: height,
      focusScreenX: previewFocusScreenX,
      data,
      setSelected,
      onNodeHover,
    });

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        closeSelectedAndReturn();
      }
    };
    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [closeSelectedAndReturn, selected]);

  // Search results for the dropdown. No auto-fly while typing — flying to
  // the first match on each keystroke guesses the destination too eagerly;
  // the user picks from the list instead (or hits Enter for the top result).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q));
  }, [query, data]);

  // Picking a search result behaves exactly like clicking the star: select,
  // fly to it, and let the panel's ✕ return to the pre-flight view.
  const pickResult = useCallback(
    (node: GalaxyNode) => {
      setQuery("");
      onNodeClick(node);
    },
    [onNodeClick],
  );

  const linkParticles = useCallback(
    (l: any) => (l.bridge && isLinkLit(l) ? 3 : 0),
    [isLinkLit],
  );

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-background">
      <ForceGraph3D
        ref={fgRef}
        width={width}
        height={height}
        graphData={data}
        backgroundColor={BG}
        showNavInfo={false}
        nodeId="id"
        nodeVal="val"
        nodeThreeObject={makeStarNode}
        onNodeHover={onNodeHover}
        // nodeLabel is the ONE raw-innerHTML sink (float-tooltip renders the
        // string unescaped): titles and folder names are untrusted vault
        // content, so both text interpolations MUST go through escapeHtml, and
        // the colour MUST go through safeHex — see galaxyTooltip.
        nodeLabel={(n: any) => nodeLabelHtml(n, clusters)}
        // Link styling is view-aware (FORCE_PROFILES) via galaxyLinks: the flat
        // 2D map needs a clearly visible web; the 3D galaxy stays subdued. Under
        // an active hover-focus, links outside the lit neighbourhood fade well
        // back (alpha only — widths keep their objects stable). Inline arrow on
        // purpose: only linkColor changes identity per render, so the library's
        // link digest recolours in place instead of rebuilding link objects.
        linkColor={(l: any) => computeLinkColor(l, view, isLinkLit(l))}
        linkWidth={linkWidth}
        linkDirectionalParticles={linkParticles}
        linkDirectionalParticleWidth={1.6}
        linkDirectionalParticleColor={PARTICLE_COLOR}
        onNodeClick={onNodeClick}
        onBackgroundClick={dismissSelected}
        onEngineStop={frameOnce}
      />

      <GalaxyToolbar
        compact={compactToolbar}
        stats={stats}
        view={view}
        onChangeView={changeView}
        query={query}
        onQueryChange={setQuery}
        results={results}
        onPickResult={pickResult}
        clusters={clusters}
      />

      {(!selected || !compactToolbar) && (
        <GalaxyLegend
          breadcrumb={breadcrumb}
          clusters={clusters}
          onPreviewCluster={previewCluster}
          onClusterSelect={onClusterSelect}
        />
      )}

      {selected && (
        <GalaxyNotePreview
          selected={selected}
          clusters={clusters}
          neighbours={neighbours}
          onNodeClick={onNodeClick}
          onClose={closeSelectedAndReturn}
          onOpenNote={onOpenNote}
          metrics={previewMetrics}
        />
      )}
    </div>
  );
}
