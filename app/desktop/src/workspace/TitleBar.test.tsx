import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteTabPanelId,
  noteTabTriggerId,
  TitleBar,
  type TitleBarTabSummary,
} from "./TitleBar";

type TitleBarProps = Parameters<typeof TitleBar>[0];

function makeTab(over: Partial<TitleBarTabSummary> = {}): TitleBarTabSummary {
  return {
    id: "tab-ideas",
    title: "Ideas",
    path: "/v/Ideas.md",
    dirty: false,
    loading: false,
    error: null,
    ...over,
  };
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

function renderTitleBar(over: Partial<TitleBarProps> = {}) {
  const props: TitleBarProps = {
    vaultName: "MyVault",
    sidebarOpen: true,
    onToggleSidebar: vi.fn(),
    chatOpen: false,
    onToggleChat: vi.fn(),
    onOpenSettings: vi.fn(),
    tabs: [],
    activeTabId: null,
    activeView: "note",
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseGraph: vi.fn(),
    onNewNote: vi.fn(),
    onNewFolder: vi.fn(),
    onRefresh: vi.fn(),
    onCloseVault: vi.fn(),
    ...over,
  };
  const view = render(<TitleBar {...props} />);
  return { props, view };
}

describe("TitleBar — panel toggles", () => {
  it("reflects sidebarOpen/chatOpen as aria-pressed", () => {
    renderTitleBar({ sidebarOpen: true, chatOpen: false });
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("reflects the flipped panel states too", () => {
    renderTitleBar({ sidebarOpen: false, chatOpen: true });
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("fires onToggleSidebar for the sidebar toggle", async () => {
    const { props } = renderTitleBar();
    await userEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(props.onToggleChat).not.toHaveBeenCalled();
  });

  it("fires onToggleChat for the chat toggle", async () => {
    const { props } = renderTitleBar();
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    );
    expect(props.onToggleChat).toHaveBeenCalledTimes(1);
    expect(props.onToggleSidebar).not.toHaveBeenCalled();
  });

  it("fires onOpenSettings for the settings button (not a toggle)", async () => {
    const { props } = renderTitleBar();
    const btn = screen.getByRole("button", { name: "Settings" });
    expect(btn).not.toHaveAttribute("aria-pressed");
    await userEvent.click(btn);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("TitleBar — vault switcher", () => {
  it("renders the vault name with a closed menu", () => {
    renderTitleBar({ vaultName: "Second Brain" });
    const switcher = screen.getByRole("button", { name: "Second Brain" });
    expect(switcher).toHaveAttribute("aria-haspopup", "menu");
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the vault menu and fires the create actions", async () => {
    const { props } = renderTitleBar();
    const switcher = screen.getByRole("button", { name: "MyVault" });

    await userEvent.click(switcher);
    expect(switcher).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Vault actions" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    expect(props.onNewNote).toHaveBeenCalledTimes(1);
    // Selecting an item closes the menu.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(switcher);
    await userEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(props.onNewFolder).toHaveBeenCalledTimes(1);
  });

  it("fires refresh and close-vault from the menu", async () => {
    const { props } = renderTitleBar();

    await userEvent.click(screen.getByRole("button", { name: "MyVault" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh tree" }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "MyVault" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Close vault" }));
    expect(props.onCloseVault).toHaveBeenCalledTimes(1);
  });

  it("supports arrow-key navigation and returns focus to the trigger", async () => {
    const { props } = renderTitleBar();
    const switcher = screen.getByRole("button", { name: "MyVault" });

    switcher.focus();
    await userEvent.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(switcher).toHaveFocus();
  });
});

describe("TitleBar — tooltips", () => {
  it("shows a visible tooltip for icon-only controls", async () => {
    const user = userEvent.setup();
    renderTitleBar();
    await user.hover(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Settings");
  });
});

describe("TitleBar — note tabs", () => {
  const ideas = makeTab();
  const plan = makeTab({
    id: "tab-plan",
    title: "APD action plan",
    path: "/v/Projects/APD action plan.md",
  });

  it("exposes the tablist and matching tab-panel relationships", () => {
    renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });

    expect(screen.getByRole("tablist", { name: "Open notes" })).toBeInTheDocument();
    const active = screen.getByRole("tab", { name: "Ideas" });
    const inactive = screen.getByRole("tab", { name: "APD action plan" });
    expect(active).toHaveAttribute("id", noteTabTriggerId(ideas.id));
    expect(active).toHaveAttribute("aria-controls", noteTabPanelId(ideas.id));
    expect(active).toHaveAttribute("aria-selected", "true");
    expect(active).toHaveAttribute("tabindex", "0");
    expect(inactive).toHaveAttribute("aria-selected", "false");
    expect(inactive).toHaveAttribute("tabindex", "-1");
  });

  it("renders clean, dirty, loading, and error states without hiding full titles", () => {
    const dirty = makeTab({ id: "dirty", title: "Dirty note", dirty: true });
    const loading = makeTab({ id: "loading", title: "Loading note", loading: true });
    const failed = makeTab({ id: "failed", title: "Failed note", error: "Read failed" });
    renderTitleBar({ tabs: [dirty, loading, failed], activeTabId: dirty.id });

    expect(screen.getByRole("tab", { name: "Dirty note, unsaved changes" })).toHaveAttribute(
      "title",
      "Dirty note",
    );
    expect(screen.getByRole("tab", { name: "Loading note, loading" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Failed note, failed to load" })).toBeInTheDocument();
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("activates a note from its trigger", async () => {
    const { props } = renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });
    await userEvent.click(screen.getByRole("tab", { name: "APD action plan" }));
    expect(props.onActivateTab).toHaveBeenCalledWith(plan.id);
  });

  it("closes a background tab without activating it", async () => {
    const { props } = renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });
    const close = screen.getByRole("button", { name: "Close APD action plan" });
    expect(close).toHaveAttribute("tabindex", "-1");
    expect(close).toHaveClass("nn-tab-close");

    await userEvent.click(close);
    expect(props.onCloseTab).toHaveBeenCalledWith(plan.id);
    expect(props.onActivateTab).not.toHaveBeenCalled();
  });

  it("moves focus and activation with wrapping arrow keys", async () => {
    const { props } = renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });
    const first = screen.getByRole("tab", { name: "Ideas" });
    const last = screen.getByRole("tab", { name: "APD action plan" });

    first.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(last).toHaveFocus();
    expect(props.onActivateTab).toHaveBeenLastCalledWith(plan.id);

    await userEvent.keyboard("{ArrowRight}");
    expect(first).toHaveFocus();
    expect(props.onActivateTab).toHaveBeenLastCalledWith(ideas.id);
  });

  it("moves to the first and last note with Home and End", async () => {
    const { props } = renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });
    const first = screen.getByRole("tab", { name: "Ideas" });
    const last = screen.getByRole("tab", { name: "APD action plan" });

    first.focus();
    await userEvent.keyboard("{End}");
    expect(last).toHaveFocus();
    expect(props.onActivateTab).toHaveBeenLastCalledWith(plan.id);
    await userEvent.keyboard("{Home}");
    expect(first).toHaveFocus();
    expect(props.onActivateTab).toHaveBeenLastCalledWith(ideas.id);
  });

  it("closes the focused note with Delete", async () => {
    const { props } = renderTitleBar({ tabs: [ideas, plan], activeTabId: ideas.id });
    const last = screen.getByRole("tab", { name: "APD action plan" });

    last.focus();
    await userEvent.keyboard("{Delete}");
    expect(props.onCloseTab).toHaveBeenNthCalledWith(1, plan.id);
    expect(props.onCloseTab).toHaveBeenCalledTimes(1);
  });

  it("scrolls the active tab into view without smooth motion", () => {
    renderTitleBar({ tabs: [ideas, plan], activeTabId: plan.id });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
  });

  it("renders no triggers when no notes are open", () => {
    renderTitleBar();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

describe("TitleBar — graph tab", () => {
  const ideas = makeTab();

  it("adds one transient selected Graph tab while graph view is active", () => {
    renderTitleBar({ tabs: [ideas], activeTabId: ideas.id, activeView: "graph" });
    const note = screen.getByRole("tab", { name: "Ideas" });
    const graph = screen.getByRole("tab", { name: "Graph" });

    expect(note).toHaveAttribute("aria-selected", "false");
    expect(note).toHaveAttribute("tabindex", "-1");
    expect(graph).toHaveAttribute("aria-selected", "true");
    expect(graph).toHaveAttribute("aria-controls", "nn-graph-panel");
    expect(screen.getAllByRole("tab").filter((tab) => tab.getAttribute("aria-selected") === "true"))
      .toHaveLength(1);
  });

  it("closes Graph through its pointer close control", async () => {
    const { props } = renderTitleBar({ tabs: [ideas], activeTabId: ideas.id, activeView: "graph" });
    await userEvent.click(screen.getByRole("button", { name: "Close Graph" }));
    expect(props.onCloseGraph).toHaveBeenCalledTimes(1);
    expect(props.onActivateTab).not.toHaveBeenCalled();
  });

  it("returns to a note when arrow navigation leaves Graph", async () => {
    const { props } = renderTitleBar({ tabs: [ideas], activeTabId: ideas.id, activeView: "graph" });
    const graph = screen.getByRole("tab", { name: "Graph" });
    graph.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Ideas" })).toHaveFocus();
    expect(props.onActivateTab).toHaveBeenCalledWith(ideas.id);
  });
});

describe("TitleBar — drag region", () => {
  it("keeps a dedicated aria-hidden drag layer behind the controls", () => {
    const { view } = renderTitleBar();
    const layer = view.container.querySelector("[data-tauri-drag-region]");
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute("aria-hidden", "true");
    // The drag layer itself carries no interactive children.
    // TODO(titlebar-drag-hit-test): this proves buttons are not DOM descendants
    // of the drag layer, not that they stack above it — jsdom has no layout or
    // hit-testing. A dropped `relative z-10` would let the inset-0 layer swallow
    // every titlebar click and still pass here; when a Playwright harness exists,
    // add a click-a-titlebar-button smoke test.
    expect(layer?.childElementCount).toBe(0);
  });
});
