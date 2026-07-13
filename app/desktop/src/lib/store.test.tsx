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

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

const vault = { name: "V", path: "/v" };
const tree = [
  {
    kind: "file" as const,
    name: "n.md",
    path: "/v/n.md",
    relPath: "n.md",
    ext: "md",
    children: null,
  },
];
const recents = [{ name: "V", path: "/v", lastOpened: 100 }];

/** Route invoke by command name; tests override individual commands as needed. */
function routeInvoke(over: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    list_recent_vaults: recents,
    open_vault: vault,
    create_vault: vault,
    read_tree: tree,
    close_vault: undefined,
    ...over,
  };
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd in table) return Promise.resolve(table[cmd]);
    return Promise.resolve(undefined);
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <VaultProvider>{children}</VaultProvider>
);

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
    routeInvoke({});
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "list_recent_vaults"
        ? Promise.reject({ message: "no recents" })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe("no recents"));
  });
});

describe("VaultProvider — openByPath", () => {
  it("opens a vault and loads its tree", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await waitFor(() => expect(result.current.recents).toEqual(recents));

    await act(async () => {
      await result.current.openByPath("/v");
    });

    expect(mockInvoke).toHaveBeenCalledWith("open_vault", { path: "/v" });
    expect(result.current.status).toBe("open");
    expect(result.current.vault).toEqual(vault);
    expect(result.current.tree).toEqual(tree);
  });

  it("returns to welcome and refreshes recents when opening fails", async () => {
    routeInvoke({});
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
    routeInvoke();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "open_vault") return opening;
      if (cmd === "list_recent_vaults") return Promise.resolve(recents);
      if (cmd === "read_tree") return Promise.resolve(tree);
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
    await act(async () => result.current.openByPath("/v"));
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
    await act(async () => result.current.openByPath("/v"));
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
  it("creates and opens the new vault", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });

    await act(async () => {
      await result.current.createVault("/parent", "New");
    });

    expect(mockInvoke).toHaveBeenCalledWith("create_vault", {
      parentDir: "/parent",
      name: "New",
    });
    expect(result.current.status).toBe("open");
    expect(result.current.vault).toEqual(vault);
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
  it("closes the vault and returns to welcome", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
    });
    expect(result.current.status).toBe("open");

    await act(async () => {
      await result.current.close();
    });

    expect(mockInvoke).toHaveBeenCalledWith("close_vault");
    expect(result.current.status).toBe("welcome");
    expect(result.current.vault).toBeNull();
    expect(result.current.tree).toEqual([]);
  });

  it("still resets the UI when close_vault rejects, surfacing the error", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
    });

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

describe("VaultProvider — refreshTree + clearError", () => {
  it("surfaces a tree refresh failure", async () => {
    routeInvoke();
    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
    });

    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_tree"
        ? Promise.reject({ message: "tree gone" })
        : Promise.resolve(undefined),
    );
    await act(async () => {
      await result.current.refreshTree();
    });
    expect(result.current.error).toBe("tree gone");

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe("VaultProvider — live tree-changed subscription", () => {
  it("subscribes when open and refreshes the tree (debounced) on a change", async () => {
    vi.useFakeTimers();
    routeInvoke();
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);

    const { result } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
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

    expect(mockInvoke).toHaveBeenCalledWith("read_tree");
  });

  it("tears down the subscription on unmount", async () => {
    routeInvoke();
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);

    const { result, unmount } = renderHook(() => useVault(), { wrapper });
    await act(async () => {
      await result.current.openByPath("/v");
    });
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
