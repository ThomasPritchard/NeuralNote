import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ArrowLeft, Search, Sparkles, X } from "lucide-react";
import { clusters, galaxyStats, graphData, type GraphNode } from "./graph";
import { makeStarNode } from "./starNode";
import { makeHybridNode } from "./hybridNode";
import { resetRegistry, setHover, updateAll } from "./nodeRegistry";
import { PREFILTER_PX, pickNode, type PickCandidate } from "./magneticPick";
import { setGalaxy } from "./nav";

// ── NeuralGalaxy ──────────────────────────────────────────────────────────
// A 3D "neural map" of the vault: notes are nodes, AI-inferred semantic links
// are edges, cross-topic BRIDGES glow brighter (the connections you never drew).
// Drag to orbit, scroll to zoom, click a node to fly to it, search to find one.
// Skinned by the active [data-direction] (neuralnote indigo) via overlay tokens.
//
// Galaxy restyle: nodes render in the ReactBits-galaxy idiom (twinkling stars),
// switchable between a flat "star" sprite and a "orb" hybrid, over a tamed
// ambient star backdrop. The cursor gives subtle life (backdrop parallax +
// node hover-glow) — never the galaxy's "everything warps to the pointer".
const BG = "#0a0913";

type NodeVariant = "star" | "orb";
type ViewMode = "3d" | "2d";

function readNodeVariant(): NodeVariant {
  return new URLSearchParams(window.location.search).get("node") === "orb" ? "orb" : "star";
}

// Experimental screen-space picking (?pick=magnet): hover snaps to the best
// node near the cursor instead of raycasting geometry. See magneticPick.ts.
function readMagnetFlag(): boolean {
  return new URLSearchParams(window.location.search).get("pick") === "magnet";
}

