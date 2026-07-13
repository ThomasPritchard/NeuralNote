import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../lib/types";
import type { CreateKind } from "./TreeRow";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("../notifications", () => ({
  useToast: () => ({ error: toastError }),
}));

// Mock only the api CRUD calls; keep errorMessage real so surfaced text is honest.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    createFolder: vi.fn(),
    createNote: vi.fn(),
    createNoteFromTemplate: vi.fn(),
    listTemplates: vi.fn(),
    renameEntry: vi.fn(),
    moveEntry: vi.fn(),
  };
});

import * as api from "../lib/api";
import { FileTree } from "./FileTree";

const mockApi = vi.mocked(api);

const fileNode = (name: string): TreeNode => ({
  kind: "file",
  name,
  path: `/v/${name}`,
  relPath: name,
  ext: "md",
  children: null,
});

const folderNode = (name: string, children: TreeNode[] = []): TreeNode => ({
  kind: "folder",
  name,
  path: `/v/${name}`,
  relPath: name,
  ext: null,
  children,
});

function setup(tree: TreeNode[], over: Partial<Parameters<typeof FileTree>[0]> = {}) {
  const props = {
    vaultPath: "/v",
    tree,
    activePath: null as string | null,
    refreshTree: vi.fn().mockResolvedValue(undefined),
    onSelect: vi.fn(),
    onDeleteRequest: vi.fn(),
    onRemap: vi.fn(),
    pendingCreate: null as CreateKind | null,
    onCreateConsumed: vi.fn(),
    ...over,
  };
  render(<FileTree {...props} />);
  return props;
}

/** Minimal DataTransfer stand-in for jsdom drag events. */
const dt = () => ({ effectAllowed: "", setData: vi.fn(), getData: vi.fn() });

// FileTree now persists fold state to localStorage, which this env doesn't
// expose — install a fresh in-memory one per test (also isolates fold state
// between tests, since one test's collapse must not leak into another).
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
}

beforeEach(() => {
  stubLocalStorage();
  toastError.mockReset();
  mockApi.createFolder.mockReset();
  mockApi.createNote.mockReset();
  mockApi.createNoteFromTemplate.mockReset();
  mockApi.renameEntry.mockReset();
  mockApi.moveEntry.mockReset();
  // No templates by default — the create flow must be exactly the plain one.
  mockApi.listTemplates.mockReset();
  mockApi.listTemplates.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FileTree — rendering", () => {
  it("renders an empty-state hint for an empty vault", () => {
    setup([]);
    expect(screen.getByText(/This vault is empty/i)).toBeInTheDocument();
  });

  it("renders files and folders with the active file marked", () => {
    setup([folderNode("Notes", [fileNode("a.md")]), fileNode("top.md")], {
      activePath: "/v/top.md",
    });
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("top.md")).toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeInTheDocument(); // folder open by default
  });
});

describe("FileTree — fold persistence", () => {
  it("remembers a collapsed folder across a remount of the same vault", async () => {
    const user = userEvent.setup();
    const tree = [folderNode("Notes", [fileNode("a.md")])];

    const first = render(
      <FileTree
        vaultPath="/v"
        tree={tree}
        activePath={null}
        refreshTree={vi.fn().mockResolvedValue(undefined)}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn()}
        onRemap={vi.fn()}
        pendingCreate={null}
        onCreateConsumed={vi.fn()}
      />,
    );
    // Open by default → child visible. The open folder is the only expanded button.
    expect(screen.getByText("a.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
    first.unmount();

    // A fresh mount of the same vault hydrates the fold from storage.
    render(
      <FileTree
        vaultPath="/v"
        tree={tree}
        activePath={null}
        refreshTree={vi.fn().mockResolvedValue(undefined)}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn()}
        onRemap={vi.fn()}
        pendingCreate={null}
        onCreateConsumed={vi.fn()}
      />,
    );
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });
});

