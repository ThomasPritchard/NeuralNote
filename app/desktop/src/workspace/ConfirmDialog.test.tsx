import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function setup(overrides = {}) {
  const props = {
    title: "Delete note?",
    message: "This cannot be undone.",
    confirmLabel: "Delete",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

describe("ConfirmDialog", () => {
  it("renders title, message and labels (default cancel label)", () => {
    setup();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete note?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("uses a custom cancel label when supplied", () => {
    setup({ cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("autofocuses the confirm button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });

  it("confirms and cancels via the buttons", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onConfirm).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const p = setup();
    await userEvent.keyboard("{Escape}");
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("cancels on backdrop click but not on dialog-body click", async () => {
    const p = setup();
    // Clicking inside the dialog must not dismiss: the backdrop is a sibling
    // <button>, so dialog clicks never reach it.
    await userEvent.click(screen.getByRole("alertdialog"));
    expect(p.onCancel).not.toHaveBeenCalled();
    // The backdrop is now an accessible button (replacing role="presentation").
    await userEvent.click(screen.getByRole("button", { name: "Dismiss dialog" }));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it("supports the danger tone", () => {
    setup({ tone: "danger" });
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-destructive");
  });

  it("returns focus to the control that opened it", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Delete selected note</button>
          {open && (
            <ConfirmDialog
              title="Delete note?"
              message="This cannot be undone."
              confirmLabel="Delete"
              onConfirm={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete selected note" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(opener).toHaveFocus());
  });
});
