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
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks } from "@tauri-apps/api/mocks";
import App from "../App";
import { createMockVault, type CreateMockVaultOptions, type MockVault } from "./mockVault";

afterEach(() => {
  cleanup();
  clearMocks();
});

export interface RenderAppResult {
  user: ReturnType<typeof userEvent.setup>;
  backend: MockVault;
}

/** Install the mock backend, render <App/>, and return the driver + backend. */
export function renderApp(opts?: CreateMockVaultOptions): RenderAppResult {
  const backend = createMockVault(opts);
  backend.install();
  const user = userEvent.setup();
  render(<App />);
  return { user, backend };
}
