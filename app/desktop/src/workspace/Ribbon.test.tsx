import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Ribbon } from "./Ribbon";

type RibbonProps = Parameters<typeof Ribbon>[0];

function renderRibbon(over: Partial<RibbonProps> = {}) {
  const props: RibbonProps = {
    sidebarPanel: "files",
    centerView: "note",
    onShowFiles: vi.fn(),
    onShowSearch: vi.fn(),
    onToggleGraph: vi.fn(),
    ...over,
  };
  render(<Ribbon {...props} />);
  return props;
}

describe("Ribbon — active states", () => {
  it("marks Files pressed when the files panel is showing", () => {
    renderRibbon({ sidebarPanel: "files" });
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks Search pressed when the search panel is showing", () => {
    renderRibbon({ sidebarPanel: "search" });
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks Graph view pressed independently of the sidebar panel", () => {
    renderRibbon({ centerView: "graph" });
    expect(screen.getByRole("button", { name: "Graph view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not disable the live buttons", () => {
    renderRibbon();
    for (const name of ["Files", "Search", "Graph view"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute(
        "aria-disabled",
      );
    }
  });
});

describe("Ribbon — callbacks", () => {
  it("fires onShowFiles for the Files button", async () => {
    const props = renderRibbon({ sidebarPanel: "search" });
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(props.onShowFiles).toHaveBeenCalledTimes(1);
    expect(props.onShowSearch).not.toHaveBeenCalled();
  });

  it("fires onShowSearch for the Search button", async () => {
    const props = renderRibbon();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(props.onShowSearch).toHaveBeenCalledTimes(1);
  });

  it("fires onToggleGraph for the Graph view button", async () => {
    const props = renderRibbon();
    await userEvent.click(screen.getByRole("button", { name: "Graph view" }));
    expect(props.onToggleGraph).toHaveBeenCalledTimes(1);
  });

  it("has no Settings button — Settings lives in the titlebar", () => {
    renderRibbon();
    expect(screen.queryByRole("button", { name: /Settings/ })).not.toBeInTheDocument();
  });
});

describe("Ribbon — placeholders", () => {
  it("keeps Capture as an aria-disabled coming-soon button", async () => {
    const props = renderRibbon();
    const btn = screen.getByRole("button", { name: "Capture (coming soon)" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toHaveAttribute("aria-pressed");
    await userEvent.click(btn);
    expect(props.onShowFiles).not.toHaveBeenCalled();
    expect(props.onShowSearch).not.toHaveBeenCalled();
    expect(props.onToggleGraph).not.toHaveBeenCalled();
  });
});
