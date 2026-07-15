// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MENU_ACTION } from "../lib/bindings/events";
import type { TreeNode } from "../lib/types";
import type { OpenNote } from "./useOpenNote";
import type { NoteTab, NoteTabsController } from "./useNoteTabs";

// Controllable store + open-note state, captured child props, and a fake Tauri
// window so the close-guard and navigation guards can be driven directly.
const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));
// The full-tree hook (useVaultTree) is its own concern with its own tests; stub
// it here so Workspace's note index / status counts / template picker read a
// controllable tree and the hook's own read_tree + tree-changed subscription
// don't run inside these Workspace unit tests.
const { fullTreeRef, refreshFullTreeMock } = vi.hoisted(() => ({
  fullTreeRef: { current: [] as TreeNode[] },
  refreshFullTreeMock: vi.fn(),
}));
const notification = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
}));
const openState = vi.hoisted(() => ({ current: null as unknown as OpenNote }));
const tabsState = vi.hoisted(() => ({
  current: null as unknown as NoteTabsController,
}));
const captured = vi.hoisted(() => ({
  fileTree: {} as Record<string, (...a: never[]) => void>,
  notePane: {} as Record<string, (...a: never[]) => void>,
  ribbon: {} as {
    navigationExpanded: boolean;
    vaultName: string;
    sidebarPanel: "files" | "search" | null;
    centerView: "note" | "graph";
    onShowFiles: () => void;
    onShowSearch: () => void;
    onInsertTemplate: () => void;
    onToggleGraph: () => void;
    onNewNote: () => void;
    onNewFolder: () => void;
    onRefresh: () => void;
    onCloseVault: () => void;
  },
  titlebar: {} as {
    navigationExpanded: boolean;
    onToggleNavigation: () => void;
    chatOpen: boolean;
    onToggleChat: () => void;
    onOpenSettings: () => void;
    tabs: Array<{ id: string; title: string; path: string; dirty: boolean }>;
    activeTabId: string | null;
    activeView: "note" | "graph";
    onActivateTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseGraph: () => void;
  },
  searchPanel: {} as { focusSignal: number; onOpen: (absPath: string) => void },
  graphView: {} as { onOpenNote: (relPath: string) => void },
  chatPane: {} as {
    openNoteAt: (absPath: string) => void;
    onOpenSettings: () => void;
    refreshSignal: number;
  },
  settingsModal: {} as { open: boolean; onClose: () => void; initialSection: string },
  templateDialog: {} as {
    open: boolean;
    templates: Array<{ relPath: string; name: string }>;
    onCreate: (template: string, name: string, parentPath: string) => void;
    onClose: () => void;
  },
}));
const win = vi.hoisted(() => {
  const state: { closeCb?: (e: { preventDefault: () => void }) => void } = {};
  return {
    state,
    destroy: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn((cb: (e: { preventDefault: () => void }) => void) => {
      state.closeCb = cb;
      return Promise.resolve(() => {});
    }),
  };
});

vi.mock("../lib/store", () => ({ useVault: mockUseVault }));
vi.mock("./useVaultTree", () => ({
  useVaultTree: () => ({ tree: fullTreeRef.current, refresh: refreshFullTreeMock }),
}));
vi.mock("../notifications", () => ({ useToast: () => notification }));
vi.mock("./useNoteTabs", () => ({ useNoteTabs: () => tabsState.current }));
// The Workspace subscribes to MENU_ACTION; mock the event bus so listen()
// resolves and tests can drive the registered handler directly.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const mockListen = vi.mocked(listen);
// The Workspace pushes edit-mode changes to the native menu via invoke; mock the
// command bus so those calls resolve and can be asserted.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
const mockInvoke = vi.mocked(invoke);

/** Invoke the latest MENU_ACTION handler the Workspace registered. */
function fireMenu(payload: {
  action: string;
  path?: string;
}) {
  const calls = mockListen.mock.calls.filter((c) => c[0] === MENU_ACTION);
  const handler = calls.at(-1)![1] as (e: { payload: unknown }) => void;
  act(() => handler({ payload }));
}
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: win.onCloseRequested,
    destroy: win.destroy,
  }),
}));
vi.mock("./FileTree", () => ({
  FileTree: (props: Record<string, (...a: never[]) => void>) => {
    captured.fileTree = props;
    return <div data-testid="filetree" />;
  },
}));
vi.mock("./NotePane", () => ({
  NotePane: (props: Record<string, (...a: never[]) => void>) => {
    captured.notePane = props;
    return <div data-testid="notepane" />;
  },
}));
vi.mock("./ChatPane", () => ({
  ChatPane: (props: {
    openNoteAt: (absPath: string) => void;
    onOpenSettings: () => void;
    refreshSignal: number;
  }) => {
    captured.chatPane = props;
    return (
      <div
        className="nn-chat-pane"
        data-testid="chatpane"
        data-refresh-signal={props.refreshSignal}
      />
    );
  },
}));
vi.mock("./SettingsModal", () => ({
  SettingsModal: (props: { open: boolean; onClose: () => void; initialSection: string }) => {
    captured.settingsModal = props;
    return props.open ? <div data-testid="settings-modal" /> : null;
  },
}));
vi.mock("./TemplateInsertDialog", () => ({
  TemplateInsertDialog: (props: {
    open: boolean;
    templates: Array<{ relPath: string; name: string }>;
    onCreate: (template: string, name: string, parentPath: string) => void;
    onClose: () => void;
  }) => {
    captured.templateDialog = props;
    return props.open ? <div data-testid="template-insert-dialog" /> : null;
  },
}));
vi.mock("./Ribbon", () => ({
  Ribbon: (props: Record<string, unknown>) => {
    captured.ribbon = props as typeof captured.ribbon;
    return <div data-testid="ribbon" />;
  },
}));
vi.mock("./TitleBar", () => ({
  GRAPH_PANEL_ID: "nn-graph-panel",
  GRAPH_TAB_ID: "nn-graph-tab",
  noteTabPanelId: (id: string) => `nn-note-panel-${id}`,
  noteTabTriggerId: (id: string) => `nn-note-tab-${id}`,
  TitleBar: (props: Record<string, unknown>) => {
    captured.titlebar = props as typeof captured.titlebar;
    return <div data-testid="titlebar" />;
  },
}));
vi.mock("./SearchPanel", () => ({
  SearchPanel: (props: { focusSignal: number; onOpen: (absPath: string) => void }) => {
    captured.searchPanel = props;
    return <div data-testid="searchpanel" data-focus-signal={props.focusSignal} />;
  },
}));
vi.mock("./GraphView", () => ({
  GraphView: (props: { onOpenNote: (relPath: string) => void }) => {
    captured.graphView = props;
    return <div data-testid="graphview" />;
  },
}));
vi.mock("./StatusBar", () => ({
  StatusBar: ({ vaultName }: { vaultName: string }) => (
    <div data-testid="statusbar">{vaultName}</div>
  ),
}));

