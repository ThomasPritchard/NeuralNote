import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Mock the Tauri boundary; the store drives all lifecycle through api.ts → invoke,
// and the live-refresh subscription through listen.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MENU_ACTION } from "./bindings/events";
import { VaultProvider, useVault } from "./store";
import { saveExpanded } from "../workspace/treeState";
import type { TreeNode } from "./types";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

const vault = { name: "V", path: "/v" };
const recents = [{ name: "V", path: "/v", lastOpened: 100 }];

const file = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

// The root listing the store fetches on open (one file, one folder).
const rootEntries: TreeNode[] = [
  file("n.md"),
  {
    kind: "folder",
    name: "Work",
    path: "/v/Work",
    relPath: "Work",
    ext: null,
    children: null,
  },
];
const rootListing = { entries: rootEntries, truncated: null };

type Listings = Record<string, { entries: TreeNode[]; truncated: number | null }>;

/** Route invoke by command name; `list_dir` is served from a per-relPath table so
 *  a test can vary what each directory returns. */
function routeInvoke(over: Record<string, unknown> = {}, listings: Listings = {}) {
  const table: Record<string, unknown> = {
    list_recent_vaults: recents,
    open_vault: vault,
    create_vault: vault,
    close_vault: undefined,
    ...over,
  };
  const dirTable: Listings = { "": rootListing, ...listings };
  mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "list_dir") {
      const path = (args as { path: string }).path;
      return Promise.resolve(dirTable[path] ?? { entries: [], truncated: null });
    }
    if (cmd in table) return Promise.resolve(table[cmd]);
    return Promise.resolve(undefined);
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <VaultProvider>{children}</VaultProvider>
);

/** Open the vault and wait until the root listing has landed. */
async function openVault(result: { current: ReturnType<typeof useVault> }) {
  await act(async () => {
    await result.current.openByPath("/v");
  });
  await waitFor(() =>
    expect(result.current.loaded.get("")?.status).toBe("loaded"),
  );
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useVault — guard", () => {
  it("throws when used outside a VaultProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useVault())).toThrow(
      "useVault must be used within a VaultProvider",
    );
    spy.mockRestore();
  });
});

describe("VaultProvider — recents", () => {
  it("loads recent vaults on mount", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.recents).toEqual(recents));
    expect(mockInvoke).toHaveBeenCalledWith("list_recent_vaults");
  });

  it("surfaces a recents load failure", async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "list_recent_vaults"
        ? Promise.reject({ message: "no recents" })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe("no recents"));
  });
});

describe("VaultProvider — openByPath (lazy root load)", () => {
  it("opens a vault and loads only its root listing", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.recents).toEqual(recents));

    await openVault(result);

    expect(mockInvoke).toHaveBeenCalledWith("open_vault", { path: "/v" });
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "" });
    expect(result.current.status).toBe("open");
    expect(result.current.vault).toEqual(vault);
    expect(result.current.loaded.get("")).toEqual({
      status: "loaded",
      children: rootEntries,
      truncated: null,
    });
    // No child directory is fetched up front — the moat's eager walk is gone.
    expect(mockInvoke).not.toHaveBeenCalledWith("list_dir", { path: "Work" });
    expect(mockInvoke).not.toHaveBeenCalledWith("read_tree");
  });

  it("returns to welcome and refreshes recents when opening fails", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "open_vault") return Promise.reject({ message: "not a vault" });
      if (cmd === "list_recent_vaults") return Promise.resolve(recents);
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.openByPath("/bad");
    });

    expect(result.current.status).toBe("welcome");
    expect(result.current.error).toBe("not a vault");
    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "list_recent_vaults").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("re-expands and loads persisted-expanded folders on open", async () => {
    saveExpanded("/v", new Set(["Work"]));
    routeInvoke({}, { Work: { entries: [file("Work/plan.md")], truncated: null } });
    const { result } = renderHook(() => useVault(), { wrapper });

    await openVault(result);

    expect(result.current.expanded).toEqual(new Set(["Work"]));
    await waitFor(() =>
      expect(result.current.loaded.get("Work")?.status).toBe("loaded"),
    );
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "" });
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "Work" });
  });
});

