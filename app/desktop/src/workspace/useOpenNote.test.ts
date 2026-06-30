import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive the real api.ts wrappers by mocking only the Tauri boundary, so the hook
// exercises errorMessage / isConflict for real and we control read/write outcomes.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { NoteDoc } from "../lib/types";
import { useOpenNote } from "./useOpenNote";

const mockInvoke = vi.mocked(invoke);

function doc(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/v/n.md",
    relPath: "n.md",
    title: "Note",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "hello world",
    raw: "# Note\n\nhello world",
    contentHash: "hash-1",
    binary: false,
    lossyText: false,
    ...overrides,
  };
}

/** A manually-resolvable promise for token-ordering tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("useOpenNote — initial state", () => {
  it("starts empty in read mode", () => {
    const { result } = renderHook(() => useOpenNote());
    expect(result.current.path).toBeNull();
    expect(result.current.note).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.mode).toBe("read");
    expect(result.current.draft).toBe("");
    expect(result.current.dirty).toBe(false);
    expect(result.current.conflict).toBe(false);
  });
});

describe("useOpenNote — open / load", () => {
  it("loads a note into read mode on success", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());

    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockInvoke).toHaveBeenCalledWith("read_note", { path: "/v/n.md" });
    expect(result.current.path).toBe("/v/n.md");
    expect(result.current.note).toEqual(d);
    expect(result.current.draft).toBe(d.raw);
    expect(result.current.mode).toBe("read");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a read error and clears the note", async () => {
    mockInvoke.mockRejectedValueOnce({ kind: "io", message: "cannot read" });
    const { result } = renderHook(() => useOpenNote());

    act(() => result.current.open("/v/bad.md"));
    await waitFor(() => expect(result.current.error).toBe("cannot read"));

    expect(result.current.note).toBeNull();
    expect(result.current.draft).toBe("");
    expect(result.current.loading).toBe(false);
  });
});

describe("useOpenNote — dirty tracking", () => {
  it("is dirty only while the draft differs from the loaded raw", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());

    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    expect(result.current.dirty).toBe(false);
    act(() => result.current.setDraft("changed"));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setDraft(d.raw));
    expect(result.current.dirty).toBe(false);
  });
});

describe("useOpenNote — save", () => {
  async function openLoaded() {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const hook = renderHook(() => useOpenNote());
    act(() => hook.result.current.open("/v/n.md"));
    await waitFor(() => expect(hook.result.current.note).not.toBeNull());
    return { hook, d };
  }

  it("persists with the read contentHash and adopts the fresh doc", async () => {
    const { hook, d } = await openLoaded();
    act(() => hook.result.current.setMode("edit"));
    act(() => hook.result.current.setDraft("# Note\n\nedited"));

    const saved = doc({ raw: "# Note\n\nedited", contentHash: "hash-2" });
    mockInvoke.mockResolvedValueOnce(saved);
    await act(async () => {
      await hook.result.current.save();
    });

    expect(mockInvoke).toHaveBeenLastCalledWith("write_note", {
      path: "/v/n.md",
      content: "# Note\n\nedited",
      expectedHash: d.contentHash,
    });
    expect(hook.result.current.note).toEqual(saved);
    expect(hook.result.current.draft).toBe(saved.raw);
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.saveError).toBeNull();
    expect(hook.result.current.saving).toBe(false);
  });

  it("keeps edits typed during an in-flight save (no silent loss)", async () => {
    const { hook } = await openLoaded();
    act(() => hook.result.current.setMode("edit"));
    act(() => hook.result.current.setDraft("v1"));

    // Start a save whose write hasn't resolved yet.
    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as Promise<unknown>);
    let savePromise!: Promise<void>;
    act(() => {
      savePromise = hook.result.current.save();
    });

    // The user keeps typing while the write is in flight.
    act(() => hook.result.current.setDraft("v1 + more"));

    // The write lands with the content as it was at save time ("v1").
    await act(async () => {
      write.resolve(doc({ raw: "v1", contentHash: "hash-2" }));
      await savePromise;
    });

    // In-flight keystrokes are preserved, and dirty still protects them.
    expect(hook.result.current.draft).toBe("v1 + more");
    expect(hook.result.current.dirty).toBe(true);
  });

  it("enters the conflict state when the write rejects with a conflict", async () => {
    const { hook } = await openLoaded();
    act(() => hook.result.current.setDraft("changed"));

    mockInvoke.mockRejectedValueOnce({ kind: "conflict", message: "stale" });
    await act(async () => {
      await hook.result.current.save();
    });

    expect(hook.result.current.conflict).toBe(true);
    expect(hook.result.current.saveError).toBeNull();
  });

  it("surfaces a non-conflict save error without entering conflict", async () => {
    const { hook } = await openLoaded();
    act(() => hook.result.current.setDraft("changed"));

    mockInvoke.mockRejectedValueOnce({ kind: "io", message: "disk full" });
    await act(async () => {
      await hook.result.current.save();
    });

    expect(hook.result.current.conflict).toBe(false);
    expect(hook.result.current.saveError).toBe("disk full");
  });

  it("is a no-op when there is no open note", async () => {
    const { result } = renderHook(() => useOpenNote());
    await act(async () => {
      await result.current.save();
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("useOpenNote — overwrite", () => {
  it("forces the write past the conflict with a null expectedHash", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    act(() => result.current.setDraft("forced body"));
    mockInvoke.mockRejectedValueOnce({ kind: "conflict", message: "stale" });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toBe(true);

    const saved = doc({ raw: "forced body", contentHash: "hash-3" });
    mockInvoke.mockResolvedValueOnce(saved);
    await act(async () => {
      await result.current.overwrite();
    });

    expect(mockInvoke).toHaveBeenLastCalledWith("write_note", {
      path: "/v/n.md",
      content: "forced body",
      expectedHash: null,
    });
    expect(result.current.conflict).toBe(false);
    expect(result.current.note).toEqual(saved);
  });

  it("is a no-op when there is no open path", async () => {
    const { result } = renderHook(() => useOpenNote());
    await act(async () => {
      await result.current.overwrite();
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("useOpenNote — reload", () => {
  it("re-reads the active note from disk", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    const fresh = doc({ raw: "reloaded", contentHash: "hash-r" });
    mockInvoke.mockResolvedValueOnce(fresh);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.note).toEqual(fresh));

    expect(mockInvoke).toHaveBeenLastCalledWith("read_note", { path: "/v/n.md" });
  });

  it("is a no-op when nothing is open", () => {
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.reload());
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("useOpenNote — repath", () => {
  it("repoints the note path and keeps relPath when none supplied", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    act(() => result.current.repath("/v/renamed.md"));
    expect(result.current.path).toBe("/v/renamed.md");
    expect(result.current.note?.path).toBe("/v/renamed.md");
    expect(result.current.note?.relPath).toBe(d.relPath);
  });

  it("updates relPath for a descendant repath", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    act(() => result.current.repath("/v/B/n.md", "B/n.md"));
    expect(result.current.path).toBe("/v/B/n.md");
    expect(result.current.note?.relPath).toBe("B/n.md");
  });

  it("sets the path even when no note is loaded", () => {
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.repath("/v/x.md"));
    expect(result.current.path).toBe("/v/x.md");
    expect(result.current.note).toBeNull();
  });
});

describe("useOpenNote — clear", () => {
  it("resets the reader entirely", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    act(() => result.current.clear());
    expect(result.current.path).toBeNull();
    expect(result.current.note).toBeNull();
    expect(result.current.draft).toBe("");
    expect(result.current.mode).toBe("read");
    expect(result.current.loading).toBe(false);
  });
});

describe("useOpenNote — load-token guard", () => {
  it("ignores a stale load that resolves after a newer open", async () => {
    const first = deferred<NoteDoc>();
    const second = deferred<NoteDoc>();
    mockInvoke
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);

    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/a.md"));
    act(() => result.current.open("/v/b.md"));

    const docB = doc({ path: "/v/b.md", raw: "B body", title: "B" });
    await act(async () => {
      second.resolve(docB);
      await second.promise;
    });
    expect(result.current.note?.title).toBe("B");

    // The earlier /a.md load now resolves but must not clobber /b.md.
    const docA = doc({ path: "/v/a.md", raw: "A body", title: "A" });
    await act(async () => {
      first.resolve(docA);
      await first.promise;
    });
    expect(result.current.note?.title).toBe("B");
    expect(result.current.path).toBe("/v/b.md");
  });

  it("ignores a save that resolves after the reader was cleared", async () => {
    const d = doc();
    mockInvoke.mockResolvedValueOnce(d);
    const { result } = renderHook(() => useOpenNote());
    act(() => result.current.open("/v/n.md"));
    await waitFor(() => expect(result.current.note).not.toBeNull());

    act(() => result.current.setDraft("in-flight edit"));
    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValueOnce(write.promise as never);

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    // User navigates away mid-save: clear() bumps the load token.
    act(() => result.current.clear());

    await act(async () => {
      write.resolve(doc({ raw: "in-flight edit", contentHash: "hash-x" }));
      await savePromise;
    });

    // The landed write is discarded against the cleared reader, but saving is off.
    expect(result.current.note).toBeNull();
    expect(result.current.saving).toBe(false);
  });
});