import { Workspace } from "./Workspace";

const node = (path: string): TreeNode => ({
  kind: "file",
  name: path.split("/").pop()!,
  path,
  relPath: path.replace("/v/", ""),
  ext: "md",
  children: null,
});

function makeOpen(over: Partial<OpenNote> = {}): OpenNote {
  return {
    sessionKey: null,
    sessionHash: null,
    path: null,
    note: null,
    loading: false,
    error: null,
    draft: "",
    dirty: false,
    saving: false,
    saveError: null,
    preservationError: null,
    conflict: false,
    externalDeleted: false,
    open: vi.fn(),
    reload: vi.fn(),
    overwrite: vi.fn(),
    repath: vi.fn(),
    setDraft: vi.fn(),
    setPreservationError: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    ...over,
  };
}

function makeTabs(over: Partial<NoteTabsController> = {}): NoteTabsController {
  const currentTab = () => {
    const active = openState.current;
    return active.path
      ? {
          id: "tab-1",
          path: active.path,
          note: active.note,
          sessionHash: active.sessionHash,
          loading: active.loading,
          error: active.error,
          draft: active.draft,
          dirty: active.dirty,
          saving: active.saving,
          saveError: active.saveError,
          preservationError: active.preservationError,
          conflict: active.conflict,
          externalDeleted: active.externalDeleted,
          loadRevision: 1,
          saveRevision: 0,
        }
      : null;
  };
  return {
    get tabs() {
      const tab = currentTab();
      return tab ? [tab] : [];
    },
    get activeTabId() {
      return currentTab()?.id ?? null;
    },
    get activeTab() {
      return currentTab();
    },
    get active() {
      return openState.current;
    },
    get dirtyTabs() {
      const tab = currentTab();
      return tab?.dirty ? [tab] : [];
    },
    open: vi.fn(() => "tab-new"),
    activate: vi.fn(),
    close: vi.fn(),
    remap: vi.fn(),
    removeDescendants: vi.fn(),
    tabsInside: vi.fn(() => []),
    clear: vi.fn(),
    ...over,
  };
}

function makeTab(path: string, over: Partial<NoteTab> = {}): NoteTab {
  return {
    id: `tab:${path}`,
    path,
    note: {
      path,
      relPath: path.replace(/^\/v\//, ""),
      title: path.split("/").at(-1)?.replace(/\.md$/, "") ?? "Note",
      frontmatter: null,
      frontmatterRaw: null,
      frontmatterError: null,
      body: "body",
      raw: "body",
      contentHash: "hash",
      binary: false,
      lossyText: false,
    },
    sessionHash: "hash",
    loading: false,
    error: null,
    draft: "body",
    dirty: false,
    saving: false,
    saveError: null,
    preservationError: null,
    conflict: false,
    externalDeleted: false,
    loadRevision: 1,
    saveRevision: 0,
    ...over,
  };
}

function defaultInvoke(command: string) {
  if (command === "load_workspace_state" || command === "reset_workspace_state") {
    return Promise.resolve({
      state: { openPaths: [], activePath: null },
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    });
  }
  return Promise.resolve(undefined);
}

function vaultCtx(over: Record<string, unknown> = {}) {
  return {
    vault: { name: "MyVault", path: "/v" },
    // Lazy file-tree store surface (issue #40). Root is loaded (empty) so the
    // manual-refresh handler has a directory to re-list.
    loaded: new Map([["", { status: "loaded", children: [], truncated: null }]]),
    expanded: new Set<string>(),
    listDir: vi.fn().mockResolvedValue(undefined),
    toggle: vi.fn(),
    refreshDir: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    openExisting: vi.fn().mockResolvedValue(undefined),
    openByPath: vi.fn().mockResolvedValue(undefined),
    error: null as string | null,
    clearError: vi.fn(),
    reportError: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockUseVault.mockReset();
  fullTreeRef.current = [];
  refreshFullTreeMock.mockReset();
  Object.values(notification).forEach((mock) => mock.mockReset());
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((command) => defaultInvoke(String(command)));
  win.state.closeCb = undefined;
  win.destroy.mockClear();
  win.onCloseRequested.mockClear();
  openState.current = makeOpen();
  tabsState.current = makeTabs();
  globalThis.localStorage?.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Workspace — shell", () => {
  it("renders nothing until a vault is present", () => {
    mockUseVault.mockReturnValue(vaultCtx({ vault: null }));
    const { container } = render(<Workspace />);
    expect(container.firstChild).toBeNull();
  });

  it("routes lifecycle failures through the app notification service", async () => {
    const ctx = vaultCtx({ error: "lifecycle boom" });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.getByTestId("statusbar")).toHaveTextContent("MyVault");
    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith("lifecycle boom", {
        dedupKey: "vault-error:lifecycle boom",
      }),
    );
    expect(ctx.clearError).toHaveBeenCalledOnce();
  });

  it("clears tabs from the previous vault before restoring the next vault", async () => {
    let ctx = vaultCtx();
    mockUseVault.mockImplementation(() => ctx);
    const { rerender } = render(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("load_workspace_state"),
    );

    ctx = vaultCtx({ vault: { name: "Other", path: "/other" } });
    rerender(<Workspace />);

    expect(tabsState.current.clear).toHaveBeenCalledOnce();
  });

  it("does not let a stale recovery action reset the next vault", async () => {
    let ctx = vaultCtx();
    let loadCount = 0;
    mockUseVault.mockImplementation(() => ctx);
    mockInvoke.mockImplementation((command) => {
      if (command === "load_workspace_state") {
        loadCount += 1;
        return Promise.resolve(
          loadCount === 1
            ? {
                state: { openPaths: [], activePath: null },
                recoveredFromCorrupt: true,
                recoveryMessage: "bad state",
              }
            : {
                state: { openPaths: [], activePath: null },
                recoveredFromCorrupt: false,
                recoveryMessage: null,
              },
        );
      }
      return defaultInvoke(String(command));
    });
    const { rerender } = render(<Workspace />);
    await waitFor(() => expect(notification.error).toHaveBeenCalledWith(
      "bad state",
      expect.objectContaining({ dedupKey: "workspace-state-recovery" }),
    ));
    const options = notification.error.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void };
    };

    ctx = vaultCtx({ vault: { name: "Other", path: "/other" } });
    rerender(<Workspace />);
    act(() => options.action.onClick());
    await Promise.resolve();

    expect(mockInvoke).not.toHaveBeenCalledWith("reset_workspace_state");
  });
});

