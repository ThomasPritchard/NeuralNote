// A tiny registry that lets the single per-frame loop in NeuralGalaxy drive
// every node's twinkle and hover-glow without walking the THREE scene graph or
// re-rendering React. Each node factory builds a handle (closures over its own
// materials) and registers it by id; the loop calls `updateAll(time)`, and
// hover handlers flip `setHover` on a node + its neighbours.

// Per-frame label/chrome context: camera world position, fovScale (tan(fov/2)
// relative to the resting lens — <1 when the dolly-zoomed 2D lens magnifies,
// so the ultra-close fade tracks how close things LOOK), and pxPerWorld
// (screen px per world unit at distance 1 = viewportHalfHeight / tan(fov/2)),
// from which each node derives its projected size for the screen-space label
// reveal and the minimum hit-target scaling.
export interface LabelCtx {
  camPos: { x: number; y: number; z: number };
  fovScale: number;
  pxPerWorld: number;
}

export interface NodeHandle {
  // Advance twinkle and ease the hover-glow toward its target. Called once
  // per frame; labels fade from the LabelCtx when provided.
  update: (time: number, labels?: LabelCtx) => void;
  // Target the hover-glow on or off; the handle eases toward it in `update`.
  setHover: (on: boolean) => void;
}

const handles = new Map<string, NodeHandle>();

export function registerNode(id: string, handle: NodeHandle): void {
  handles.set(id, handle);
}

export function resetRegistry(): void {
  handles.clear();
}

export function updateAll(time: number, labels?: LabelCtx): void {
  handles.forEach((h) => h.update(time, labels));
}

export function setHover(id: string, on: boolean): void {
  handles.get(id)?.setHover(on);
}
