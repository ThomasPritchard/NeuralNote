// Journeys 12–13: the graph view.
//   12. Ribbon → graph mounts with REAL link-graph data (mockVault implements
//       read_link_graph faithfully, so wikilink/md-link resolution, clusters,
//       and cross-folder bridges are honestly end-to-end); node click → detail
//       panel with neighbours → "Open in reader" lands back in the note view.
//   13. Graph navigation preserves dirty note tabs, and a backend failure shows
//       the in-pane error + Retry — never a silent empty galaxy.
//
// Only the WebGL renderer is stubbed: react-force-graph-3d is module-mocked to
// record its props (the DATA path stays real), mirroring the unit suites in
// workspace/GraphView.test.tsx / galaxy/NeuralGalaxy.test.tsx. jsdom has no
// layout, so a controllable ResizeObserver drives the pane size GraphView
// needs before it mounts the galaxy.
//
// skippedFiles: the in-memory backend can never fail per-file, so the mock
// always reports 0 — journeys assert the degradation notice is ABSENT at 0;
// the >0 rendering is unit-tested in GraphView.test.tsx.

import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { createFakeForceGraph, type FakeForceGraph } from "../test/fakeForceGraph";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

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
// three-spritetext draws on a 2D canvas context, which jsdom lacks.
vi.mock("three-spritetext", () => ({
  default: class {
    material = { transparent: false, opacity: 1 };
    position = { y: 0 };
    fontFace = "";
    fontWeight = "";
  },
}));

// Controllable ResizeObserver: tests drive the pane size by firing the captured
// callbacks (the real observer fires on observe; jsdom never does).
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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  resize.callbacks.length = 0;
  harness.fg = createFakeForceGraph();
  harness.props = null;
});

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

// Two folders; a wikilink WITHIN notes/ and a markdown link ACROSS folders
// (essays → notes), so the graph carries exactly one bridge. Bodies avoid `#`
// H1s: titles derive from stems, keeping reader headings unambiguous.
const LINKED_SEED: SeedEntry[] = [
  { kind: "file", relPath: "notes/Alpha.md", content: "Linked to [[Beta]].\n\nAlpha body." },
  { kind: "file", relPath: "notes/Beta.md", content: "Beta body." },
  {
    kind: "file",
    relPath: "essays/Gamma.md",
    content: "See [alpha note](../notes/Alpha.md).\n\nGamma body.",
  },
];

async function openVault(seed: SeedEntry[]): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name"); // workspace is up
  return result;
}

/** Ribbon → graph view → size the pane → wait for the stubbed renderer. */
async function enterGraphView(user: RenderAppResult["user"]) {
  await user.click(screen.getByRole("button", { name: "Graph view" }));
  fireResize(800, 600);
  await screen.findByTestId("force-graph-3d");
}

/** Drive a node click the way the real renderer would report it. */
function clickNode(id: string) {
  const node = harness.props.graphData.nodes.find((n: any) => n.id === id);
  expect(node).toBeDefined();
  act(() => harness.props.onNodeClick(node));
}

const legendCard = () => within(screen.getByText("Clusters").parentElement as HTMLElement);

