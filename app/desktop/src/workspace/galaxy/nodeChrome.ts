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
  };
}

// Every node carries a label. Cluster hubs (val >= HUB_VAL) are visible from
// afar; leaf labels reveal by proximity — invisible in the overview (forty
// captions at once is noise), legible as the camera closes in. Muted
// off-white keeps the bloom pass from haloing the text.
export const HUB_VAL = 7;

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

// Label opacity from (fov-normalized) camera distance — ONE behavior for
// every node (hubs differ only in text size). closeFade mirrors the shader's
// proxAtten (40→220): ultra-close, a label yields to its star instead of
// blooming into a smear. The far band is the view's to choose: [full, gone]
// in effective units — 3D keeps ghosts at the resting overview and sharpens
// on approach; 2D stays fully labeled at the fitted map and fades only when
// pulled well back beyond it.
export type LabelBand = [full: number, gone: number];

export function labelOpacity(dist: number, band: LabelBand): number {
  const closeFade = smooth01((dist - 40) / 180);
  const farFade = 1 - smooth01((dist - band[0]) / (band[1] - band[0]));
  return (0.08 + 0.82 * closeFade) * farFade;
}
