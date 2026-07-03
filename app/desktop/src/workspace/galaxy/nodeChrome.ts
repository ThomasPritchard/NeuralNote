import * as THREE from "three";
import SpriteText from "three-spritetext";
import { BILLBOARD_VERT, PROX_ATTEN } from "./starfield.glsl";

// Shared node "chrome" — the pieces every node variant needs around its
// visual: an invisible raycast proxy, a hover ring that reveals the true
// click target, and a persistent label for cluster hubs.
//
// The proxy exists because both variants draw their star on the GPU (the
// billboard vertex shader scales and orients the quad), which the CPU
// raycaster never sees — without a real sphere the click target is a
// 2-unit plane frozen in world orientation.

// Minimum hit radius in world units, so leaf notes are as acquirable as hubs.
export const HIT_FLOOR = 9;

export function hitRadius(visualR: number): number {
  return Math.max(visualR * 2, HIT_FLOOR);
}

// World units are meaningless to a fingertip: at the fitted overview a
// 9-unit proxy projects sub-pixel. The per-frame tick scales each proxy so
// its PROJECTED radius never drops below MIN_HIT_PX (the hover ring tracks
// the same radius, so the revealed target stays the true click target).
export const MIN_HIT_PX = 10;

/**
 * Scale factor for a hit proxy of world radius `hitR`, viewed from `dist`
 * with `pxPerWorld` screen px per world unit at distance 1. Never below 1 —
 * a close-up proxy keeps its true (world-tuned) radius.
 */
export function hitProxyScale(hitR: number, pxPerWorld: number, dist: number): number {
  const projectedPx = (hitR * pxPerWorld) / Math.max(dist, 1e-6);
  return Math.max(1, MIN_HIT_PX / projectedPx);
}

export function makeHitProxy(hitR: number): THREE.Mesh {
  // Material-invisible (not object-invisible): three.js still raycasts it.
  return new THREE.Mesh(
    new THREE.SphereGeometry(hitR, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
}

const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uHover;
  varying vec2 vUv;
  varying float vDist;
  ${PROX_ATTEN}
  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    float d = length(uv);
    float ring = smoothstep(0.78, 0.85, d) * (1.0 - smoothstep(0.88, 0.95, d));
    gl_FragColor = vec4(uColor, 1.0) * ring * uHover * 0.9 * proxAtten(vDist);
  }
`;

export interface HoverRing {
  mesh: THREE.Mesh;
  setHover: (eased: number) => void;
  /** Re-aim the annulus at a (possibly screen-space-grown) hit radius. */
  setRadius: (worldR: number) => void;
}

// The annulus peaks at ~0.86 of the quad half-extent, so the quad is
// oversized to land the ring exactly at the hit radius.
export function makeHoverRing(hitR: number, color: string): HoverRing {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHover: { value: 0 },
      uScale: { value: hitR / 0.86 },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: RING_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  return {
    mesh,
    setHover: (eased) => {
      material.uniforms.uHover.value = eased;
    },
    setRadius: (worldR) => {
      material.uniforms.uScale.value = worldR / 0.86;
    },
  };
}

// Every node carries a label, and ONE fade rule governs them all: a label
// reveals when its star's PROJECTED radius crosses LABEL_REVEAL_PX (see
// labelOpacity). Hubs differ only in text size and — being bigger stars —
// cross the reveal threshold earlier as you zoom; nothing is always-on, so
// the fitted overview stays a clean field of stars. Muted off-white keeps
// the bloom pass from haloing the text.
//
// HUB_VAL gates the bigger text tier. Under graphTransform's degreeVal
// mapping (2.5 + 2.2·√degree, cap 17) it corresponds to degree ≥ 12 —
// genuinely top-tier MOC territory, pinned by graphTransform.test.ts.
export const HUB_VAL = 10;

export function makeNodeLabel(n: { title: string; val: number }, hitR: number): SpriteText {
  const isHub = n.val >= HUB_VAL;
  const label = new SpriteText(n.title, isHub ? 4 : 3, "#d9d8ea");
  label.fontFace = "Inter, sans-serif";
  label.fontWeight = "600";
  label.position.y = -(hitR + 4);
  label.material.transparent = true;
  label.material.opacity = 0; // first frame tick sets the real fade
  return label;
}

function smooth01(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// Label reveal is SCREEN-SPACE: readability is about apparent size, not
// world distance (distance bands broke at real-vault scale — every label
// rendered at the fitted overview). A label starts fading in when its star's
// projected radius crosses LABEL_REVEAL_PX and is fully on by LABEL_FULL_PX.
// Projection (worldR · pxPerWorld / dist) is inherently fov-correct, so the
// 2D dolly-zoom lens (fov 20) and the 3D view behave equivalently for free.
//
// Tuned headlessly at real-vault scale (~765 notes, 1400×1800 viewport): the
// fitted 2D overview projects the biggest hubs at ~18px (zero labels needs
// reveal > that with margin) and a wheel notch zooms ~×1.4, so hubs (~37px
// two notches in) label first while degree-1-2 leaves (~15px there) stay
// quiet until the camera is well into a neighbourhood (~4 notches).
export const LABEL_REVEAL_PX = 30;
export const LABEL_FULL_PX = 40;

/**
 * @param screenR  the star's projected on-screen radius in px
 * @param effDist  fov-normalized camera distance (world dist × fovScale) —
 *                 drives only the ultra-close fade, mirroring the shader's
 *                 proxAtten (40→220): parked on a star, its label yields
 *                 instead of blooming into a smear.
 */
export function labelOpacity(screenR: number, effDist: number): number {
  const reveal = smooth01((screenR - LABEL_REVEAL_PX) / (LABEL_FULL_PX - LABEL_REVEAL_PX));
  const closeFade = smooth01((effDist - 40) / 180);
  return reveal * (0.08 + 0.82 * closeFade);
}