describe("FileTree — create", () => {
  it("shows a visible tooltip for the root new-note control", async () => {
    setup([]);

    const button = screen.getByRole("button", { name: "New note" });
    await userEvent.hover(button);

    expect(await screen.findByRole("tooltip")).toHaveTextContent("New note");
  });

  it("creates a note at the vault root and selects it", async () => {
    const node = { ...fileNode("New.md"), path: "/v/New.md" };
    mockApi.createNote.mockResolvedValueOnce(node);
    const p = setup([]);

    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    const input = screen.getByLabelText("New note name");
    await userEvent.type(input, "New.md{Enter}");

    await waitFor(() =>
      expect(mockApi.createNote).toHaveBeenCalledWith("/v", "New.md"),
    );
    expect(p.refreshTree).toHaveBeenCalled();
    expect(p.onSelect).toHaveBeenCalledWith("/v/New.md", false);
  });

  it("keeps ordinary note creation blank-only without loading templates", async () => {
    mockApi.listTemplates.mockResolvedValue([
      { relPath: "Templates/Daily.md", name: "Daily" },
    ]);
    mockApi.createNote.mockResolvedValueOnce(fileNode("Blank.md"));
    setup([]);

    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(mockApi.listTemplates).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Note template")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("New note name"), "Blank.md{Enter}");
    await waitFor(() =>
      expect(mockApi.createNote).toHaveBeenCalledWith("/v", "Blank.md"),
    );
    expect(mockApi.createNoteFromTemplate).not.toHaveBeenCalled();
  });

  it("keeps the input open and surfaces an error when creation fails", async () => {
    mockApi.createNote.mockRejectedValueOnce({ kind: "alreadyExists", message: "Already exists" });
    setup([]);

    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    await userEvent.type(screen.getByLabelText("New note name"), "Dup.md{Enter}");

    expect(await screen.findByText("Already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("New note name")).toBeInTheDocument();

    // The inline error is dismissible.
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("Already exists")).not.toBeInTheDocument();
  });

  it("creates a folder at the vault root from a pending create request", async () => {
    // The vault menu moved to the titlebar; root creates reach FileTree
    // through the pendingCreate prop, which opens the inline row directly.
    mockApi.createFolder.mockResolvedValueOnce(folderNode("Sub"));
    const p = setup([], { pendingCreate: "folder" });

    await userEvent.type(screen.getByLabelText("New folder name"), "Sub{Enter}");

    await waitFor(() =>
      expect(mockApi.createFolder).toHaveBeenCalledWith("/v", "Sub"),
    );
    expect(p.refreshTree).toHaveBeenCalled();
  });

  it("creates a note inside a folder via its hover action", async () => {
    mockApi.createNote.mockResolvedValueOnce({
      ...fileNode("child.md"),
      path: "/v/Notes/child.md",
    });
    const p = setup([folderNode("Notes", [fileNode("a.md")])]);

    await userEvent.click(screen.getByRole("button", { name: "New note in Notes" }));
    await userEvent.type(screen.getByLabelText("New note name"), "child.md{Enter}");

    await waitFor(() =>
      expect(mockApi.createNote).toHaveBeenCalledWith("/v/Notes", "child.md"),
    );
    expect(p.onSelect).toHaveBeenCalledWith("/v/Notes/child.md", false);
  });
});

describe("FileTree — rename", () => {
  it("renames a file and remaps the open note", async () => {
    const renamed = { ...fileNode("b.md"), path: "/v/b.md" };
    mockApi.renameEntry.mockResolvedValueOnce(renamed);
    const p = setup([fileNode("a.md")]);

    await userEvent.click(screen.getByRole("button", { name: "Rename a.md" }));
    const input = screen.getByLabelText("Rename a.md");
    await userEvent.clear(input);
    await userEvent.type(input, "b.md{Enter}");

    await waitFor(() =>
      expect(mockApi.renameEntry).toHaveBeenCalledWith("/v/a.md", "b.md"),
    );
    expect(p.refreshTree).toHaveBeenCalled();
    expect(p.onRemap).toHaveBeenCalledWith("/v/a.md", renamed);
  });

  it("surfaces a rename failure", async () => {
    mockApi.renameEntry.mockRejectedValueOnce({ kind: "invalidName", message: "Invalid name" });
    setup([fileNode("a.md")]);

    await userEvent.click(screen.getByRole("button", { name: "Rename a.md" }));
    const input = screen.getByLabelText("Rename a.md");
    await userEvent.clear(input);
    await userEvent.type(input, "bad/name{Enter}");

    expect(await screen.findByText("Invalid name")).toBeInTheDocument();
  });
});

describe("FileTree — folder collapse", () => {
  it("toggles a folder open and closed", async () => {
    setup([folderNode("Notes", [fileNode("a.md")])]);
    const folderBtn = screen.getByText("Notes").closest("button")!;
    expect(screen.getByText("a.md")).toBeInTheDocument();
    await userEvent.click(folderBtn);
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
    await userEvent.click(folderBtn);
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });
});

describe("FileTree — drag and drop", () => {
  it("moves a file into a folder on drop", async () => {
    const moved = { ...fileNode("a.md"), path: "/v/Notes/a.md" };
    mockApi.moveEntry.mockResolvedValueOnce(moved);
    const p = setup([folderNode("Notes", []), fileNode("a.md")]);

    const fileBtn = screen.getByText("a.md").closest("button")!;
    const folderRow = screen.getByText("Notes").closest("div")!;

    fireEvent.dragStart(fileBtn, { dataTransfer: dt() });
    fireEvent.dragOver(folderRow, { dataTransfer: dt() });
    fireEvent.drop(folderRow, { dataTransfer: dt() });

    await waitFor(() =>
      expect(mockApi.moveEntry).toHaveBeenCalledWith("/v/a.md", "/v/Notes"),
    );
    expect(p.onRemap).toHaveBeenCalledWith("/v/a.md", moved);
  });

  it("no-ops a drop onto a file (stopPropagation, never a root move)", () => {
    setup([fileNode("a.md"), fileNode("b.md")]);
    const a = screen.getByText("a.md").closest("button")!;
    const bRow = screen.getByText("b.md").closest("div")!;

    fireEvent.dragStart(a, { dataTransfer: dt() });
    fireEvent.drop(bRow, { dataTransfer: dt() });

    expect(mockApi.moveEntry).not.toHaveBeenCalled();
  });

  it("no-ops when dropping a root file back onto the vault root", () => {
    setup([fileNode("a.md")]);
    const a = screen.getByText("a.md").closest("button")!;
    const scrollBody = a.closest(".overflow-y-auto")!;

    fireEvent.dragStart(a, { dataTransfer: dt() });
    fireEvent.drop(scrollBody, { dataTransfer: dt() });

    expect(mockApi.moveEntry).not.toHaveBeenCalled();
  });

  it("moves a nested file out to the vault root via the scroll-body drop target", async () => {
    const nestedFile: TreeNode = {
      kind: "file",
      name: "a.md",
      path: "/v/Notes/a.md",
      relPath: "Notes/a.md",
      ext: "md",
      children: null,
    };
    const moved = { ...nestedFile, path: "/v/a.md", relPath: "a.md" };
    mockApi.moveEntry.mockResolvedValueOnce(moved);
    setup([folderNode("Notes", [nestedFile])]);

    const nested = screen.getByText("a.md").closest("button")!;
    const scrollBody = nested.closest(".overflow-y-auto")!;

    fireEvent.dragStart(nested, { dataTransfer: dt() });
    fireEvent.drop(scrollBody, { dataTransfer: dt() });

    await waitFor(() =>
      expect(mockApi.moveEntry).toHaveBeenCalledWith("/v/Notes/a.md", "/v"),
    );
  });
});

describe("FileTree — TreeRow interactions", () => {
  it("reports ordinary and Command-click note selection separately", async () => {
    const p = setup([fileNode("a.md")]);
    const note = screen.getByText("a.md").closest("button")!;

    await userEvent.click(note);
    fireEvent.click(note, { metaKey: true });

    expect(p.onSelect).toHaveBeenNthCalledWith(1, "/v/a.md", false);
    expect(p.onSelect).toHaveBeenNthCalledWith(2, "/v/a.md", true);
  });

  it("raises deletion to Workspace without opening its own confirmation", async () => {
    const onDeleteRequest = vi.fn();
    setup(
      [fileNode("a.md")],
      { onDeleteRequest } as never,
    );

    await userEvent.click(screen.getByRole("button", { name: "Delete a.md" }));

    expect(onDeleteRequest).toHaveBeenCalledWith(fileNode("a.md"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("renames a folder via double-click", async () => {
    setup([folderNode("Notes", [])]);
    await userEvent.dblClick(screen.getByText("Notes").closest("button")!);
    expect(screen.getByLabelText("Rename Notes")).toBeInTheDocument();
  });

  it("renames a file via double-click", async () => {
    setup([fileNode("a.md")]);
    await userEvent.dblClick(screen.getByText("a.md").closest("button")!);
    expect(screen.getByLabelText("Rename a.md")).toBeInTheDocument();
  });

  it("renames a folder via its hover action", async () => {
    setup([folderNode("Notes", [])]);
    await userEvent.click(screen.getByRole("button", { name: "Rename Notes" }));
    expect(screen.getByLabelText("Rename Notes")).toBeInTheDocument();
  });

  it("creates a folder inside a folder via its hover action", async () => {
    setup([folderNode("Notes", [])]);
    await userEvent.click(screen.getByRole("button", { name: "New folder in Notes" }));
    expect(screen.getByLabelText("New folder name")).toBeInTheDocument();
  });

  it("supports dragging a folder and leaving a drop target", () => {
    setup([folderNode("Src", []), folderNode("Dest", [])]);
    const srcRow = screen.getByText("Src").closest("div")!;
    const destRow = screen.getByText("Dest").closest("div")!;

    fireEvent.dragStart(srcRow, { dataTransfer: dt() });
    fireEvent.dragOver(destRow, { dataTransfer: dt() });
    fireEvent.dragLeave(destRow, { dataTransfer: dt() });
    fireEvent.dragEnd(srcRow, { dataTransfer: dt() });

    // No drop occurred, so no move was attempted.
    expect(mockApi.moveEntry).not.toHaveBeenCalled();
  });
});

describe("FileTree — filename filter", () => {
  it("renders an enabled filter input with the new labels and no ⌘K chip", () => {
    setup([fileNode("a.md")]);
    const input = screen.getByLabelText("Filter files by name");
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("placeholder", "Filter files…");
    // ⌘K belongs to the vault-wide SearchPanel, not the sidebar filter.
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
  });

  it("typing narrows the tree to matching files and their ancestor folders", async () => {
    setup([
      folderNode("Notes", [fileNode("alpha.md"), fileNode("beta.md")]),
      fileNode("top.md"),
    ]);

    await userEvent.type(screen.getByLabelText("Filter files by name"), "beta");

    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("beta.md")).toBeInTheDocument();
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument();
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();
  });

  it("auto-expands collapsed folders while the filter is active", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md")])]);
    await userEvent.click(screen.getByText("Notes").closest("button")!); // collapse
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Filter files by name"), "alpha");

    expect(screen.getByText("alpha.md")).toBeInTheDocument();
  });

  it("keeps only the filtered children of a folder whose own name matches", async () => {
    setup([folderNode("Projects", [fileNode("alpha.md"), fileNode("project-plan.md")])]);

    await userEvent.type(screen.getByLabelText("Filter files by name"), "project");

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("project-plan.md")).toBeInTheDocument();
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument();
  });

  it("shows the ✕ clear button only while the filter is non-empty", async () => {
    setup([fileNode("a.md")]);
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Filter files by name"), "a");

    const clear = screen.getByRole("button", { name: "Clear filter" });
    expect(clear).toBeInTheDocument();
    await userEvent.hover(clear);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Clear filter");
  });

  it("clearing via ✕ restores the full tree and the prior collapse state", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md")]), fileNode("top.md")]);
    await userEvent.click(screen.getByText("Notes").closest("button")!); // collapse
    await userEvent.type(screen.getByLabelText("Filter files by name"), "alpha");
    expect(screen.getByText("alpha.md")).toBeInTheDocument();
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.getByLabelText("Filter files by name")).toHaveValue("");
    expect(screen.getByText("top.md")).toBeInTheDocument(); // full tree back
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument(); // Notes still collapsed
  });

  it("Escape clears the filter and restores the full tree and collapse state", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md")]), fileNode("top.md")]);
    await userEvent.click(screen.getByText("Notes").closest("button")!); // collapse
    const input = screen.getByLabelText("Filter files by name");
    await userEvent.type(input, "alpha");
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();

    await userEvent.type(input, "{Escape}");

    expect(input).toHaveValue("");
    expect(screen.getByText("top.md")).toBeInTheDocument();
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument(); // Notes still collapsed
  });

  it("shows a no-match empty state distinct from the empty-vault copy", async () => {
    setup([fileNode("a.md")]);

    await userEvent.type(screen.getByLabelText("Filter files by name"), "zzz");

    expect(screen.getByText('No files match "zzz"')).toBeInTheDocument();
    expect(screen.queryByText(/This vault is empty/i)).not.toBeInTheDocument();
  });
});

