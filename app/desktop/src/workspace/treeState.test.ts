import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCollapsed, saveCollapsed } from "./treeState";

// The vitest env here doesn't expose localStorage, so we install a fresh
// in-memory one per test. (Production's try/catch already handles the case where
// localStorage is genuinely absent — see treeState.ts.)
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
}

describe("treeState", () => {
  beforeEach(stubLocalStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty set when nothing is stored (all folders open by default)", () => {
    expect(loadCollapsed("/vault/a")).toEqual(new Set());
  });

  it("round-trips a collapsed set through save/load", () => {
    saveCollapsed("/vault/a", new Set(["Work", "Work/2026"]));
    expect(loadCollapsed("/vault/a")).toEqual(new Set(["Work", "Work/2026"]));
  });

  it("keeps each vault's fold state isolated by path", () => {
    saveCollapsed("/vault/a", new Set(["Work"]));
    saveCollapsed("/vault/b", new Set(["Cooking"]));
    expect(loadCollapsed("/vault/a")).toEqual(new Set(["Work"]));
    expect(loadCollapsed("/vault/b")).toEqual(new Set(["Cooking"]));
  });

  it("treats a re-saved empty set as all-open", () => {
    saveCollapsed("/vault/a", new Set(["Work"]));
    saveCollapsed("/vault/a", new Set());
    expect(loadCollapsed("/vault/a")).toEqual(new Set());
  });

  it("degrades to empty on corrupt JSON instead of throwing", () => {
    localStorage.setItem("nn:tree-collapsed:/vault/a", "{not json");
    expect(loadCollapsed("/vault/a")).toEqual(new Set());
  });

  it("ignores a non-array payload", () => {
    localStorage.setItem("nn:tree-collapsed:/vault/a", '{"Work":true}');
    expect(loadCollapsed("/vault/a")).toEqual(new Set());
  });

  it("drops non-string entries so junk can't reach the tree", () => {
    localStorage.setItem("nn:tree-collapsed:/vault/a", '["Work", 7, null, "Notes"]');
    expect(loadCollapsed("/vault/a")).toEqual(new Set(["Work", "Notes"]));
  });
});
