// Proves issue #25: TreeRow's React.memo boundary actually bites — an unrelated
// FileTree re-render (a parent handing it a fresh, inert callback identity while
// the tree data and all row-relevant state are unchanged) must NOT re-render the
// visible rows. Before ctx/handler stabilization, FileTree rebuilt its context
// object every render, so memo compared a fresh `ctx` each time and every row
// re-rendered regardless.
//
// This lives in its own file so the TreeRow module mock (a transparent render
// counter around the real row) stays scoped here and never touches the main
// FileTree.test.tsx behavioural suite.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../lib/types";
import type { LoadedDir } from "../lib/store";

const { toastError, treeRowRender } = vi.hoisted(() => ({
  toastError: vi.fn(),
  treeRowRender: vi.fn(),
}));

// A STABLE toast controller, mirroring the real useToast's memoized contract —
// an unstable one would churn the error-surfacing callbacks and mask the memo.
vi.mock("../notifications", () => {
  const controller = { error: toastError };
  return { useToast: () => controller };
});

// Instrument TreeRow's memo boundary: count each render, then delegate to the
// real row so DOM output and the default (shallow-prop) memo comparison are
// preserved exactly.
vi.mock("./TreeRow", async (importActual) => {
  const actual = await importActual<typeof import("./TreeRow")>();
  const { memo, createElement } = await import("react");
  const Instrumented = memo(function TreeRowSpy(
    props: Readonly<{ node: TreeNode; ctx: unknown }>,
  ) {
    treeRowRender(props.node.path);
    return createElement(actual.TreeRow, props as never);
  });
  return { ...actual, TreeRow: Instrumented };
});

import { FileTree } from "./FileTree";

const fileNode = (name: string, relPath = name): TreeNode => ({
  kind: "file",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const folderNode = (name: string, relPath = name): TreeNode => ({
  kind: "folder",
  name,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children: null,
});

const dir = (children: TreeNode[]): LoadedDir => ({
  status: "loaded",
  children,
  truncated: null,
});

type FileTreeProps = Parameters<typeof FileTree>[0];

/** A small, stable tree: two root files plus an expanded folder with a child —
 *  four node rows, all mounted (well under the virtualization threshold). */
function stableProps(): FileTreeProps {
  const loaded = new Map<string, LoadedDir>([
    ["", dir([folderNode("Notes"), fileNode("top.md"), fileNode("readme.md")])],
    ["Notes", dir([fileNode("a.md", "Notes/a.md")])],
  ]);
  return {
    vaultPath: "/v",
    activePath: null,
    loaded,
    expanded: new Set(["Notes"]),
    onToggle: vi.fn(),
    onListDir: vi.fn().mockResolvedValue(undefined),
    onRefreshDir: vi.fn().mockResolvedValue(undefined),
    onSelect: vi.fn(),
    onDeleteRequest: vi.fn(),
    onRemap: vi.fn(),
    pendingCreate: null,
    onCreateConsumed: vi.fn(),
  };
}

afterEach(() => {
  toastError.mockReset();
  treeRowRender.mockReset();
  vi.restoreAllMocks();
});

describe("FileTree — memo effectiveness (issue #25)", () => {
  it("does not re-render unchanged rows on an unrelated parent update", () => {
    const props = stableProps();
    const { rerender } = render(<FileTree {...props} />);

    // Every visible node row rendered once on mount.
    expect(treeRowRender).toHaveBeenCalled();
    treeRowRender.mockClear();

    // An unrelated parent update: FileTree is handed a brand-new (inert) callback
    // identity — forcing it through its own memo and a full re-render — while the
    // tree data, expansion, selection and every row-relevant prop are byte-for-byte
    // the same references. No row's inputs changed, so no row should re-render.
    rerender(<FileTree {...props} onCreateConsumed={vi.fn()} />);

    expect(treeRowRender).not.toHaveBeenCalled();
  });

  it("still re-renders rows when a row-relevant input actually changes", () => {
    // Guard against over-memoization / a stale closure freezing the tree: a real
    // change (selecting a file → activePath) must still propagate to the rows.
    const props = stableProps();
    const { rerender } = render(<FileTree {...props} />);
    treeRowRender.mockClear();

    rerender(<FileTree {...props} activePath="/v/top.md" />);

    expect(treeRowRender).toHaveBeenCalled();
  });
});
