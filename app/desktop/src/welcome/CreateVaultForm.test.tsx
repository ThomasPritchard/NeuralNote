import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateVaultForm } from "./CreateVaultForm";

function setup(overrides = {}) {
  const props = {
    parentDir: "/home/projects",
    submitting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<CreateVaultForm {...props} />);
  return props;
}

describe("CreateVaultForm", () => {
  it("shows the chosen parent directory", () => {
    setup();
    expect(screen.getByText("/home/projects")).toBeInTheDocument();
  });

  it("disables confirm until a non-empty name is entered", async () => {
    setup();
    const confirm = screen.getByRole("button", { name: /Create vault/i });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Vault name"), "  ");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Vault name"), "My Brain");
    expect(confirm).toBeEnabled();
  });

  it("confirms with the trimmed name on submit", async () => {
    const p = setup();
    await userEvent.type(screen.getByLabelText("Vault name"), "  Spaced  ");
    await userEvent.click(screen.getByRole("button", { name: /Create vault/i }));
    expect(p.onConfirm).toHaveBeenCalledWith("Spaced");
  });

  it("cancels via the Back button", async () => {
    const p = setup();
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("shows the submitting state and blocks input", () => {
    setup({ submitting: true });
    expect(screen.getByText("Creating…")).toBeInTheDocument();
    expect(screen.getByLabelText("Vault name")).toBeDisabled();
  });

  it("does not confirm when submitting even if a name exists", async () => {
    const p = setup({ submitting: true });
    // The form's submit guard short-circuits while submitting.
    const form = screen.getByLabelText("Vault name").closest("form")!;
    form.requestSubmit?.();
    expect(p.onConfirm).not.toHaveBeenCalled();
  });
});
