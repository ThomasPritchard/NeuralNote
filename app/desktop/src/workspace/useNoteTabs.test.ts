import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { NoteDoc } from "../lib/types";
import { useNoteTabs } from "./useNoteTabs";

const mockInvoke = vi.mocked(invoke);

function doc(path: string, raw = `# ${path}`): NoteDoc {
  return {
    path,
    relPath: path.replace(/^\/v\//, ""),
    title: path.split("/").at(-1)?.replace(/\.md$/, "") ?? "Note",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: raw,
    raw,
    contentHash: `hash:${raw}`,
    binary: false,
    lossyText: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => mockInvoke.mockReset());

describe("useNoteTabs - collection behavior", () => {
  it("keeps two notes loaded and preserves each tab's draft and mode", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/b.md", "B"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => {
      result.current.active.setMode("edit");
      result.current.active.setDraft("A draft");
    });
    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));

    expect(result.current.tabs).toHaveLength(2);
    const first = result.current.tabs[0];
    expect(first.mode).toBe("edit");
    expect(first.draft).toBe("A draft");
    expect(first.dirty).toBe(true);

    act(() => result.current.activate(first.id));
    expect(result.current.active.path).toBe("/v/a.md");
    expect(result.current.active.draft).toBe("A draft");
  });

  it("reuses a clean active tab for ordinary navigation", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md"))
      .mockResolvedValueOnce(doc("/v/b.md"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    const stableId = result.current.activeTabId;
    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.path).toBe("/v/b.md"));

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(stableId);
  });

  it("opens a separate tab when forceNew is requested", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md"))
      .mockResolvedValueOnce(doc("/v/b.md"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toBe("/v/b.md"));

    expect(result.current.tabs).toHaveLength(2);
  });

  it("activates an already-open path without rereading or duplicating it", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md"))
      .mockResolvedValueOnce(doc("/v/b.md"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    const aId = result.current.activeTabId;
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toBe("/v/b.md"));
    act(() => result.current.open("/v/a.md"));

    expect(result.current.activeTabId).toBe(aId);
    expect(result.current.tabs).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it("deduplicates equivalent provisional path spellings before Rust resolves", async () => {
    const read = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(read.promise as Promise<unknown>);
    const { result } = renderHook(() => useNoteTabs());

    let firstId = "";
    let secondId = "";
    act(() => { firstId = result.current.open("/v/Folder/../a.md"); });
    act(() => { secondId = result.current.open("/v/a.md", { forceNew: true }); });

    expect(secondId).toBe(firstId);
    expect(result.current.tabs).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      read.resolve(doc("/v/a.md"));
      await read.promise;
    });
  });

  it("closes the active tab to its right, then falls back to its left", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md"))
      .mockResolvedValueOnce(doc("/v/b.md"))
      .mockResolvedValueOnce(doc("/v/c.md"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toBe("/v/b.md"));
    act(() => result.current.open("/v/c.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toBe("/v/c.md"));
    const [, b] = result.current.tabs;
    act(() => result.current.activate(b.id));
    act(() => result.current.close(b.id));
    expect(result.current.active.path).toBe("/v/c.md");

    act(() => result.current.close(result.current.activeTabId!));
    expect(result.current.active.path).toBe("/v/a.md");
  });
});

