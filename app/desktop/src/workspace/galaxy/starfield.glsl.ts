// Shared GLSL building blocks for the galaxy-inspired surfaces.
//
// The `star()` falloff + crossed-flare math is adapted from the ReactBits
// "Galaxy" background shader (DavidHDev/react-bits, OGL fragment shader). We
// lift only the per-star drawing function and the small hashing/HSV helpers it
// needs — re-authored here as a reusable module — rather than porting the whole
// procedural starfield component. Both the node materials (one star each) and
// the backdrop (a layered field of them) include this string.
//
// Injected into THREE.ShaderMaterial fragment shaders, which already provide a
// float precision prelude, so none is declared here.

export const STAR_HELPERS = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  float tri(float x)  { return abs(fract(x) * 2.0 - 1.0); }
  float tris(float x) { float t = fract(x); return 1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0)); }
  float trisn(float x){ float t = fract(x); return 2.0 * (1.0 - smoothstep(0.0, 1.0, abs(2.0 * t - 1.0))) - 1.0; }

  // A single star centred at uv=0: a bright 1/d core, a 4-point flare and a
  // 45deg-rotated secondary flare, faded out toward the cell edge. The glow arg
  // scales the core brightness; the flare arg scales the sparkle streaks.
  float star(vec2 uv, float flare, float glow) {
    float d = length(uv);
    // Epsilon guard: a fragment landing exactly on the quad centre would make
    // 1/d non-finite, and one Inf pixel smears the whole frame via bloom.
    float m = (0.05 * glow) / max(d, 1e-4);
    float rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
    m += rays * flare * glow;
    uv *= mat2(0.7071, -0.7071, 0.7071, 0.7071);
    rays = smoothstep(0.0, 1.0, 1.0 - abs(uv.x * uv.y * 1000.0));
    m += rays * 0.3 * flare * glow;
    m *= smoothstep(1.0, 0.2, d);
    return m;
  }
`;

// Spherical billboard for a quad: place the node origin in view space, then
// offset by the quad corner ignoring rotation, so the sprite always faces the
// camera while perspective still scales it with distance. Expects a `uScale`
// uniform (quad half-extent). Shared by the star node, the hybrid flare and
// the hover ring. Also exports `vDist` (view distance) so fragments can
// attenuate close-up, and caps the effective size so a near star can't grow
// to fill the screen and saturate under bloom.
export const BILLBOARD_VERT = /* glsl */ `
  uniform float uScale;
  varying vec2 vUv;
  varying float vDist;
  void main() {
    vUv = uv;
    vec3 center = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float dist = length(center);
    vDist = dist;
    float s = min(uScale, dist * 0.45);
    vec3 viewPos = center + vec3(position.xy * s, 0.0);
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

// Close-range brightness attenuation shared by the additive star surfaces:
// additive blending + bloom saturate to white as the camera nears, so
// intensity eases down inside ~220 world units. The click-to-focus flight
// parks the camera 90 units out — the curve must already bite hard there,
// while the overview (camera ≥600) stays untouched. Include after vDist is
// declared in the fragment.
export const PROX_ATTEN = /* glsl */ `
  float proxAtten(float dist) {
    return mix(0.14, 1.0, smoothstep(40.0, 220.0, dist));
  }
`;
