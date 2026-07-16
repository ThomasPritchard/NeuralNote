import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri boundary so the typed wrappers can be driven in jsdom (which has
// no Tauri runtime). Every wrapper funnels through `invoke`; `onTreeChanged` uses
// `listen`. We assert each wrapper calls the right command with the right args.
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  answerElicitation,
  cancelChatRun,
  cancelRequirementDownload,
  chat,
  closeVault,
  createFolder,
  createNote,
  createNoteFromTemplate,
  createVault,
  deleteEntry,
  downloadRequirement,
  errorMessage,
  isConflict,
  isNotFound,
  listDir,
  listRecentVaults,
  listSkills,
  listTemplates,
  loadWorkspaceState,
  moveEntry,
  onMenu,
  onTreeChanged,
  openVault,
  openOpenRouterRankings,
  openRouterModelMenu,
  openYoutubeTimestamp,
  pickNewVaultLocation,
  pickVaultFolder,
  readBacklinks,
  readLinkGraph,
  readNote,
  readTree,
  refreshReasoningSupport,
  renameEntry,
  resetWorkspaceState,
  quitApp,
  saveWorkspaceState,
  searchVault,
  selectOpenRouterModel,
  setActiveProvider,
  setReasoning,
  setSkillEnabled,
  setMenuEditing,
  undoSkillRun,
  writeNote,
} from "./api";
import type { AiStatus, ChatEvent, PullEvent } from "./types";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);
const TURN_ID = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e21";

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

const makeStatus = (model: string, reasoning: boolean): AiStatus => ({
  activeProvider: "openRouter",
  reasoningSupported: "unknown",
  openrouter: { hasKey: true, model, reasoning },
  local: { activeModelTag: null },
});