describe("useNoteTabs - async ownership", () => {
  it("keeps the renamed relative path when a read resolves after the rename", async () => {
    const read = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(read.promise as Promise<unknown>);
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    act(() => result.current.remap("/v/a.md", "/v/Folder/b.md", "Folder/b.md"));
    await act(async () => {
      read.resolve(doc("/v/a.md", "A"));
      await read.promise;
    });

    expect(result.current.active.path).toBe("/v/Folder/b.md");
    expect(result.current.active.note?.relPath).toBe("Folder/b.md");
  });

  it("lands out-of-order loads in the tab that started each read", async () => {
    const a = deferred<NoteDoc>();
    const b = deferred<NoteDoc>();
    mockInvoke
      .mockReturnValueOnce(a.promise as Promise<unknown>)
      .mockReturnValueOnce(b.promise as Promise<unknown>);
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await act(async () => {
      b.resolve(doc("/v/b.md", "B"));
      await b.promise;
    });
    await act(async () => {
      a.resolve(doc("/v/a.md", "A"));
      await a.promise;
    });

    expect(result.current.tabs.map((tab) => [tab.path, tab.note?.raw])).toEqual([
      ["/v/a.md", "A"],
      ["/v/b.md", "B"],
    ]);
    expect(result.current.active.path).toBe("/v/b.md");
  });

  it("lands a background save in its owning tab after activation changes", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setDraft("A saved"));

    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    mockInvoke.mockResolvedValueOnce(doc("/v/b.md", "B"));
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "A saved"));
      await save;
    });

    expect(result.current.active.path).toBe("/v/b.md");
    expect(result.current.tabs[0].note?.raw).toBe("A saved");
    expect(result.current.tabs[0].saving).toBe(false);
    expect(result.current.tabs[0].dirty).toBe(false);
  });

  it("keeps typing performed while a save is in flight dirty", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.active.setDraft("first edit"));
    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    act(() => result.current.active.setDraft("first edit plus more"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "first edit"));
      await save;
    });

    expect(result.current.active.draft).toBe("first edit plus more");
    expect(result.current.active.dirty).toBe(true);
  });

  it("keeps a background conflict attached to the tab that attempted the save", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.active.setDraft("dirty A"));
    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    mockInvoke.mockResolvedValueOnce(doc("/v/b.md", "B"));
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toBe("/v/b.md"));
    await act(async () => {
      write.reject({ kind: "conflict", message: "changed on disk" });
      await save;
    });

    expect(result.current.active.conflict).toBe(false);
    expect(result.current.tabs[0].conflict).toBe(true);
    expect(result.current.tabs[0].saveError).toBeNull();
  });

  it("does not let a save response restore a path renamed in flight", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.active.setDraft("saved"));
    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    act(() => result.current.remap("/v/a.md", "/v/renamed.md", "renamed.md"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "saved"));
      await save;
    });

    expect(result.current.active.path).toBe("/v/renamed.md");
    expect(result.current.active.note?.path).toBe("/v/renamed.md");
    expect(result.current.active.note?.relPath).toBe("renamed.md");
  });

  it("ignores an old save after its clean tab is reused for another note", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));

    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    mockInvoke.mockResolvedValueOnce(doc("/v/b.md", "B"));
    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "A"));
      await save;
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.active.path).toBe("/v/b.md");
    expect(result.current.active.note?.raw).toBe("B");
  });

  it("merges canonical aliases and preserves an existing dirty draft", async () => {
    const alias = deferred<NoteDoc>();
    const canonical = deferred<NoteDoc>();
    mockInvoke
      .mockReturnValueOnce(alias.promise as Promise<unknown>)
      .mockReturnValueOnce(canonical.promise as Promise<unknown>);
    const { result } = renderHook(() => useNoteTabs());
    let firstId = "";
    act(() => { firstId = result.current.open("/v/alias.md"); });
    act(() => result.current.open("/v/a.md", { forceNew: true }));

    await act(async () => {
      alias.resolve(doc("/v/a.md", "canonical"));
      await alias.promise;
    });
    act(() => result.current.activate(firstId));
    act(() => result.current.active.setDraft("important local draft"));
    await act(async () => {
      canonical.resolve(doc("/v/a.md", "canonical"));
      await canonical.promise;
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe(firstId);
    expect(result.current.active.draft).toBe("important local draft");
    expect(result.current.active.dirty).toBe(true);
  });
});

describe("useNoteTabs - path collection operations", () => {
  it("remaps every descendant while retaining IDs, drafts, and modes", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/Old/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/Old/deep/b.md", "B"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/Old/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => {
      result.current.active.setMode("edit");
      result.current.active.setDraft("draft A");
    });
    act(() => result.current.open("/v/Old/deep/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toContain("b.md"));
    const ids = result.current.tabs.map((tab) => tab.id);

    act(() => result.current.remap("/v/Old", "/v/New", "New"));

    expect(result.current.tabs.map((tab) => tab.path)).toEqual([
      "/v/New/a.md",
      "/v/New/deep/b.md",
    ]);
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(ids);
    expect(result.current.tabs[0]).toMatchObject({
      mode: "edit",
      draft: "draft A",
      dirty: true,
    });
    expect(result.current.tabs.map((tab) => tab.note?.relPath)).toEqual([
      "New/a.md",
      "New/deep/b.md",
    ]);
  });

  it("reports and removes all descendants, including dirty background tabs", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/Folder/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/Folder/b.md", "B"))
      .mockResolvedValueOnce(doc("/v/outside.md", "O"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/Folder/a.md"));
    await waitFor(() => expect(result.current.active.note).not.toBeNull());
    act(() => result.current.active.setDraft("dirty A"));
    act(() => result.current.open("/v/Folder/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toContain("b.md"));
    act(() => result.current.open("/v/outside.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.path).toContain("outside"));

    expect(result.current.tabsInside("/v/Folder")).toHaveLength(2);
    expect(result.current.tabsInside("/v/Folder").filter((tab) => tab.dirty)).toHaveLength(1);
    act(() => result.current.removeDescendants("/v/Folder"));

    expect(result.current.tabs.map((tab) => tab.path)).toEqual(["/v/outside.md"]);
    expect(result.current.active.path).toBe("/v/outside.md");
  });
});
