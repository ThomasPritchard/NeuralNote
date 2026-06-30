// Global test setup: jest-dom matchers (toBeInTheDocument, etc.) and DOM cleanup
// between tests. Tauri IPC (`invoke`, `listen`) is mocked per-test where needed.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