describe("AI config mutation sequencing", () => {
  it("does not start a later model mutation until the earlier reasoning response resolves", async () => {
    let resolveReasoning!: (value: AiStatus) => void;
    let resolveModel!: (value: AiStatus) => void;
    const reasoningResponse = new Promise<AiStatus>((resolve) => {
      resolveReasoning = resolve;
    });
    const modelResponse = new Promise<AiStatus>((resolve) => {
      resolveModel = resolve;
    });
    mockInvoke.mockImplementation((command) => {
      if (command === "set_reasoning") return reasoningResponse as never;
      if (command === "select_openrouter_model") return modelResponse as never;
      return Promise.resolve(undefined as never);
    });

    const first = setReasoning(false);
    const second = selectOpenRouterModel("vendor/new");
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    expect(mockInvoke).toHaveBeenLastCalledWith("set_reasoning", { enabled: false });

    resolveReasoning(makeStatus("vendor/old", false));
    await expect(first).resolves.toEqual(makeStatus("vendor/old", false));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
    expect(mockInvoke).toHaveBeenLastCalledWith("select_openrouter_model", {
      model: "vendor/new",
    });
    resolveModel(makeStatus("vendor/new", false));
    await expect(second).resolves.toEqual(makeStatus("vendor/new", false));
  });

  it("keeps provider selection and its status read inside the same mutation slot", async () => {
    const selected = makeStatus("vendor/current", false);
    mockInvoke
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(selected as never);

    await expect(setActiveProvider("openRouter")).resolves.toEqual(selected);
    expect(mockInvoke.mock.calls).toEqual([
      ["set_active_provider", { provider: "openRouter", localModelTag: undefined }],
      ["ai_status"],
    ]);
  });

  it("does not let a pending capability probe block a later config mutation", async () => {
    let resolveProbe!: (value: AiStatus) => void;
    const probeResponse = new Promise<AiStatus>((resolve) => {
      resolveProbe = resolve;
    });
    const staleProbe = makeStatus("vendor/old", false);
    const selected = makeStatus("vendor/new", true);
    mockInvoke.mockImplementation((command) => {
      if (command === "refresh_reasoning_support") return probeResponse as never;
      if (command === "select_openrouter_model") {
        return Promise.resolve(selected as never);
      }
      return Promise.resolve(undefined as never);
    });

    const probe = refreshReasoningSupport();
    const mutation = selectOpenRouterModel("vendor/new");
    let mutationResult: AiStatus | undefined;
    void mutation.then((value) => {
      mutationResult = value;
    });

    let failure: unknown;
    try {
      await vi.waitFor(() => expect(mutationResult).toEqual(selected), {
        timeout: 500,
      });
      expect(mockInvoke.mock.calls).toContainEqual([
        "select_openrouter_model",
        { model: "vendor/new" },
      ]);
    } catch (error) {
      failure = error;
    } finally {
      resolveProbe(staleProbe);
      await expect(probe).resolves.toEqual(staleProbe);
      await mutation;
    }
    if (failure) throw failure;
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

describe("isNotFound", () => {
  it("is true only for a CoreError with kind === notFound", () => {
    expect(
      isNotFound({ kind: "notFound", message: "elicitation 'q1' is not live" }),
    ).toBe(true);
  });

  it("is false for other kinds and non-error shapes", () => {
    expect(isNotFound({ kind: "conflict", message: "x" })).toBe(false);
    expect(isNotFound({ message: "no kind" })).toBe(false);
    expect(isNotFound("notFound")).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe("skills-bank wrappers", () => {
  it("returns a Promise that resolves to the mocked run id", async () => {
    mockInvoke.mockResolvedValueOnce("skill-run-7");

    const result = chat(TURN_ID, "file this", [], vi.fn());

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe("skill-run-7");
  });

  it("returns the run id produced by chat", async () => {
    mockInvoke.mockResolvedValueOnce("skill-run-7");

    const result: Promise<string> = chat(TURN_ID, "file this", [], vi.fn());

    await expect(result).resolves.toBe("skill-run-7");
  });

  it("defaults chat activeSkills to an empty list", async () => {
    await chat(TURN_ID, "hello", [], vi.fn());

    expect(mockInvoke).toHaveBeenCalledWith("chat", {
      prompt: "hello",
      turnId: TURN_ID,
      history: [],
      onEvent: expect.any(Object),
      activeSkills: [],
    });
  });

  it("forwards explicit chat activeSkills", async () => {
    await chat(TURN_ID, "distil this", [], vi.fn(), ["youtube-distil", "fixture"]);

    expect(mockInvoke).toHaveBeenCalledWith("chat", {
      prompt: "distil this",
      turnId: TURN_ID,
      history: [],
      onEvent: expect.any(Object),
      activeSkills: ["youtube-distil", "fixture"],
    });
  });

  it("forwards chat channel messages to onEvent", async () => {
    const onEvent = vi.fn();
    await chat(TURN_ID, "hello", [], onEvent);
    const args = mockInvoke.mock.calls.at(-1)?.[1] as {
      onEvent: { onmessage?: (event: ChatEvent) => void };
    };

    args.onEvent.onmessage?.({ type: "skillStep", message: "Writing note" });

    expect(onEvent).toHaveBeenCalledWith({
      type: "skillStep",
      message: "Writing note",
    });
  });

  it("answers a live elicitation with the selected option ids scoped to its run", async () => {
    await answerElicitation(TURN_ID, "consent-1", ["yes"]);

    expect(mockInvoke).toHaveBeenCalledWith("answer_elicitation", {
      turnId: TURN_ID,
      id: "consent-1",
      choices: ["yes"],
    });
  });

  it("cancels only the exact caller-owned chat turn and returns its typed outcome", async () => {
    const outcome = { turnId: TURN_ID, status: "cancelled" as const };
    mockInvoke.mockResolvedValueOnce(outcome);

    await expect(cancelChatRun(TURN_ID)).resolves.toEqual(outcome);
    expect(mockInvoke).toHaveBeenCalledWith("cancel_chat_run", { turnId: TURN_ID });
  });

  it("opens a validated YouTube timestamp through the Rust shell", async () => {
    await openYoutubeTimestamp("https://youtu.be/jNQXAC9IVRw?t=872");
    expect(mockInvoke).toHaveBeenCalledWith("open_youtube_timestamp", {
      url: "https://youtu.be/jNQXAC9IVRw?t=872",
    });
  });

  it("returns the per-file undo report", async () => {
    const report = {
      files: [
        {
          relPath: "Sources/Example.md",
          status: "deleted",
          message: null,
        },
      ],
    };
    mockInvoke.mockResolvedValueOnce(report);

    await expect(undoSkillRun("skill-run-7")).resolves.toEqual(report);
    expect(mockInvoke).toHaveBeenCalledWith("undo_skill_run", {
      runId: "skill-run-7",
    });
  });

  it("lists skills through the backend catalogue command", async () => {
    const listings = [
      {
        id: "fixture-note-workflow",
        name: "Fixture note workflow",
        description: "Demonstrate the built-in skill flow.",
        icon: "flask",
        enabled: true,
        requirements: [],
      },
    ];
    mockInvoke.mockResolvedValueOnce(listings);

    await expect(listSkills()).resolves.toEqual(listings);
    expect(mockInvoke).toHaveBeenCalledWith("list_skills");
  });

  it("returns the persisted state when setting a skill enabled flag", async () => {
    mockInvoke.mockResolvedValueOnce(false);

    await expect(
      setSkillEnabled("fixture-note-workflow", false),
    ).resolves.toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("set_skill_enabled", {
      id: "fixture-note-workflow",
      enabled: false,
    });
  });

  it("passes the requirement name and a progress channel", async () => {
    const onEvent = vi.fn();
    await downloadRequirement("yt-dlp", onEvent);
    const args = mockInvoke.mock.calls.at(-1)?.[1] as {
      name: string;
      onEvent: { onmessage?: (event: PullEvent) => void };
    };

    expect(mockInvoke).toHaveBeenCalledWith("download_requirement", {
      name: "yt-dlp",
      onEvent: args.onEvent,
    });
  });

  it("forwards requirement download progress to onEvent", async () => {
    const onEvent = vi.fn();
    await downloadRequirement("yt-dlp", onEvent);
    const args = mockInvoke.mock.calls.at(-1)?.[1] as {
      onEvent: { onmessage?: (event: PullEvent) => void };
    };
    const progress: PullEvent = {
      type: "progress",
      status: "downloading",
      digest: null,
      completed: 10,
      total: 100,
      percent: 10,
    };

    args.onEvent.onmessage?.(progress);

    expect(onEvent).toHaveBeenCalledWith(progress);
  });

  it("cancels the active requirement download", async () => {
    await cancelRequirementDownload();

    expect(mockInvoke).toHaveBeenCalledWith("cancel_requirement_download");
  });
});

describe("OpenRouter model menu wrappers", () => {
  it("loads the ranked model menu with the caller's refresh intent", async () => {
    const menu = {
      models: [],
      asOf: "2026-07-13",
      selectedModel: "openai/gpt-5",
      pinnedSelectedModel: "openai/gpt-5",
    };
    mockInvoke.mockResolvedValueOnce(menu);

    await expect(openRouterModelMenu(true)).resolves.toEqual(menu);
    expect(mockInvoke).toHaveBeenCalledWith("openrouter_model_menu", {
      forceRefresh: true,
    });
  });

  it("defaults model-menu reads to the native daily cache", async () => {
    await openRouterModelMenu();

    expect(mockInvoke).toHaveBeenCalledWith("openrouter_model_menu", {
      forceRefresh: false,
    });
  });

  it("selects only the exact model offered by the native catalogue", async () => {
    const status = { activeProvider: "openRouter" };
    mockInvoke.mockResolvedValueOnce(status);

    await expect(selectOpenRouterModel("anthropic/claude-sonnet-4")).resolves.toEqual(
      status,
    );
    expect(mockInvoke).toHaveBeenCalledWith("select_openrouter_model", {
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("opens the Rust-owned rankings URL without accepting a webview URL", async () => {
    await openOpenRouterRankings();

    expect(mockInvoke).toHaveBeenCalledWith("open_openrouter_rankings");
  });
});

describe("vault lifecycle wrappers", () => {
  it("quits only through the explicit confirmation command", async () => {
    await quitApp();
    expect(mockInvoke).toHaveBeenCalledWith("quit_app");
  });

  it("loads, saves, and resets vault workspace state through the typed IPC seam", async () => {
    const state = {
      openPaths: ["Ideas.md", "Projects/Plan.md"],
      activePath: "Projects/Plan.md",
    };
    const loaded = {
      state,
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    };
    mockInvoke.mockResolvedValueOnce(loaded);

    await expect(loadWorkspaceState()).resolves.toEqual(loaded);
    expect(mockInvoke).toHaveBeenCalledWith("load_workspace_state");

    await saveWorkspaceState(state);
    expect(mockInvoke).toHaveBeenCalledWith("save_workspace_state", { state });

    mockInvoke.mockResolvedValueOnce(loaded);
    await expect(resetWorkspaceState()).resolves.toEqual(loaded);
    expect(mockInvoke).toHaveBeenCalledWith("reset_workspace_state");
  });

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

  it("setMenuEditing forwards the editing flag", async () => {
    await setMenuEditing(true);
    expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: true });
    await setMenuEditing(false);
    expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: false });
  });
});

describe("tree + note wrappers", () => {
  it("readTree calls read_tree", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await readTree();
    expect(mockInvoke).toHaveBeenCalledWith("read_tree");
  });

  it("listDir lists the vault root with an empty path", async () => {
    const listing = { entries: [], truncated: null };
    mockInvoke.mockResolvedValueOnce(listing);
    await expect(listDir("")).resolves.toEqual(listing);
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "" });
  });

  it("listDir passes a nested folder's relPath and returns its listing", async () => {
    const listing = {
      entries: [
        {
          kind: "file",
          name: "note.md",
          path: "/v/Work/note.md",
          relPath: "Work/note.md",
          ext: "md",
          children: null,
        },
      ],
      truncated: 3,
    };
    mockInvoke.mockResolvedValueOnce(listing);
    await expect(listDir("Work")).resolves.toEqual(listing);
    expect(mockInvoke).toHaveBeenCalledWith("list_dir", { path: "Work" });
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

describe("backlinks + templates wrappers", () => {
  it("readBacklinks passes the path", async () => {
    mockInvoke.mockResolvedValueOnce({ linked: [], unlinked: [], skippedFiles: 0 });
    const out = await readBacklinks("/v/target.md");
    expect(mockInvoke).toHaveBeenCalledWith("read_backlinks", { path: "/v/target.md" });
    expect(out).toEqual({ linked: [], unlinked: [], skippedFiles: 0 });
  });

  it("listTemplates calls list_templates", async () => {
    mockInvoke.mockResolvedValueOnce([{ relPath: "Templates/Daily.md", name: "Daily" }]);
    const out = await listTemplates();
    expect(mockInvoke).toHaveBeenCalledWith("list_templates");
    expect(out).toEqual([{ relPath: "Templates/Daily.md", name: "Daily" }]);
  });

  it("createNoteFromTemplate passes parentPath, name, and template", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "file", name: "Daily.md" });
    await createNoteFromTemplate("/v", "Daily", "Templates/Daily.md");
    expect(mockInvoke).toHaveBeenCalledWith("create_note_from_template", {
      parentPath: "/v",
      name: "Daily",
      template: "Templates/Daily.md",
    });
  });

  it("createNoteFromTemplate passes null when creating a blank note", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "file", name: "Blank.md" });
    await createNoteFromTemplate("/v", "Blank", null);
    expect(mockInvoke).toHaveBeenCalledWith("create_note_from_template", {
      parentPath: "/v",
      name: "Blank",
      template: null,
    });
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

describe("onMenu", () => {
  it("subscribes to menu://action and forwards the event payload", async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValueOnce(unlisten);
    const cb = vi.fn();

    const returned = await onMenu(cb);

    expect(mockListen).toHaveBeenCalledWith(
      "menu://action",
      expect.any(Function),
    );
    expect(returned).toBe(unlisten);

    // The wrapper unwraps the Tauri envelope and hands the payload to the callback.
    const handler = mockListen.mock.calls.at(-1)![1] as (e: unknown) => void;
    handler({ payload: { action: "open-recent", path: "/vaults/Brain" } });
    expect(cb).toHaveBeenCalledWith({ action: "open-recent", path: "/vaults/Brain" });
  });
});
