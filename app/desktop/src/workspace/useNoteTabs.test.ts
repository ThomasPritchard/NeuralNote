// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { NoteDoc, RichEditDocument } from "../lib/types";
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

function rich(body: string, revision = `hash:${body}`): RichEditDocument {
  return {
    revision,
    frontmatterPrefix: "",
    body,
    disposition: { kind: "rich" },
    blocks: [{ id: `block:${revision}`, leadingSeparator: "", markdown: body, trailingSeparator: "" }],
  };
}

beforeEach(() => mockInvoke.mockReset());

describe("useNoteTabs - collection behavior", () => {
  it("keeps rich drafts and bounded undo history with their owning tabs", async () => {
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A"))
      .mockResolvedValueOnce(doc("/v/b.md", "B"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("A first"));
    act(() => result.current.active.setRichBody("A second"));

    act(() => result.current.open("/v/b.md", { forceNew: true }));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));
    act(() => result.current.active.setRichDocument(rich("B")));
    act(() => result.current.active.setRichBody("B first"));
    act(() => result.current.active.undoRich());
    expect(result.current.active.richBody).toBe("B");

    act(() => result.current.activate(result.current.tabs[0].id));
    expect(result.current.active.richBody).toBe("A second");
    act(() => result.current.active.undoRich());
    expect(result.current.active.richBody).toBe("A first");
    act(() => result.current.active.redoRich());
    expect(result.current.active.richBody).toBe("A second");
  });

  it("bounds rich undo history by UTF-8 bytes for CJK drafts", async () => {
    const historyBudget = 8 * 1024 * 1024;
    const oversizedCjkDraft = "界".repeat(Math.floor(historyBudget / 3) + 1);
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody(oversizedCjkDraft));
    act(() => result.current.active.setRichBody("latest"));

    expect(result.current.activeTab?.richPast).toHaveLength(1);
    expect(result.current.activeTab?.richPast[0]).toBe(oversizedCjkDraft);
  });

  it("bounds rich undo history by UTF-8 bytes for emoji drafts", async () => {
    const historyBudget = 8 * 1024 * 1024;
    const oversizedEmojiDraft = "😀".repeat(Math.floor(historyBudget / 4) + 1);
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());

    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody(oversizedEmojiDraft));
    act(() => result.current.active.setRichBody("latest"));

    expect(result.current.activeTab?.richPast).toHaveLength(1);
    expect(result.current.activeTab?.richPast[0]).toBe(oversizedEmojiDraft);
  });

  it("persists rich edits through an opaque source-range patch", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("A changed"));

    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A changed"))
      .mockResolvedValueOnce(rich("A changed"));
    await act(() => result.current.active.save());

    expect(mockInvoke).toHaveBeenNthCalledWith(2, "write_rich_note", {
      path: "/v/a.md",
      patch: {
        expectedRevision: "hash:A",
        changedBlockIds: ["block:hash:A"],
        replacementMarkdown: "A changed",
      },
    });
    expect(result.current.active.dirty).toBe(false);
    expect(result.current.active.richDocument?.revision).toBe("hash:A changed");
  });

  it("falls back to raw Markdown when native rich preservation rejects the patch", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("A changed"));

    mockInvoke.mockRejectedValueOnce({
      kind: "invalidContent",
      message: "mailto link is malformed",
    });
    await act(() => result.current.active.save());

    expect(result.current.active.richDocument).toBeNull();
    expect(result.current.active.richError).toBe("mailto link is malformed");
    expect(result.current.active.draft).toBe("A changed");
    expect(result.current.active.dirty).toBe(true);
  });

  it("falls back locally without writing when rich preflight rejects malformed mailto", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("[mail](mailto:invalid)"));

    await act(() => result.current.active.save());

    expect(result.current.active.richDocument).toBeNull();
    expect(result.current.active.richError).toContain("unsafe link");
    expect(result.current.active.draft).toBe("[mail](mailto:invalid)");
    expect(mockInvoke.mock.calls.some(([command]) => command === "write_rich_note")).toBe(false);
  });

  it("refreshes the rich revision after conflict overwrite without losing newer typing", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("local edit"));

    mockInvoke.mockRejectedValueOnce({ kind: "conflict", message: "changed on disk" });
    await act(() => result.current.active.save());
    expect(result.current.active.conflict).toBe(true);

    const overwrite = deferred<NoteDoc>();
    const refresh = deferred<RichEditDocument>();
    mockInvoke
      .mockReturnValueOnce(overwrite.promise as Promise<unknown>)
      .mockReturnValueOnce(refresh.promise as Promise<unknown>);
    let overwriteSave!: Promise<void>;
    act(() => { overwriteSave = result.current.active.overwrite(); });
    act(() => result.current.active.setRichBody("local edit plus more"));
    await act(async () => {
      overwrite.resolve(doc("/v/a.md", "local edit"));
      await overwrite.promise;
    });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("read_rich_note", { path: "/v/a.md" }),
    );
    expect(result.current.active.saving).toBe(true);
    await act(async () => {
      refresh.resolve(rich("local edit"));
      await overwriteSave;
    });

    expect(result.current.active.richDocument?.revision).toBe("hash:local edit");
    expect(result.current.active.richBody).toBe("local edit plus more");
    expect(result.current.active.dirty).toBe(true);

    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "local edit plus more"))
      .mockResolvedValueOnce(rich("local edit plus more"));
    await act(() => result.current.active.save());

    expect(mockInvoke).toHaveBeenLastCalledWith("read_rich_note", {
      path: "/v/a.md",
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(5, "write_rich_note", {
      path: "/v/a.md",
      patch: {
        expectedRevision: "hash:local edit",
        changedBlockIds: ["block:hash:local edit"],
        replacementMarkdown: "local edit plus more",
      },
    });
    expect(result.current.active.dirty).toBe(false);
  });

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
  it("keeps each tab save single-flight when save is requested twice", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setDraft("saved once"));

    const write = deferred<NoteDoc>();
    mockInvoke.mockReturnValue(write.promise as Promise<unknown>);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.active.save();
      second = result.current.active.save();
    });
    await act(async () => {
      write.resolve(doc("/v/a.md", "saved once"));
      await Promise.all([first, second]);
    });

    expect(mockInvoke.mock.calls.filter(([command]) => command === "write_note")).toHaveLength(1);
    expect(result.current.active.conflict).toBe(false);
    expect(result.current.active.dirty).toBe(false);
  });

  it("keeps a rich save visibly in flight until its revision refresh completes", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("first edit"));

    const refresh = deferred<RichEditDocument>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "first edit"))
      .mockReturnValueOnce(refresh.promise as Promise<unknown>);
    let first!: Promise<void>;
    act(() => { first = result.current.active.save(); });
    await waitFor(() =>
      expect(mockInvoke.mock.calls.some(([command]) => command === "read_rich_note")).toBe(true),
    );
    expect(result.current.active.saving).toBe(true);

    act(() => result.current.active.setRichBody("second edit"));
    expect(result.current.active.saving).toBe(true);
    await act(() => result.current.active.save());

    expect(mockInvoke.mock.calls.filter(([command]) => command === "write_rich_note")).toHaveLength(1);

    await act(async () => {
      refresh.resolve(rich("first edit"));
      await first;
    });
    expect(result.current.active.saving).toBe(false);
    expect(result.current.active.dirty).toBe(true);
  });

  it("reloads the rich revision at a remapped path before allowing the next save", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("first edit"));

    const oldPathRefresh = deferred<RichEditDocument>();
    const remappedPathRefresh = deferred<RichEditDocument>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "first edit"))
      .mockReturnValueOnce(oldPathRefresh.promise as Promise<unknown>)
      .mockReturnValueOnce(remappedPathRefresh.promise as Promise<unknown>);
    let firstSave!: Promise<void>;
    act(() => { firstSave = result.current.active.save(); });
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("read_rich_note", { path: "/v/a.md" }),
    );

    act(() => result.current.remap("/v/a.md", "/v/renamed.md", "renamed.md"));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("read_rich_note", { path: "/v/renamed.md" }),
    );
    expect(result.current.active.saving).toBe(true);

    await act(async () => {
      remappedPathRefresh.resolve(rich("first edit"));
      await remappedPathRefresh.promise;
    });
    expect(result.current.active.richDocument?.revision).toBe("hash:first edit");
    expect(result.current.active.saving).toBe(false);

    await act(async () => {
      oldPathRefresh.resolve(rich("first edit"));
      await firstSave;
    });
    expect(result.current.active.richDocument?.revision).toBe("hash:first edit");

    act(() => result.current.active.setRichBody("second edit"));
    mockInvoke
      .mockResolvedValueOnce(doc("/v/renamed.md", "second edit"))
      .mockResolvedValueOnce(rich("second edit"));
    await act(() => result.current.active.save());

    const richWrites = mockInvoke.mock.calls.filter(([command]) => command === "write_rich_note");
    expect(richWrites).toHaveLength(2);
    expect(richWrites.at(-1)?.[1]).toMatchObject({
      path: "/v/renamed.md",
      patch: { expectedRevision: "hash:first edit" },
    });
  });

  it("ignores a successful rich refresh after its clean tab is reused for another note", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("A saved"));

    const refresh = deferred<RichEditDocument>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A saved"))
      .mockReturnValueOnce(refresh.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    await waitFor(() =>
      expect(mockInvoke.mock.calls.some(([command]) => command === "read_rich_note")).toBe(true),
    );

    const reusedTabId = result.current.activeTabId;
    mockInvoke.mockResolvedValueOnce(doc("/v/b.md", "B"));
    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));
    expect(result.current.activeTabId).toBe(reusedTabId);

    await act(async () => {
      refresh.resolve(rich("A saved"));
      await save;
    });

    expect(result.current.active.note?.raw).toBe("B");
    expect(result.current.active.richDocument).toBeNull();
    expect(result.current.active.richError).toBeNull();
  });

  it("ignores a failed rich refresh after its clean tab is reused for another note", async () => {
    mockInvoke.mockResolvedValueOnce(doc("/v/a.md", "A"));
    const { result } = renderHook(() => useNoteTabs());
    act(() => result.current.open("/v/a.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("A"));
    act(() => result.current.active.setRichDocument(rich("A")));
    act(() => result.current.active.setRichBody("A saved"));

    const refresh = deferred<RichEditDocument>();
    mockInvoke
      .mockResolvedValueOnce(doc("/v/a.md", "A saved"))
      .mockReturnValueOnce(refresh.promise as Promise<unknown>);
    let save!: Promise<void>;
    act(() => { save = result.current.active.save(); });
    await waitFor(() =>
      expect(mockInvoke.mock.calls.some(([command]) => command === "read_rich_note")).toBe(true),
    );

    const reusedTabId = result.current.activeTabId;
    mockInvoke.mockResolvedValueOnce(doc("/v/b.md", "B"));
    act(() => result.current.open("/v/b.md"));
    await waitFor(() => expect(result.current.active.note?.raw).toBe("B"));
    expect(result.current.activeTabId).toBe(reusedTabId);

    await act(async () => {
      refresh.reject(new Error("old refresh failed"));
      await save;
    });

    expect(result.current.active.note?.raw).toBe("B");
    expect(result.current.active.richDocument).toBeNull();
    expect(result.current.active.richError).toBeNull();
  });

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
