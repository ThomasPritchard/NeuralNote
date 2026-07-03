import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeForceGraph, type FakeForceGraph } from "../../test/fakeForceGraph";
import type { NeuralGalaxyProps } from "./NeuralGalaxy";
import { NeuralGalaxy } from "./NeuralGalaxy";

// The 3D renderer is mocked away: these tests drive the plain-DOM overlays
// (top bar, search, legend, detail panel) and the imperative fg traffic.
const harness = vi.hoisted(() => ({
  fg: null as unknown as FakeForceGraph,
  props: null as any,
}));

vi.mock("react-force-graph-3d", () => ({
  // React 19: function components receive `ref` as a plain prop (never
  // auto-attached), so the stub hands the fake fg instance to NeuralGalaxy.
  default: (props: any) => {
    harness.props = props;
    if (props.ref) props.ref.current = harness.fg;
    return <div data-testid="force-graph-3d" />;
  },
}));

// three-spritetext draws on a 2D canvas context, which jsdom lacks — mock it
// in case a node factory (nodeThreeObject) is exercised.
vi.mock("three-spritetext", () => ({
  default: class {
    material = { transparent: false, opacity: 1 };
    position = { y: 0 };
    fontFace = "";
    fontWeight = "";
  },
}));

function makeProps(overrides: Partial<NeuralGalaxyProps> = {}): NeuralGalaxyProps {
  return {
    // Fresh objects per call — the component mutates node objects (morph pins).
    data: {
      nodes: [
        { id: "alpha.md", title: "Alpha", cluster: "", val: 7, color: "#7d6fe0" },
        { id: "notes/beta.md", title: "Beta", cluster: "notes", val: 4, color: "#2f9d93" },
        { id: "notes/gamma.md", title: "Gamma", cluster: "notes", val: 2.5, color: "#2f9d93" },
      ],
      links: [
        { source: "alpha.md", target: "notes/beta.md", bridge: true },
        { source: "notes/beta.md", target: "notes/gamma.md" },
      ],
    },
    clusters: {
      "": { label: "My Vault", color: "#7d6fe0" },
      notes: { label: "notes", color: "#2f9d93" },
    },
    stats: { notes: 3, links: 2, crossFolderLinks: 1 },
    width: 800,
    height: 600,
    onOpenNote: vi.fn(),
    ...overrides,
  };
}

function clickNode(id: string) {
  const node = harness.props.graphData.nodes.find((n: any) => n.id === id);
  act(() => harness.props.onNodeClick(node));
}

beforeEach(() => {
  harness.fg = createFakeForceGraph();
  harness.props = null;
});

describe("NeuralGalaxy", () => {
  it("renders the stats line and the cluster legend with the cross-folder row", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    expect(screen.getByText("3 notes · 2 links · 1 cross-folder links")).toBeInTheDocument();
    expect(screen.getByText("My Vault")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("Cross-folder link")).toBeInTheDocument();
  });

  it("adds a bloom pass on mount and removes the SAME pass on unmount (StrictMode safety)", () => {
    const { unmount } = render(<NeuralGalaxy {...makeProps()} />);
    expect(harness.fg.__composer.addPass).toHaveBeenCalledTimes(1);
    const pass = harness.fg.__composer.addPass.mock.calls[0][0];
    unmount();
    expect(harness.fg.__composer.removePass).toHaveBeenCalledWith(pass);
  });

  it("filters the search dropdown, flies to the top result on Enter, clears on Escape", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    const input = screen.getByPlaceholderText("Search the galaxy…");

    await user.type(input, "bet");
    expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Alpha/ })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "zzz");
    expect(screen.getByText(/No notes match/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "bet");
    fireEvent.keyDown(input, { key: "Enter" });
    // Picking the top result selects it (detail panel) and flies the camera.
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(harness.fg.cameraPosition).toHaveBeenCalled();
    expect(input).toHaveValue(""); // query cleared by the pick

    await user.type(input, "bet");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
  });

  it("opens the detail panel on node click with cluster badge and neighbours", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    clickNode("alpha.md");
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("1 connected note")).toBeInTheDocument();
    const neighbour = screen.getByRole("button", { name: /Beta/ });
    expect(neighbour).toHaveTextContent("Cross-folder");
    expect(harness.fg.cameraPosition).toHaveBeenCalled();
  });

  it("traverses to a neighbour from the panel", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    clickNode("alpha.md");
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.getByText("2 connected notes")).toBeInTheDocument();
  });

  it("closes the panel via ✕ and restores the pre-focus camera", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    clickNode("alpha.md");
    const flights = harness.fg.cameraPosition.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
    // One more flight: back out to the camera pose saved before the click-focus.
    expect(harness.fg.cameraPosition.mock.calls.length).toBe(flights + 1);
  });

  it("routes 'Open in reader' to onOpenNote with the node id", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<NeuralGalaxy {...props} />);
    clickNode("notes/beta.md");
    await user.click(screen.getByRole("button", { name: "Open in reader" }));
    expect(props.onOpenNote).toHaveBeenCalledWith("notes/beta.md");
  });

  it("marks the active view on the 3D/2D toggle and morphs the camera", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    const btn2d = screen.getByRole("button", { name: "2d" });
    const btn3d = screen.getByRole("button", { name: "3d" });
    expect(btn3d.className).toContain("bg-primary");
    expect(btn2d.className).not.toContain("bg-primary");

    await user.click(btn2d);
    expect(btn2d.className).toContain("bg-primary");
    expect(btn3d.className).not.toContain("bg-primary");
    expect(harness.fg.__controls.noRotate).toBe(true);
    expect(harness.fg.cameraPosition).toHaveBeenCalled();
    expect(harness.fg.d3ReheatSimulation).toHaveBeenCalled();
  });
});