describe("VaultProvider — listDir", () => {
  it("transitions a directory loading → loaded", async () => {
    let resolveList!: (value: { entries: TreeNode[]; truncated: number | null }) => void;
    const pending = new Promise<{ entries: TreeNode[]; truncated: number | null }>(
      (resolve) => {
        resolveList = resolve;
      },
    );
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "list_dir") {
        const path = (args as { path: string }).path;
        return path === "Work" ? pending : Promise.resolve(rootListing);
      }
      if (cmd === "open_vault") return Promise.resolve(vault);
      if (cmd === "list_recent_vaults") return Promise.resolve(recents);
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    act(() => {
      void result.current.listDir("Work");
    });
    await waitFor(() =>
      expect(result.current.loaded.get("Work")?.status).toBe("loading"),
    );

    const workListing = { entries: [file("Work/plan.md")], truncated: 4 };
    await act(async () => {
      resolveList(workListing);
      await pending;
    });

    await waitFor(() =>
      expect(result.current.loaded.get("Work")?.status).toBe("loaded"),
    );
    expect(result.current.loaded.get("Work")).toEqual({
      status: "loaded",
      children: workListing.entries,
      truncated: 4,
    });
  });

  it("records a listDir failure as a per-folder error row, not the global error", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "list_dir") {
        const path = (args as { path: string }).path;
        if (path === "Work") return Promise.reject({ message: "permission denied" });
        return Promise.resolve(rootListing);
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      await result.current.listDir("Work");
    });

    expect(result.current.loaded.get("Work")).toMatchObject({
      status: "error",
      error: "permission denied",
    });
    // A failed folder listing is a per-folder row, never a whole-tree failure.
    expect(result.current.error).toBeNull();
  });
});

describe("VaultProvider — toggle", () => {
  it("expands an unloaded folder (fetching it), then re-reveals it from cache", async () => {
    routeInvoke({}, { Work: { entries: [file("Work/plan.md")], truncated: null } });
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);
    mockInvoke.mockClear();

    act(() => result.current.toggle("Work"));
    expect(result.current.expanded.has("Work")).toBe(true);
    await waitFor(() =>
      expect(result.current.loaded.get("Work")?.status).toBe("loaded"),
    );
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "Work" });

    // Collapse keeps the cached listing and fetches nothing.
    mockInvoke.mockClear();
    act(() => result.current.toggle("Work"));
    expect(result.current.expanded.has("Work")).toBe(false);
    expect(result.current.loaded.get("Work")?.status).toBe("loaded");
    expect(mockInvoke).not.toHaveBeenCalledWith("list_dir", { path: "Work" });

    // Re-expand also fetches nothing — the cache survives collapse → re-expand.
    act(() => result.current.toggle("Work"));
    expect(result.current.expanded.has("Work")).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalledWith("list_dir", { path: "Work" });
  });

  it("persists the expanded set so it survives a reopen", async () => {
    routeInvoke({}, { Work: { entries: [file("Work/plan.md")], truncated: null } });
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    act(() => result.current.toggle("Work"));
    await waitFor(() =>
      expect(result.current.loaded.get("Work")?.status).toBe("loaded"),
    );

    await act(async () => {
      await result.current.close();
    });
    await openVault(result);

    expect(result.current.expanded).toEqual(new Set(["Work"]));
  });
});

describe("VaultProvider — refreshDir", () => {
  it("re-lists one directory in place without touching siblings", async () => {
    routeInvoke(
      {},
      {
        A: { entries: [file("A/old.md")], truncated: null },
        B: { entries: [file("B/keep.md")], truncated: null },
      },
    );
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    await act(async () => {
      await result.current.listDir("A");
      await result.current.listDir("B");
    });
    const bBefore = result.current.loaded.get("B");
    mockInvoke.mockClear();

    // A's listing changed on disk; refreshDir must pick it up.
    routeInvoke(
      {},
      {
        A: { entries: [file("A/new.md")], truncated: null },
        B: { entries: [file("B/keep.md")], truncated: null },
      },
    );
    await act(async () => {
      await result.current.refreshDir("A");
    });

    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "A" });
    expect(mockInvoke).not.toHaveBeenCalledWith("list_dir", { path: "B" });
    const a = result.current.loaded.get("A");
    if (a?.status !== "loaded") throw new Error("expected A to be loaded");
    expect(a.children).toEqual([file("A/new.md")]);
    // Sibling B's cached listing is the same reference — untouched.
    expect(result.current.loaded.get("B")).toBe(bBefore);
  });
});

describe("VaultProvider — openExisting", () => {
  it("opens the picked folder", async () => {
    routeInvoke({ pick_vault_folder: "/v" });
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.openExisting();
    });

    expect(mockInvoke).toHaveBeenCalledWith("pick_vault_folder");
    expect(mockInvoke).toHaveBeenCalledWith("open_vault", { path: "/v" });
    expect(result.current.status).toBe("open");
  });

  it("does nothing when the picker is cancelled", async () => {
    routeInvoke({ pick_vault_folder: null });
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.recents).toEqual(recents));

    await act(async () => {
      await result.current.openExisting();
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("open_vault", expect.anything());
    expect(result.current.status).toBe("welcome");
  });

  it("surfaces a picker error", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pick_vault_folder")
        return Promise.reject({ message: "picker broke" });
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.openExisting();
    });

    expect(result.current.error).toBe("picker broke");
  });
});

