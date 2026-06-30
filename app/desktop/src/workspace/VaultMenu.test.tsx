import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultMenu } from "./VaultMenu";

function setup() {
  const props = {
    onClose: vi.fn(),
    onNewNote: vi.fn(),
    onNewFolder: vi.fn(),
    onRefresh: vi.fn(),
    onCloseVault: vi.fn(),
  };
  render(<VaultMenu {...props} />);
  return props;
}

describe("VaultMenu", () => {
  it("renders the four vault actions", () => {
    setup();
    expect(screen.getByRole("menuitem", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh tree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Close vault" })).toBeInTheDocument();
  });

  it("each item closes the menu then runs its action", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onNewNote).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(p.onNewFolder).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh tree" }));
    expect(p.onRefresh).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: "Close vault" }));
    expect(p.onCloseVault).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const p = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it("closes when the click-outside backdrop is clicked", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { hidden: true }));
    expect(p.onClose).toHaveBeenCalled();
  });
});
