import { useEffect, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { graphData } from "../galaxy/graph";
import { makeNodeObject } from "../galaxy/orb";

// Decorative auto-rotating galaxy for use as a hero background. No overlays, no
// interaction (pointer-events off) so hero text/CTAs above it stay clickable.
// Fills its parent; give the parent a position + size.
export default function GalaxyHero({ className = "" }: { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ w: 960, h: 640 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.postProcessingComposer().addPass(
      new UnrealBloomPass(new THREE.Vector2(dims.w, dims.h), 0.5, 0.5, 0.4),
    );
    const c = fg.controls();
    c.autoRotate = true;
    c.autoRotateSpeed = 0.5;
    c.enableZoom = false;
    c.enablePan = false;
    const t = setTimeout(() => fg.zoomToFit(900, 70), 1600);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrap} className={`pointer-events-none ${className}`} aria-hidden>
      <ForceGraph3D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor="#0b0a16"
        controlType="orbit"
        showNavInfo={false}
        enableNodeDrag={false}
        nodeVal="val"
        nodeThreeObject={makeNodeObject}
        linkColor={(l: any) => (l.bridge ? "rgba(244,170,255,0.7)" : "rgba(150,150,200,0.14)")}
        linkWidth={(l: any) => (l.bridge ? 0.7 : 0.25)}
        linkDirectionalParticles={(l: any) => (l.bridge ? 2 : 0)}
        linkDirectionalParticleWidth={1.4}
        linkDirectionalParticleColor={() => "#f4aaff"}
      />
    </div>
  );
}
