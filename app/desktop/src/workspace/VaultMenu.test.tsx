import { fireEvent, render, screen } from "@testing-library/react";
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
  return {
    props,
    trigger: screen.getByRole("button", { name: "Vault actions menu", hidden: true }),
  };
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
    const { props: p, trigger } = setup();
    await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onNewNote).toHaveBeenCalled();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await userEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(p.onNewFolder).toHaveBeenCalled();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh tree" }));
    expect(p.onRefresh).toHaveBeenCalled();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    await userEvent.click(screen.getByRole("menuitem", { name: "Close vault" }));
    expect(p.onCloseVault).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const { props: p } = setup();
    await userEvent.keyboard("{Escape}");
    expect(p.onClose).toHaveBeenCalled();
  });

  it("closes when its trigger is toggled", async () => {
    const { props: p, trigger } = setup();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(p.onClose).toHaveBeenCalled();
  });
});
