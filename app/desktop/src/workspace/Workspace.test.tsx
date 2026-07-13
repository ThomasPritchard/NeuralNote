import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MENU_ACTION } from "../lib/bindings/events";
import type { TreeNode } from "../lib/types";
import type { OpenNote } from "./useOpenNote";

// Controllable store + open-note state, captured child props, and a fake Tauri
// window so the close-guard and navigation guards can be driven directly.
const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));
const openState = vi.hoisted(() => ({ current: null as unknown as OpenNote }));
const captured = vi.hoisted(() => ({
  fileTree: {} as Record<string, (...a: never[]) => void>,
  notePane: {} as Record<string, (...a: never[]) => void>,
  ribbon: {} as Record<string, (...a: never[]) => void>,
  titlebar: {} as {
    vaultName: string;
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    chatOpen: boolean;
    onToggleChat: () => void;
    onOpenSettings: () => void;
    note: unknown;
    noteDirty: boolean;
    onCloseNote: () => void;
    onNewNote: () => void;
    onNewFolder: () => void;
    onRefresh: () => void;
    onCloseVault: () => void;
  },
  searchPanel: {} as { focusSignal: number; onOpen: (absPath: string) => void },
  graphView: {} as { onOpenNote: (relPath: string) => void },
  chatPane: {} as {
    openNoteAt: (absPath: string) => void;
    onOpenSettings: () => void;
    refreshSignal: number;
  },
  settingsModal: {} as { open: boolean; onClose: () => void },
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
vi.mock("./useOpenNote", () => ({ useOpenNote: () => openState.current }));
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
    return <div data-testid="chatpane" data-refresh-signal={props.refreshSignal} />;
  },
}));
vi.mock("./SettingsModal", () => ({
  SettingsModal: (props: { open: boolean; onClose: () => void }) => {
    captured.settingsModal = props;
    return props.open ? <div data-testid="settings-modal" /> : null;
  },
}));
vi.mock("./Ribbon", () => ({
  Ribbon: (props: Record<string, (...a: never[]) => void>) => {
    captured.ribbon = props;
    return <div data-testid="ribbon" />;
  },
}));
vi.mock("./TitleBar", () => ({
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
    path: null,
    note: null,
    loading: false,
    error: null,
    mode: "read",
    draft: "",
    dirty: false,
    saving: false,
    saveError: null,
    conflict: false,
    open: vi.fn(),
    reload: vi.fn(),
    overwrite: vi.fn(),
    repath: vi.fn(),
    setMode: vi.fn(),
    setDraft: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    ...over,
  };
}

function vaultCtx(over: Record<string, unknown> = {}) {
  return {
    vault: { name: "MyVault", path: "/v" },
    tree: [] as TreeNode[],
    refreshTree: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    error: null as string | null,
    clearError: vi.fn(),
    reportError: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockUseVault.mockReset();
  mockInvoke.mockClear();
  win.state.closeCb = undefined;
  win.destroy.mockClear();
  win.onCloseRequested.mockClear();
  openState.current = makeOpen();
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

  it("renders the panes and a dismissible error banner", async () => {
    const ctx = vaultCtx({ error: "lifecycle boom" });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.getByTestId("statusbar")).toHaveTextContent("MyVault");
    expect(screen.getByText("lifecycle boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(ctx.clearError).toHaveBeenCalled();
  });
});

describe("Workspace — note index + rel-path opener threading", () => {
  it("builds the note index from the tree and passes it to the note pane", () => {
    mockUseVault.mockReturnValue(vaultCtx({ tree: [node("/v/Target.md")] }));
    render(<Workspace />);
    expect((captured.notePane as { noteIndex?: unknown }).noteIndex).toEqual([
      { relPath: "Target.md", stem: "target" },
    ]);
  });

  it("opens wikilink/backlink targets via the guarded absolute-path open", async () => {
    mockUseVault.mockReturnValue(vaultCtx({ tree: [node("/v/Target.md")] }));
    render(<Workspace />);
    const { onOpenLink } = captured.notePane as unknown as {
      onOpenLink: (rel: string) => void;
    };
    await act(async () => onOpenLink("Target.md"));
    expect(openState.current.open).toHaveBeenCalledWith("/v/Target.md");
  });

  it("routes a dirty wikilink navigation through the discard guard", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx({ tree: [node("/v/Target.md")] }));
    render(<Workspace />);
    const { onOpenLink } = captured.notePane as unknown as {
      onOpenLink: (rel: string) => void;
    };
    await act(async () => onOpenLink("Target.md"));
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(openState.current.open).not.toHaveBeenCalled();
  });
});

