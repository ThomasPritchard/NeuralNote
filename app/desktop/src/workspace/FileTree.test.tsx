import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";

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

const fileNode = (name: string, relPath = name): TreeNode => ({
  kind: "file",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const folderNode = (name: string, children: TreeNode[] = [], relPath = name): TreeNode => ({
  kind: "folder",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children,
});

/** Folder nodes in the lazy model carry children: null — the loaded map holds
 *  the children, not the node. */
const strip = (nodes: TreeNode[]): TreeNode[] =>
  nodes.map((n) => (n.kind === "folder" ? { ...n, children: null } : n));

const dir = (children: TreeNode[], truncated: number | null = null): LoadedDir => ({
  status: "loaded",
  children: strip(children),
  truncated,
});

/** Build the store's per-directory `loaded` map from a nested tree fixture,
 *  pre-loading every folder (collapsed by default is the EXPANDED set's job). */
function loadedFrom(nodes: TreeNode[]): Map<string, LoadedDir> {
  const map = new Map<string, LoadedDir>();
  const walk = (ns: TreeNode[], rel: string): void => {
    map.set(rel, dir(ns));
    for (const n of ns) if (n.kind === "folder" && n.children) walk(n.children, n.relPath);
  };
  walk(nodes, "");
  return map;
}

type FileTreeProps = Parameters<typeof FileTree>[0];

function setup(nodes: TreeNode[], over: Partial<FileTreeProps> = {}) {
  const props: FileTreeProps = {
    vaultPath: "/v",
    activePath: null,
    loaded: loadedFrom(nodes),
    expanded: new Set<string>(),
    onToggle: vi.fn(),
    onListDir: vi.fn().mockResolvedValue(undefined),
    onRefreshDir: vi.fn().mockResolvedValue(undefined),
    onSelect: vi.fn(),
    onDeleteRequest: vi.fn(),
    onRemap: vi.fn(),
    pendingCreate: null,
    onCreateConsumed: vi.fn(),
    ...over,
  };
  render(<FileTree {...props} />);
  return props;
}

/** Minimal DataTransfer stand-in for jsdom drag events. */
const dt = () => ({ effectAllowed: "", setData: vi.fn(), getData: vi.fn() });

beforeEach(() => {
  toastError.mockReset();
  mockApi.createFolder.mockReset();
  mockApi.createNote.mockReset();
  mockApi.createNoteFromTemplate.mockReset();
  mockApi.renameEntry.mockReset();
  mockApi.moveEntry.mockReset();
  mockApi.listTemplates.mockReset();
  mockApi.listTemplates.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileTree — rendering", () => {
  it("renders an empty-state hint for an empty vault", () => {
    setup([]);
    expect(screen.getByText(/This vault is empty/i)).toBeInTheDocument();
  });

  it("renders files and folders with the active file marked", () => {
    setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")]), fileNode("top.md")], {
      expanded: new Set(["Notes"]),
      activePath: "/v/top.md",
    });
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("top.md")).toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeInTheDocument(); // Notes is in the expanded set
  });
});

describe("FileTree — collapse by default", () => {
  it("starts folders collapsed: children are hidden until expanded", () => {
    setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")])]);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });

  it("shows a folder's children when it is in the expanded set", () => {
    setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")])], {
      expanded: new Set(["Notes"]),
    });
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });

  it("clicking a folder chevron asks the store to toggle it", async () => {
    const p = setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")])]);
    await userEvent.click(screen.getByText("Notes").closest("button")!);
    expect(p.onToggle).toHaveBeenCalledWith("Notes");
  });
});

