// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NoteDoc } from "../lib/types";
import { normalizeRequestedPath } from "./noteTabsReducer";
import { useNoteTabs } from "./useNoteTabs";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

/** The raw handler `useNoteTabs` registered with the on-disk change event, used
 *  by the external-reload tests to fire the watcher directly. */
function treeChangedHandler(): () => void {
  const call = mockListen.mock.calls.find(
    ([event]) => event === "vault://tree-changed",
  );
  if (!call) throw new Error("useNoteTabs did not subscribe to tree-changed");
  return call[1] as () => void;
}

/** Flush the microtasks behind a mocked `read_note` / `write_note` so the tab
 *  state settles, without depending on real timers. */
async function drainMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  // Default: a resolvable subscription so mounting the hook's external-reload
  // watcher never throws. Individual tests grab the handler or an unlisten spy.
  mockListen.mockResolvedValue(vi.fn());
});

afterEach(() => vi.useRealTimers());

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

  it("lands an in-flight save on the renamed path without restoring the old one", async () => {
    const write = deferred<NoteDoc>();
    mockInvoke.mockImplementation((command) => {
      if (command === "read_note") return Promise.resolve(doc("/v/a.md", "A")) as never;
      if (command === "write_note") return write.promise as never;
      return Promise.resolve(undefined) as never;
    });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("edited"));

    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    // Rename the note while its save is still in flight.
    act(() => result.current.active.repath("/v/renamed.md", "renamed.md"));

    await act(async () => {
      // The backend echoes the path it actually wrote — the old one, still on
      // disk when the save began — which must NOT overwrite the renamed path.
      write.resolve(doc("/v/a.md", "edited"));
      await save;
    });

    expect(result.current.active.path).toBe("/v/renamed.md");
    expect(result.current.active.note?.path).toBe("/v/renamed.md");
    expect(result.current.active.note?.relPath).toBe("renamed.md");
    expect(result.current.active.note?.raw).toBe("edited"); // landed content preserved
    expect(result.current.active.note?.contentHash).toBe("hash:edited");
    expect(result.current.active.dirty).toBe(false);
    expect(result.current.active.saving).toBe(false);
  });

  it("routes a post-move save to the new location with the saved hash", async () => {
    const firstWrite = deferred<NoteDoc>();
    const writeCalls: Array<{ path: string; expectedHash: string | null }> = [];
    mockInvoke.mockImplementation((command, args) => {
      if (command === "read_note") return Promise.resolve(doc("/v/a.md", "A")) as never;
      if (command === "write_note") {
        const call = args as { path: string; content: string; expectedHash: string | null };
        writeCalls.push({ path: call.path, expectedHash: call.expectedHash });
        if (writeCalls.length === 1) return firstWrite.promise as never;
        return Promise.resolve(doc("/v/sub/a.md", call.content)) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.draft).toBe("A"));
    act(() => result.current.active.setDraft("moved edit"));

    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    // Move the note into a subfolder while its save is still in flight.
    act(() => result.current.active.repath("/v/sub/a.md", "sub/a.md"));
    await act(async () => {
      firstWrite.resolve(doc("/v/a.md", "moved edit"));
      await save;
    });

    expect(result.current.active.path).toBe("/v/sub/a.md");
    expect(result.current.active.note?.relPath).toBe("sub/a.md");
    expect(result.current.active.note?.raw).toBe("moved edit"); // landed content preserved
    // The in-flight write targeted the path/hash the note carried when it began.
    expect(writeCalls[0]).toEqual({ path: "/v/a.md", expectedHash: "hash:A" });

    // A follow-up save must target the NEW path with the hash the last save
    // landed — optimistic concurrency continues from the moved location.
    act(() => result.current.active.setDraft("moved edit again"));
    await act(() => result.current.active.save());
    expect(writeCalls[1]).toEqual({ path: "/v/sub/a.md", expectedHash: "hash:moved edit" });
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

describe("useNoteTabs external-change reload", () => {
  /** A fake vault keyed by path; `read_note` returns the current bytes, a missing
   *  path rejects as not-found, and `write_note` mutates the store — so an in-app
   *  save and a later external read agree, exactly like the real backend. */
  function mockDisk(initial: Record<string, string>) {
    const files: Record<string, string> = { ...initial };
    mockInvoke.mockImplementation((command, args) => {
      if (command === "read_note") {
        const path = (args as { path: string }).path;
        if (!(path in files)) {
          return Promise.reject({ kind: "notFound", message: "gone" }) as never;
        }
        return Promise.resolve(doc(path, files[path])) as never;
      }
      if (command === "write_note") {
        const call = args as { path: string; content: string };
        files[call.path] = call.content;
        return Promise.resolve(doc(call.path, call.content)) as never;
      }
      return Promise.resolve(undefined) as never;
    });
    return files;
  }

  async function fireWatcher(): Promise<void> {
    const handler = treeChangedHandler();
    await act(async () => {
      handler();
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it("reloads a clean open note when its file changes externally (debounced once)", async () => {
    vi.useFakeTimers();
    const files = mockDisk({ "/v/a.md": "A" });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await drainMicrotasks();
    expect(result.current.active.draft).toBe("A");

    files["/v/a.md"] = "edited elsewhere";
    const readsBefore = mockInvoke.mock.calls.filter(([c]) => c === "read_note").length;
    const handler = treeChangedHandler();
    await act(async () => {
      handler();
      handler();
      handler(); // a burst must collapse into a single reconcile read
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.active.draft).toBe("edited elsewhere");
    expect(result.current.active.dirty).toBe(false);
    expect(result.current.active.note?.raw).toBe("edited elsewhere");
    const readsAfter = mockInvoke.mock.calls.filter(([c]) => c === "read_note").length;
    expect(readsAfter - readsBefore).toBe(1);
  });

  it("preserves a dirty draft and surfaces a conflict instead of replacing it", async () => {
    vi.useFakeTimers();
    const files = mockDisk({ "/v/a.md": "A" });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await drainMicrotasks();
    act(() => result.current.active.setDraft("my unsaved work"));

    files["/v/a.md"] = "changed under me";
    await fireWatcher();

    expect(result.current.active.conflict).toBe(true);
    expect(result.current.active.draft).toBe("my unsaved work"); // never clobbered
    expect(result.current.active.dirty).toBe(true);
    expect(result.current.active.note?.raw).toBe("A"); // base unchanged
  });

  it("surfaces an external deletion while keeping the note and draft", async () => {
    vi.useFakeTimers();
    const files = mockDisk({ "/v/a.md": "A" });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await drainMicrotasks();
    act(() => result.current.active.setDraft("still here"));

    delete files["/v/a.md"]; // removed on disk
    await fireWatcher();

    expect(result.current.active.externalDeleted).toBe(true);
    expect(result.current.active.note).not.toBeNull(); // not dropped
    expect(result.current.active.draft).toBe("still here"); // recoverable
  });

  it("follows an in-app rename: an external edit reloads the note at its new path", async () => {
    vi.useFakeTimers();
    const files = mockDisk({ "/v/a.md": "A" });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await drainMicrotasks();

    act(() => result.current.remap("/v/a.md", "/v/b.md", "b.md"));
    expect(result.current.active.path).toBe("/v/b.md");
    files["/v/b.md"] = "edited at new path"; // external edit lands at the new path
    await fireWatcher();

    expect(result.current.active.path).toBe("/v/b.md");
    expect(result.current.active.draft).toBe("edited at new path");
    expect(result.current.active.dirty).toBe(false);
  });

  it("does not reload or conflict after an in-app save fires the watcher (self-write guard)", async () => {
    vi.useFakeTimers();
    mockDisk({ "/v/a.md": "A" });
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await drainMicrotasks();
    act(() => result.current.active.setDraft("A changed"));
    await act(async () => {
      await result.current.active.save();
    });
    expect(result.current.active.dirty).toBe(false);

    await fireWatcher(); // the save wrote the file, which fires the watcher

    expect(result.current.active.conflict).toBe(false);
    expect(result.current.active.externalDeleted).toBe(false);
    expect(result.current.active.draft).toBe("A changed"); // unchanged, no spurious reload
    expect(result.current.active.dirty).toBe(false);
  });

  it("tears down the watcher subscription on unmount", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);
    mockDisk({ "/v/a.md": "A" });
    const { unmount } = renderHook(() => useNoteTabs());
    await drainMicrotasks(); // let the subscription promise assign the unlisten fn

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});
