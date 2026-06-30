import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ArrowLeft, Search, Sparkles, X } from "lucide-react";
import { clusters, galaxyStats, graphData, type GraphNode } from "./graph";
import { makeNodeObject } from "./orb";
import { setGalaxy } from "./nav";

// ── NeuralGalaxy ──────────────────────────────────────────────────────────
// A 3D "neural map" of the vault: notes are nodes, AI-inferred semantic links
// are edges, cross-topic BRIDGES glow brighter (the connections you never drew).
// Drag to orbit, scroll to zoom, click a node to fly to it, search to find one.
// Skinned by the active [data-direction] (neuralnote indigo) via overlay tokens.
const BG = "#0a0913";

export default function NeuralGalaxy() {
  const fgRef = useRef<any>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState("");
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Add a restrained bloom pass so only node cores glow (high threshold avoids
  // blowing the whole scene to white), then frame the settled layout.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const bloom = new UnrealBloomPass(new THREE.Vector2(dims.w, dims.h), 0.4, 0.5, 0.45);
    fg.postProcessingComposer().addPass(bloom);
    const t = setTimeout(() => fg.zoomToFit(800, 110), 1800);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(graphData.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
  }, [query]);

  // Fly to the first search match.
  useEffect(() => {
    if (!matches || matches.size === 0) return;
    const first = graphData.nodes.find((n) => matches.has(n.id)) as any;
    if (first && fgRef.current && first.x != null) focus(first);
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = useCallback((node: any) => {
    const dist = 90;
    const r = 1 + dist / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
    fgRef.current?.cameraPosition(
      { x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r },
      node,
      1400,
    );
  }, []);

  const onNodeClick = useCallback(
    (node: any) => {
      setSelected(node as GraphNode);
      focus(node);
    },
    [focus],
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <ForceGraph3D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor={BG}
        showNavInfo={false}
        nodeId="id"
        nodeVal="val"
        nodeThreeObject={makeNodeObject}
        nodeLabel={(n: any) =>
          `<div style="font:600 12px Inter,sans-serif;color:#fff;background:rgba(20,18,32,.92);border:1px solid rgba(255,255,255,.12);padding:5px 9px;border-radius:8px">${n.title}<span style="color:${n.color};margin-left:8px;font-weight:500">${clusters[n.cluster].label}</span></div>`
        }
        linkColor={(l: any) => (l.bridge ? "rgba(244,170,255,0.85)" : "rgba(150,150,200,0.16)")}
        linkWidth={(l: any) => (l.bridge ? 0.8 : 0.3)}
        linkDirectionalParticles={(l: any) => (l.bridge ? 3 : 0)}
        linkDirectionalParticleWidth={1.6}
        linkDirectionalParticleColor={() => "#f4aaff"}
        onNodeClick={onNodeClick}
        onBackgroundClick={() => setSelected(null)}
        onEngineStop={() => fgRef.current?.zoomToFit(800, 110)}
      />

      {/* ── Top bar: back + title + search ─────────────────────────────── */}
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

        <label className="pointer-events-auto flex w-72 items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-sm text-muted-foreground backdrop-blur focus-within:border-primary/60">
          <Search className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the galaxy…"
            className="w-full bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear">
              <X className="size-3.5 hover:text-foreground" />
            </button>
          )}
        </label>
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
            <button onClick={() => setSelected(null)} aria-label="Close">
              <X className="size-4 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
          <h3 className="nn-heading mt-2 text-base font-semibold leading-snug text-foreground">{selected.title}</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {linkedTitles(selected.id)} connected note{linkedCount(selected.id) === 1 ? "" : "s"}. Click a neighbour
            to traverse, or open in the reader.
          </p>
          <button className="mt-3 w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">
            Open in reader
          </button>
        </div>
      )}
    </div>
  );
}

function linkedCount(id: string): number {
  return graphData.links.filter((l: any) => l.source === id || l.target === id || l.source?.id === id || l.target?.id === id).length;
}
function linkedTitles(id: string): number {
  return linkedCount(id);
}