// A controlled harness that mimics the store: onToggle updates the expanded set
// and lazily loads a folder's children (a real macrotask) on first expand. This
// proves the whole expand → load → show → collapse → hide flow end to end.
function ControlledTree({ full }: Readonly<{ full: TreeNode[] }>) {
  const dataRef = useRef<Map<string, TreeNode[]>>(undefined);
  if (!dataRef.current) {
    const m = new Map<string, TreeNode[]>();
    const walk = (ns: TreeNode[], rel: string): void => {
      m.set(rel, ns);
      for (const n of ns) if (n.kind === "folder") walk(n.children ?? [], n.relPath);
    };
    walk(full, "");
    dataRef.current = m;
  }
  const data = dataRef.current;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, LoadedDir>>(
    () => new Map([["", dir(data.get("") ?? [])]]),
  );
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const onListDir = useCallback(
    (rel: string): Promise<void> => {
      setLoaded((prev) =>
        new Map(prev).set(rel, { status: "loading" }),
      );
      setTimeout(
        () => setLoaded((prev) => new Map(prev).set(rel, dir(data.get(rel) ?? []))),
        0,
      );
      return Promise.resolve();
    },
    [data],
  );

  const onToggle = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
          if (!loadedRef.current.has(rel)) void onListDir(rel);
        }
        return next;
      });
    },
    [onListDir],
  );

  return (
    <FileTree
      vaultPath="/v"
      activePath={null}
      loaded={loaded}
      expanded={expanded}
      onToggle={onToggle}
      onListDir={onListDir}
      onRefreshDir={vi.fn().mockResolvedValue(undefined)}
      onSelect={vi.fn()}
      onDeleteRequest={vi.fn()}
      onRemap={vi.fn()}
      pendingCreate={null}
      onCreateConsumed={vi.fn()}
    />
  );
}

describe("FileTree — lazy expand flow", () => {
  it("expands a folder to load and reveal its children, then collapse hides them", async () => {
    const user = userEvent.setup();
    render(<ControlledTree full={[folderNode("Notes", [fileNode("a.md", "Notes/a.md")])]} />);

    // Collapsed by default — the child is not loaded and not shown.
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();

    // Expand: the store loads Notes, then its child appears.
    await user.click(screen.getByText("Notes").closest("button")!);
    expect(await screen.findByText("a.md")).toBeInTheDocument();

    // Collapse: the child leaves the flat list entirely.
    await user.click(screen.getByText("Notes").closest("button")!);
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });
});

describe("FileTree — lazy status rows", () => {
  it("shows a subtle loading row under an expanded folder whose listing is in flight", () => {
    // Root is loaded and lists Notes, but Notes' own listing hasn't landed.
    const loaded = new Map<string, LoadedDir>([["", dir([folderNode("Notes")])]]);
    setup([], { loaded, expanded: new Set(["Notes"]) });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows a per-folder error row with a Retry that re-lists just that folder", async () => {
    const loaded = new Map<string, LoadedDir>([
      ["", dir([folderNode("Notes")])],
      ["Notes", { status: "error", error: "Permission denied" }],
    ]);
    const p = setup([], { loaded, expanded: new Set(["Notes"]) });

    expect(screen.getByText("Permission denied")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /Retry loading Notes/i });
    await userEvent.click(retry);
    expect(p.onListDir).toHaveBeenCalledWith("Notes");
  });

  it("shows a non-interactive 'N more…' truncation row", () => {
    const loaded = new Map<string, LoadedDir>([["", dir([fileNode("top.md")], 12)]]);
    setup([], { loaded });

    const more = screen.getByText("12 more…");
    expect(more).toBeInTheDocument();
    // Truncation is informational only — search still reaches those files.
    expect(more.closest("button")).toBeNull();
  });

  it("thousand-scale truncation counts are shown human-readable", () => {
    const loaded = new Map<string, LoadedDir>([["", dir([fileNode("top.md")], 15000)]]);
    setup([], { loaded });
    expect(screen.getByText("15,000 more…")).toBeInTheDocument();
  });
});

