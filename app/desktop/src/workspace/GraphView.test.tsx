import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkGraph } from "../lib/types";
import { createFakeForceGraph, type FakeForceGraph } from "../test/fakeForceGraph";
import { CLUSTER_PALETTE } from "./galaxy/graph";
import { degreeVal } from "./graphTransform";
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
      val: degreeVal(1), // degree-derived size via the exported mapping seam
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
    fireResize(700, 600);
    const notice = await screen.findByText("2 file(s) couldn't be read");
    expect(notice).toBeInTheDocument();
    expect(notice.parentElement).toHaveAttribute("data-layout", "compact");
    expect(screen.getByTestId("force-graph-3d")).toBeInTheDocument();
  });

  it("caps a huge root graph at 500 nodes with a truncation notice; drilling under the cap clears it (PA-006)", async () => {
    // 505 flat notes in big/ plus a drillable small/ folder — over the cap at
    // root, comfortably under it once drilled.
    const nodes = Array.from({ length: 505 }, (_, i) => ({
      id: `big/note-${String(i).padStart(3, "0")}.md`,
      title: `Note ${i}`,
      cluster: "big",
    }));
    nodes.push(
      { id: "small/sub/x.md", title: "X", cluster: "small" },
      { id: "small/sub/y.md", title: "Y", cluster: "small" },
      { id: "small/z.md", title: "Z", cluster: "small" },
    );
    mocks.readLinkGraph.mockResolvedValue(linkGraph({ nodes, links: [] }));
    render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    await screen.findByTestId("force-graph-3d");

    // Only the cap reaches the 3D sim, and the partial view says so.
    expect(harness.props.graphData.nodes).toHaveLength(500);
    expect(
      screen.getByText(/Showing the 500 most-linked of 508 notes/),
    ).toBeInTheDocument();

    // The capped-out folder stays in the legend; drilling re-derives the level
    // under the cap, so the notice disappears with the truncation.
    await userEvent.click(screen.getByRole("button", { name: "small" }));
    expect(harness.props.graphData.nodes).toHaveLength(3);
    expect(screen.queryByText(/most-linked of/)).not.toBeInTheDocument();
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

// ── Cluster drill-down (spec §Addendum) ─────────────────────────────────────
describe("GraphView cluster drill-down", () => {
  // Two levels under notes/ so the journey can drill twice.
  const deepGraph = (): LinkGraph => ({
    nodes: [
      { id: "alpha.md", title: "Alpha", cluster: "" },
      { id: "notes/beta.md", title: "Beta", cluster: "notes" },
      { id: "notes/daily/gamma.md", title: "Gamma", cluster: "notes" },
      { id: "notes/daily/delta.md", title: "Delta", cluster: "notes" },
      { id: "essays/epsilon.md", title: "Epsilon", cluster: "essays" },
    ],
    links: [
      { source: "alpha.md", target: "notes/beta.md", bridge: true },
      { source: "notes/beta.md", target: "notes/daily/gamma.md", bridge: false },
      { source: "notes/daily/gamma.md", target: "notes/daily/delta.md", bridge: false },
      { source: "essays/epsilon.md", target: "notes/beta.md", bridge: true },
    ],
    skippedFiles: 0,
  });

  const nodeIds = () => harness.props.graphData.nodes.map((n: any) => n.id).sort();

  async function renderDeep() {
    mocks.readLinkGraph.mockResolvedValue(deepGraph());
    const view = render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    await screen.findByTestId("force-graph-3d");
    return view;
  }

  it("drills into a clicked cluster: filtered galaxy, breadcrumb, outside-links stat", async () => {
    await renderDeep();
    expect(screen.queryByRole("navigation", { name: "Folder breadcrumb" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "notes" }));

    // The galaxy remounted with ONLY the folder's notes and links.
    expect(nodeIds()).toEqual(["notes/beta.md", "notes/daily/delta.md", "notes/daily/gamma.md"]);
    expect(harness.props.graphData.links).toHaveLength(2);

    // Breadcrumb: clickable root, inert current level.
    const crumb = screen.getByRole("navigation", { name: "Folder breadcrumb" });
    expect(within(crumb).getByRole("button", { name: "All notes" })).toBeInTheDocument();
    expect(within(crumb).getByText("notes")).toBeInTheDocument();
    expect(within(crumb).queryByRole("button", { name: "notes" })).toBeNull();

    // Stats recompute at this level, with the outside-links segment appended
    // (alpha→beta and epsilon→beta each leave one foot outside the folder).
    expect(
      screen.getByText("3 notes · 2 links · 1 cross-folder link · 2 links lead outside"),
    ).toBeInTheDocument();
  });

  it("drills two levels, then breadcrumb ancestors jump back up", async () => {
    await renderDeep();
    await userEvent.click(screen.getByRole("button", { name: "notes" }));
    await userEvent.click(screen.getByRole("button", { name: "daily" }));

    expect(nodeIds()).toEqual(["notes/daily/delta.md", "notes/daily/gamma.md"]);
    const crumb = screen.getByRole("navigation", { name: "Folder breadcrumb" });
    // "notes" is an ancestor now (clickable); "daily" is current (inert).
    expect(within(crumb).queryByRole("button", { name: "daily" })).toBeNull();

    await userEvent.click(within(crumb).getByRole("button", { name: "notes" }));
    expect(nodeIds()).toEqual(["notes/beta.md", "notes/daily/delta.md", "notes/daily/gamma.md"]);

    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Folder breadcrumb" })).getByRole("button", {
        name: "All notes",
      }),
    );
    expect(nodeIds()).toEqual([
      "alpha.md",
      "essays/epsilon.md",
      "notes/beta.md",
      "notes/daily/delta.md",
      "notes/daily/gamma.md",
    ]);
    expect(screen.queryByRole("navigation", { name: "Folder breadcrumb" })).toBeNull();
  });

  it("resets a stale trail to root when a refetch no longer has notes under it", async () => {
    mocks.readLinkGraph.mockResolvedValueOnce(deepGraph());
    const { rerender } = render(<GraphView onOpenNote={vi.fn()} />);
    fireResize(800, 600);
    await screen.findByTestId("force-graph-3d");
    await userEvent.click(screen.getByRole("button", { name: "notes" }));
    expect(nodeIds()).toHaveLength(3);

    // A vault-name change re-runs the fetch; the new graph lost the notes/
    // folder entirely — the stale trail must reset, never an empty galaxy.
    const prunedGraph: LinkGraph = {
      nodes: [
        { id: "alpha.md", title: "Alpha", cluster: "" },
        { id: "essays/epsilon.md", title: "Epsilon", cluster: "essays" },
      ],
      links: [],
      skippedFiles: 0,
    };
    mocks.readLinkGraph.mockResolvedValueOnce(prunedGraph);
    mocks.useVault.mockReturnValue({ vault: { name: "Other Vault", path: "/v2" } });
    rerender(<GraphView onOpenNote={vi.fn()} />);
    await screen.findByTestId("force-graph-3d");

    expect(nodeIds()).toEqual(["alpha.md", "essays/epsilon.md"]);
    expect(screen.queryByRole("navigation", { name: "Folder breadcrumb" })).toBeNull();
  });
});
