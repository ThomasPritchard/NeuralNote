import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeForceGraph, type FakeForceGraph } from "../../test/fakeForceGraph";
import type { NeuralGalaxyProps } from "./NeuralGalaxy";
import { FORCE_PROFILES, NeuralGalaxy } from "./NeuralGalaxy";

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
    expect(screen.getByText("3 notes · 2 links · 1 cross-folder link")).toBeInTheDocument();
    expect(screen.getByText("My Vault")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("Cross-folder link")).toBeInTheDocument();
  });

  it("pluralizes each stat independently", () => {
    render(
      <NeuralGalaxy
        {...makeProps({ stats: { notes: 1, links: 1, crossFolderLinks: 0 } })}
      />,
    );
    expect(screen.getByText("1 note · 1 link · 0 cross-folder links")).toBeInTheDocument();
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

  it("keeps the neighbour count in step with the rendered rows when a link points at a missing node", () => {
    const props = makeProps();
    // A dangling link: "ghost.md" appears in the links but not in the nodes.
    props.data.links.push({ source: "alpha.md", target: "ghost.md" });
    render(<NeuralGalaxy {...props} />);
    clickNode("alpha.md");
    // Adjacency sees two neighbours, but only Beta resolves — the count must
    // match the single rendered row, never the raw adjacency length.
    expect(screen.getByText("1 connected note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByText(/ghost/i)).not.toBeInTheDocument();
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

  it("applies the 3D force profile on init: capped charge, link distance, gravity", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const p = FORCE_PROFILES["3d"];
    expect(harness.fg.__forces.charge.strength).toHaveBeenCalledWith(p.chargeStrength);
    expect(harness.fg.__forces.charge.distanceMax).toHaveBeenCalledWith(p.chargeDistanceMax);
    expect(harness.fg.__forces.link.distance).toHaveBeenCalledWith(p.linkDistance);
    expect(typeof harness.fg.__customForces.gravity).toBe("function");
  });

  it("swaps to the 2D force profile when the view toggles (and reheats the sim)", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    await user.click(screen.getByRole("button", { name: "2d" }));
    const p = FORCE_PROFILES["2d"];
    expect(harness.fg.__forces.charge.strength).toHaveBeenLastCalledWith(p.chargeStrength);
    expect(harness.fg.__forces.charge.distanceMax).toHaveBeenLastCalledWith(p.chargeDistanceMax);
    expect(harness.fg.__forces.link.distance).toHaveBeenLastCalledWith(p.linkDistance);
    expect(harness.fg.d3ReheatSimulation).toHaveBeenCalled();
  });

  it("3D gravity pulls nodes toward the origin on all three axes", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const gravity = harness.fg.__customForces.gravity as any;
    const node = { x: 100, y: -50, z: 20, vx: 0, vy: 0, vz: 0 };
    gravity.initialize([node]);
    gravity(1);
    expect(node.vx).toBeLessThan(0);
    expect(node.vy).toBeGreaterThan(0);
    expect(node.vz).toBeLessThan(0);
  });

  it("2D gravity pulls x/y only (z is pinned by the morph)", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    await user.click(screen.getByRole("button", { name: "2d" }));
    const gravity = harness.fg.__customForces.gravity as any;
    const node = { x: 100, y: -50, z: 20, vx: 0, vy: 0, vz: 0 };
    gravity.initialize([node]);
    gravity(1);
    expect(node.vx).toBeLessThan(0);
    expect(node.vy).toBeGreaterThan(0);
    expect(node.vz).toBe(0);
  });

  it("styles links per view profile — bridges stay pink and stronger in both", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    const normal = { bridge: false };
    const bridge = { bridge: true };

    const p3 = FORCE_PROFILES["3d"];
    expect(p3.bridgeWidth).toBeGreaterThan(p3.linkWidth);
    expect(harness.props.linkColor(normal)).toBe(`rgba(150,150,200,${p3.linkAlpha})`);
    expect(harness.props.linkColor(bridge)).toBe("rgba(244,170,255,0.85)");
    expect(harness.props.linkWidth(normal)).toBe(p3.linkWidth);
    expect(harness.props.linkWidth(bridge)).toBe(p3.bridgeWidth);

    await user.click(screen.getByRole("button", { name: "2d" }));
    const p2 = FORCE_PROFILES["2d"];
    expect(p2.bridgeWidth).toBeGreaterThan(p2.linkWidth);
    expect(harness.props.linkColor(normal)).toBe(`rgba(150,150,200,${p2.linkAlpha})`);
    expect(harness.props.linkColor(bridge)).toBe("rgba(244,170,255,0.85)");
    expect(harness.props.linkWidth(normal)).toBe(p2.linkWidth);
    expect(harness.props.linkWidth(bridge)).toBe(p2.bridgeWidth);
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