describe("VaultProvider — native vault menu ownership", () => {
  it("confirms native Quit directly while no workspace is mounted", async () => {
    routeInvoke();
    renderHook(() => useVault(), { wrapper });

    await waitFor(() =>
      expect(mockListen.mock.calls.some(([event]) => event === MENU_ACTION)).toBe(true),
    );
    const handler = mockListen.mock.calls.find(([event]) => event === MENU_ACTION)![1] as (
      event: { payload: { action: string } },
    ) => void;
    act(() => handler({ payload: { action: "quit-app" } }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("quit_app"));
  });

  it("confirms native Quit while a vault is still loading", async () => {
    let resolveOpen!: (value: typeof vault) => void;
    const opening = new Promise<typeof vault>((resolve) => {
      resolveOpen = resolve;
    });
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "open_vault") return opening;
      if (cmd === "list_recent_vaults") return Promise.resolve(recents);
      if (cmd === "list_dir") {
        const path = (args as { path: string }).path;
        return Promise.resolve(path === "" ? rootListing : { entries: [], truncated: null });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });

    act(() => {
      void result.current.openByPath("/v");
    });
    await waitFor(() => expect(result.current.status).toBe("loading"));
    await waitFor(() =>
      expect(mockListen.mock.calls.filter(([event]) => event === MENU_ACTION).length).toBeGreaterThan(1),
    );
    const handler = mockListen.mock.calls.filter(([event]) => event === MENU_ACTION).at(-1)![1] as (
      event: { payload: { action: string } },
    ) => void;
    act(() => handler({ payload: { action: "quit-app" } }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("quit_app"));
    resolveOpen(vault);
  });

  it("leaves native Quit to Workspace while a vault is open", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);
    mockInvoke.mockClear();

    const handler = mockListen.mock.calls.filter(([event]) => event === MENU_ACTION).at(-1)![1] as (
      event: { payload: { action: string } },
    ) => void;
    act(() => handler({ payload: { action: "quit-app" } }));

    expect(mockInvoke).not.toHaveBeenCalledWith("quit_app");
  });

  it("handles Open Vault on the welcome screen", async () => {
    routeInvoke({ pick_vault_folder: "/v" });
    renderHook(() => useVault(), { wrapper });

    await waitFor(() =>
      expect(mockListen.mock.calls.some(([event]) => event === MENU_ACTION)).toBe(true),
    );
    const handler = mockListen.mock.calls.find(([event]) => event === MENU_ACTION)![1] as (
      event: { payload: { action: string } },
    ) => void;
    act(() => handler({ payload: { action: "open-vault" } }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("pick_vault_folder"));
  });

  it("leaves Open Vault to Workspace while a vault is open so dirty tabs can guard it", async () => {
    routeInvoke({ pick_vault_folder: "/other" });
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);
    mockInvoke.mockClear();

    const handlers = mockListen.mock.calls.filter(([event]) => event === MENU_ACTION);
    const handler = handlers.at(-1)![1] as (
      event: { payload: { action: string } },
    ) => void;
    act(() => handler({ payload: { action: "open-vault" } }));

    expect(mockInvoke).not.toHaveBeenCalledWith("pick_vault_folder");
    expect(mockInvoke).not.toHaveBeenCalledWith("open_vault", expect.anything());
  });
});

describe("VaultProvider — pickNewLocation", () => {
  it("returns the chosen directory", async () => {
    routeInvoke({ pick_new_vault_location: "/parent" });
    const { result } = renderHook(() => useVault(), { wrapper });

    let dir: string | null = null;
    await act(async () => {
      dir = await result.current.pickNewLocation();
    });
    expect(dir).toBe("/parent");
  });

  it("returns null and surfaces an error on failure", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pick_new_vault_location")
        return Promise.reject({ message: "denied" });
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });

    let dir: string | null = "x";
    await act(async () => {
      dir = await result.current.pickNewLocation();
    });
    expect(dir).toBeNull();
    expect(result.current.error).toBe("denied");
  });
});

