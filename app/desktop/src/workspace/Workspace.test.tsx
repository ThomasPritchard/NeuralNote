import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  searchPanel: {} as { focusSignal: number; onOpen: (absPath: string) => void },
  graphView: {} as { onOpenNote: (relPath: string) => void },
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
vi.mock("./ChatStub", () => ({ ChatStub: () => <div data-testid="chatstub" /> }));
vi.mock("./Ribbon", () => ({
  Ribbon: (props: Record<string, (...a: never[]) => void>) => {
    captured.ribbon = props;
    return <div data-testid="ribbon" />;
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
    await act(async () => captured.fileTree.onCloseVault());
    expect(ctx.close).toHaveBeenCalled();
  });

  it("guards close-vault behind the discard dialog when dirty", async () => {
    const ctx = vaultCtx();
    openState.current = makeOpen({ dirty: true });
    mockUseVault.mockReturnValue(ctx);
    render(<Workspace />);
    await act(async () => captured.fileTree.onCloseVault());
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(ctx.close).toHaveBeenCalled();
  });

  it("clears the note pane directly when clean", async () => {
    openState.current = makeOpen({ dirty: false });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.notePane.onClose());
    expect(openState.current.clear).toHaveBeenCalled();
  });

  it("guards clearing the note pane when dirty", async () => {
    openState.current = makeOpen({ dirty: true });
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);
    await act(async () => captured.notePane.onClose());
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

  it("⌘K / Ctrl+K opens the search panel and bumps the focus signal", () => {
    mockUseVault.mockReturnValue(vaultCtx());
    render(<Workspace />);

    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(screen.getByTestId("searchpanel")).toHaveAttribute(
      "data-focus-signal",
      "1",
    );

    // Repeat presses (case-insensitive, Ctrl too) keep bumping the signal.
    act(() => {
      fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    });
    expect(screen.getByTestId("searchpanel")).toHaveAttribute(
      "data-focus-signal",
      "2",
    );
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