describe("Workspace — note index + rel-path opener threading", () => {
  it("builds the note index from the tree and passes it to the note pane", () => {
    // The note index is built from the FULL vault tree (useVaultTree), not the
    // lazy display subset.
    fullTreeRef.current = [node("/v/Target.md")];
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect((captured.notePane as { noteIndex?: unknown }).noteIndex).toEqual([
      { relPath: "Target.md", stem: "target" },
    ]);
  });

  it("opens wikilink/backlink targets through the tab controller", async () => {
    mockUseVault.mockReturnValue(vaultCtx({ tree: [node("/v/Target.md")] }));
    render(<Workspace />);
    const { onOpenLink } = captured.notePane as unknown as {
      onOpenLink: (rel: string) => void;
    };
    await act(async () => onOpenLink("Target.md"));
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/Target.md", {
      forceNew: false,
    });
  });

  it("preserves a dirty tab while opening a wikilink without a discard prompt", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx({ tree: [node("/v/Target.md")] }));
    render(<Workspace />);
    const { onOpenLink } = captured.notePane as unknown as {
      onOpenLink: (rel: string) => void;
    };
    await act(async () => onOpenLink("Target.md"));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/Target.md", {
      forceNew: false,
    });
  });
});

describe("Workspace — selection guard", () => {
  it("ignores reselecting the already-open note", async () => {
    openState.current = makeOpen({ path: "/v/a.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onSelect("/v/a.md" as never, false as never));
    expect(tabsState.current.open).not.toHaveBeenCalled();
  });

  it("opens a different note directly when the buffer is clean", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onSelect("/v/b.md" as never, false as never));
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/b.md", {
      forceNew: false,
    });
  });

  it("opens from a dirty active tab without prompting", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.fileTree.onSelect("/v/b.md" as never, false as never));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/b.md", {
      forceNew: false,
    });
  });

  it("threads Command-click as a forced new-tab request", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.fileTree.onSelect("/v/b.md" as never, true as never));
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/b.md", {
      forceNew: true,
    });
  });
});

describe("Workspace — deletion sync", () => {
  it("deletes then removes every affected tab after confirmation", async () => {
    const ctx = vaultCtx();
    const affected = makeTab("/v/Notes/a.md", { dirty: true });
    tabsState.current = makeTabs({
      tabs: [affected],
      activeTabId: affected.id,
      activeTab: affected,
      dirtyTabs: [affected],
      tabsInside: vi.fn(() => [affected]),
    });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    act(() => captured.fileTree.onDeleteRequest(node("/v/Notes") as never));
    expect(screen.getByText("Delete note?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("delete_entry", { path: "/v/Notes" }),
    );
    // The deleted entry's parent folder is re-listed (relPath "Notes" → parent "").
    expect(ctx.refreshDir).toHaveBeenCalledWith("");
    expect(tabsState.current.removeDescendants).toHaveBeenCalledWith("/v/Notes");
  });

  it("does not remove tabs when deletion is cancelled", async () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.fileTree.onDeleteRequest(node("/v/Notes") as never));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_entry", expect.anything());
    expect(tabsState.current.removeDescendants).not.toHaveBeenCalled();
  });
});

describe("Workspace — rename/move remap", () => {
  it("remaps all affected tabs for a clean rename", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, node("/v/b.md") as never),
    );
    expect(tabsState.current.remap).toHaveBeenCalledWith("/v/a.md", "/v/b.md", "b.md");
  });

  it("repaths in place (preserving the buffer) when dirty", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const renamed: TreeNode = { ...node("/v/b.md"), relPath: "b.md" };
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, renamed as never),
    );
    expect(tabsState.current.remap).toHaveBeenCalledWith("/v/a.md", "/v/b.md", "b.md");
  });

  it("ignores a remap that does not affect the open note", async () => {
    openState.current = makeOpen({ path: "/v/a.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/other" as never, node("/v/moved") as never),
    );
    expect(tabsState.current.remap).toHaveBeenCalledWith(
      "/v/other",
      "/v/moved",
      "moved",
    );
  });

  it("does nothing when no note is open", async () => {
    openState.current = makeOpen({ path: null });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, node("/v/b.md") as never),
    );
    expect(tabsState.current.remap).toHaveBeenCalledWith("/v/a.md", "/v/b.md", "b.md");
  });
});

