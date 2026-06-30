import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VaultActions } from "./VaultActions";

describe("VaultActions", () => {
  it("renders the open and create entry points", () => {
    render(<VaultActions onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Open vault/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New vault/i })).toBeInTheDocument();
  });

  it("fires the right callback for each card", async () => {
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    render(<VaultActions onOpen={onOpen} onCreate={onCreate} />);
    await userEvent.click(screen.getByRole("button", { name: /Open vault/i }));
    expect(onOpen).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /New vault/i }));
    expect(onCreate).toHaveBeenCalled();
  });
});