describe("Journey 12: graph view over real link data", () => {
  it("mounts the galaxy with resolved nodes, links, and the cross-folder bridge", async () => {
    const { user } = await openVault(LINKED_SEED);
    await enterGraphView(user);

    // The seeded vault flows through real read_link_graph → graphTransform → the
    // renderer. (Node/link/bridge resolution is pinned at the contract and
    // transform layers — mockVault.test.ts + GraphView.test.tsx — so this case
    // only smoke-tests the mount pipeline and its legend/stats surface.)
    expect(screen.getByText("3 notes · 2 links · 1 cross-folder link")).toBeInTheDocument();
    const legend = within(screen.getByText("Clusters").parentElement as HTMLElement);
    expect(legend.getByText("essays")).toBeInTheDocument();
    expect(legend.getByText("notes")).toBeInTheDocument();
    expect(legend.getByText("Cross-folder link")).toBeInTheDocument();

    // skippedFiles is 0 through the mock — the degradation notice must be absent.
    expect(screen.queryByText(/couldn't be read/)).not.toBeInTheDocument();
  });

  it("treats the legend's inert current-level row as a no-op drill (spec §Addendum)", async () => {
    const { user } = await openVault(LINKED_SEED);
    await enterGraphView(user);

    // Drill into the "notes" cluster via the legend card (scoped there because
    // the sidebar tree also shows folder names).
    await user.click(legendCard().getByRole("button", { name: "notes" }));

    // At this level "notes" appears twice in the legend card: an accessible
    // preview-only BUTTON (a drill target) and the breadcrumb's inert current
    // level (SPAN). Clicking the BUTTON row must be a no-op: the drilled
    // payload stays exactly as it is. (Drill-recompute + breadcrumb restore are
    // pinned in GraphView.test.tsx; this guards the legend no-op edge only.)
    expect(
      legendCard()
        .getAllByText("notes")
        .map((el) => el.tagName)
        .sort(),
    ).toEqual(["BUTTON", "SPAN"]);
    const before = harness.props.graphData.nodes.map((n: any) => n.id).sort();
    await user.click(legendCard().getByRole("button", { name: "notes" }));
    expect(harness.props.graphData.nodes.map((n: any) => n.id).sort()).toEqual(before);
  });

  it("opens the detail panel on node click and routes 'Open in reader' back to the note view", async () => {
    const { user } = await openVault(LINKED_SEED);
    await enterGraphView(user);

    clickNode("notes/Alpha.md");

    // Detail panel: title, neighbour count, and both neighbours — the
    // cross-folder one carries its marker. Scoped to the panel: the sidebar
    // tree also lists "Beta.md" / "Gamma.md" buttons.
    const heading = screen.getByRole("heading", { name: "Alpha", level: 3 });
    const panel = within(heading.parentElement as HTMLElement);
    expect(panel.getByText("2 connected notes")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Beta" })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: /Gamma.*Cross-folder/ })).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Open in reader" }));

    // Back in the note view with the right note loaded (heading + breadcrumb).
    expect(await screen.findByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("notes/Alpha.md")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
  });
});

describe("Journey 13: graph guard and failure surfacing", () => {
  it("opens a graph note in a new tab while preserving the dirty buffer", async () => {
    const { user } = await openVault(LINKED_SEED);

    // notes/ is collapsed by default (lazy tree) — expand it to reach Beta.md.
    await user.click(await screen.findByRole("button", { name: /^notes/ }));

    // Open Beta and dirty its buffer.
    await user.click(await screen.findByRole("button", { name: "Beta.md" }));
    await screen.findByRole("heading", { name: "Beta", level: 1 });
    const editor = await screen.findByRole("textbox", { name: "Note content" });
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}");
    await user.type(editor, " edit");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

    // Switching to the graph is not destructive — no dialog, buffer preserved.
    await enterGraphView(user);

    // Open-in-reader for a DIFFERENT note is non-destructive: it gets its own
    // tab and the dirty Beta buffer stays available in the background.
    clickNode("essays/Gamma.md");
    await user.click(screen.getByRole("button", { name: "Open in reader" }));
    expect(await screen.findByRole("heading", { name: "Gamma", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("essays/Gamma.md")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Beta, unsaved changes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Beta, unsaved changes" }));
    const restoredEditor = await screen.findByRole("textbox", { name: "Note content" });
    await waitFor(() => expect(restoredEditor).toHaveTextContent("Beta body."));
    expect(restoredEditor).toHaveTextContent("edit");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("shows the in-pane error on a real graph-read failure — never a silent empty galaxy", async () => {
    const { user, backend } = await openVault(LINKED_SEED);
    backend.setFailure("read_link_graph", { kind: "io", message: "graph scan failed" });

    await user.click(screen.getByRole("button", { name: "Graph view" }));
    fireResize(800, 600);

    // A real read_link_graph rejection surfaces in-pane — never a silent empty
    // galaxy. (Retry-refetch mechanics are pinned in GraphView.test.tsx.)
    expect(await screen.findByText("graph scan failed")).toBeInTheDocument();
    expect(screen.queryByTestId("force-graph-3d")).not.toBeInTheDocument();
  });
});