describe("Workspace — close vault + close note", () => {
  it("closes the vault directly when clean", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    await act(async () => captured.ribbon.onCloseVault());
    expect(ctx.close).toHaveBeenCalled();
  });

  it("guards close-vault behind the discard dialog when dirty", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    await act(async () => captured.ribbon.onCloseVault());
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(ctx.close).toHaveBeenCalled();
  });

  it("closes the requested titlebar tab directly when clean", async () => {
    const tab = makeTab("/v/a.md");
    tabsState.current = makeTabs({
      tabs: [tab],
      activeTabId: tab.id,
      activeTab: tab,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseTab(tab.id));
    expect(tabsState.current.close).toHaveBeenCalledWith(tab.id);
  });

  it("moves focus to the selected neighbour after closing a focused tab", async () => {
    const first = makeTab("/v/a.md", { id: "first" });
    const next = makeTab("/v/b.md", { id: "next" });
    tabsState.current = makeTabs({
      tabs: [first, next],
      activeTabId: first.id,
      activeTab: first,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const nextTrigger = document.createElement("button");
    nextTrigger.id = "nn-note-tab-next";
    document.body.append(nextTrigger);

    await act(async () => captured.titlebar.onCloseTab(first.id));
    await waitFor(() => expect(nextTrigger).toHaveFocus());
    nextTrigger.remove();
  });

  it("moves focus to the empty note panel after closing the last tab", async () => {
    const only = makeTab("/v/a.md", { id: "only" });
    tabsState.current = makeTabs({
      tabs: [only],
      activeTabId: only.id,
      activeTab: only,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const emptyPanel = document.createElement("div");
    emptyPanel.id = "nn-empty-note-panel";
    emptyPanel.tabIndex = -1;
    document.body.append(emptyPanel);

    await act(async () => captured.titlebar.onCloseTab(only.id));
    await waitFor(() => expect(emptyPanel).toHaveFocus());
    emptyPanel.remove();
  });

  it("guards only the requested dirty titlebar tab", async () => {
    const tab = makeTab("/v/a.md", { dirty: true, draft: "edited" });
    tabsState.current = makeTabs({
      tabs: [tab],
      activeTabId: tab.id,
      activeTab: tab,
      dirtyTabs: [tab],
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseTab(tab.id));
    expect(tabsState.current.close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(tabsState.current.close).toHaveBeenCalledWith(tab.id);
  });
});

describe("Workspace — view state (sidebar panel + center view)", () => {
  it("loads templates from the ribbon and creates then opens the chosen note", async () => {
    const ctx = vaultCtx();
    mockUseVault.mockReturnValue(ctx);
    mockInvoke.mockImplementation((command) => {
      if (command === "list_templates") {
        return Promise.resolve([
          { relPath: "Templates/Daily.md", name: "Daily" },
        ]);
      }
      if (command === "create_note_from_template") {
        return Promise.resolve(node("/v/Journal.md"));
      }
      return defaultInvoke(String(command));
    });
    render(<Workspace />);

    await act(async () => captured.ribbon.onInsertTemplate());
    expect(screen.getByTestId("template-insert-dialog")).toBeInTheDocument();
    expect(captured.templateDialog.templates).toEqual([
      { relPath: "Templates/Daily.md", name: "Daily" },
    ]);

    await act(async () =>
      captured.templateDialog.onCreate(
        "Templates/Daily.md",
        "Journal.md",
        "/v",
      ),
    );
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("create_note_from_template", {
        parentPath: "/v",
        name: "Journal.md",
        template: "Templates/Daily.md",
      }),
    );
    expect(ctx.refreshDir).toHaveBeenCalledWith(""); // destination folder re-listed
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/Journal.md", {
      forceNew: false,
    });
  });

  it("creates from a template without discarding a dirty background draft", async () => {
    openState.current = makeOpen({ path: "/v/Draft.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    mockInvoke.mockImplementation((command) => {
      if (command === "list_templates") {
        return Promise.resolve([{ relPath: "Templates/Daily.md", name: "Daily" }]);
      }
      if (command === "create_note_from_template") {
        return Promise.resolve(node("/v/Journal.md"));
      }
      return defaultInvoke(String(command));
    });
    render(<Workspace />);

    await act(async () => captured.ribbon.onInsertTemplate());
    await act(async () =>
      captured.templateDialog.onCreate(
        "Templates/Daily.md",
        "Journal.md",
        "/v",
      ),
    );
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "create_note_from_template",
        expect.anything(),
      ),
    );
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(tabsState.current.open).toHaveBeenCalledWith("/v/Journal.md", {
        forceNew: false,
      }),
    );
  });

  it("keeps both sidebar panels mounted while the ribbon swaps and collapses them", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();
    expect(screen.getByTestId("filetree").parentElement).not.toHaveAttribute(
      "hidden",
    );
    expect(screen.getByTestId("searchpanel").parentElement).toHaveAttribute(
      "hidden",
    );

    act(() => captured.ribbon.onShowSearch());
    expect(captured.ribbon.sidebarPanel).toBe("search");
    expect(screen.getByTestId("searchpanel").parentElement).not.toHaveAttribute(
      "hidden",
    );
    expect(screen.getByTestId("filetree").parentElement).toHaveAttribute(
      "hidden",
    );

    act(() => captured.ribbon.onShowSearch());
    expect(captured.ribbon.sidebarPanel).toBeNull();
    expect(screen.getByTestId("searchpanel").parentElement).toHaveAttribute(
      "hidden",
    );
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowFiles());
    expect(captured.ribbon.sidebarPanel).toBe("files");
    expect(screen.getByTestId("filetree").parentElement).not.toHaveAttribute(
      "hidden",
    );
  });

  it("toggles the center pane between note and graph via the ribbon", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("notepane")).toBeInTheDocument();

    act(() => captured.ribbon.onToggleGraph());
    expect(screen.getByTestId("graphview")).toBeInTheDocument();
    expect(screen.queryByTestId("notepane")).not.toBeInTheDocument();

    act(() => captured.ribbon.onToggleGraph());
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
    expect(screen.queryByTestId("graphview")).not.toBeInTheDocument();
  });

  it("the search menu action opens the search panel and bumps the focus signal", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    // Find in Vault (⌘K) is a menu accelerator now; the action opens the panel.
    fireMenu({ action: "search" });
    expect(screen.getByTestId("searchpanel")).toHaveAttribute(
      "data-focus-signal",
      "1",
    );

    // Each Find action keeps bumping the focus signal.
    fireMenu({ action: "search" });
    expect(screen.getByTestId("searchpanel")).toHaveAttribute(
      "data-focus-signal",
      "2",
    );
    expect(captured.ribbon.sidebarPanel).toBe("search");
  });

  // Menu actions the e2e journey doesn't cover (open-recent, new-note,
  // view-search, toggle-graph and toggle-chat live in menubar.e2e). These need
  // the open-note / store state that the mocked children make easy to assert.
  it("the save action saves the open note when it is dirty", () => {
    openState.current = makeOpen({
      path: "/v/a.md",
      note: { binary: false } as unknown as OpenNote["note"],
      dirty: true,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "save" });
    expect(openState.current.save).toHaveBeenCalledTimes(1);
  });

  it("the save action is a no-op when the note is clean", () => {
    openState.current = makeOpen({
      path: "/v/a.md",
      note: { binary: false } as unknown as OpenNote["note"],
      dirty: false,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "save" });
    expect(openState.current.save).not.toHaveBeenCalled();
  });

  it("tells the native menu to enable Format whenever a text note is open", async () => {
    mockUseVault.mockReturnValue(vaultCtx());
    // Read mode (no note): Format disabled.
    openState.current = makeOpen();
    const { rerender } = render(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: false }),
    );

    // A text note is editable in place without a separate mode: Format enabled.
    mockInvoke.mockClear();
    openState.current = makeOpen({
      path: "/v/a.md",
      note: { binary: false } as unknown as OpenNote["note"],
    });
    rerender(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: true }),
    );

    // A binary attachment has no editable text: Format stays disabled.
    mockInvoke.mockClear();
    openState.current = makeOpen({
      path: "/v/img.png",
      note: { binary: true } as unknown as OpenNote["note"],
    });
    rerender(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: false }),
    );
  });

  it("the close-vault action closes when there are no unsaved edits", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    fireMenu({ action: "close-vault" });
    await waitFor(() => expect(ctx.close).toHaveBeenCalled());
  });

  it("the toggle-graph action swaps the center pane to the graph and back", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("notepane")).toBeInTheDocument();

    fireMenu({ action: "toggle-graph" });
    expect(screen.getByTestId("graphview")).toBeInTheDocument();
    expect(screen.queryByTestId("notepane")).not.toBeInTheDocument();

    fireMenu({ action: "toggle-graph" });
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
  });

  it("view-files shows the files sidebar and a clean Open Vault reaches the store", async () => {
    const ctx = vaultCtx();
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    fireMenu({ action: "search" });
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();

    fireMenu({ action: "view-files" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();

    fireMenu({ action: "open-vault" });
    await waitFor(() => expect(ctx.openExisting).toHaveBeenCalled());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
  });

  it("ignores a plain K press without a modifier", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => {
      fireEvent.keyDown(window, { key: "k" });
    });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.getByTestId("searchpanel").parentElement).toHaveAttribute(
      "hidden",
    );
  });

  it("opens a search result through the guard and lands in note view", () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onShowSearch());
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.searchPanel.onOpen("/v/b.md"));
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/b.md", {
      forceNew: false,
    });
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
    expect(screen.queryByTestId("graphview")).not.toBeInTheDocument();
  });

  it("opens a graph target without discarding the dirty active tab", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.graphView.onOpenNote("b.md"));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/b.md", {
      forceNew: false,
    });
  });

  it("joins the vault path for a graph open and returns to note view", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.graphView.onOpenNote("Notes/b.md"));
    expect(tabsState.current.open).toHaveBeenCalledWith("/v/Notes/b.md", {
      forceNew: false,
    });
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
  });
});

