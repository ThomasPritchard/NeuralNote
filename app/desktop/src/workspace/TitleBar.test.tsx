import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeWindow = vi.hoisted(() => ({
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn(),
  resizeHandler: undefined as undefined | (() => void),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => nativeWindow,
}));
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
  nativeWindow.isFullscreen.mockReset();
  nativeWindow.isFullscreen.mockResolvedValue(false);
  nativeWindow.unlisten.mockReset();
  nativeWindow.resizeHandler = undefined;
  nativeWindow.onResized.mockReset();
  nativeWindow.onResized.mockImplementation((handler: () => void) => {
    nativeWindow.resizeHandler = handler;
    return Promise.resolve(nativeWindow.unlisten);
  });
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  delete (window.navigator as { userAgent?: string }).userAgent;
});

function renderTitleBar(over: Partial<TitleBarProps> = {}) {
  const props: TitleBarProps = {
    navigationExpanded: true,
    onToggleNavigation: vi.fn(),
    chatOpen: false,
    onToggleChat: vi.fn(),
    onOpenSettings: vi.fn(),
    tabs: [],
    activeTabId: null,
    activeView: "note",
    onActivateTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseGraph: vi.fn(),
    ...over,
  };
  const view = render(<TitleBar {...props} />);
  return { props, view };
}

describe("TitleBar — panel toggles", () => {
  it("reflects navigationExpanded/chatOpen as aria-pressed", () => {
    renderTitleBar({ navigationExpanded: true, chatOpen: false });
    expect(
      screen.getByRole("button", { name: "Toggle navigation sidebar" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("reflects the flipped panel states too", () => {
    renderTitleBar({ navigationExpanded: false, chatOpen: true });
    expect(
      screen.getByRole("button", { name: "Toggle navigation sidebar" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("fires onToggleNavigation for the navigation toggle", async () => {
    const { props } = renderTitleBar();
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle navigation sidebar" }),
    );
    expect(props.onToggleNavigation).toHaveBeenCalledTimes(1);
    expect(props.onToggleChat).not.toHaveBeenCalled();
  });

  it("fires onToggleChat for the chat toggle", async () => {
    const { props } = renderTitleBar();
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle chat panel" }),
    );
    expect(props.onToggleChat).toHaveBeenCalledTimes(1);
    expect(props.onToggleNavigation).not.toHaveBeenCalled();
  });

  it("fires onOpenSettings for the settings button (not a toggle)", async () => {
    const { props } = renderTitleBar();
    const btn = screen.getByRole("button", { name: "Settings" });
    expect(btn).not.toHaveAttribute("aria-pressed");
    await userEvent.click(btn);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("TitleBar — navigation ownership", () => {
  it("does not render vault identity or actions", () => {
    renderTitleBar();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "MyVault" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Vault actions/ })).not.toBeInTheDocument();
  });

  it("exposes navigation state on the titlebar geometry boundary", () => {
    const { view } = renderTitleBar({ navigationExpanded: false });
    expect(view.container.querySelector(".nn-titlebar")).toHaveAttribute(
      "data-navigation-expanded",
      "false",
    );
  });
});

describe("TitleBar — native fullscreen geometry", () => {
  it("uses 74px on macOS windowed, then 12px after a fullscreen resize", async () => {
    nativeWindow.isFullscreen
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderTitleBar();
    const leftCluster = screen.getByRole("button", {
      name: "Toggle navigation sidebar",
    }).parentElement;

    await waitFor(() => expect(nativeWindow.isFullscreen).toHaveBeenCalledOnce());
    expect(leftCluster).toHaveClass("pl-[74px]");
    expect(leftCluster?.closest(".nn-titlebar")).toHaveClass(
      "nn-titlebar-toggle-clearance-windowed",
    );

    act(() => nativeWindow.resizeHandler?.());
    await waitFor(() => expect(leftCluster).toHaveClass("pl-[12px]"));
    expect(leftCluster?.closest(".nn-titlebar")).toHaveClass(
      "nn-titlebar-toggle-clearance-fullscreen",
    );
    expect(nativeWindow.isFullscreen).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale mount query that resolves after the resize query", async () => {
    let resolveMount!: (value: boolean) => void;
    nativeWindow.isFullscreen
      .mockReturnValueOnce(new Promise((resolve) => { resolveMount = resolve; }))
      .mockResolvedValueOnce(true);
    renderTitleBar();
    const leftCluster = screen.getByRole("button", {
      name: "Toggle navigation sidebar",
    }).parentElement;

    await waitFor(() => expect(nativeWindow.onResized).toHaveBeenCalledOnce());
    act(() => nativeWindow.resizeHandler?.());
    await waitFor(() => expect(leftCluster).toHaveClass("pl-[12px]"));
    resolveMount(false);
    await act(async () => Promise.resolve());

    expect(leftCluster).toHaveClass("pl-[12px]");
  });

  it("retains 74px and avoids native fullscreen IPC on other platforms", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    renderTitleBar();

    expect(screen.getByRole("button", {
      name: "Toggle navigation sidebar",
    }).parentElement).toHaveClass("pl-[74px]");
    await act(async () => Promise.resolve());
    expect(nativeWindow.isFullscreen).not.toHaveBeenCalled();
    expect(nativeWindow.onResized).not.toHaveBeenCalled();
  });

  it("unsubscribes from native resize when the titlebar unmounts", async () => {
    const { view } = renderTitleBar();
    await waitFor(() => expect(nativeWindow.onResized).toHaveBeenCalledOnce());

    view.unmount();

    expect(nativeWindow.unlisten).toHaveBeenCalledOnce();
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

  it("keeps the layout wrapper between tablist and tabs free of ARIA semantics", () => {
    renderTitleBar({ tabs: [ideas], activeTabId: ideas.id });
    const wrapper = screen.getByRole("tab", { name: "Ideas" }).closest(".nn-note-tab");
    expect(wrapper).not.toBeNull();
    // A plain div is generic scaffolding; re-adding a role here (including
    // "presentation") either trips S6819 or hides the tab from its tablist.
    expect(wrapper).not.toHaveAttribute("role");
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
    // The drag layer itself carries no interactive children. This proves the
    // buttons are not DOM *descendants* of the drag layer — a structural check.
    // It cannot prove they stack ABOVE it (jsdom has no layout or hit-testing): a
    // dropped `relative z-10` would let the inset-0 layer swallow every titlebar
    // click and still pass here. The real-layout complement is the headless-Chromium
    // hit test in TitleBar.browser.test.tsx (issue #30), which fails on exactly that
    // regression via elementFromPoint + a Playwright actionability click.
    expect(layer?.childElementCount).toBe(0);
  });
});
