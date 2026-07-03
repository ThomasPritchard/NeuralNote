import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri boundary so the typed wrappers can be driven in jsdom (which has
// no Tauri runtime). Every wrapper funnels through `invoke`; `onTreeChanged` uses
// `listen`. We assert each wrapper calls the right command with the right args.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  closeVault,
  createFolder,
  createNote,
  createVault,
  deleteEntry,
  errorMessage,
  isConflict,
  listRecentVaults,
  moveEntry,
  onTreeChanged,
  openVault,
  pickNewVaultLocation,
  pickVaultFolder,
  readLinkGraph,
  readNote,
  readTree,
  renameEntry,
  searchVault,
  writeNote,
} from "./api";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined as never);
  mockListen.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorMessage", () => {
  it("returns the message of a serialised CoreError", () => {
    expect(errorMessage({ kind: "io", message: "disk on fire" })).toBe(
      "disk on fire",
    );
  });

  it("coerces a non-string message field to a string", () => {
    expect(errorMessage({ message: 123 })).toBe("123");
  });

  it("returns a raw string error verbatim", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  it("falls back for unknown shapes (null, number, object without message)", () => {
    expect(errorMessage(null)).toBe("Something went wrong.");
    expect(errorMessage(42)).toBe("Something went wrong.");
    expect(errorMessage({})).toBe("Something went wrong.");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });
});

describe("isConflict", () => {
  it("is true only for a CoreError with kind === conflict", () => {
    expect(isConflict({ kind: "conflict", message: "changed" })).toBe(true);
  });

  it("is false for other kinds and non-error shapes", () => {
    expect(isConflict({ kind: "io", message: "x" })).toBe(false);
    expect(isConflict({ message: "no kind" })).toBe(false);
    expect(isConflict("conflict")).toBe(false);
    expect(isConflict(null)).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });
});

describe("vault lifecycle wrappers", () => {
  it("listRecentVaults calls list_recent_vaults", async () => {
    mockInvoke.mockResolvedValueOnce([{ name: "v", path: "/v", lastOpened: 1 }]);
    const out = await listRecentVaults();
    expect(mockInvoke).toHaveBeenCalledWith("list_recent_vaults");
    expect(out).toEqual([{ name: "v", path: "/v", lastOpened: 1 }]);
  });

  it("pickVaultFolder calls pick_vault_folder", async () => {
    mockInvoke.mockResolvedValueOnce("/chosen");
    expect(await pickVaultFolder()).toBe("/chosen");
    expect(mockInvoke).toHaveBeenCalledWith("pick_vault_folder");
  });

  it("pickNewVaultLocation calls pick_new_vault_location", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    expect(await pickNewVaultLocation()).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("pick_new_vault_location");
  });

  it("openVault passes the path", async () => {
    mockInvoke.mockResolvedValueOnce({ name: "V", path: "/v" });
    await openVault("/v");
    expect(mockInvoke).toHaveBeenCalledWith("open_vault", { path: "/v" });
  });

  it("createVault passes parentDir and name", async () => {
    mockInvoke.mockResolvedValueOnce({ name: "New", path: "/p/New" });
    await createVault("/p", "New");
    expect(mockInvoke).toHaveBeenCalledWith("create_vault", {
      parentDir: "/p",
      name: "New",
    });
  });

  it("closeVault calls close_vault", async () => {
    await closeVault();
    expect(mockInvoke).toHaveBeenCalledWith("close_vault");
  });
});

describe("tree + note wrappers", () => {
  it("readTree calls read_tree", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await readTree();
    expect(mockInvoke).toHaveBeenCalledWith("read_tree");
  });

  it("readNote passes the path", async () => {
    mockInvoke.mockResolvedValueOnce({ raw: "x" });
    await readNote("/v/n.md");
    expect(mockInvoke).toHaveBeenCalledWith("read_note", { path: "/v/n.md" });
  });

  it("writeNote defaults expectedHash to null", async () => {
    mockInvoke.mockResolvedValueOnce({ raw: "x" });
    await writeNote("/v/n.md", "body");
    expect(mockInvoke).toHaveBeenCalledWith("write_note", {
      path: "/v/n.md",
      content: "body",
      expectedHash: null,
    });
  });

  it("writeNote forwards an explicit expectedHash", async () => {
    mockInvoke.mockResolvedValueOnce({ raw: "x" });
    await writeNote("/v/n.md", "body", "hash123");
    expect(mockInvoke).toHaveBeenCalledWith("write_note", {
      path: "/v/n.md",
      content: "body",
      expectedHash: "hash123",
    });
  });
});

describe("file / folder operation wrappers", () => {
  it("createFolder passes parentPath and name", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "folder" });
    await createFolder("/v", "Sub");
    expect(mockInvoke).toHaveBeenCalledWith("create_folder", {
      parentPath: "/v",
      name: "Sub",
    });
  });

  it("createNote passes parentPath and name", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "file" });
    await createNote("/v", "Note.md");
    expect(mockInvoke).toHaveBeenCalledWith("create_note", {
      parentPath: "/v",
      name: "Note.md",
    });
  });

  it("renameEntry passes path and newName", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "file" });
    await renameEntry("/v/a.md", "b.md");
    expect(mockInvoke).toHaveBeenCalledWith("rename_entry", {
      path: "/v/a.md",
      newName: "b.md",
    });
  });

  it("deleteEntry passes the path", async () => {
    await deleteEntry("/v/a.md");
    expect(mockInvoke).toHaveBeenCalledWith("delete_entry", { path: "/v/a.md" });
  });

  it("moveEntry passes path and newParentPath", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "file" });
    await moveEntry("/v/a.md", "/v/Sub");
    expect(mockInvoke).toHaveBeenCalledWith("move_entry", {
      path: "/v/a.md",
      newParentPath: "/v/Sub",
    });
  });
});

describe("search + graph wrappers", () => {
  it("searchVault passes the query", async () => {
    mockInvoke.mockResolvedValueOnce({ hits: [], truncated: false, skippedFiles: 0 });
    const out = await searchVault("neural");
    expect(mockInvoke).toHaveBeenCalledWith("search_vault", { query: "neural" });
    expect(out).toEqual({ hits: [], truncated: false, skippedFiles: 0 });
  });

  it("readLinkGraph calls read_link_graph", async () => {
    mockInvoke.mockResolvedValueOnce({ nodes: [], links: [], skippedFiles: 0 });
    const out = await readLinkGraph();
    expect(mockInvoke).toHaveBeenCalledWith("read_link_graph");
    expect(out).toEqual({ nodes: [], links: [], skippedFiles: 0 });
  });
});

describe("onTreeChanged", () => {
  it("subscribes to the tree-changed event and invokes the callback", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValueOnce(unlisten);
    const cb = vi.fn();

    const returned = await onTreeChanged(cb);

    expect(mockListen).toHaveBeenCalledWith(
      "vault://tree-changed",
      expect.any(Function),
    );
    expect(returned).toBe(unlisten);

    // The wrapper ignores the event payload and just notifies the callback.
    const handler = mockListen.mock.calls[0][1] as (e: unknown) => void;
    handler({ payload: "anything" });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