describe("Workspace — settings modal", () => {
  it("offers template settings when insertion finds no templates", async () => {
    mockUseVault.mockReturnValue(vaultCtx());
    mockInvoke.mockImplementation((command) =>
      command === "list_templates" ? Promise.resolve([]) : Promise.resolve(),
    );
    render(<Workspace />);

    await act(() => captured.ribbon.onInsertTemplate());
    expect(notification.warning).toHaveBeenCalledWith("No templates found", {
      dedupKey: "no-templates",
      action: expect.objectContaining({ label: "Open template settings" }),
    });
    const options = notification.warning.mock.calls[0][1];
    act(() => options.action.onClick());
    expect(captured.settingsModal.initialSection).toBe("templates");
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
  });

  it("opens from the titlebar cog and closes back", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();

    // Settings moved off the ribbon onto the titlebar in the overlay-titlebar cut.
    act(() => captured.titlebar.onOpenSettings());
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    expect(captured.settingsModal.initialSection).toBe("whatsNew");

    act(() => captured.settingsModal.onClose());
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
  });

  it("opens from the chat pane, and bumps its refresh signal on close", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("chatpane")).toHaveAttribute("data-refresh-signal", "0");

    act(() => captured.chatPane.onOpenSettings());
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    expect(captured.settingsModal.initialSection).toBe("ai");

    // Closing settings must poke the chat pane to re-read the AI status — a
    // provider configured in the modal has to reach the docked pane.
    act(() => captured.settingsModal.onClose());
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("chatpane")).toHaveAttribute("data-refresh-signal", "1");
  });
});

