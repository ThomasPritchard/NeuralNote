import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import * as THREE from "three";
import type { GalaxyNode } from "./graph";
import {
  applyForceProfile,
  easeInOut,
  FORCE_PROFILES,
  FOV_2D,
  MORPH_MS,
  type ViewMode,
} from "./galaxyForces";

interface GalaxyCameraArgs {
  fgRef: RefObject<any>;
  reducedRef: RefObject<boolean>;
  /** IMMUTABLE per mount — the morph mutates node objects in place. */
  data: { nodes: GalaxyNode[] };
  setSelected: Dispatch<SetStateAction<GalaxyNode | null>>;
  /** Clears a parked hover when the view morphs (the lib only re-raycasts on
   *  mousemove). Sourced from useHoverFocus. */
  onNodeHover: (node: any) => void;
}

export interface GalaxyCamera {
  view: ViewMode;
  onNodeClick: (node: any) => void;
  dismissSelected: () => void;
  closeSelectedAndReturn: () => void;
  changeView: (v: ViewMode) => void;
  /** Stable identity, on purpose: `linkWidth` sits on the library's
   *  recreate-objects list, so a fresh identity per render would rebuild
   *  every link mesh. Width re-evaluates per digest via viewRef. */
  linkWidth: (l: any) => number;
}

export function useGalaxyCamera({
  fgRef,
  reducedRef,
  data,
  setSelected,
  onNodeHover,
}: GalaxyCameraArgs): GalaxyCamera {
  const [view, setView] = useState<ViewMode>("3d");
  const viewRef = useRef<ViewMode>("3d");
  const morphRaf = useRef(0);
  const savedCamRef = useRef<{ pos: THREE.Vector3; fov: number } | null>(null);
  // Cancel any in-flight morph tween when the galaxy unmounts (the RAF would
  // otherwise fire once more against a torn-down scene). The value is read at
  // cleanup time on purpose — it must be the LATEST pending frame id.
  useEffect(() => () => cancelAnimationFrame(morphRaf.current), []);
  // Camera pose from before the first click-focus of a selection session, so
  // the panel's ✕ can fly back out. Traversing neighbours keeps the original
  // pose; background-click dismisses in place (pose dropped, no flight).
  const preFocusRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  const focus = useCallback(
    (node: any) => {
      const dist = 90;
      const r = 1 + dist / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
      fgRef.current?.cameraPosition(
        { x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r },
        node,
        1400,
      );
    },
    [fgRef],
  );

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
    [fgRef, focus, setSelected],
  );

  const dismissSelected = useCallback(() => {
    preFocusRef.current = null;
    setSelected(null);
  }, [setSelected]);

  const closeSelectedAndReturn = useCallback(() => {
    const saved = preFocusRef.current;
    preFocusRef.current = null;
    setSelected(null);
    if (saved) fgRef.current?.cameraPosition(saved.pos, saved.target, reducedRef.current ? 0 : 1200);
  }, [fgRef, reducedRef, setSelected]);

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
    [fgRef, reducedRef, data],
  );

  const changeView = useCallback(
    (v: ViewMode) => {
      const fg = fgRef.current;
      if (v === viewRef.current || !fg) return;
      viewRef.current = v;
      setView(v);
      // The library only re-raycasts on mousemove: a hover parked under the
      // morphing camera would keep the old neighbourhood lit — drop it.
      onNodeHover(null);
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
    [fgRef, reducedRef, animateMorph, onNodeHover],
  );

  const linkWidth = useCallback((l: any) => {
    const p = FORCE_PROFILES[viewRef.current];
    return l.bridge ? p.bridgeWidth : p.linkWidth;
  }, []);

  return { view, onNodeClick, dismissSelected, closeSelectedAndReturn, changeView, linkWidth };
}