describe("Workspace — selection guard", () => {
  it("ignores reselecting the already-open note", async () => {
    openState.current = makeOpen({ path: "/v/a.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onSelect("/v/a.md" as never));
    expect(openState.current.open).not.toHaveBeenCalled();
  });

  it("opens a different note directly when the buffer is clean", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onSelect("/v/b.md" as never));
    expect(openState.current.open).toHaveBeenCalledWith("/v/b.md");
  });

  it("routes a dirty selection through the discard guard (confirm)", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.fileTree.onSelect("/v/b.md" as never));
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(openState.current.open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(openState.current.open).toHaveBeenCalledWith("/v/b.md");
  });

  it("cancels a dirty selection, leaving the note untouched", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    await act(async () => captured.fileTree.onSelect("/v/b.md" as never));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
    expect(openState.current.open).not.toHaveBeenCalled();
  });
});

describe("Workspace — deletion sync", () => {
  it("clears the reader when the open note is inside the deleted node", async () => {
    openState.current = makeOpen({ path: "/v/Notes/a.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onDeleted(node("/v/Notes") as never));
    expect(openState.current.clear).toHaveBeenCalled();
  });

  it("leaves the reader alone for an unrelated deletion", async () => {
    openState.current = makeOpen({ path: "/v/x.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onDeleted(node("/v/Notes") as never));
    expect(openState.current.clear).not.toHaveBeenCalled();
  });

  it("does nothing when no note is open", async () => {
    openState.current = makeOpen({ path: null });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.fileTree.onDeleted(node("/v/Notes") as never));
    expect(openState.current.clear).not.toHaveBeenCalled();
  });
});

describe("Workspace — rename/move remap", () => {
  it("reopens the moved note when the buffer is clean", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, node("/v/b.md") as never),
    );
    expect(openState.current.open).toHaveBeenCalledWith("/v/b.md");
  });

  it("repaths in place (preserving the buffer) when dirty", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const renamed: TreeNode = { ...node("/v/b.md"), relPath: "b.md" };
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, renamed as never),
    );
    expect(openState.current.repath).toHaveBeenCalledWith("/v/b.md", "b.md");
    expect(openState.current.open).not.toHaveBeenCalled();
  });

  it("ignores a remap that does not affect the open note", async () => {
    openState.current = makeOpen({ path: "/v/a.md" });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/other" as never, node("/v/moved") as never),
    );
    expect(openState.current.open).not.toHaveBeenCalled();
    expect(openState.current.repath).not.toHaveBeenCalled();
  });

  it("does nothing when no note is open", async () => {
    openState.current = makeOpen({ path: null });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () =>
      captured.fileTree.onRemap("/v/a.md" as never, node("/v/b.md") as never),
    );
    expect(openState.current.open).not.toHaveBeenCalled();
  });
});

describe("Workspace — close vault + close note", () => {
  it("closes the vault directly when clean", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseVault());
    expect(ctx.close).toHaveBeenCalled();
  });

  it("guards close-vault behind the discard dialog when dirty", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: true });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseVault());
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(ctx.close).toHaveBeenCalled();
  });

  it("clears the note directly from the titlebar tab when clean", async () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseNote());
    expect(openState.current.clear).toHaveBeenCalled();
  });

  it("guards clearing the note from the titlebar tab when dirty", async () => {
    openState.current = makeOpen({ dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.titlebar.onCloseNote());
    expect(openState.current.clear).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(openState.current.clear).toHaveBeenCalled();
  });
});

