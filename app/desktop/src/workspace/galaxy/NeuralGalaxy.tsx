import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Search, Sparkles, X } from "lucide-react";
import type { GalaxyLink, GalaxyNode } from "./graph";
import { makeStarNode } from "./starNode";
import { resetRegistry, setHover, updateAll } from "./nodeRegistry";

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
const BG = "#0a0913";

type ViewMode = "3d" | "2d";

const MORPH_MS = 1100;
const FOV_2D = 20; // narrow lens ≈ orthographic once the dolly-zoom lands

// ── Force profiles ──────────────────────────────────────────────────────────
// Layout physics + link visibility per view. Tuned headlessly at real-vault
// scale (~765 notes / ~1435 links) against an "Obsidian-like" bar for the 2D
// map: one cohesive connected web with readable sub-clusters, islands pulled
// near the main mass, and the link web visible at overview. The 3D galaxy
// keeps more spread but must never scatter disconnected islands to infinity.
// Applied on init and re-applied on every 2D↔3D morph (see applyForceProfile).
// Hand-tweak values here — everything layout-physics lives in this block.
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

const BRIDGE_COLOR = "rgba(244,170,255,0.85)";

/** Simulation node as d3-force-3d sees it: positions + velocities are live. */
type SimNode = GalaxyNode & { x: number; y: number; z: number; vx: number; vy: number; vz: number };

