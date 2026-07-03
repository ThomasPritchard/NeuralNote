// Global test setup: jest-dom matchers (toBeInTheDocument, etc.), DOM cleanup
// between tests, and stubs for browser APIs jsdom lacks (matchMedia,
// ResizeObserver — both used by the graph view). Tauri IPC (`invoke`, `listen`)
// is mocked per-test where needed.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom has no matchMedia. Default stub: no media query matches (i.e. no
// reduced-motion). Tests that need `matches: true` override via vi.stubGlobal.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(), // legacy API, some libs still probe it
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom has no ResizeObserver. Inert by default (never fires); tests that need
// to drive a resize install their own controllable stub via vi.stubGlobal.
class ResizeObserverStub implements ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
globalThis.ResizeObserver ??= ResizeObserverStub;