describe("Workspace — titlebar + sidebar", () => {
  it("passes the vault identity to navigation and note-tab summaries to the titlebar", () => {
    const a = makeTab("/v/A.md", { dirty: true, draft: "edited" });
    const b = makeTab("/v/B.md", { loading: true, note: null });
    tabsState.current = makeTabs({
      tabs: [a, b],
      activeTabId: a.id,
      activeTab: a,
      dirtyTabs: [a],
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(captured.ribbon.vaultName).toBe("MyVault");
    expect(captured.ribbon.navigationExpanded).toBe(true);
    expect(captured.titlebar.navigationExpanded).toBe(true);
    expect(captured.titlebar.chatOpen).toBe(true);
    expect(captured.titlebar.tabs).toEqual([
      expect.objectContaining({ id: a.id, title: "A", path: "/v/A.md", dirty: true }),
      expect.objectContaining({ id: b.id, title: "B", path: "/v/B.md", loading: true }),
    ]);
    expect(captured.titlebar.activeTabId).toBe(a.id);
    expect(captured.titlebar.activeView).toBe("note");
  });

  it("activates a note tab and exits graph view", () => {
    const tab = makeTab("/v/A.md");
    tabsState.current = makeTabs({ tabs: [tab], activeTabId: tab.id, activeTab: tab });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());
    expect(captured.titlebar.activeView).toBe("graph");

    act(() => captured.titlebar.onActivateTab(tab.id));
    expect(tabsState.current.activate).toHaveBeenCalledWith(tab.id);
    expect(captured.titlebar.activeView).toBe("note");
  });

  it("keeps both secondary panes mounted in the compact workspace", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const panes = screen.getByTestId("workspace-panes");
    expect(panes).toContainElement(screen.getByTestId("filetree"));
    expect(panes).toContainElement(screen.getByTestId("chatpane"));
  });

  it("compacts navigation without unmounting the active file pane", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const fileTree = screen.getByTestId("filetree");

    act(() => captured.titlebar.onToggleNavigation());
    expect(captured.titlebar.navigationExpanded).toBe(false);
    expect(captured.ribbon.navigationExpanded).toBe(false);
    expect(screen.getByTestId("filetree")).toBe(fileTree);

    act(() => captured.titlebar.onToggleNavigation());
    expect(captured.titlebar.navigationExpanded).toBe(true);
    expect(screen.getByTestId("filetree")).toBe(fileTree);
  });

  it("toggles navigation from the compatible menu action without hiding Files", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const fileTree = screen.getByTestId("filetree");

    fireMenu({ action: "toggle-sidebar" });
    expect(captured.titlebar.navigationExpanded).toBe(false);
    expect(screen.getByTestId("filetree")).toBe(fileTree);

    fireMenu({ action: "toggle-sidebar" });
    expect(captured.titlebar.navigationExpanded).toBe(true);
    expect(screen.getByTestId("filetree")).toBe(fileTree);
  });

  it("keeps compact navigation when selecting Files", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.titlebar.onToggleNavigation());

    act(() => captured.ribbon.onShowFiles());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(captured.titlebar.navigationExpanded).toBe(false);
  });

  it("keeps compact navigation when selecting Search", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.titlebar.onToggleNavigation());

    act(() => captured.ribbon.onShowSearch());
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();
    expect(captured.titlebar.navigationExpanded).toBe(false);
  });

  it("renders a semantic splitter and aligns shared layout variables", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    const panes = screen.getByTestId("workspace-panes");
    const sidebar = screen
      .getByTestId("filetree")
      .closest("#nn-primary-sidebar");
    expect(sidebar).toHaveAttribute("id", "nn-primary-sidebar");
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-controls",
      "nn-primary-sidebar",
    );
    expect(panes.parentElement).toHaveStyle({
      "--navigation-width": "192px",
      "--sidebar-width": "296px",
      "--splitter-width": "8px",
    });
  });

  it("collapses and restores the preferred sidebar width from Files", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--sidebar-width": "304px",
    });

    act(() => captured.ribbon.onShowFiles());
    expect(captured.ribbon.sidebarPanel).toBeNull();
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--sidebar-width": "0px",
      "--splitter-width": "0px",
    });
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowFiles());
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--sidebar-width": "304px",
      "--splitter-width": "8px",
    });
  });

  it("resizes the primary pane without remounting note or chat content", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const notePane = screen.getByTestId("notepane");
    const chatPane = screen.getByTestId("chatpane");

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--sidebar-width": "304px",
    });
    expect(screen.getByTestId("notepane")).toBe(notePane);
    expect(screen.getByTestId("chatpane")).toBe(chatPane);
  });

  it("resizes the primary pane without remounting the active graph", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());
    const graph = screen.getByTestId("graphview");

    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(screen.getByTestId("graphview")).toBe(graph);
  });

  it("auto-compacts for the measured chat width without overwriting expansion preference", () => {
    let workspaceWidth = 920;
    let chatSlotWidth = 0;
    let navigationWidth = 192;
    const chatTargetWidth = 324;
    let resizeCallback: ResizeObserverCallback | undefined;
    class ControlledResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.matches('[data-testid="workspace-panes"]')
          ? workspaceWidth
          : this.matches(".nn-chat-slot")
            ? chatSlotWidth
            : this.matches(".nn-chat-pane")
              ? chatTargetWidth
              : this.matches(".nn-ribbon")
                ? navigationWidth
                : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 0,
          left: 0,
          width,
          height: 0,
          toJSON: () => ({}),
        };
      },
    );

    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const fileTree = screen.getByTestId("filetree");
    const notePane = screen.getByTestId("notepane");
    const chatPane = screen.getByTestId("chatpane");

    expect(captured.titlebar.navigationExpanded).toBe(false);
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--navigation-width": "56px",
      "--sidebar-width": "296px",
    });

    chatSlotWidth = 324;
    navigationWidth = 56;
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--navigation-width": "56px",
      "--sidebar-width": "292px",
    });

    act(() => captured.titlebar.onToggleNavigation());
    workspaceWidth = 1_200;
    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(captured.titlebar.navigationExpanded).toBe(true);
    expect(screen.getByTestId("workspace-panes").parentElement).toHaveStyle({
      "--navigation-width": "192px",
      "--sidebar-width": "296px",
    });
    expect(screen.getByTestId("filetree")).toBe(fileTree);
    expect(screen.getByTestId("notepane")).toBe(notePane);
    expect(screen.getByTestId("chatpane")).toBe(chatPane);
  });

  it("flips chat visibility from the titlebar toggle", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(captured.titlebar.chatOpen).toBe(true);
    const chatPane = screen.getByTestId("chatpane");
    const chatSlot = chatPane.parentElement;

    act(() => captured.titlebar.onToggleChat());
    expect(captured.titlebar.chatOpen).toBe(false);
    expect(screen.getByTestId("chatpane")).toBe(chatPane);
    expect(chatSlot).toHaveAttribute("data-visible", "false");
    expect(chatSlot).toHaveAttribute("aria-hidden", "true");
    expect(chatSlot).toHaveAttribute("inert");
    expect(chatSlot).not.toHaveAttribute("hidden");
  });

  it("syncs titlebar chat visibility changes to the native menu checkmark", async () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_chat_visible", { visible: true }),
    );

    mockInvoke.mockClear();
    act(() => captured.titlebar.onToggleChat());
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_chat_visible", { visible: false }),
    );
  });

  it("flips chat visibility on a bare toggle-chat menu action", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(captured.titlebar.chatOpen).toBe(true);

    // The CheckMenuItem no longer carries a `checked` payload — a bare action
    // just requests a flip, and the webview owns the resulting value.
    fireMenu({ action: "toggle-chat" });
    expect(captured.titlebar.chatOpen).toBe(false);
  });

  it("switches to Files when New Note fires from the menu without changing navigation", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "toggle-sidebar" });
    act(() => captured.ribbon.onShowSearch());
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();

    fireMenu({ action: "new-note" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(captured.titlebar.navigationExpanded).toBe(false);
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("note");
  });

  it("starts New Note from the navigation vault menu", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    act(() => captured.ribbon.onNewNote());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("note");
  });

  it("starts New Folder from the navigation vault menu", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    act(() => captured.ribbon.onNewFolder());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("folder");
  });
});