// Positional gravity toward the origin — the same math as d3's forceX(0)/
// forceY(0) (+ forceZ in 3D), written as a tiny custom force so we don't
// import the untyped, transitive d3-force-3d package. `d3Force(name, fn)`
// accepts any function force with an `initialize` hook.
function makeGravity(strength: number, withZ: boolean) {
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
function applyForceProfile(fg: any, mode: ViewMode) {
  const p = FORCE_PROFILES[mode];
  fg.d3Force("charge")?.strength(p.chargeStrength).distanceMax(p.chargeDistanceMax);
  fg.d3Force("link")?.distance(p.linkDistance);
  fg.d3Force("gravity", makeGravity(p.gravityStrength, mode === "3d"));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface NeuralGalaxyProps {
  /** Pre-decorated render graph. IMMUTABLE per mount: the force simulation
   *  and the 2D morph mutate the node objects in place, so a refetch means a
   *  remount with a fresh payload (see galaxy/graph.ts + graphTransform). */
  data: { nodes: GalaxyNode[]; links: GalaxyLink[] };
  /** Legend/label metadata — every node.cluster key must be present. */
  clusters: Record<string, { label: string; color: string }>;
  stats: { notes: number; links: number; crossFolderLinks: number };
  width: number;
  height: number;
  onOpenNote: (id: string) => void;
}

export function NeuralGalaxy({
  data,
  clusters,
  stats,
  width,
  height,
  onOpenNote,
}: Readonly<NeuralGalaxyProps>) {
  const fgRef = useRef<any>(null);
  const hoveredRef = useRef<Set<string>>(new Set());
  const reducedRef = useRef(
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  );
  const [selected, setSelected] = useState<GalaxyNode | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("3d");
  const morphRaf = useRef(0);
  const savedCamRef = useRef<{ pos: THREE.Vector3; fov: number } | null>(null);
  // The RAF tick (mount effect, [] deps) needs the LIVE viewport height for
  // screen-space label/hit math — a ref sidesteps the stale closure.
  const heightRef = useRef(height);
  heightRef.current = height;

  // Adjacency for hover-glow and the panel's neighbour list: a node's direct
  // neighbours (with the bridge flag) in both directions. Links may be raw
  // id strings or (post-simulation) node refs — handle both.
  const adjacency = useMemo(() => {
    const m = new Map<string, { id: string; bridge: boolean }[]>();
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

  // Init (once): restrained bloom (only node cores glow) plus a single RAF loop
  // driving node twinkle and hover-glow easing. The graph is never remounted,
  // so this scene lives for the component's lifetime.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.4, 0.5, 0.45);
    fg.postProcessingComposer().addPass(bloom);

    // Layout physics live in FORCE_PROFILES (top of file). The graph mounts
    // in 3D; changeView re-applies the matching profile on every morph.
    applyForceProfile(fg, "3d");

    const start = performance.now();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const time = reducedRef.current ? 0 : (performance.now() - start) / 1000;
      // twinkle + hover-glow easing + screen-space chrome (hover works even
      // if reduced). Labels reveal by each star's PROJECTED radius and hit
      // proxies keep a minimum projected size (see nodeChrome): pxPerWorld
      // is the screen px per world unit at distance 1, so a node's apparent
      // radius is worldR · pxPerWorld / dist. fov comes in via tan(fov/2),
      // which keeps the 2D dolly-zoom lens (fov 20) equivalent to 3D for
      // free; fovScale still normalizes the ultra-close label fade.
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const tanHalfFov = Math.tan((cam.fov * Math.PI) / 360);
      const fovScale = tanHalfFov / Math.tan((50 * Math.PI) / 360);
      const pxPerWorld = heightRef.current / 2 / tanHalfFov;
      updateAll(time, { camPos: cam.position, fovScale, pxPerWorld });
    };
    raf = requestAnimationFrame(tick);

    const framed = setTimeout(() => fg.zoomToFit(800, 110), 1800);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(morphRaf.current);
      clearTimeout(framed);
      // StrictMode: the composer outlives this effect's dev double-invoke, so
      // the bloom pass must come off or two stacked passes wash out the render.
      fg.postProcessingComposer().removePass(bloom);
      resetRegistry(); // the node registry is a module singleton
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Search results for the dropdown. No auto-fly while typing — flying to
  // the first match on each keystroke guesses the destination too eagerly;
  // the user picks from the list instead (or hits Enter for the top result).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return data.nodes.filter((n) => n.title.toLowerCase().includes(q));
  }, [query, data]);

  const focus = useCallback((node: any) => {
    const dist = 90;
    const r = 1 + dist / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
    fgRef.current?.cameraPosition(
      { x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r },
      node,
      1400,
    );
  }, []);

  // Camera pose from before the first click-focus of a selection session, so
  // the panel's ✕ can fly back out. Traversing neighbours keeps the original
  // pose; background-click dismisses in place (pose dropped, no flight).
  const preFocusRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  const onNodeClick = useCallback(
    (node: any) => {
      const fg = fgRef.current;
      if (fg && !preFocusRef.current) {
        const controls: any = fg.controls();
        preFocusRef.current = {
          pos: (fg.camera() as THREE.PerspectiveCamera).position.clone(),
          target: controls.target?.clone() ?? new THREE.Vector3(),
        };
      }
      setSelected(node as GalaxyNode);
      focus(node);
    },
    [focus],
  );

  const dismissSelected = useCallback(() => {
    preFocusRef.current = null;
    setSelected(null);
  }, []);

  const closeSelectedAndReturn = useCallback(() => {
    const saved = preFocusRef.current;
    preFocusRef.current = null;
    setSelected(null);
    if (saved) fgRef.current?.cameraPosition(saved.pos, saved.target, reducedRef.current ? 0 : 1200);
  }, []);

  // Picking a search result behaves exactly like clicking the star: select,
  // fly to it, and let the panel's ✕ return to the pre-flight view.
  const pickResult = useCallback(
    (node: any) => {
      setQuery("");
      onNodeClick(node);
    },
    [onNodeClick],
  );

  // Hover-glow: brighten the hovered node and its direct neighbours.
  const onNodeHover = useCallback(
    (node: any) => {
      hoveredRef.current.forEach((id) => setHover(id, false));
      hoveredRef.current.clear();
      if (node) {
        setHover(node.id, true);
        hoveredRef.current.add(node.id);
        for (const nb of adjacency.get(node.id) ?? []) {
          setHover(nb.id, true);
          hoveredRef.current.add(nb.id);
        }
      }
    },
    [adjacency],
  );

  // ── 2D ↔ 3D morph ────────────────────────────────────────────────────────
  // One scene for both views. "2D" tweens every node's fz pin to 0 while the
  // camera flies front-on and dolly-zooms; the sim stays hot so links track
  // the real coordinates through ordinary ticks. fz is the ONLY pin the morph
  // ever holds: x/y stay free, so the layout keeps living — a drag tugs the
  // neighbourhood along in both views (dragend releases fx/fy automatically
  // because they were never fixed), and returning to 3D deletes fz entirely.
  // Two rejected flavors, for the record: scaling the graph group's z
  // exploded under DragControls (inverse parent matrix × 1e-4 scale amplifies
  // float noise 10⁴×), and pinning fx/fy froze the network so a dragged node
  // just stretched its links (Tom wants the organic tug).
  const animateMorph = useCallback(
    (fov1: number, toFlat: boolean, done?: () => void) => {
      const fg = fgRef.current;
      if (!fg) return;
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const fov0 = cam.fov;
      const nodes = data.nodes as any[];
      if (toFlat) for (const n of nodes) n.__z3d = n.z ?? 0;
      fg.d3ReheatSimulation(); // keep ticks flowing so objects + links follow the tween
      const dur = reducedRef.current ? 0 : MORPH_MS;
      const t0 = performance.now();
      cancelAnimationFrame(morphRaf.current);
      const step = () => {
        const t = dur === 0 ? 1 : Math.min(1, (performance.now() - t0) / dur);
        const e = easeInOut(t);
        cam.fov = fov0 + (fov1 - fov0) * e;
        cam.updateProjectionMatrix();
        for (const n of nodes) {
          const z3d = n.__z3d ?? 0;
          n.fz = toFlat ? z3d * (1 - e) : z3d * e;
        }
        if (t < 1) {
          morphRaf.current = requestAnimationFrame(step);
        } else {
          if (!toFlat) for (const n of nodes) delete n.fz; // fully organic 3D
          done?.();
        }
      };
      step();
    },
    [data],
  );

  const viewRef = useRef<ViewMode>("3d");
  const changeView = useCallback(
    (v: ViewMode) => {
      const fg = fgRef.current;
      if (v === viewRef.current || !fg) return;
      viewRef.current = v;
      setView(v);
      // Swap the layout physics with the view; animateMorph's reheat below
      // keeps the sim ticking so the new forces take hold through the tween.
      applyForceProfile(fg, v);
      preFocusRef.current = null; // a pose saved in the other view's camera regime is wrong
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const controls: any = fg.controls();
      const ms = reducedRef.current ? 0 : MORPH_MS;
      if (v === "2d") {
        savedCamRef.current = { pos: cam.position.clone(), fov: cam.fov };
        controls.noRotate = true;
        // Fly front-on at a dolly-zoom-compensated distance so the graph
        // holds its apparent size while the lens narrows toward ortho.
        const d = cam.position.length();
        const d2 = (d * Math.tan((cam.fov * Math.PI) / 360)) / Math.tan((FOV_2D * Math.PI) / 360);
        fg.cameraPosition({ x: 0, y: 0, z: d2 }, { x: 0, y: 0, z: 0 }, ms);
        animateMorph(FOV_2D, true, () => fg.zoomToFit(600, 100));
      } else {
        controls.noRotate = false;
        const saved = savedCamRef.current;
        if (saved) fg.cameraPosition(saved.pos, { x: 0, y: 0, z: 0 }, ms);
        animateMorph(saved?.fov ?? cam.fov, false);
      }
    },
    [animateMorph],
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
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
        nodeLabel={(n: any) =>
          `<div style="font:600 12px Inter,sans-serif;color:#fff;background:rgba(20,18,32,.92);border:1px solid rgba(255,255,255,.12);padding:5px 9px;border-radius:8px">${n.title}<span style="color:${n.color};margin-left:8px;font-weight:500">${clusters[n.cluster]?.label ?? n.cluster}</span></div>`
        }
        // Link styling is view-aware (FORCE_PROFILES): the flat 2D map needs a
        // clearly visible web at overview; the 3D galaxy stays more subdued.
        linkColor={(l: any) =>
          l.bridge ? BRIDGE_COLOR : `rgba(150,150,200,${FORCE_PROFILES[view].linkAlpha})`
        }
        linkWidth={(l: any) =>
          l.bridge ? FORCE_PROFILES[view].bridgeWidth : FORCE_PROFILES[view].linkWidth
        }
        linkDirectionalParticles={(l: any) => (l.bridge ? 3 : 0)}
        linkDirectionalParticleWidth={1.6}
        linkDirectionalParticleColor={() => "#f4aaff"}
        onNodeClick={onNodeClick}
        onBackgroundClick={dismissSelected}
        onEngineStop={() => fgRef.current?.zoomToFit(800, 110)}
      />

      {/* ── Top bar: title + view toggle + search ──────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
        <div className="pointer-events-auto flex items-center gap-3">
          <div>
            <div className="nn-heading flex items-center gap-2 text-lg font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" /> Neural galaxy
            </div>
            <div className="nn-mono text-[11px] text-muted-foreground">
              {plural(stats.notes, "note")} · {plural(stats.links, "link")} ·{" "}
              {plural(stats.crossFolderLinks, "cross-folder link")}
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-3">
          {/* 2D map ↔ 3D galaxy morph */}
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card/80 p-1 text-xs backdrop-blur">
            {(["3d", "2d"] as const).map((v) => (
              <button
                key={v}
                onClick={() => changeView(v)}
                className={`rounded-md px-2.5 py-1 uppercase transition ${
                  view === v
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="relative w-72">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-sm text-muted-foreground backdrop-blur focus-within:border-primary/60">
              <Search className="size-4 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && results?.length) pickResult(results[0]);
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search the galaxy…"
                className="w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear">
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
                    onClick={() => pickResult(n)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-primary/10"
                  >
                    <span className="size-2 shrink-0 rounded-full" style={{ background: n.color }} />
                    <span className="truncate">{n.title}</span>
                    <span className="nn-mono ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {clusters[n.cluster]?.label ?? n.cluster}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Cluster legend ─────────────────────────────────────────────── */}
      <div className="absolute bottom-5 left-5 flex flex-col gap-1.5 rounded-lg border border-border bg-card/80 px-4 py-3 backdrop-blur">
        <div className="nn-mono mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Clusters</div>
        {Object.values(clusters).map((c) => (
          <div key={c.label} className="flex items-center gap-2 text-xs text-foreground">
            <span className="size-2.5 rounded-full" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
            {c.label}
          </div>
        ))}
        <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-xs text-foreground">
          <span className="h-0.5 w-4 rounded-full" style={{ background: "#f4aaff", boxShadow: "0 0 8px #f4aaff" }} />
          <span>Cross-folder link</span>
        </div>
      </div>

      {/* ── Selected-node detail panel ─────────────────────────────────── */}
      {selected && (
        <div className="absolute right-5 top-24 w-72 rounded-xl border border-border bg-card/90 p-4 backdrop-blur">
          <div className="flex items-start justify-between gap-2">
            <span
              className="nn-mono rounded-full px-2 py-0.5 text-[10px]"
              style={{ background: `${selected.color}22`, color: selected.color }}
            >
              {clusters[selected.cluster]?.label ?? selected.cluster}
            </span>
            <button onClick={closeSelectedAndReturn} aria-label="Close">
              <X className="size-4 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
          <h3 className="nn-heading mt-2 text-base font-semibold leading-snug text-foreground">{selected.title}</h3>
          <div className="nn-mono mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            {plural(neighbours.length, "connected note")}
          </div>
          <div className="mt-1.5 max-h-56 overflow-y-auto">
            {neighbours.map(({ node: nb, bridge }) => (
              <button
                key={nb.id}
                onClick={() => onNodeClick(nb)}
                onMouseEnter={() => setHover(nb.id, true)}
                onMouseLeave={() => setHover(nb.id, false)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-primary/10"
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: nb.color }} />
                <span className="truncate">{nb.title}</span>
                {bridge && (
                  <span className="nn-mono ml-auto shrink-0 text-[9px]" style={{ color: "#f4aaff" }}>
                    Cross-folder
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            onClick={() => onOpenNote(selected.id)}
            className="mt-3 w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Open in reader
          </button>
        </div>
      )}
    </div>
  );
}
