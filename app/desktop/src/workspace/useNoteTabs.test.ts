// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { NoteDoc } from "../lib/types";
import { normalizeRequestedPath, useNoteTabs } from "./useNoteTabs";

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

describe("normalizeRequestedPath", () => {
  it("normalizes separators and dot segments without escaping relative parents", () => {
    expect(normalizeRequestedPath("/v/a/../b.md")).toBe("/v/b.md");
    expect(normalizeRequestedPath("C:\\v\\.\\b.md")).toBe("C:/v/b.md");
    expect(normalizeRequestedPath("../b.md")).toBe("../b.md");
  });
});

describe("useNoteTabs single-source state", () => {
  it("loads one complete source draft and exposes no retired mode or rich state", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A\r\n"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A\r\n"));

    expect(result.current.active.sessionKey).toBe("note-tab-1");
    expect(result.current.active.sessionHash).toBe("hash:A\r\n");
    expect(result.current.active).not.toHaveProperty("mode");
    expect(result.current.active).not.toHaveProperty("richDocument");
  });

  it("reuses an existing tab for equivalent paths", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/folder/../a.md"));
    await waitFor(() => expect(result.current.tabs).toHaveLength(1));
    act(() => result.current.open("/v/a.md", { forceNew: true }));
    expect(result.current.tabs).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("reuses a clean active tab but preserves a dirty tab by opening a new one", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/b.md", "B"))
      .mockResolvedValueOnce(doc("/v/c.md", "C"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    const firstId = result.current.activeTabId;

    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("B"));
    expect(result.current.activeTabId).toBe(firstId);
    act(() => result.current.active.setDraft("B changed"));
    act(() => result.current.open("/v/c.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("C"));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].draft).toBe("B changed");
  });

  it("persists only through write_note with the loaded expected hash", async () => {
    mockInvoke.mockImplementation((command, args) => {
      if (command === "read_note") return Promise.resolve(doc("/v/a.md", "A")) as never;
      if (command === "write_note") {
        const content = (args as { content: string }).content;
        return Promise.resolve(doc("/v/a.md", content)) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("A changed\r\n"));
    await act(() => result.current.active.save());

    expect(mockInvoke).toHaveBeenCalledWith("write_note", {
      path: "/v/a.md",
      content: "A changed\r\n",
      expectedHash: "hash:A",
    });
    expect(result.current.active.dirty).toBe(false);
  });

  it("keeps later typing dirty when an earlier save resolves", async () => {
    const write = deferred<NoteDoc>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockReturnValueOnce(write.promise as never);
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("first"));
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    act(() => result.current.active.setDraft("second"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "first"));
      await save;
    });
    expect(result.current.active.draft).toBe("second");
    expect(result.current.active.dirty).toBe(true);
  });

  it("binds late editor mutations to the tab that owns the editor session", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/b.md", "B"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    const lateSetDraft = result.current.active.setDraft;
    const lateSetPreservationError = result.current.active.setPreservationError;

    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.draft).toBe("B"));
    act(() => {
      lateSetDraft("A composed");
      lateSetPreservationError("A preservation error");
    });

    expect(result.current.tabs[0]).toMatchObject({
      draft: "A composed",
      dirty: true,
      preservationError: "A preservation error",
    });
    expect(result.current.tabs[1]).toMatchObject({ draft: "B", dirty: false, preservationError: null });
  });

  it("serializes duplicate saves per tab", async () => {
    const write = deferred<NoteDoc>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockReturnValueOnce(write.promise as never);
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("changed"));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.active.save();
      second = result.current.active.save();
    });
    expect(mockInvoke.mock.calls.filter(([command]) => command === "write_note")).toHaveLength(1);
    await act(async () => {
      write.resolve(doc("/v/a.md", "changed"));
      await Promise.all([first, second]);
    });
  });

  it("keeps conflicts explicit and overwrites only with a null hash", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockRejectedValueOnce({ kind: "conflict", message: "changed on disk" })
      .mockResolvedValueOnce(doc("/v/a.md", "changed"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("changed"));
    await act(() => result.current.active.save());
    expect(result.current.active.conflict).toBe(true);
    expect(result.current.active.saveError).toBeNull();
    await act(() => result.current.active.overwrite());
    expect(mockInvoke).toHaveBeenLastCalledWith("write_note", {
      path: "/v/a.md",
      content: "changed",
      expectedHash: null,
    });
    expect(result.current.active.conflict).toBe(false);
  });

  it("blocks persistence while exact-source preservation is ambiguous", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("changed"));
    act(() => result.current.active.setPreservationError("ambiguous line endings"));
    await act(() => result.current.active.save());
    expect(mockInvoke.mock.calls.map(([command]) => command)).not.toContain("write_note");
    expect(result.current.active.saveError).toBe("ambiguous line endings");
    expect(result.current.active.dirty).toBe(true);
  });

  it("reloads the current path and discards its draft", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/a.md", "disk"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("local"));
    act(() => result.current.active.reload());
    await waitFor(() => expect(result.current.active.draft).toBe("disk"));
    expect(result.current.active.dirty).toBe(false);
  });

  it("remaps descendants without losing drafts and closes removed descendants", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/f/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/other.md", "O"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/f/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("local"));
    act(() => result.current.open("/v/other.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.draft).toBe("O"));

    act(() => result.current.remap("/v/f", "/v/g", "g"));
    expect(result.current.tabs[0].path).toBe("/v/g/a.md");
    expect(result.current.tabs[0].draft).toBe("local");
    act(() => result.current.removeDescendants("/v/g"));
    expect(result.current.tabs.map((tab) => tab.path)).toEqual(["/v/other.md"]);
  });

  it("keeps a save owned by its tab when another tab becomes active", async () => {
    const write = deferred<NoteDoc>();
    mockInvoke.mockImplementation((command, args) => {
      if (command === "read_note") {
        const path = (args as { path: string }).path;
        return Promise.resolve(doc(path, path.endsWith("a.md") ? "A" : "B")) as never;
      }
      if (command === "write_note") return write.promise as never;
      return Promise.resolve(undefined) as never;
    });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("A saved"));
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.draft).toBe("B"));
    await act(async () => {
      write.resolve(doc("/v/a.md", "A saved"));
      await save;
    });
    expect(result.current.active.path).toBe("/v/b.md");
    expect(result.current.tabs.find((tab) => tab.path === "/v/a.md")?.dirty).toBe(false);
  });
});