describe("Workspace — view state (sidebar panel + center view)", () => {
  it("swaps the sidebar between files and search via the ribbon", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.queryByTestId("searchpanel")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowSearch());
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowFiles());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.queryByTestId("searchpanel")).not.toBeInTheDocument();
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

  it("the toggle-mode action flips a text note between read and edit", () => {
    openState.current = makeOpen({
      path: "/v/a.md",
      note: { binary: false } as unknown as OpenNote["note"],
      mode: "read",
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "toggle-mode" });
    expect(openState.current.setMode).toHaveBeenCalledWith("edit");
  });

  it("tells the native menu to enable Format only while editing a text note", async () => {
    mockUseVault.mockReturnValue(vaultCtx());
    // Read mode (no note): Format disabled.
    openState.current = makeOpen();
    const { rerender } = render(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: false }),
    );

    // A text note open in edit mode: Format enabled.
    mockInvoke.mockClear();
    openState.current = makeOpen({
      path: "/v/a.md",
      note: { binary: false } as unknown as OpenNote["note"],
      mode: "edit",
    });
    rerender(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: true }),
    );

    // A binary attachment in edit mode has no editable text: Format stays disabled.
    mockInvoke.mockClear();
    openState.current = makeOpen({
      path: "/v/img.png",
      note: { binary: true } as unknown as OpenNote["note"],
      mode: "edit",
    });
    rerender(<Workspace />);
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("set_menu_editing", { editing: false }),
    );
  });

  it("the close-vault action closes when there are no unsaved edits", () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);

    fireMenu({ action: "close-vault" });
    expect(ctx.close).toHaveBeenCalled();
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

  it("view-files shows the files sidebar; store-handled actions are ignored here", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "search" });
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();

    fireMenu({ action: "view-files" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();

    // open-vault / open-recent are the store's job — they fall through the
    // Workspace switch as a no-op without disturbing the current view.
    fireMenu({ action: "open-vault" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
  });

  it("ignores a plain K press without a modifier", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => {
      fireEvent.keyDown(window, { key: "k" });
    });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(screen.queryByTestId("searchpanel")).not.toBeInTheDocument();
  });

  it("opens a search result through the guard and lands in note view", () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onShowSearch());
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.searchPanel.onOpen("/v/b.md"));
    expect(openState.current.open).toHaveBeenCalledWith("/v/b.md");
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
    expect(screen.queryByTestId("graphview")).not.toBeInTheDocument();
  });

  it("keeps the graph view when a guarded open is cancelled", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.graphView.onOpenNote("b.md"));
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("graphview")).toBeInTheDocument();
    expect(openState.current.open).not.toHaveBeenCalled();
  });

  it("joins the vault path for a confirmed graph open and returns to note view", async () => {
    openState.current = makeOpen({ path: "/v/a.md", dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.ribbon.onToggleGraph());

    act(() => captured.graphView.onOpenNote("Notes/b.md"));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(openState.current.open).toHaveBeenCalledWith("/v/Notes/b.md");
    expect(screen.getByTestId("notepane")).toBeInTheDocument();
  });
});

describe("Workspace — settings modal", () => {
  it("opens from the titlebar cog and closes back", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();

    // Settings moved off the ribbon onto the titlebar in the overlay-titlebar cut.
    act(() => captured.titlebar.onOpenSettings());
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();

    act(() => captured.settingsModal.onClose());
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
  });

  it("opens from the chat pane, and bumps its refresh signal on close", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("chatpane")).toHaveAttribute("data-refresh-signal", "0");

    act(() => captured.chatPane.onOpenSettings());
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();

    // Closing settings must poke the chat pane to re-read the AI status — a
    // provider configured in the modal has to reach the docked pane.
    act(() => captured.settingsModal.onClose());
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("chatpane")).toHaveAttribute("data-refresh-signal", "1");
  });
});

