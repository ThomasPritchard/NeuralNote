import * as THREE from "three";
import { makeNodeObject } from "./orb";
import { BILLBOARD_VERT, PROX_ATTEN, STAR_HELPERS } from "./starfield.glsl";
import { registerNode, type NodeHandle } from "./nodeRegistry";
import { hitRadius, labelOpacity, makeHitProxy, makeHoverRing, makeNodeLabel } from "./nodeChrome";

// Variant B — the hybrid orb.
//
// Keeps the existing 3D orb (lit core sphere + fresnel shell from orb.ts) for
// real depth and shading, then grafts the galaxy idiom on top: a brighter core,
// a billboarded additive sparkle flare, and a subtle twinkle. orb.ts is reused
// untouched (it is also the landing hero's node), so this never risks that page.

const CORE_EMISSIVE = 0.6; //   brighter than orb.ts's 0.35 for a "star" core
const HOVER_BOOST = 1.4;
const TWINKLE = 0.12; //        gentle — the orb is a solid body, not a flat star
const TWINKLE_SPEED = 1.4;

const FLARE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSeed;
  uniform float uIntensity;
  varying vec2 vUv;
  varying float vDist;
  ${STAR_HELPERS}
  ${PROX_ATTEN}
  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    // Flare-heavy, light core: the orb already supplies the body, so this layer
    // is mostly the sparkle cross.
    float m = star(uv, 0.9, 0.3) * uIntensity * proxAtten(vDist);
    gl_FragColor = vec4(uColor * m, 1.0);
  }
`;

function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

export function makeHybridNode(n: any): THREE.Object3D {
  const group = makeNodeObject(n) as THREE.Group;
  group.scale.setScalar(1.4); // bigger, more prominent (orb.ts stays shared/untouched)
  const r = 2.8 * Math.cbrt(Math.max(1, n.val));
  const seed = seedFrom(n.id);

  // The orb's lit core is the only MeshStandardMaterial in the group.
  const core = group.children.find(
    (c): c is THREE.Mesh =>
      c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial,
  );
  const coreMat = core?.material as THREE.MeshStandardMaterial | undefined;
  if (coreMat) coreMat.emissiveIntensity = CORE_EMISSIVE;

  // Billboarded sparkle flare layered over the orb.
  const flareMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(n.color) },
      uTime: { value: 0 },
      uSeed: { value: seed },
      uIntensity: { value: 1 },
      uScale: { value: r * 3.2 },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: FLARE_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flareMat));

  // Chrome lives on an unscaled root so hit radius, ring and label are sized
  // in world units regardless of the orb group's 1.4x scale.
  const hitR = hitRadius(r * 1.4);
  const ringHandle = makeHoverRing(hitR, n.color);
  const root = new THREE.Group();
  root.add(group, makeHitProxy(hitR), ringHandle.mesh);
  const label = makeNodeLabel(n, hitR);
  root.add(label);

  let hover = 0;
  let hoverTarget = 0;
  const worldPos = new THREE.Vector3();
  const camVec = new THREE.Vector3();
  const handle: NodeHandle = {
    update: (time, labels) => {
      hover += (hoverTarget - hover) * 0.12;
      const boost = 1 + hover * HOVER_BOOST;
      const twinkle = 1 - TWINKLE + TWINKLE * (Math.sin(time * TWINKLE_SPEED + seed * 6.2831) * 0.5 + 0.5);
      if (coreMat) coreMat.emissiveIntensity = CORE_EMISSIVE * boost * twinkle;
      flareMat.uniforms.uTime.value = time;
      flareMat.uniforms.uIntensity.value = boost * twinkle;
      ringHandle.setHover(hover);
      if (labels) {
        root.getWorldPosition(worldPos);
        camVec.set(labels.camPos.x, labels.camPos.y, labels.camPos.z);
        label.material.opacity = labelOpacity(worldPos.distanceTo(camVec) * labels.fovScale, labels.band);
      }
    },
    setHover: (on) => {
      hoverTarget = on ? 1 : 0;
    },
  };
  registerNode(n.id, handle);
  return root;
}