describe("FileTree — virtualization (PA-005)", () => {
  // Above VIRTUALIZE_MIN_ROWS the tree body windows via @tanstack/react-virtual.
  // The virtualizer measures via offsetHeight (jsdom: always 0), so give the
  // scroll container a real viewport and every row a fixed height — the lib
  // reads the container synchronously on mount, making the window math
  // deterministic without ResizeObserver ever firing.
  const VIEWPORT = 600;
  const ROW = 26;

  function stubLayout() {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "tree" ? VIEWPORT : ROW;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240);
  }

  const bigTree = (n = 300) =>
    Array.from({ length: n }, (_, i) => fileNode(`note-${String(i).padStart(3, "0")}.md`));

  it("mounts only the visible window of a large tree, not every row", () => {
    stubLayout();
    setup(bigTree());

    expect(screen.getByText("note-000.md")).toBeInTheDocument();
    // The far end of the list is NOT in the DOM — that's the windowing.
    expect(screen.queryByText("note-299.md")).not.toBeInTheDocument();
    const mounted = screen.getAllByRole("treeitem").length;
    expect(mounted).toBeLessThan(100);
    expect(mounted).toBeGreaterThan(VIEWPORT / ROW - 1); // the viewport is filled
  });

  it("mounts late rows (and drops early ones) when scrolled to the bottom", () => {
    stubLayout();
    setup(bigTree());
    const scroller = screen.getByRole("tree");

    scroller.scrollTop = 300 * ROW - VIEWPORT;
    fireEvent.scroll(scroller);

    expect(screen.getByText("note-299.md")).toBeInTheDocument();
    expect(screen.queryByText("note-000.md")).not.toBeInTheDocument();
  });

  it("keeps selection and collapse working through the virtualized body", async () => {
    stubLayout();
    const p = setup([folderNode("Notes", [fileNode("inside.md")]), ...bigTree()]);

    // Select a mounted file row.
    await userEvent.click(screen.getByText("note-000.md").closest("button")!);
    expect(p.onSelect).toHaveBeenCalledWith("/v/note-000.md", false);

    // Collapse the folder: its child leaves the flat list entirely.
    expect(screen.getByText("inside.md")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Notes").closest("button")!);
    expect(screen.queryByText("inside.md")).not.toBeInTheDocument();
  });

  it("renders small trees without windowing (every row mounted)", () => {
    // No layout stubs at all: with jsdom's 0-height viewport a virtualized
    // body would mount almost nothing — every row being present proves the
    // sub-threshold tree takes the plain, unwindowed path.
    setup([folderNode("Notes", [fileNode("a.md")]), fileNode("top.md")]);
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("top.md")).toBeInTheDocument();
  });
});

describe("FileTree — pending create requests", () => {
  // Root-level creates arrive from window chrome (the native File menu and the
  // titlebar's vault menu) via the pendingCreate prop; FileTree opens the
  // inline row and consumes the request exactly once.
  it("opens the root folder-create row and consumes the request", () => {
    const p = setup([], { pendingCreate: "folder" });
    expect(screen.getByLabelText("New folder name")).toBeInTheDocument();
    expect(p.onCreateConsumed).toHaveBeenCalledTimes(1);
  });

  it("opens the root note-create row and consumes the request", async () => {
    const p = setup([], { pendingCreate: "note" });
    expect(screen.getByLabelText("New note name")).toBeInTheDocument();
    expect(p.onCreateConsumed).toHaveBeenCalledTimes(1);
    // A note create kicks off the optional template fetch — flush its (empty)
    // resolution so the state update lands inside the test.
    await act(async () => {});
    expect(screen.queryByLabelText("Note template")).not.toBeInTheDocument();
  });
});