describe("Workspace — OS close guard", () => {
  it("quits a clean workspace through the explicit native command", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "quit-app" });

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("quit_app"));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
  });

  it("cancels native Quit without exiting when a tab is dirty", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "quit-app" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockInvoke).not.toHaveBeenCalledWith("quit_app");
  });

  it("flushes pending workspace state before confirmed native Quit", async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockInvoke.mockImplementation((command) => {
      if (command === "load_workspace_state") return defaultInvoke(String(command));
      if (command === "save_workspace_state") return savePending;
      return Promise.resolve(undefined);
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_workspace_state",
        expect.any(Object),
      ),
    );

    fireMenu({ action: "quit-app" });
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(mockInvoke).not.toHaveBeenCalledWith("quit_app");

    resolveSave();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("quit_app"));
  });

  it("does not replace or duplicate an in-flight dirty Quit request", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "quit-app" });
    fireMenu({ action: "quit-app" });
    expect(screen.getAllByText("Discard unsaved changes?")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("quit_app"));
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "quit_app"),
    ).toHaveLength(1);
  });

  it("registers an onCloseRequested handler", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(win.onCloseRequested).toHaveBeenCalled();
    expect(typeof win.state.closeCb).toBe("function");
  });

  it("holds a clean close long enough to flush state, then destroys the window", async () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const event = { preventDefault: vi.fn() };
    act(() => win.state.closeCb!(event));
    expect(event.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(win.destroy).toHaveBeenCalled());
  });

  it("holds a dirty window open, then destroys it on discard", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    const event = { preventDefault: vi.fn() };
    act(() => win.state.closeCb!(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(win.destroy).toHaveBeenCalled();
  });

  it("surfaces a failure to install the close guard through the app", async () => {
    win.onCloseRequested.mockReturnValueOnce(
      Promise.reject(new Error("no window bus")),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = vaultCtx();
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    await waitFor(() =>
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.stringContaining("unsaved-changes guard"),
      ),
    );
  });
});

