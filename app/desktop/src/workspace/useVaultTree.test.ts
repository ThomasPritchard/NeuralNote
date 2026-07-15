import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";

// Mock the Tauri boundary: the hook reads the full tree through api.ts → invoke
// and subscribes to on-disk changes through listen. Same seam the store test mocks.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TREE_CHANGED } from "../lib/bindings/events";
import { useVaultTree } from "./useVaultTree";
import type { TreeNode } from "../lib/types";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

const file = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop()!,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const treeA: TreeNode[] = [file("a.md")];
const treeB: TreeNode[] = [file("a.md"), file("b.md")];

/** The captured tree-changed handler that `api.onTreeChanged` registered. */
function treeChangedHandler(): () => void {
  const call = mockListen.mock.calls.find(([event]) => event === TREE_CHANGED);
  if (!call) throw new Error("no tree-changed subscription was registered");
  return call[1] as () => void;
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

describe("useVaultTree", () => {
  it("returns [] for an undefined vault and never reads the tree or subscribes", () => {
    const { result } = renderHook(() => useVaultTree(undefined));

    expect(result.current.tree).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("reads and returns the whole vault tree on mount", async () => {
    mockInvoke.mockResolvedValue(treeA);

    const { result } = renderHook(() => useVaultTree("/v"));

    await waitFor(() => expect(result.current.tree).toEqual(treeA));
    expect(mockInvoke).toHaveBeenCalledWith("read_tree");
  });

  it("re-reads and shows the new tree when a tree-changed event fires (debounced 300ms)", async () => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue(treeA);

    const { result } = renderHook(() => useVaultTree("/v"));
    // Flush the mount read + subscription microtasks.
    await act(async () => {});
    expect(result.current.tree).toEqual(treeA);

    const handler = treeChangedHandler();
    expect(mockListen).toHaveBeenCalledWith(TREE_CHANGED, expect.any(Function));

    // The vault changed on disk; the debounced re-read must pick up the new tree.
    mockInvoke.mockResolvedValue(treeB);
    await act(async () => {
      handler();
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.tree).toEqual(treeB);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "read_tree").length).toBe(2);
  });

  it("debounces a burst of tree-changed events into a single re-read", async () => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue(treeA);

    renderHook(() => useVaultTree("/v"));
    await act(async () => {});
    const handler = treeChangedHandler();
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(treeB);

    await act(async () => {
      handler();
      await vi.advanceTimersByTimeAsync(100);
      handler();
      await vi.advanceTimersByTimeAsync(100);
      handler();
      await vi.advanceTimersByTimeAsync(300);
    });

    // Three events inside one debounce window collapse to a single read.
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "read_tree").length).toBe(1);
  });

  it("surfaces a read failure through onError and leaves the tree empty, without throwing", async () => {
    mockInvoke.mockRejectedValue({ message: "read failed" });
    const onError = vi.fn();

    const { result } = renderHook(() => useVaultTree("/v", onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("read failed"));
    expect(result.current.tree).toEqual([]);
  });

  it("re-reads the whole tree when refresh() is called, without a tree-changed event", async () => {
    mockInvoke.mockResolvedValue(treeA);
    const { result } = renderHook(() => useVaultTree("/v"));
    await waitFor(() => expect(result.current.tree).toEqual(treeA));

    // The manual Refresh path must not depend on the disk watcher — refresh()
    // re-reads directly, so the whole-vault index/counts can't go silently stale.
    mockInvoke.mockResolvedValue(treeB);
    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.tree).toEqual(treeB));
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "read_tree").length).toBe(2);
  });

  it("tears down the tree-changed subscription on unmount", async () => {
    mockInvoke.mockResolvedValue(treeA);
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);

    const { result, unmount } = renderHook(() => useVaultTree("/v"));
    await waitFor(() => expect(result.current.tree).toEqual(treeA));

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it("unlistens immediately when torn down before the subscription resolves (no leak across reopens)", async () => {
    mockInvoke.mockResolvedValue([]);
    let resolveListen!: (fn: UnlistenFn) => void;
    const pending = new Promise<UnlistenFn>((resolve) => {
      resolveListen = resolve;
    });
    mockListen.mockReturnValue(pending);
    const unlisten = vi.fn();

    const { unmount } = renderHook(() => useVaultTree("/v"));
    // Tear down before listen() resolves.
    unmount();

    // The late-resolving subscription must be unlistened at once, not stored.
    await act(async () => {
      resolveListen(unlisten);
      await pending;
    });
    expect(unlisten).toHaveBeenCalled();
  });
});