describe("FileTree — create", () => {
  it("shows a visible tooltip for the root new-note control", async () => {
    setup([]);
    const button = screen.getByRole("button", { name: "New note" });
    await userEvent.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("New note");
  });

  it("creates a note at the vault root, re-lists the root, and selects it", async () => {
    const node = { ...fileNode("New.md"), path: "/v/New.md" };
    mockApi.createNote.mockResolvedValueOnce(node);
    const p = setup([]);

    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    await userEvent.type(screen.getByLabelText("New note name"), "New.md{Enter}");

    await waitFor(() =>
      expect(mockApi.createNote).toHaveBeenCalledWith("/v", "New.md"),
    );
    expect(p.onRefreshDir).toHaveBeenCalledWith(""); // root re-listed
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

    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("Already exists")).not.toBeInTheDocument();
  });

  it("creates a folder at the vault root from a pending create request", async () => {
    mockApi.createFolder.mockResolvedValueOnce(folderNode("Sub"));
    const p = setup([], { pendingCreate: "folder" });

    await userEvent.type(screen.getByLabelText("New folder name"), "Sub{Enter}");

    await waitFor(() =>
      expect(mockApi.createFolder).toHaveBeenCalledWith("/v", "Sub"),
    );
    expect(p.onRefreshDir).toHaveBeenCalledWith("");
  });

  it("creates a note inside a folder via its hover action", async () => {
    mockApi.createNote.mockResolvedValueOnce({
      ...fileNode("child.md"),
      path: "/v/Notes/child.md",
    });
    // Notes starts collapsed; the create action must expand it so the inline row
    // is reachable.
    const p = setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")])]);

    await userEvent.click(screen.getByRole("button", { name: "New note in Notes" }));
    expect(p.onToggle).toHaveBeenCalledWith("Notes"); // expanded to reveal the row
    await userEvent.type(screen.getByLabelText("New note name"), "child.md{Enter}");

    await waitFor(() =>
      expect(mockApi.createNote).toHaveBeenCalledWith("/v/Notes", "child.md"),
    );
    expect(p.onRefreshDir).toHaveBeenCalledWith("Notes");
    expect(p.onSelect).toHaveBeenCalledWith("/v/Notes/child.md", false);
  });
});