describe("Workspace — workspace-state persistence failures", () => {
  it("surfaces a workspace-state save failure without losing edits", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockInvoke.mockImplementation((command) => {
      if (command === "save_workspace_state") {
        return Promise.reject(new Error("disk full"));
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dedupKey: "workspace-state-save" }),
      ),
    );
  });

  it("restores previously open tabs by relative path on load", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "load_workspace_state") {
        return Promise.resolve({
          state: { openPaths: ["Note.md"], activePath: "Note.md" },
          recoveredFromCorrupt: false,
          recoveryMessage: null,
        });
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(tabsState.current.open).toHaveBeenCalledWith("/v/Note.md", {
        forceNew: true,
      }),
    );
  });

  it("resets corrupt tab state and re-persists when the recovery action is taken", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "load_workspace_state") {
        return Promise.resolve({
          state: { openPaths: [], activePath: null },
          recoveredFromCorrupt: true,
          recoveryMessage: "tab state unreadable",
        });
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(
        "tab state unreadable",
        expect.objectContaining({ dedupKey: "workspace-state-recovery" }),
      ),
    );
    const options = notification.error.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void };
    };
    await act(async () => options.action.onClick());

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("reset_workspace_state"),
    );
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_workspace_state",
        expect.any(Object),
      ),
    );
  });

  it("reports a failed recovery reset", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "load_workspace_state") {
        return Promise.resolve({
          state: { openPaths: [], activePath: null },
          recoveredFromCorrupt: true,
          recoveryMessage: "tab state unreadable",
        });
      }
      if (command === "reset_workspace_state") {
        return Promise.reject(new Error("still unreadable"));
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(
        "tab state unreadable",
        expect.objectContaining({ dedupKey: "workspace-state-recovery" }),
      ),
    );
    const options = notification.error.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void };
    };
    await act(async () => options.action.onClick());

    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dedupKey: "workspace-state-reset" }),
      ),
    );
  });
});

describe("Workspace — menu action + intent failures", () => {
  it("reports a failure to subscribe to native menu actions", async () => {
    mockListen.mockReturnValueOnce(Promise.reject(new Error("no menu bus")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = vaultCtx();
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    await waitFor(() =>
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.stringContaining("Menu actions are unavailable"),
      ),
    );
  });

  it("logs but tolerates a failed editor-state menu sync", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockImplementation((command) => {
      if (command === "set_menu_editing") {
        return Promise.reject(new Error("menu offline"));
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("editor state"),
        expect.any(Error),
      ),
    );
  });

  it("logs but tolerates a failed chat-visibility menu sync", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockImplementation((command) => {
      if (command === "set_chat_visible") {
        return Promise.reject(new Error("menu offline"));
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("chat visibility"),
        expect.any(Error),
      ),
    );
  });

  it("starts a new folder from the menu", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "new-folder" });
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("folder");
  });

  it("closes the active tab from the menu when clean", async () => {
    const tab = makeTab("/v/a.md");
    tabsState.current = makeTabs({
      tabs: [tab],
      activeTabId: tab.id,
      activeTab: tab,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "close-tab" });
    await waitFor(() =>
      expect(tabsState.current.close).toHaveBeenCalledWith(tab.id),
    );
  });

  it("closes the window from the menu and logs a rejected destroy", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    win.destroy.mockRejectedValueOnce(new Error("cannot destroy"));
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "close-window" });
    await waitFor(() => expect(win.destroy).toHaveBeenCalled());
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("window destroy failed"),
        expect.any(Error),
      ),
    );
  });

  it("opens a recent vault from the menu when clean", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    fireMenu({ action: "open-recent", path: "/other/vault" });
    await waitFor(() =>
      expect(ctx.openByPath).toHaveBeenCalledWith("/other/vault"),
    );
  });

  it("ignores an unrecognised menu action", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "definitely-not-a-real-action" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
  });

  it("reports a failure to quit the app", async () => {
    openState.current = makeOpen({ dirty: false });
    mockInvoke.mockImplementation((command) => {
      if (command === "quit_app") return Promise.reject(new Error("quit blocked"));
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "quit-app" });
    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dedupKey: "quit-app-failed" }),
      ),
    );
  });

  it("reports a failed deletion after confirmation", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "delete_entry") return Promise.reject(new Error("locked"));
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.fileTree.onDeleteRequest(node("/v/Notes") as never));
    await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

    await waitFor(() =>
      expect(notification.error).toHaveBeenCalledWith(expect.stringMatching(/locked/i)),
    );
    expect(tabsState.current.removeDescendants).not.toHaveBeenCalled();
  });

  it("refreshes the tree from the navigation vault menu", async () => {
    const ctx = vaultCtx();
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    await act(async () => captured.ribbon.onRefresh());
    // Manual refresh re-lists every loaded directory (here just the root)…
    expect(ctx.refreshDir).toHaveBeenCalledWith("");
    // …and re-reads the whole-vault tree, so the wikilink index / counts / picker
    // don't stay stale when the disk watcher is the very thing that's broken.
    expect(refreshFullTreeMock).toHaveBeenCalled();
  });

  it("reports a failure to list templates for insertion", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "list_templates") return Promise.reject(new Error("no templates dir"));
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.ribbon.onInsertTemplate());
    expect(notification.error).toHaveBeenCalledWith(
      expect.stringMatching(/no templates dir/i),
    );
  });

  it("reports and does not open when template creation fails", async () => {
    const ctx = vaultCtx();
    mockInvoke.mockImplementation((command) => {
      if (command === "list_templates") {
        return Promise.resolve([{ relPath: "Templates/Daily.md", name: "Daily" }]);
      }
      if (command === "create_note_from_template") {
        return Promise.reject(new Error("template invalid"));
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    await act(async () => captured.ribbon.onInsertTemplate());
    await act(async () =>
      captured.templateDialog.onCreate("Templates/Daily.md", "Journal.md", "/v"),
    );

    await waitFor(() =>
      expect(ctx.reportError).toHaveBeenCalledWith(
        expect.stringMatching(/template invalid/i),
      ),
    );
    expect(tabsState.current.open).not.toHaveBeenCalled();
  });

  it("dismisses the template insert dialog on request", async () => {
    mockInvoke.mockImplementation((command) => {
      if (command === "list_templates") {
        return Promise.resolve([{ relPath: "Templates/Daily.md", name: "Daily" }]);
      }
      return defaultInvoke(String(command));
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.ribbon.onInsertTemplate());
    expect(screen.getByTestId("template-insert-dialog")).toBeInTheDocument();

    act(() => captured.templateDialog.onClose());
    expect(screen.queryByTestId("template-insert-dialog")).not.toBeInTheDocument();
  });
});
