// A vi.fn-wrapped fake of the react-force-graph-3d instance (what NeuralGalaxy
// reaches via its ref). Covers every method the component calls so tests can
// mount the real component against a mocked <ForceGraph3D/> and assert on the
// imperative traffic (bloom pass add/remove, force tuning, camera flights…).
import * as THREE from "three";
import { vi } from "vitest";

/** A d3 force accessor as NeuralGalaxy uses it: `d3Force("charge").strength(n)`
 *  / `d3Force("link").distance(n)` — chainable, so setters return the force. */
export interface FakeForce {
  strength: ReturnType<typeof vi.fn>;
  distance: ReturnType<typeof vi.fn>;
}

export interface FakeForceGraph {
  postProcessingComposer: ReturnType<typeof vi.fn>;
  d3Force: ReturnType<typeof vi.fn>;
  camera: ReturnType<typeof vi.fn>;
  controls: ReturnType<typeof vi.fn>;
  cameraPosition: ReturnType<typeof vi.fn>;
  zoomToFit: ReturnType<typeof vi.fn>;
  d3ReheatSimulation: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  /** Test-side handles (not part of the real fg surface). */
  __composer: { addPass: ReturnType<typeof vi.fn>; removePass: ReturnType<typeof vi.fn> };
  __camera: THREE.PerspectiveCamera;
  __controls: { target: THREE.Vector3; noRotate: boolean };
  __forces: Record<string, FakeForce>;
}

export function createFakeForceGraph(): FakeForceGraph {
  const composer = { addPass: vi.fn(), removePass: vi.fn() };

  const forces: Record<string, FakeForce> = {};
  const d3Force = vi.fn((name: string) => {
    if (!forces[name]) {
      const force: Partial<FakeForce> = {};
      force.strength = vi.fn(() => force);
      force.distance = vi.fn(() => force);
      forces[name] = force as FakeForce;
    }
    return forces[name];
  });

  // A real camera: the RAF tick and the 2D morph read/write fov and position.
  const camera = new THREE.PerspectiveCamera(50);
  camera.position.set(0, 0, 600);

  const controls = { target: new THREE.Vector3(), noRotate: false };

  return {
    postProcessingComposer: vi.fn(() => composer),
    d3Force,
    camera: vi.fn(() => camera),
    controls: vi.fn(() => controls),
    cameraPosition: vi.fn(),
    zoomToFit: vi.fn(),
    d3ReheatSimulation: vi.fn(),
    refresh: vi.fn(),
    __composer: composer,
    __camera: camera,
    __controls: controls,
    __forces: forces,
  };
}
