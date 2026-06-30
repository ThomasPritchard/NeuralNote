import * as THREE from "three";

// Glowing-orb node factory, shared by the galaxy surface and the landing hero.
// A lit + emissive core sphere wrapped in an additive fresnel-glow shell.
const GLOW_VERT = `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const GLOW_FRAG = `
  uniform vec3 uColor;
  varying vec3 vN; varying vec3 vV;
  void main() {
    float i = pow(clamp(0.74 - dot(vN, vV), 0.0, 1.0), 2.8);
    gl_FragColor = vec4(uColor, 1.0) * i * 0.5;
  }`;

export function makeNodeObject(n: any): THREE.Object3D {
  const r = 2.8 * Math.cbrt(Math.max(1, n.val));
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(r, 32, 32),
    new THREE.MeshStandardMaterial({
      color: n.color,
      emissive: n.color,
      emissiveIntensity: 0.35,
      roughness: 0.28,
      metalness: 0.0,
    }),
  );
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.7, 24, 24),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(n.color) } },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  group.add(core, glow);
  return group;
}
