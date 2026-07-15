import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Ribbon } from "./Ribbon";

type RibbonProps = Parameters<typeof Ribbon>[0];

function renderRibbon(over: Partial<RibbonProps> = {}) {
  const props: RibbonProps = {
    navigationExpanded: true,
    vaultName: "MyVault",
    sidebarPanel: "files",
    centerView: "note",
    onShowFiles: vi.fn(),
    onShowSearch: vi.fn(),
    onInsertTemplate: vi.fn(),
    onToggleGraph: vi.fn(),
    onNewNote: vi.fn(),
    onNewFolder: vi.fn(),
    onRefresh: vi.fn(),
    onCloseVault: vi.fn(),
    ...over,
  };
  render(<Ribbon {...props} />);
  return props;
}

describe("Ribbon — navigation modes", () => {
  it("renders an expanded navigation sidebar with visible labels", () => {
    renderRibbon({ navigationExpanded: true });

    const navigation = screen.getByRole("navigation", { name: "Workspace" });
    expect(navigation).toHaveAttribute("data-navigation-expanded", "true");
    expect(screen.getByText("Quick links")).not.toHaveClass("sr-only");
    expect(screen.getByText("Files")).not.toHaveClass("sr-only");
    expect(screen.getByText("Search")).not.toHaveClass("sr-only");
    expect(screen.getByText("Insert from template")).not.toHaveClass("sr-only");
    expect(screen.getByText("Graph view")).not.toHaveClass("sr-only");
  });

  it("exposes the quick links as a labelled navigation landmark", () => {
    renderRibbon({ navigationExpanded: true });

    const quickLinks = screen.getByRole("navigation", { name: "Quick links" });
    for (const name of ["Files", "Search", "Insert from template", "Graph view"]) {
      expect(within(quickLinks).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("renders compact controls with accessible names and hidden labels", () => {
    renderRibbon({ navigationExpanded: false });

    const navigation = screen.getByRole("navigation", { name: "Workspace" });
    expect(navigation).toHaveAttribute("data-navigation-expanded", "false");
    expect(screen.getByText("Quick links")).toHaveClass("nn-navigation-copy");
    for (const name of ["Files", "Search", "Insert from template", "Graph view"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
      expect(screen.getByText(name)).toHaveClass("nn-navigation-copy");
      expect(screen.getByText(name)).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("keeps a fixed icon gutter while navigation width animates", () => {
    const { rerender } = render(<Ribbon {...({
      navigationExpanded: true,
      vaultName: "MyVault",
      sidebarPanel: "files",
      centerView: "note",
      onShowFiles: vi.fn(),
      onShowSearch: vi.fn(),
      onInsertTemplate: vi.fn(),
      onToggleGraph: vi.fn(),
      onNewNote: vi.fn(),
      onNewFolder: vi.fn(),
      onRefresh: vi.fn(),
      onCloseVault: vi.fn(),
    } satisfies RibbonProps)} />);
    const trigger = screen.getByRole("button", { name: "MyVault" });
    const filesIconGutter = screen
      .getByRole("button", { name: "Files" })
      .querySelector(".nn-navigation-icon-gutter");
    expect(filesIconGutter).toHaveClass("w-[56px]");
    expect(screen.getByText("Quick links")).toHaveClass("pl-[56px]");

    rerender(<Ribbon {...({
      navigationExpanded: false,
      vaultName: "MyVault",
      sidebarPanel: "files",
      centerView: "note",
      onShowFiles: vi.fn(),
      onShowSearch: vi.fn(),
      onInsertTemplate: vi.fn(),
      onToggleGraph: vi.fn(),
      onNewNote: vi.fn(),
      onNewFolder: vi.fn(),
      onRefresh: vi.fn(),
      onCloseVault: vi.fn(),
    } satisfies RibbonProps)} />);

    expect(screen.getByRole("button", { name: "Vault actions for MyVault" })).toBe(
      trigger,
    );
    expect(filesIconGutter).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toHaveClass(
      "items-stretch",
    );
  });

  it("shows tooltips for compact navigation controls", async () => {
    const user = userEvent.setup();
    renderRibbon({ navigationExpanded: false });

    await user.hover(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Search");
  });

  it("keeps keyboard focus visible in both navigation modes", () => {
    const { rerender } = render(<Ribbon {...({
      navigationExpanded: false,
      vaultName: "MyVault",
      sidebarPanel: "files",
      centerView: "note",
      onShowFiles: vi.fn(),
      onShowSearch: vi.fn(),
      onInsertTemplate: vi.fn(),
      onToggleGraph: vi.fn(),
      onNewNote: vi.fn(),
      onNewFolder: vi.fn(),
      onRefresh: vi.fn(),
      onCloseVault: vi.fn(),
    } satisfies RibbonProps)} />);

    expect(screen.getByRole("button", { name: "Files" })).toHaveClass(
      "focus-visible:ring-2",
    );

    rerender(<Ribbon {...({
      navigationExpanded: true,
      vaultName: "MyVault",
      sidebarPanel: "files",
      centerView: "note",
      onShowFiles: vi.fn(),
      onShowSearch: vi.fn(),
      onInsertTemplate: vi.fn(),
      onToggleGraph: vi.fn(),
      onNewNote: vi.fn(),
      onNewFolder: vi.fn(),
      onRefresh: vi.fn(),
      onCloseVault: vi.fn(),
    } satisfies RibbonProps)} />);
    expect(screen.getByRole("button", { name: "Files" })).toHaveClass(
      "focus-visible:ring-2",
    );
  });
});

describe("Ribbon — vault actions", () => {
  it("shows the vault identity in expanded mode", () => {
    renderRibbon({ navigationExpanded: true, vaultName: "Second Brain" });
    const trigger = screen.getByRole("button", { name: "Second Brain" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the compact vault trigger accessible", async () => {
    const user = userEvent.setup();
    renderRibbon({ navigationExpanded: false, vaultName: "Second Brain" });
    const trigger = screen.getByRole("button", {
      name: "Vault actions for Second Brain",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Vault actions for Second Brain",
    );
  });

  it("opens the vault menu and dispatches every action", async () => {
    const props = renderRibbon();
    const trigger = screen.getByRole("button", { name: "MyVault" });

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    expect(props.onNewNote).toHaveBeenCalledTimes(1);

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(props.onNewFolder).toHaveBeenCalledTimes(1);

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh tree" }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Close vault" }));
    expect(props.onCloseVault).toHaveBeenCalledTimes(1);
  });
});

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

  it("fires onInsertTemplate for the template button", async () => {
    const props = renderRibbon();
    await userEvent.click(
      screen.getByRole("button", { name: "Insert from template" }),
    );
    expect(props.onInsertTemplate).toHaveBeenCalledTimes(1);
  });

  it("has no Settings button — Settings lives in the titlebar", () => {
    renderRibbon();
    expect(screen.queryByRole("button", { name: /Settings/ })).not.toBeInTheDocument();
  });
});

describe("Ribbon — live actions", () => {
  it("exposes Insert from template as an enabled action", () => {
    const props = renderRibbon();
    const btn = screen.getByRole("button", { name: "Insert from template" });
    expect(btn).not.toHaveAttribute("aria-disabled");
    expect(btn).not.toHaveAttribute("aria-pressed");
    expect(props.onShowFiles).not.toHaveBeenCalled();
    expect(props.onShowSearch).not.toHaveBeenCalled();
    expect(props.onToggleGraph).not.toHaveBeenCalled();
  });
});
