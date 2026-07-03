import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkGraph } from "../lib/types";
import { createFakeForceGraph, type FakeForceGraph } from "../test/fakeForceGraph";
import { CLUSTER_PALETTE } from "./galaxy/graph";
import { GraphView } from "./GraphView";

const mocks = vi.hoisted(() => ({
  readLinkGraph: vi.fn(),
  useVault: vi.fn(),
}));

// Real errorMessage/toGalaxy stay live; only the Tauri call is faked.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  readLinkGraph: mocks.readLinkGraph,
}));
vi.mock("../lib/store", () => ({ useVault: mocks.useVault }));

// The 3D renderer is stubbed: it records its props and hands NeuralGalaxy the
// fake fg instance (React 19 passes `ref` as a plain prop).
const harness = vi.hoisted(() => ({
  fg: null as unknown as FakeForceGraph,
  props: null as any,
}));
vi.mock("react-force-graph-3d", () => ({
  default: (props: any) => {
    harness.props = props;
    if (props.ref) props.ref.current = harness.fg;
    return <div data-testid="force-graph-3d" />;
  },
}));
vi.mock("three-spritetext", () => ({
  default: class {
    material = { transparent: false, opacity: 1 };
    position = { y: 0 };
    fontFace = "";
    fontWeight = "";
  },
}));

// Controllable ResizeObserver: tests drive the container size by firing the
// captured callbacks (the real observer fires on observe; jsdom never does).
const resize = vi.hoisted(() => ({ callbacks: [] as ((entries: unknown[]) => void)[] }));
class ControlledResizeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    resize.callbacks.push(cb);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function fireResize(width: number, height: number) {
  act(() => {
    for (const cb of resize.callbacks) cb([{ contentRect: { width, height } }]);
  });
}

const linkGraph = (overrides: Partial<LinkGraph> = {}): LinkGraph => ({
  nodes: [
    { id: "alpha.md", title: "Alpha", cluster: "" },
    { id: "notes/beta.md", title: "Beta", cluster: "notes" },
  ],
  links: [{ source: "alpha.md", target: "notes/beta.md", bridge: true }],
  skippedFiles: 0,
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  resize.callbacks.length = 0;
  harness.fg = createFakeForceGraph();
  harness.props = null;
  mocks.readLinkGraph.mockReset();
  mocks.useVault.mockReturnValue({ vault: { name: "My Vault", path: "/v" } });
});

describe("GraphView", () => {
  it("shows a loading spinner while the graph is being read", () => {
    mocks.readLinkGraph.mockReturnValue(new Promise(() => {}));
    render(<GraphView onOpenNote={vi.fn()} />);
    expect(screen.getByLabelText("Loading graph")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
  });

  it("mounts the galaxy with transformed props once loaded AND sized", async () => {
    mocks.readLinkGraph.mockResolvedValue(linkGraph());
    render(<GraphView onOpenNote={vi.fn()} />);

    // Data loaded but the container is still 0×0 — no galaxy yet, and the
    // spinner stays up (a ready-but-unsized pane must never look blank).
    await act(async () => {});
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading graph")).toBeInTheDocument();

    fireResize(800, 600);
    expect(screen.getByTestId("force-graph-3d")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading graph")).not.toBeInTheDocument();
    expect(
      screen.getByText("2 notes · 1 link · 1 cross-folder link"),
    ).toBeInTheDocument();

    // Transformed shape reached the renderer: decorated vals/colours, and the
    // vault name became the root-cluster label.
    const nodes = harness.props.graphData.nodes;
    expect(nodes[0]).toMatchObject({
      id: "alpha.md",
      val: 3.25, // degree 1 → 2.5 + 0.75
      color: CLUSTER_PALETTE[0],
    });
    expect(harness.props.width).toBe(800);
    expect(harness.props.height).toBe(600);
    expect(screen.getByText("My Vault")).toBeInTheDocument();
  });

  it("falls back to 'Vault root' when no vault name is available", async () => {
    mocks.useVault.mockReturnValue({ vault: null });
    mocks.readLinkGraph.mockResolvedValue(linkGraph());
    render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    expect(await screen.findByText("Vault root")).toBeInTheDocument();
  });

  it("shows the empty state for a vault with no notes", async () => {
    mocks.readLinkGraph.mockResolvedValue(linkGraph({ nodes: [], links: [] }));
    render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    expect(await screen.findByText("No notes yet")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
  });

  it("surfaces read failures with a Retry button that refetches — never an empty galaxy", async () => {
    mocks.readLinkGraph
      .mockRejectedValueOnce({ kind: "io", message: "vault unreadable" })
      .mockResolvedValueOnce(linkGraph());
    render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);

    expect(await screen.findByText("vault unreadable")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByTestId("force-graph-3d")).toBeInTheDocument();
    expect(mocks.readLinkGraph).toHaveBeenCalledTimes(2);
  });

  it("renders a non-blocking notice when files were skipped", async () => {
    mocks.readLinkGraph.mockResolvedValue(linkGraph({ skippedFiles: 2 }));
    render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    expect(await screen.findByText("2 file(s) couldn't be read")).toBeInTheDocument();
    expect(screen.getByTestId("force-graph-3d")).toBeInTheDocument();
  });

  it("routes 'Open in reader' through onOpenNote with the node's relPath", async () => {
    mocks.readLinkGraph.mockResolvedValue(linkGraph());
    const onOpenNote = vi.fn();
    render(<GraphView onOpenNote={onOpenNote} />);
    fireResize(800, 600);
    await screen.findByTestId("force-graph-3d");

    const beta = harness.props.graphData.nodes.find((n: any) => n.id === "notes/beta.md");
    act(() => harness.props.onNodeClick(beta));
    await userEvent.click(screen.getByRole("button", { name: "Open in reader" }));
    expect(onOpenNote).toHaveBeenCalledWith("notes/beta.md");
  });
});