const MORPH_MS = 1100;
const FOV_2D = 20; // narrow lens ≈ orthographic once the dolly-zoom lands

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export default function NeuralGalaxy() {
  const fgRef = useRef<any>(null);
  const hoveredRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const reducedRef = useRef(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState("");
  const [variant, setVariant] = useState<NodeVariant>(readNodeVariant);
  const [view, setView] = useState<ViewMode>("3d");
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight });
  const magnetic = useMemo(readMagnetFlag, []);
  const magnetNodeRef = useRef<any>(null);
  const morphRaf = useRef(0);
  const savedCamRef = useRef<{ pos: THREE.Vector3; fov: number } | null>(null);

  useEffect(() => {
    const onResize = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Adjacency for hover-glow and the panel's neighbour list: a node's direct
  // neighbours (with the AI-bridge flag) in both directions. Links may be raw
  // id strings or (post-simulation) node refs — handle both.
  const adjacency = useMemo(() => {
    const m = new Map<string, { id: string; bridge: boolean }[]>();
    const add = (a: string, b: string, bridge: boolean) =>
      m.set(a, [...(m.get(a) ?? []), { id: b, bridge }]);
    for (const l of graphData.links as any[]) {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      add(s, t, !!l.bridge);
      add(t, s, !!l.bridge);
    }
    return m;
  }, []);

  const nodeById = useMemo(() => new Map(graphData.nodes.map((n) => [n.id, n])), []);

  // Init (once): restrained bloom (only node cores glow) plus a single RAF loop
  // driving node twinkle and hover-glow easing. The graph is never remounted,
  // so this scene lives for the component's lifetime.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const bloom = new UnrealBloomPass(new THREE.Vector2(dims.w, dims.h), 0.4, 0.5, 0.45);
    fg.postProcessingComposer().addPass(bloom);
    (window as any).__nnFg = fg; // dev debug handle (prototype only)

    // Disperse the resting layout: stronger repulsion + longer link
    // rest-length than the lib defaults (-60 charge, 30 distance), so
    // clusters separate and their members breathe instead of clumping.
    fg.d3Force("charge")?.strength(-160);
    fg.d3Force("link")?.distance(55);

    const start = performance.now();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const time = reducedRef.current ? 0 : (performance.now() - start) / 1000;
      // twinkle + hover-glow easing + proximity label fade (hover works even
      // if reduced). fovScale normalizes label distances for the 2D lens.
      // Label bands self-calibrate against the graph's live bounding radius
      // (absolute constants broke the moment the layout dispersion changed):
      // fitDist ≈ the effective distance of a whole-graph overview. 3D shows
      // ghosts at the fitted overview and sharpens on approach; 2D stays
      // fully labeled at its fit and fades only when pulled well back.
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const fovScale = Math.tan((cam.fov * Math.PI) / 360) / Math.tan((50 * Math.PI) / 360);
      let r2max = 1;
      for (const n of graphData.nodes as any[]) {
        if (n.x == null) continue;
        const d2 = n.x * n.x + n.y * n.y + (n.z ?? 0) * (n.z ?? 0);
        if (d2 > r2max) r2max = d2;
      }
      const fitDist = Math.sqrt(r2max) / Math.tan((25 * Math.PI) / 180);
      // Fractions calibrated against measured resting ratios: the 3D
      // overview sits at ~1.45×fitDist (ghost labels there, crisp a couple
      // of zoom notches in); the fitted 2D map sits at ~1.2×fitDist (fully
      // labeled, gone by ~2× when pulled well back).
      const band: [number, number] =
        viewRef.current === "2d"
          ? [1.25 * fitDist, 1.9 * fitDist]
          : [0.95 * fitDist, 1.75 * fitDist];
      updateAll(time, { camPos: cam.position, fovScale, band });
    };
    raf = requestAnimationFrame(tick);

    const framed = setTimeout(() => fg.zoomToFit(800, 110), 1800);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(morphRaf.current);
      clearTimeout(framed);
      resetRegistry();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Swap node style in place (no remount): clear stale handles and rebuild node
  // objects with the new factory. Positions are preserved, so the two variants
  // are compared on identical layouts. Skips the initial mount.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    resetRegistry();
    fgRef.current?.refresh();
  }, [variant]);

  // Search results for the dropdown. No auto-fly while typing — flying to
  // the first match on each keystroke guesses the destination too eagerly;
  // the user picks from the list instead (or hits Enter for the top result).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return graphData.nodes.filter((n) => n.title.toLowerCase().includes(q));
  }, [query]);

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
      setSelected(node as GraphNode);
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

  const changeVariant = (v: NodeVariant) => {
    setVariant(v);
    const url = new URL(window.location.href);
    url.searchParams.set("node", v);
    window.history.replaceState(null, "", url);
  };

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
      const nodes = graphData.nodes as any[];
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
    [],
  );

  const viewRef = useRef<ViewMode>("3d");
  const changeView = useCallback(
    (v: ViewMode) => {
      const fg = fgRef.current;
      if (v === viewRef.current || !fg) return;
      viewRef.current = v;
      setView(v);
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

  // ── Magnetic picking (flagged) ───────────────────────────────────────────
  // Library raycast picking is off; hover snaps to the best candidate near
  // the cursor, projected straight through the camera (node coordinates are
  // real in both views since the 2D morph pins positions).
  const scratchVec = useMemo(() => new THREE.Vector3(), []);
  const onMagnetMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const fg = fgRef.current;
      if (!fg) return;
      const overCanvas = (e.target as HTMLElement).tagName === "CANVAS";
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cam = fg.camera();
      const candidates: PickCandidate[] = [];
      // Pointer over a UI panel = no candidates, so hover/cursor clear
      // instead of freezing on the last node.
      for (const n of overCanvas ? (graphData.nodes as any[]) : []) {
        if (n.x == null) continue;
        scratchVec.set(n.x, n.y, n.z ?? 0).project(cam);
        if (scratchVec.z > 1 || scratchVec.z < -1) continue;
        const sx = ((scratchVec.x + 1) * rect.width) / 2;
        const sy = ((1 - scratchVec.y) * rect.height) / 2;
        const px = Math.hypot(sx - mx, sy - my);
        if (px < PREFILTER_PX) candidates.push({ node: n, px, depth: scratchVec.z });
      }
      const winner = pickNode(candidates);
      if (winner !== magnetNodeRef.current) {
        magnetNodeRef.current = winner;
        onNodeHover(winner);
        e.currentTarget.style.cursor = winner ? "pointer" : "";
      }
    },
    [onNodeHover, scratchVec],
  );

  const onMagnetClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).tagName !== "CANVAS") return; // ignore UI clicks
      const winner = magnetNodeRef.current;
      if (winner) onNodeClick(winner);
      else dismissSelected();
    },
    [onNodeClick, dismissSelected],
  );

  const nodeFactory = variant === "star" ? makeStarNode : makeHybridNode;

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-background"
      onPointerMove={magnetic ? onMagnetMove : undefined}
      onClick={magnetic ? onMagnetClick : undefined}
    >
      <ForceGraph3D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor={BG}
        showNavInfo={false}
        enablePointerInteraction={!magnetic}
        nodeId="id"
        nodeVal="val"
        nodeThreeObject={nodeFactory}
        onNodeHover={onNodeHover}
        nodeLabel={(n: any) =>
          `<div style="font:600 12px Inter,sans-serif;color:#fff;background:rgba(20,18,32,.92);border:1px solid rgba(255,255,255,.12);padding:5px 9px;border-radius:8px">${n.title}<span style="color:${n.color};margin-left:8px;font-weight:500">${clusters[n.cluster].label}</span></div>`
        }
        linkColor={(l: any) => (l.bridge ? "rgba(244,170,255,0.85)" : "rgba(150,150,200,0.16)")}
        linkWidth={(l: any) => (l.bridge ? 0.8 : 0.3)}
        linkDirectionalParticles={(l: any) => (l.bridge ? 3 : 0)}
        linkDirectionalParticleWidth={1.6}
        linkDirectionalParticleColor={() => "#f4aaff"}
        onNodeClick={onNodeClick}
        // In magnet mode the library still fires background clicks (its
        // pointerup path ignores enablePointerInteraction), which would
        // instantly clear the magnet selection — deselection is handled by
        // onMagnetClick instead.
        onBackgroundClick={magnetic ? undefined : dismissSelected}
        onEngineStop={() => fgRef.current?.zoomToFit(800, 110)}
      />

      {/* ── Top bar: back + title + node toggle + search ───────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
        <div className="pointer-events-auto flex items-center gap-3">
          <button
            onClick={() => setGalaxy(false)}
            className="flex items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-sm text-foreground backdrop-blur transition hover:bg-card"
          >
            <ArrowLeft className="size-4" /> Workspace
          </button>
          <div>
            <div className="nn-heading flex items-center gap-2 text-lg font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" /> Neural galaxy
            </div>
            <div className="nn-mono text-[11px] text-muted-foreground">
              {galaxyStats.notes} notes · {galaxyStats.links} links · {galaxyStats.bridges} AI-inferred bridges
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

          {/* Node-style A/B toggle (experimental) */}
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card/80 p-1 text-xs backdrop-blur">
            {(["star", "orb"] as const).map((v) => (
              <button
                key={v}
                onClick={() => changeVariant(v)}
                className={`rounded-md px-2.5 py-1 capitalize transition ${
                  variant === v
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
                      {clusters[n.cluster].label}
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
          AI-inferred bridge
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
              {clusters[selected.cluster].label}
            </span>
            <button onClick={closeSelectedAndReturn} aria-label="Close">
              <X className="size-4 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
          <h3 className="nn-heading mt-2 text-base font-semibold leading-snug text-foreground">{selected.title}</h3>
          <div className="nn-mono mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            {(adjacency.get(selected.id) ?? []).length} connected note
            {(adjacency.get(selected.id) ?? []).length === 1 ? "" : "s"}
          </div>
          <div className="mt-1.5 max-h-56 overflow-y-auto">
            {(adjacency.get(selected.id) ?? []).map(({ id, bridge }) => {
              const nb = nodeById.get(id) as any;
              if (!nb) return null;
              return (
                <button
                  key={id}
                  onClick={() => onNodeClick(nb)}
                  onMouseEnter={() => setHover(id, true)}
                  onMouseLeave={() => setHover(id, false)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-primary/10"
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: nb.color }} />
                  <span className="truncate">{nb.title}</span>
                  {bridge && (
                    <span className="nn-mono ml-auto shrink-0 text-[9px]" style={{ color: "#f4aaff" }}>
                      AI bridge
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button className="mt-3 w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">
            Open in reader
          </button>
        </div>
      )}
    </div>
  );
}
