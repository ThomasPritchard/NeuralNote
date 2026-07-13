import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../lib/types";
import { TitleBar } from "./TitleBar";

type TitleBarProps = Parameters<typeof TitleBar>[0];

function makeNote(over: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/v/Ideas.md",
    relPath: "Ideas.md",
    title: "Ideas",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "Some thoughts.",
    raw: "Some thoughts.",
    contentHash: "hash-1",
    binary: false,
    lossyText: false,
    ...over,
  };
}

function renderTitleBar(over: Partial<TitleBarProps> = {}) {
  const props: TitleBarProps = {
    vaultName: "MyVault",
    sidebarOpen: true,
    onToggleSidebar: vi.fn(),
    chatOpen: false,
    onToggleChat: vi.fn(),
    onOpenSettings: vi.fn(),
    note: null,
    noteDirty: false,
    onCloseNote: vi.fn(),
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

describe("TitleBar — note tab", () => {
  it("renders the note title without a dirty dot when clean", () => {
    renderTitleBar({ note: makeNote(), noteDirty: false });
    expect(screen.getByText("Ideas")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("shows the unsaved-changes dot when dirty", () => {
    renderTitleBar({ note: makeNote(), noteDirty: true });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("fires onCloseNote from the tab's close button", async () => {
    const { props } = renderTitleBar({ note: makeNote() });
    const closeButton = screen.getByRole("button", { name: "Close note" });
    expect(closeButton).toHaveClass("size-6");
    await userEvent.click(closeButton);
    expect(props.onCloseNote).toHaveBeenCalledTimes(1);
  });

  it("renders no tab when note is null", () => {
    renderTitleBar({ note: null, noteDirty: true });
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close note" }),
    ).not.toBeInTheDocument();
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
