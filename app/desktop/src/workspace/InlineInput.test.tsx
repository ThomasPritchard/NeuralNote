import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineInput } from "./InlineInput";

function setup(overrides = {}) {
  const props = {
    placeholder: "Name",
    ariaLabel: "New name",
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<InlineInput {...props} />);
  return props;
}

describe("InlineInput", () => {
  it("focuses on mount and prefills the initial value", () => {
    setup({ initialValue: "draft.md" });
    const input = screen.getByLabelText("New name") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.value).toBe("draft.md");
  });

  it("submits the trimmed value on Enter", async () => {
    const p = setup();
    const input = screen.getByLabelText("New name");
    await userEvent.type(input, "  hello  {Enter}");
    expect(p.onSubmit).toHaveBeenCalledWith("hello");
  });

  it("cancels instead of submitting an empty value on Enter", async () => {
    const p = setup();
    await userEvent.type(screen.getByLabelText("New name"), "{Enter}");
    expect(p.onSubmit).not.toHaveBeenCalled();
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const p = setup({ initialValue: "x" });
    await userEvent.type(screen.getByLabelText("New name"), "{Escape}");
    expect(p.onCancel).toHaveBeenCalled();
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on blur when nothing was confirmed", async () => {
    const p = setup({ initialValue: "x" });
    screen.getByLabelText("New name").blur();
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("does not double-cancel: a blur after Enter is ignored", async () => {
    const p = setup();
    const input = screen.getByLabelText("New name");
    await userEvent.type(input, "valid{Enter}");
    input.blur();
    expect(p.onSubmit).toHaveBeenCalledTimes(1);
    expect(p.onCancel).not.toHaveBeenCalled();
  });
});
