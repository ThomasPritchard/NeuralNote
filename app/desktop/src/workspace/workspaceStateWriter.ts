import type { WorkspaceState } from "../lib/types";

export interface WorkspaceStateWriter {
  schedule: (state: WorkspaceState) => void;
  flush: () => Promise<void>;
}

const isSameState = (left: WorkspaceState, right: WorkspaceState): boolean =>
  left.activePath === right.activePath &&
  left.openPaths.length === right.openPaths.length &&
  left.openPaths.every((path, index) => path === right.openPaths[index]);

export function createWorkspaceStateWriter(
  save: (state: WorkspaceState) => Promise<void>,
  onError: (error: unknown) => void,
): WorkspaceStateWriter {
  let pending: WorkspaceState | null = null;
  let running: Promise<void> | null = null;
  let scheduled = false;
  let lastSaved: WorkspaceState | null = null;

  const drain = async (): Promise<void> => {
    scheduled = false;
    if (running) {
      await running;
      if (pending) await drain();
      return;
    }

    const next = pending;
    if (!next) return;
    pending = null;
    if (lastSaved && isSameState(lastSaved, next)) return;
    const task = save(next)
      .then(() => {
        lastSaved = next;
      })
      .catch(onError);
    running = task;
    await task;
    if (running === task) running = null;
    if (pending) await drain();
  };

  return {
    schedule(state) {
      pending = {
        openPaths: [...state.openPaths],
        activePath: state.activePath,
      };
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => void drain());
    },
    async flush() {
      scheduled = false;
      // eslint-disable-next-line eslint/no-unmodified-loop-condition -- `running`/`pending` are reassigned inside the awaited `drain()` closure, which static analysis can't see.
      while (running || pending) {
        if (running) await running;
        else await drain();
      }
    },
  };
}
