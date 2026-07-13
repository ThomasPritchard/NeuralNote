import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeForceGraph, type FakeForceGraph } from "../../test/fakeForceGraph";
import type { NeuralGalaxyProps } from "./NeuralGalaxy";
import { BRIDGE_FADED_COLOR, FORCE_PROFILES, LINK_FADE, NeuralGalaxy } from "./NeuralGalaxy";
import { CLUSTER_PALETTE } from "./graph";
import { registerNode } from "./nodeRegistry";

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
      "": { label: "My Vault", color: "#7d6fe0", drillable: false },
      notes: { label: "notes", color: "#2f9d93", drillable: true },
    },
    stats: { notes: 3, links: 2, crossFolderLinks: 1, outsideLinks: 0 },
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

// Handles normally register from makeStarNode (mocked away with the
// renderer) — register fakes so the focus plumbing has targets.
function registerFakes() {
  const make = () => ({
    update: vi.fn<(time: number) => void>(),
    setHover: vi.fn<(on: boolean) => void>(),
    setDimmed: vi.fn<(on: boolean) => void>(),
  });
  const handles = { alpha: make(), beta: make(), gamma: make() };
  registerNode("alpha.md", handles.alpha);
  registerNode("notes/beta.md", handles.beta);
  registerNode("notes/gamma.md", handles.gamma);
  return handles;
}