describe("FileTree — rename", () => {
  it("renames a file, re-lists its parent, and remaps the open note", async () => {
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
    expect(p.onRefreshDir).toHaveBeenCalledWith(""); // parent of a root file is the root
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

describe("FileTree — folder expand from the store", () => {
  it("reveals children when the expanded set gains the folder (re-render)", () => {
    const nodes = [folderNode("Notes", [fileNode("a.md", "Notes/a.md")])];
    const { rerender } = render(
      <FileTree
        vaultPath="/v"
        activePath={null}
        loaded={loadedFrom(nodes)}
        expanded={new Set()}
        onToggle={vi.fn()}
        onListDir={vi.fn().mockResolvedValue(undefined)}
        onRefreshDir={vi.fn().mockResolvedValue(undefined)}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn()}
        onRemap={vi.fn()}
        pendingCreate={null}
        onCreateConsumed={vi.fn()}
      />,
    );
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();

    rerender(
      <FileTree
        vaultPath="/v"
        activePath={null}
        loaded={loadedFrom(nodes)}
        expanded={new Set(["Notes"])}
        onToggle={vi.fn()}
        onListDir={vi.fn().mockResolvedValue(undefined)}
        onRefreshDir={vi.fn().mockResolvedValue(undefined)}
        onSelect={vi.fn()}
        onDeleteRequest={vi.fn()}
        onRemap={vi.fn()}
        pendingCreate={null}
        onCreateConsumed={vi.fn()}
      />,
    );
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
    expect(p.onRefreshDir).toHaveBeenCalledWith(""); // source parent (root)
    expect(p.onRefreshDir).toHaveBeenCalledWith("Notes"); // dest is loaded
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
    const nestedFile = fileNode("a.md", "Notes/a.md");
    const moved = { ...nestedFile, path: "/v/a.md", relPath: "a.md" };
    mockApi.moveEntry.mockResolvedValueOnce(moved);
    setup([folderNode("Notes", [nestedFile])], { expanded: new Set(["Notes"]) });

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
    setup([fileNode("a.md")], { onDeleteRequest });

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

    expect(mockApi.moveEntry).not.toHaveBeenCalled();
  });
});

describe("FileTree — filename filter", () => {
  it("renders an enabled filter input with the new labels and no ⌘K chip", () => {
    setup([fileNode("a.md")]);
    const input = screen.getByLabelText("Filter files by name");
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("placeholder", "Filter files…");
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
  });

  it("typing narrows the tree to matching files and their ancestor folders", async () => {
    setup([
      folderNode("Notes", [fileNode("alpha.md", "Notes/alpha.md"), fileNode("beta.md", "Notes/beta.md")]),
      fileNode("top.md"),
    ]);

    await userEvent.type(screen.getByLabelText("Filter files by name"), "beta");

    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("beta.md")).toBeInTheDocument();
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument();
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();
  });

  it("auto-expands collapsed (but loaded) folders while the filter is active", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md", "Notes/alpha.md")])]);
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument(); // collapsed

    await userEvent.type(screen.getByLabelText("Filter files by name"), "alpha");

    expect(screen.getByText("alpha.md")).toBeInTheDocument();
  });

  it("keeps only the filtered children of a folder whose own name matches", async () => {
    setup([
      folderNode("Projects", [
        fileNode("alpha.md", "Projects/alpha.md"),
        fileNode("project-plan.md", "Projects/project-plan.md"),
      ]),
    ]);

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

  it("clearing via ✕ restores the full tree and the collapse state", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md", "Notes/alpha.md")]), fileNode("top.md")]);
    await userEvent.type(screen.getByLabelText("Filter files by name"), "alpha");
    expect(screen.getByText("alpha.md")).toBeInTheDocument();
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(screen.getByLabelText("Filter files by name")).toHaveValue("");
    expect(screen.getByText("top.md")).toBeInTheDocument(); // full tree back
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument(); // Notes collapsed again
  });

  it("Escape clears the filter and restores the full tree and collapse state", async () => {
    setup([folderNode("Notes", [fileNode("alpha.md", "Notes/alpha.md")]), fileNode("top.md")]);
    const input = screen.getByLabelText("Filter files by name");
    await userEvent.type(input, "alpha");
    expect(screen.queryByText("top.md")).not.toBeInTheDocument();

    await userEvent.type(input, "{Escape}");

    expect(input).toHaveValue("");
    expect(screen.getByText("top.md")).toBeInTheDocument();
    expect(screen.queryByText("alpha.md")).not.toBeInTheDocument();
  });

  it("shows a no-match empty state distinct from the empty-vault copy", async () => {
    setup([fileNode("a.md")]);

    await userEvent.type(screen.getByLabelText("Filter files by name"), "zzz");

    expect(screen.getByText('No files match "zzz"')).toBeInTheDocument();
    expect(screen.queryByText(/This vault is empty/i)).not.toBeInTheDocument();
  });
});

describe("FileTree — virtualization (PA-005)", () => {
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
    expect(screen.queryByText("note-299.md")).not.toBeInTheDocument();
    const mounted = screen.getAllByRole("treeitem").length;
    expect(mounted).toBeLessThan(100);
    expect(mounted).toBeGreaterThan(VIEWPORT / ROW - 1);
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

  it("keeps selection working through the virtualized body", async () => {
    stubLayout();
    const p = setup(bigTree());

    await userEvent.click(screen.getByText("note-000.md").closest("button")!);
    expect(p.onSelect).toHaveBeenCalledWith("/v/note-000.md", false);
  });

  it("renders small trees without windowing (every row mounted)", () => {
    setup([folderNode("Notes", [fileNode("a.md", "Notes/a.md")]), fileNode("top.md")], {
      expanded: new Set(["Notes"]),
    });
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("top.md")).toBeInTheDocument();
  });
});

describe("FileTree — pending create requests", () => {
  it("opens the root folder-create row and consumes the request", () => {
    const p = setup([], { pendingCreate: "folder" });
    expect(screen.getByLabelText("New folder name")).toBeInTheDocument();
    expect(p.onCreateConsumed).toHaveBeenCalledTimes(1);
  });

  it("opens the root note-create row and consumes the request", async () => {
    const p = setup([], { pendingCreate: "note" });
    expect(screen.getByLabelText("New note name")).toBeInTheDocument();
    expect(p.onCreateConsumed).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(screen.queryByLabelText("Note template")).not.toBeInTheDocument();
  });
});
