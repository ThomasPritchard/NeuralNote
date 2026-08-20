// Render harness for the mockIPC e2e suite: install the in-memory vault backend,
// render the REAL <App/>, and hand back a userEvent instance + the backend handle.
//
// Teardown is registered here (once per importing test file): cleanup() unmounts
// the tree FIRST — so the store's `vault://tree-changed` and the window's
// `tauri://close-requested` unlisten callbacks still find a live IPC mock — then
// clearMocks() wipes the Tauri internals. Including cleanup() here makes the
// ordering robust regardless of how Vitest interleaves it with the global
// afterEach(cleanup) in src/test/setup.ts.

import { afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import App from "../App";
import { DEFAULT_PREFERENCES } from "../preferences/preferences";
import { CURRENT_RELEASE_NOTES } from "../whats-new/releaseNotes";
import { createMockVault, type CreateMockVaultOptions, type MockVault } from "./mockVault";

const contractBackends = new Set<MockVault>();

afterEach(() => {
  let contractError: unknown;
  for (const backend of contractBackends) {
    try {
      backend.assertContractConsumed();
    } catch (error) {
      contractError ??= error;
    }
  }
  contractBackends.clear();
  cleanup();
  clearMocks();
  if (contractError) throw contractError;
});

export interface RenderAppResult {
  user: ReturnType<typeof userEvent.setup>;
  backend: MockVault;
  /** Deliver exactly one queued mock frame/control task under React `act`. */
  advanceNextFrame: () => Promise<boolean>;
  /** Deliver all currently queued mock frames/control tasks under React `act`. */
  advanceAllFrames: () => Promise<number>;
}

const advanceScheduled = async <T,>(run: () => T): Promise<T> => {
  let result!: T;
  await act(async () => {
    result = run();
    await Promise.resolve();
  });
  return result;
};

/** Install the mock backend, render <App/>, and return the driver + backend. */
export function renderApp(opts?: CreateMockVaultOptions): RenderAppResult {
  const backend = createMockVault(opts);
  if (opts?.mockIpcScenario) contractBackends.add(backend);
  backend.install();
  const user = userEvent.setup();
  render(
    <App
      initialPreferences={{
        preferences: {
          ...DEFAULT_PREFERENCES,
          lastSeenWhatsNewVersion: CURRENT_RELEASE_NOTES.version,
        },
        recoveredFromCorrupt: false,
        readFailed: false,
        recoveryMessage: null,
      }}
    />,
  );
  return {
    user,
    backend,
    advanceNextFrame: () => advanceScheduled(() => backend.scheduler.runNext()),
    advanceAllFrames: () => advanceScheduled(() => backend.scheduler.runAll()),
  };
}
