import { useCallback, useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { applyForceProfile } from "./galaxyForces";
import { resetRegistry, updateAll } from "./nodeRegistry";

interface GalaxySceneArgs {
  fgRef: RefObject<any>;
  rootRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
  /** Whether to freeze motion (twinkle) for prefers-reduced-motion. */
  reducedRef: RefObject<boolean>;
}

export interface GalaxyScene {
  /** Auto-frame guard: fits the graph at most once per mount (onEngineStop). */
  frameOnce: () => void;
}

// Init (once): restrained bloom (only node cores glow) plus a single RAF loop
// driving node twinkle and hover-glow easing. The graph is never remounted, so
// this scene lives for the component's lifetime.
export function useGalaxyScene({
  fgRef,
  rootRef,
  width,
  height,
  reducedRef,
}: GalaxySceneArgs): GalaxyScene {
  // The RAF tick (mount effect, [] deps) needs the LIVE viewport height for
  // screen-space label/hit math — a ref sidesteps the stale closure.
  const heightRef = useRef(height);
  heightRef.current = height;

  // ── Auto-framing: at most ONCE per mount, never against the user ─────────
  // The layout engine restarts on every morph reheat, profile swap, and drag,
  // so an engine stop can land seconds into the user's own navigation — an
  // unguarded zoomToFit there yanks the camera away mid-zoom. One guard is
  // shared by the initial 1800ms timeout and the engine-stop handler
  // (whichever fires first wins); the first wheel/pointerdown hands the
  // camera to the user and kills any pending auto-frame. Deliberate fits are
  // unaffected: changeView's 2D frame calls zoomToFit directly, and a
  // drill-down isolation remounts with a fresh guard (auto-fits once again).
  const framedRef = useRef(false);
  const frameOnce = useCallback(() => {
    if (framedRef.current) return;
    framedRef.current = true;
    fgRef.current?.zoomToFit(800, 110);
  }, [fgRef]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.4, 0.5, 0.45);
    fg.postProcessingComposer().addPass(bloom);

    // Layout physics live in FORCE_PROFILES (galaxyForces). The graph mounts
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

    const framed = setTimeout(frameOnce, 1800);

    // First wheel/pointerdown = the user owns the camera: cancel any pending
    // auto-frame (both the timeout above and the engine-stop path).
    const cancelAutoFrame = () => {
      framedRef.current = true;
      clearTimeout(framed);
    };
    const root = rootRef.current;
    root?.addEventListener("wheel", cancelAutoFrame, { passive: true });
    root?.addEventListener("pointerdown", cancelAutoFrame);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(framed);
      root?.removeEventListener("wheel", cancelAutoFrame);
      root?.removeEventListener("pointerdown", cancelAutoFrame);
      // StrictMode: the composer outlives this effect's dev double-invoke, so
      // the bloom pass must come off or two stacked passes wash out the render.
      fg.postProcessingComposer().removePass(bloom);
      resetRegistry(); // the node registry is a module singleton
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { frameOnce };
}