describe("VaultProvider — createVault", () => {
  it("creates and opens the new vault, loading its root", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.createVault("/parent", "New");
    });
    await waitFor(() => expect(result.current.loaded.get("")?.status).toBe("loaded"));

    expect(mockInvoke).toHaveBeenCalledWith("create_vault", {
      parentDir: "/parent",
      name: "New",
    });
    expect(result.current.status).toBe("open");
    expect(result.current.vault).toEqual(vault);
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "" });
  });

  it("returns to welcome with an error on failure", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "create_vault")
        return Promise.reject({ message: "name taken" });
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.createVault("/parent", "Dup");
    });

    expect(result.current.status).toBe("welcome");
    expect(result.current.error).toBe("name taken");
  });
});

describe("VaultProvider — close", () => {
  it("closes the vault, clears the loaded tree, and returns to welcome", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);
    expect(result.current.status).toBe("open");

    await act(async () => {
      await result.current.close();
    });

    expect(mockInvoke).toHaveBeenCalledWith("close_vault");
    expect(result.current.status).toBe("welcome");
    expect(result.current.vault).toBeNull();
    expect(result.current.loaded.size).toBe(0);
    expect(result.current.expanded.size).toBe(0);
  });

  it("still resets the UI when close_vault rejects, surfacing the error", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "close_vault")
        return Promise.reject({ message: "close failed" });
      if (cmd === "list_recent_vaults") return Promise.resolve(recents);
      return Promise.resolve(undefined);
    });
    await act(async () => {
      await result.current.close();
    });

    expect(result.current.error).toBe("close failed");
    expect(result.current.status).toBe("welcome");
    expect(result.current.vault).toBeNull();
  });
});

describe("VaultProvider — stale-response guard", () => {
  it("drops a slow list_dir from a closed vault so it cannot poison the reopened tree", async () => {
    // "Work" hangs until we release it — long enough to close and reopen first.
    let releaseWork!: (v: { entries: TreeNode[]; truncated: number | null }) => void;
    const workPending = new Promise<{ entries: TreeNode[]; truncated: number | null }>(
      (resolve) => {
        releaseWork = resolve;
      },
    );
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "list_dir") {
        const path = (args as { path: string }).path;
        if (path === "Work") return workPending; // vault A's slow fetch
        return Promise.resolve(rootListing);
      }
      const table: Record<string, unknown> = {
        list_recent_vaults: recents,
        open_vault: vault,
        close_vault: undefined,
      };
      return Promise.resolve(cmd in table ? table[cmd] : undefined);
    });

    const { result } = renderHook(() => useVault(), { wrapper });
    await openVault(result);

    // Kick off the slow "Work" fetch, then close and reopen before it lands.
    act(() => {
      void result.current.listDir("Work");
    });
    await act(async () => {
      await result.current.close();
    });
    await act(async () => {
      await result.current.openByPath("/v");
    });
    await waitFor(() =>
      expect(result.current.loaded.get("")?.status).toBe("loaded"),
    );

    // The closed vault's "Work" listing finally resolves. Without the generation
    // guard this write lands in the reopened vault's map; the guard drops it.
    await act(async () => {
      releaseWork({ entries: [file("Work/STALE.md")], truncated: null });
      await workPending;
    });

    expect(result.current.loaded.has("Work")).toBe(false);
  });
});

describe("VaultProvider — error channel", () => {
  it("clears a reported error", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });

    act(() => result.current.reportError("something failed"));
    expect(result.current.error).toBe("something failed");

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe("VaultProvider — live tree-changed subscription", () => {
  it("subscribes when open and refreshes every loaded dir (debounced) on a change", async () => {
    vi.useFakeTimers();
    routeInvoke({}, { Work: { entries: [file("Work/plan.md")], truncated: null } });
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
      await vi.runOnlyPendingTimersAsync();
    });
    await vi.waitFor(() => expect(result.current.loaded.get("")?.status).toBe("loaded"));

    // Load a second directory so the watcher has two to refresh.
    await act(async () => {
      await result.current.listDir("Work");
    });

    expect(mockListen).toHaveBeenCalledWith(
      "vault://tree-changed",
      expect.any(Function),
    );
    const handler = mockListen.mock.calls.find(
      ([event]) => event === "vault://tree-changed",
    )![1] as () => void;

    mockInvoke.mockClear();
    await act(async () => {
      handler();
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "" });
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "Work" });
  });

  it("tears down the subscription on unmount", async () => {
    routeInvoke();
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);

    const { result, unmount } = renderHook(() => useVault(), { wrapper });
    await openVault(result);
    await waitFor(() => expect(mockListen).toHaveBeenCalled());

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it("surfaces a failed subscription instead of dropping it silently", async () => {
    routeInvoke();
    mockListen.mockRejectedValueOnce({ message: "watcher dead" });

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
    });

    await waitFor(() => expect(result.current.error).toBe("watcher dead"));
  });
});