describe("Workspace — titlebar + sidebar", () => {
  it("passes the vault name and open-note state through to the titlebar", () => {
    openState.current = makeOpen({
      note: { title: "A" } as unknown as OpenNote["note"],
      dirty: true,
    });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(captured.titlebar.vaultName).toBe("MyVault");
    expect(captured.titlebar.sidebarOpen).toBe(true);
    expect(captured.titlebar.chatOpen).toBe(true);
    expect(captured.titlebar.noteDirty).toBe(true);
  });

  it("keeps both secondary panes mounted in the compact workspace", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const panes = screen.getByTestId("workspace-panes");
    expect(panes).toContainElement(screen.getByTestId("filetree"));
    expect(panes).toContainElement(screen.getByTestId("chatpane"));
  });

  it("collapses the sidebar (unmounting the file tree) via the titlebar toggle", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("filetree")).toBeInTheDocument();

    act(() => captured.titlebar.onToggleSidebar());
    expect(captured.titlebar.sidebarOpen).toBe(false);
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    act(() => captured.titlebar.onToggleSidebar());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
  });

  it("toggles the sidebar off and back on from the menu", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(screen.getByTestId("filetree")).toBeInTheDocument();

    fireMenu({ action: "toggle-sidebar" });
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    fireMenu({ action: "toggle-sidebar" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
  });

  // Regression: selecting a panel while the sidebar is collapsed used to swap
  // `sidebarPanel` behind a hidden sidebar — the click did nothing visible.
  // Every "show me this panel" caller must force the sidebar open.
  it("re-opens a collapsed sidebar when the ribbon's Files icon is clicked", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.titlebar.onToggleSidebar());
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowFiles());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(captured.titlebar.sidebarOpen).toBe(true);
  });

  it("re-opens a collapsed sidebar when the ribbon's Search icon is clicked", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    act(() => captured.titlebar.onToggleSidebar());
    expect(screen.queryByTestId("searchpanel")).not.toBeInTheDocument();

    act(() => captured.ribbon.onShowSearch());
    expect(screen.getByTestId("searchpanel")).toBeInTheDocument();
    expect(captured.titlebar.sidebarOpen).toBe(true);
  });

  it("flips chat visibility from the titlebar toggle", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(captured.titlebar.chatOpen).toBe(true);

    act(() => captured.titlebar.onToggleChat());
    expect(captured.titlebar.chatOpen).toBe(false);
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

  it("re-opens a collapsed sidebar when New Note fires from the menu", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    fireMenu({ action: "toggle-sidebar" });
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    // Menu-driven New Note must force the sidebar back open onto Files, else its
    // inline create row (the only place a create can happen) never appears.
    fireMenu({ action: "new-note" });
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("note");
  });

  it("re-opens a collapsed sidebar when New Note fires from the titlebar", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    act(() => captured.titlebar.onToggleSidebar());
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    act(() => captured.titlebar.onNewNote());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("note");
  });

  it("re-opens a collapsed sidebar when New Folder fires from the titlebar", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    act(() => captured.titlebar.onToggleSidebar());
    expect(screen.queryByTestId("filetree")).not.toBeInTheDocument();

    act(() => captured.titlebar.onNewFolder());
    expect(screen.getByTestId("filetree")).toBeInTheDocument();
    expect(
      (captured.fileTree as unknown as { pendingCreate: string }).pendingCreate,
    ).toBe("folder");
  });
});

describe("Workspace — OS close guard", () => {
  it("registers an onCloseRequested handler", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    expect(win.onCloseRequested).toHaveBeenCalled();
    expect(typeof win.state.closeCb).toBe("function");
  });

  it("lets a clean window close without intervention", () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    const event = { preventDefault: vi.fn() };
    act(() => win.state.closeCb!(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("holds a dirty window open, then destroys it on discard", async () => {
    openState.current = makeOpen({ dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    const event = { preventDefault: vi.fn() };
    act(() => win.state.closeCb!(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(win.destroy).toHaveBeenCalled();
  });
});
