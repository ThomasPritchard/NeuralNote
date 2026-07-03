import * as THREE from "three";
import { BILLBOARD_VERT, PROX_ATTEN, STAR_HELPERS } from "./starfield.glsl";
import { registerNode, type NodeHandle } from "./nodeRegistry";
import { hitRadius, labelOpacity, makeHitProxy, makeHoverRing, makeNodeLabel } from "./nodeChrome";

// Variant A — the galaxy "star" node.
//
// A single billboarded quad whose shader draws one star() (bright 1/d core +
// sparkle flare), tinted by the node's cluster colour. No lit sphere: the look
// is a flat, additive, twinkling star rather than an orb. The quad is held
// facing the camera in the vertex shader (a spherical billboard), so it never
// shears as you orbit, and it never needs per-node JS to re-orient.

const HOVER_BOOST = 1.6; // how much brighter a hovered/neighbour node burns
const TWINKLE = 0.4; //     depth of the per-star brightness flicker (0..1)
const TWINKLE_SPEED = 0.5;

const STAR_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSeed;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vDist;
  ${STAR_HELPERS}
  ${PROX_ATTEN}
  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;                          // -1..1 across the quad
    float atten = proxAtten(vDist);
    float tw = trisn(uTime * ${TWINKLE_SPEED.toFixed(2)} + uSeed * 6.2831) * 0.5 + 1.0;
    float twinkle = mix(1.0, tw, ${TWINKLE.toFixed(2)});
    float m = star(uv, 0.65, 1.25) * uIntensity * twinkle * atten;
    // Solid nucleus: a crisp near-white core so the star reads as a body you
    // could touch, not just haze. Steadier than the glow (no twinkle).
    float core = smoothstep(0.11, 0.03, length(uv)) * atten;
    vec3 col = uColor * m + mix(uColor, vec3(1.0), 0.7) * core * uIntensity;
    // Additive (SRC_ALPHA, ONE): rgb is added, and m -> 0 at the rim leaves no box.
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Stable 0..1 phase per node id so stars don't all twinkle in lock-step.
function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

export function makeStarNode(n: any): THREE.Object3D {
  const r = 4.4 * Math.cbrt(Math.max(1, n.val));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(n.color) },
      uTime: { value: 0 },
      uSeed: { value: seedFrom(n.id) },
      uIntensity: { value: 1 },
      uScale: { value: r * 2.8 }, // quad half-extent; glow reaches the rim
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);

  // Chrome: real-geometry hit target (the shader-billboarded quad is invisible
  // to the raycaster), a ring that reveals it on hover, hub labels.
  const hitR = hitRadius(r);
  const ring = makeHoverRing(hitR, n.color);
  const group = new THREE.Group();
  group.add(mesh, makeHitProxy(hitR), ring.mesh);
  const label = makeNodeLabel(n, hitR);
  group.add(label);

  // Twinkle + eased hover-glow, driven once per frame by NeuralGalaxy's loop.
  let hover = 0;
  let hoverTarget = 0;
  const worldPos = new THREE.Vector3();
  const camVec = new THREE.Vector3();
  const handle: NodeHandle = {
    update: (time, labels) => {
      hover += (hoverTarget - hover) * 0.12;
      material.uniforms.uTime.value = time;
      material.uniforms.uIntensity.value = 1 + hover * HOVER_BOOST;
      ring.setHover(hover);
      if (labels) {
        group.getWorldPosition(worldPos);
        camVec.set(labels.camPos.x, labels.camPos.y, labels.camPos.z);
        label.material.opacity = labelOpacity(worldPos.distanceTo(camVec) * labels.fovScale, labels.band);
      }
    },
    setHover: (on) => {
      hoverTarget = on ? 1 : 0;
    },
  };
  registerNode(n.id, handle);
  return group;
}
