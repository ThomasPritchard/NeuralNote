// SettingsModal: the presentational shell — open/close (Esc, backdrop, X),
// section switching, initial-section override, focus handling (a native
// <dialog> opened via showModal; the jsdom polyfill lives in test/setup.ts).
// AiSettingsPage is stubbed out: its data loading has its own suite, and the
// shell's job is only to mount the right section.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./AiSettingsPage", () => ({
  AiSettingsPage: () => <div data-testid="ai-settings-page" />,
}));

import { SettingsModal } from "./SettingsModal";

function setup(props: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(<SettingsModal open onClose={onClose} {...props} />);
  return { onClose, user, view };
}

describe("SettingsModal — shell", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a labelled modal dialog, defaulting to the AI section", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Default section is Configure the AI — the reason the modal exists in v1.
    expect(screen.getByTestId("ai-settings-page")).toBeInTheDocument();
    // The section nav lists all three sections.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav).toContainElement(screen.getByRole("button", { name: "General" }));
    expect(nav).toContainElement(
      screen.getByRole("button", { name: "Configure the AI" }),
    );
    expect(nav).toContainElement(screen.getByRole("button", { name: "About" }));
  });

  it("switches sections from the left nav", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByText(/more settings coming soon/i)).toBeInTheDocument();
    expect(screen.queryByTestId("ai-settings-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("NeuralNote")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Configure the AI" }));
    expect(screen.getByTestId("ai-settings-page")).toBeInTheDocument();
  });

  it("honours an explicit initial section", () => {
    setup({ initialSection: "about" });
    expect(screen.getByText("NeuralNote")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-settings-page")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { onClose, user } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from the backdrop and from the X button", async () => {
    const { onClose, user } = setup();
    await user.click(screen.getByRole("button", { name: "Dismiss settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsModal — focus", () => {
  it("takes focus on open and returns it to the opener on close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <button type="button">opener</button>
        <SettingsModal open={false} onClose={onClose} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "opener" });
    await user.click(opener);
    expect(opener).toHaveFocus();

    rerender(
      <>
        <button type="button">opener</button>
        <SettingsModal open onClose={onClose} />
      </>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();

    rerender(
      <>
        <button type="button">opener</button>
        <SettingsModal open={false} onClose={onClose} />
      </>,
    );
    expect(opener).toHaveFocus();
  });

  it("opens as a native modal (showModal), which traps focus in the dialog", () => {
    // The focus trap is the browser's: showModal() puts the dialog in the top
    // layer and makes the rest of the document inert, so Tab can only cycle
    // the dialog's own controls. jsdom implements neither top layer nor tab
    // order, so the test pins the mechanism that delivers the trap.
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    setup();
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    showModal.mockRestore();
  });
});
