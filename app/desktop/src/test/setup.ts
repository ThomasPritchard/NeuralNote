// Global test setup: jest-dom matchers (toBeInTheDocument, etc.), DOM cleanup
// between tests, and stubs for browser APIs jsdom lacks (matchMedia,
// ResizeObserver — both used by the graph view). Tauri IPC (`invoke`, `listen`)
// is mocked per-test where needed.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  globalThis.localStorage?.clear();
});

// jsdom has no matchMedia. Default stub: no media query matches (i.e. no
// reduced-motion). Tests that need `matches: true` override via vi.stubGlobal.
Object.defineProperty(globalThis, "matchMedia", {
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

// Lexical scrolls a freshly edited selection into view. jsdom implements Range
// but not its layout methods; a zero rect is sufficient for interaction tests.
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;

// jsdom's <dialog> carries only the `open` property — showModal()/close() are
// unimplemented (jsdom/jsdom#3294). Minimal polyfill so components can drive a
// native modal dialog; top-layer/inert/focus behaviour stays a real-browser
// concern (covered by the Tier-2 native WebDriver specs).
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};