function hover(id: string | null) {
  const node = id ? harness.props.graphData.nodes.find((n: any) => n.id === id) : null;
  act(() => harness.props.onNodeHover(node));
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

  it("compacts the toolbar at the narrow native pane width and labels galaxy search", () => {
    render(<NeuralGalaxy {...makeProps({ width: 700 })} />);

    expect(screen.getByTestId("galaxy-toolbar")).toHaveAttribute(
      "data-layout",
      "compact",
    );
    expect(screen.getByRole("searchbox", { name: "Search the galaxy" })).toBeInTheDocument();
  });

  it("pluralizes each stat independently", () => {
    render(
      <NeuralGalaxy
        {...makeProps({ stats: { notes: 1, links: 1, crossFolderLinks: 0, outsideLinks: 0 } })}
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

  describe("hover-focus dimming", () => {
    it("dims everything outside the hovered node's neighbourhood", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();
      hover("alpha.md");
      // alpha + its direct neighbour beta stay lit; gamma dims.
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
    });

    it("restores every node on hover-end when nothing is selected", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();
      hover("alpha.md");
      hover(null);
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
    });

    it("fades links outside the neighbourhood — only links touching the hovered node stay lit", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      registerFakes();
      const p = FORCE_PROFILES["3d"];
      const bridgeLink = { source: "alpha.md", target: "notes/beta.md", bridge: true };
      const normalLink = { source: "notes/beta.md", target: "notes/gamma.md", bridge: false };

      hover("alpha.md");
      // alpha↔beta touches the hovered node: full styling. beta↔gamma does
      // not (even though beta is lit): faded.
      expect(harness.props.linkColor(bridgeLink)).toBe("rgba(244,170,255,0.85)");
      expect(harness.props.linkDirectionalParticles(bridgeLink)).toBe(3);
      expect(harness.props.linkColor(normalLink)).toBe(
        `rgba(150,150,200,${+(p.linkAlpha * LINK_FADE).toFixed(3)})`,
      );

      hover("notes/gamma.md");
      // Now the bridge is outside the lit neighbourhood: it must stop drawing
      // the eye — faded colour, particles off.
      expect(harness.props.linkColor(bridgeLink)).toBe(BRIDGE_FADED_COLOR);
      expect(harness.props.linkDirectionalParticles(bridgeLink)).toBe(0);
      expect(harness.props.linkColor(normalLink)).toBe(`rgba(150,150,200,${p.linkAlpha})`);

      hover(null);
      expect(harness.props.linkColor(bridgeLink)).toBe("rgba(244,170,255,0.85)");
      expect(harness.props.linkDirectionalParticles(bridgeLink)).toBe(3);
      expect(harness.props.linkColor(normalLink)).toBe(`rgba(150,150,200,${p.linkAlpha})`);
    });

    it("resolves post-simulation object endpoints when matching links to the lit set", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      registerFakes();
      hover("alpha.md");
      const objectLink = {
        source: { id: "alpha.md" },
        target: { id: "notes/beta.md" },
        bridge: true,
      };
      expect(harness.props.linkColor(objectLink)).toBe("rgba(244,170,255,0.85)");
    });

    it("keeps the selection's neighbourhood lit while the panel is open; hover overrides", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();

      clickNode("alpha.md"); // panel open: {alpha, beta} lit
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);

      hover("notes/gamma.md"); // hover wins while it lasts: {gamma, beta} lit
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);

      hover(null); // falls back to the selection's neighbourhood
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);

      act(() => harness.props.onBackgroundClick()); // dismiss: everything restored
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
    });

    it("clears a parked hover when the view toggles (the lib only re-raycasts on mousemove)", async () => {
      const user = userEvent.setup();
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();
      hover("alpha.md");
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);

      await user.click(screen.getByRole("button", { name: "2d" }));
      expect(h.alpha.setHover).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
    });
  });

  describe("interactive legend (cluster drill-down)", () => {
    it("renders folder cluster rows as buttons that fire onClusterSelect with the cluster key", async () => {
      const user = userEvent.setup();
      const onClusterSelect = vi.fn();
      render(<NeuralGalaxy {...makeProps({ onClusterSelect })} />);
      await user.click(screen.getByRole("button", { name: "notes" }));
      expect(onClusterSelect).toHaveBeenCalledWith("notes");
    });

    it("renders the '' row (the current folder's own notes) as a preview-only row that never drills", async () => {
      const user = userEvent.setup();
      const onClusterSelect = vi.fn();
      render(<NeuralGalaxy {...makeProps({ onClusterSelect })} />);
      // A real button (keyboard focus drives the same cluster preview as
      // hover — pinned below), but with no drill action: clicking is a no-op.
      await user.click(screen.getByRole("button", { name: "My Vault" }));
      expect(onClusterSelect).not.toHaveBeenCalled();
    });

    it("keyboard focus on the '' row previews its cluster exactly like hover; blur restores", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();

      fireEvent.focus(screen.getByRole("button", { name: "My Vault" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(true);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);

      fireEvent.blur(screen.getByRole("button", { name: "My Vault" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
    });

    it("survives a legend click without onClusterSelect (prop is optional)", async () => {
      const user = userEvent.setup();
      render(<NeuralGalaxy {...makeProps()} />);
      await user.click(screen.getByRole("button", { name: "notes" }));
      expect(screen.getByText("notes")).toBeInTheDocument(); // no throw, row intact
    });

    it("shows the drill chevron only on clusters with sub-structure", () => {
      const flat = makeProps({
        clusters: {
          "": { label: "My Vault", color: "#7d6fe0", drillable: false },
          notes: { label: "notes", color: "#2f9d93", drillable: false },
        },
      });
      const { unmount } = render(<NeuralGalaxy {...flat} />);
      expect(screen.getByRole("button", { name: "notes" }).querySelector("svg")).toBeNull();
      unmount();

      render(<NeuralGalaxy {...makeProps()} />); // notes is drillable here
      expect(screen.getByRole("button", { name: "notes" }).querySelector("svg")).not.toBeNull();
    });

    it("hovering a legend row lights the whole cluster and dims the rest; leave restores", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();

      fireEvent.mouseEnter(screen.getByRole("button", { name: "notes" }));
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true);

      fireEvent.mouseLeave(screen.getByRole("button", { name: "notes" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);
    });

    it("previews the '' cluster from its plain row too", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();
      fireEvent.mouseEnter(screen.getByText("My Vault"));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(true);
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
      fireEvent.mouseLeave(screen.getByText("My Vault"));
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
    });

    it("fades links outside the previewed cluster — intra-cluster links stay lit, bridges out fade", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      registerFakes();
      const p = FORCE_PROFILES["3d"];
      const bridgeOut = { source: "alpha.md", target: "notes/beta.md", bridge: true };
      const intra = { source: "notes/beta.md", target: "notes/gamma.md", bridge: false };

      fireEvent.mouseEnter(screen.getByRole("button", { name: "notes" }));
      // Both endpoints inside the previewed cluster: full styling.
      expect(harness.props.linkColor(intra)).toBe(`rgba(150,150,200,${p.linkAlpha})`);
      // The bridge leaves the cluster: it must stop drawing the eye.
      expect(harness.props.linkColor(bridgeOut)).toBe(BRIDGE_FADED_COLOR);
      expect(harness.props.linkDirectionalParticles(bridgeOut)).toBe(0);

      fireEvent.mouseLeave(screen.getByRole("button", { name: "notes" }));
      expect(harness.props.linkColor(bridgeOut)).toBe("rgba(244,170,255,0.85)");
    });

    it("restores to the SELECTION's focus (not full brightness) when the legend preview ends", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();

      clickNode("alpha.md"); // selection: {alpha, beta} lit, gamma dim
      fireEvent.mouseEnter(screen.getByRole("button", { name: "notes" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true); // preview wins
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(false);

      fireEvent.mouseLeave(screen.getByRole("button", { name: "notes" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false); // selection focus back
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
    });

    it("node-hover and legend-hover share the focus channel — last event wins", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      const h = registerFakes();

      fireEvent.mouseEnter(screen.getByRole("button", { name: "notes" }));
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true);

      hover("alpha.md"); // node hover fired later: it takes the channel
      expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(false);
      expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false); // alpha's neighbour
      expect(h.gamma.setDimmed).toHaveBeenLastCalledWith(true);
    });

    it("appends the outside-links stat segment only when links lead outside", () => {
      const { unmount } = render(
        <NeuralGalaxy
          {...makeProps({ stats: { notes: 3, links: 2, crossFolderLinks: 1, outsideLinks: 212 } })}
        />,
      );
      expect(
        screen.getByText("3 notes · 2 links · 1 cross-folder link · 212 links lead outside"),
      ).toBeInTheDocument();
      unmount();

      render(
        <NeuralGalaxy
          {...makeProps({ stats: { notes: 3, links: 2, crossFolderLinks: 1, outsideLinks: 1 } })}
        />,
      );
      expect(
        screen.getByText("3 notes · 2 links · 1 cross-folder link · 1 link leads outside"),
      ).toBeInTheDocument();
    });

    it("renders the breadcrumb slot inside the legend card, above the cluster rows", () => {
      render(
        <NeuralGalaxy {...makeProps({ breadcrumb: <span data-testid="crumb">Areas</span> })} />,
      );
      const crumb = screen.getByTestId("crumb");
      const legendCard = screen.getByText("Clusters").parentElement as HTMLElement;
      expect(legendCard.contains(crumb)).toBe(true);
      // Above the rows: the crumb precedes the first cluster row in the card.
      const rows = screen.getByText("My Vault");
      expect(crumb.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps the Cross-folder legend row non-interactive", () => {
      render(<NeuralGalaxy {...makeProps({ onClusterSelect: vi.fn() })} />);
      expect(
        screen.queryByRole("button", { name: /Cross-folder link/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Cross-folder link")).toBeInTheDocument();
    });
  });

  describe("auto-framing (fires once, never fights the user's camera)", () => {
    // The engine restarts on every morph reheat, profile swap, and drag — a
    // stop can land seconds into the user's own zooming. Auto-fit must fire
    // at most once per mount and die on first user wheel/pointerdown.
    it("zoomToFits exactly once across repeated engine stops", () => {
      render(<NeuralGalaxy {...makeProps()} />);
      act(() => harness.props.onEngineStop());
      act(() => harness.props.onEngineStop());
      expect(harness.fg.zoomToFit).toHaveBeenCalledTimes(1);
    });

    it("cancels the pending auto-frame on user wheel — an engine stop no longer refits", () => {
      const { container } = render(<NeuralGalaxy {...makeProps()} />);
      fireEvent.wheel(container.firstChild as Element);
      act(() => harness.props.onEngineStop());
      expect(harness.fg.zoomToFit).not.toHaveBeenCalled();
    });

    it("cancels on pointerdown too (drag/orbit owns the camera)", () => {
      const { container } = render(<NeuralGalaxy {...makeProps()} />);
      fireEvent.pointerDown(container.firstChild as Element);
      act(() => harness.props.onEngineStop());
      expect(harness.fg.zoomToFit).not.toHaveBeenCalled();
    });

    it("keeps the user-initiated 2D-morph fit alive after the auto-frame is cancelled", async () => {
      // Reduced motion collapses the morph tween to 0ms so its completion
      // callback (the intentional zoomToFit) runs synchronously in jsdom.
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
      try {
        const user = userEvent.setup();
        const { container } = render(<NeuralGalaxy {...makeProps()} />);
        fireEvent.wheel(container.firstChild as Element); // kill auto-framing
        await user.click(screen.getByRole("button", { name: "2d" }));
        expect(harness.fg.zoomToFit).toHaveBeenCalledWith(600, 100);
        // …and the dead auto-frame stays dead through later engine stops.
        act(() => harness.props.onEngineStop());
        expect(harness.fg.zoomToFit).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("resets per mount: a remount (the drill-down isolation path) auto-fits once again", () => {
      const { container, unmount } = render(<NeuralGalaxy {...makeProps()} />);
      fireEvent.wheel(container.firstChild as Element);
      act(() => harness.props.onEngineStop());
      expect(harness.fg.zoomToFit).not.toHaveBeenCalled();
      unmount();

      render(<NeuralGalaxy {...makeProps()} />); // fresh mount = fresh guard
      act(() => harness.props.onEngineStop());
      expect(harness.fg.zoomToFit).toHaveBeenCalledTimes(1);
    });
  });

  it("marks the active view on the 3D/2D toggle and morphs the camera", async () => {
    const user = userEvent.setup();
    render(<NeuralGalaxy {...makeProps()} />);
    const dimensionGroup = screen.getByRole("group", { name: "Graph dimension" });
    expect(dimensionGroup.tagName).toBe("FIELDSET");
    expect(dimensionGroup).not.toHaveAttribute("role");
    const btn2d = screen.getByRole("button", { name: "2d" });
    const btn3d = screen.getByRole("button", { name: "3d" });
    expect(btn3d).toHaveAttribute("aria-pressed", "true");
    expect(btn2d).toHaveAttribute("aria-pressed", "false");

    await user.click(btn2d);
    expect(btn2d).toHaveAttribute("aria-pressed", "true");
    expect(btn3d).toHaveAttribute("aria-pressed", "false");
    expect(harness.fg.__controls.noRotate).toBe(true);
    expect(harness.fg.cameraPosition).toHaveBeenCalled();
    expect(harness.fg.d3ReheatSimulation).toHaveBeenCalled();
  });
});

describe("tooltip HTML escaping (nodeLabel is the one raw-innerHTML sink)", () => {
  // Note titles and folder names are untrusted vault content; float-tooltip
  // renders nodeLabel's string via innerHTML with no escaping of its own.
  it("escapes a hostile note title", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const html = harness.props.nodeLabel({
      title: '<img src=x onerror=alert(1)>',
      cluster: "notes",
      color: "#7d6fe0",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a hostile folder/cluster name on the fallback path", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const html = harness.props.nodeLabel({
      title: "ok",
      cluster: '<b onmouseover=x>evil</b>',
      color: "#7d6fe0",
    });
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;b onmouseover=x&gt;evil&lt;/b&gt;");
  });

  it("escapes single quotes so escaped text stays inert in attribute position (PA-025)", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const html = harness.props.nodeLabel({
      title: "Rock 'n' roll' onmouseover='alert(1)",
      cluster: "notes",
      color: "#7d6fe0",
    });
    // The template itself uses no single quotes, so none may survive at all.
    expect(html).not.toContain("'");
    expect(html).toContain("Rock &#39;n&#39; roll&#39; onmouseover=&#39;alert(1)");
  });

  it("pins the tooltip colour to a strict hex — off-form values fall back to the palette (PA-025)", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const html = harness.props.nodeLabel({
      title: "ok",
      cluster: "notes",
      color: 'red;background:url(x)" onmouseover="alert(1)',
    });
    expect(html).toContain(`color:${CLUSTER_PALETTE[0]}`);
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("url(x)");
  });

  it("passes a legitimate palette hex through unchanged", () => {
    render(<NeuralGalaxy {...makeProps()} />);
    const html = harness.props.nodeLabel({ title: "ok", cluster: "notes", color: "#2f9d93" });
    expect(html).toContain("color:#2f9d93");
  });
});

describe("legend cluster preview vs raycast noise", () => {
  it("survives a spurious onNodeHover(null) while the pointer is on the legend row", () => {
    // The sim can drift a node out from under the last on-canvas pointer
    // position and fire onHover(null) — that must not wipe an active preview.
    render(<NeuralGalaxy {...makeProps()} />);
    const h = registerFakes();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "notes" }));
    expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true);

    act(() => harness.props.onNodeHover(null));
    expect(h.alpha.setDimmed).toHaveBeenLastCalledWith(true);
    expect(h.beta.setDimmed).toHaveBeenLastCalledWith(false);
  });
});
