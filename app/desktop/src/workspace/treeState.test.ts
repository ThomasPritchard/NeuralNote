import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExpanded, saveExpanded } from "./treeState";

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

  it("returns an empty set when nothing is stored (all folders collapsed by default)", () => {
    expect(loadExpanded("/vault/a")).toEqual(new Set());
  });

  it("round-trips an expanded set through save/load", () => {
    saveExpanded("/vault/a", new Set(["Work", "Work/2026"]));
    expect(loadExpanded("/vault/a")).toEqual(new Set(["Work", "Work/2026"]));
  });

  it("keeps each vault's expand state isolated by path", () => {
    saveExpanded("/vault/a", new Set(["Work"]));
    saveExpanded("/vault/b", new Set(["Cooking"]));
    expect(loadExpanded("/vault/a")).toEqual(new Set(["Work"]));
    expect(loadExpanded("/vault/b")).toEqual(new Set(["Cooking"]));
  });

  it("treats a re-saved empty set as all-collapsed", () => {
    saveExpanded("/vault/a", new Set(["Work"]));
    saveExpanded("/vault/a", new Set());
    expect(loadExpanded("/vault/a")).toEqual(new Set());
  });

  it("ignores an old collapsed-set key so the flip starts fresh (all collapsed)", () => {
    // A value left behind by the previous collapsed-set persistence must not be
    // read as an expanded set — a fresh vault opens fully collapsed.
    localStorage.setItem(
      "nn:tree-collapsed:/vault/a",
      JSON.stringify(["Work", "Notes"]),
    );
    expect(loadExpanded("/vault/a")).toEqual(new Set());
  });

  it("degrades to empty on corrupt JSON instead of throwing", () => {
    localStorage.setItem("nn:tree-expanded:/vault/a", "{not json");
    expect(loadExpanded("/vault/a")).toEqual(new Set());
  });

  it("ignores a non-array payload", () => {
    localStorage.setItem("nn:tree-expanded:/vault/a", '{"Work":true}');
    expect(loadExpanded("/vault/a")).toEqual(new Set());
  });

  it("drops non-string entries so junk can't reach the tree", () => {
    localStorage.setItem(
      "nn:tree-expanded:/vault/a",
      '["Work", 7, null, "Notes"]',
    );
    expect(loadExpanded("/vault/a")).toEqual(new Set(["Work", "Notes"]));
  });
});
