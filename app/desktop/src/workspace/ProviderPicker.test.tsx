// ProviderPicker: the presentational first-run fork. Both choices and the
// skip escape hatch fire their callbacks — no logic of its own to test beyond
// the wiring and the honest copy.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderPicker } from "./ProviderPicker";

function setup() {
  const onPickOpenRouter = vi.fn();
  const onPickLocal = vi.fn();
  const onSkip = vi.fn();
  const user = userEvent.setup();
  render(
    <ProviderPicker
      onPickOpenRouter={onPickOpenRouter}
      onPickLocal={onPickLocal}
      onSkip={onSkip}
    />,
  );
  return { onPickOpenRouter, onPickLocal, onSkip, user };
}

describe("ProviderPicker", () => {
  it("offers both providers and the skip escape hatch", () => {
    setup();
    expect(screen.getByText("Choose your AI")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect an openrouter key/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up local ai/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip for now/i })).toBeInTheDocument();
  });

  it("fires the OpenRouter choice", async () => {
    const { onPickOpenRouter, onPickLocal, user } = setup();
    await user.click(screen.getByRole("button", { name: /connect an openrouter key/i }));
    expect(onPickOpenRouter).toHaveBeenCalledOnce();
    expect(onPickLocal).not.toHaveBeenCalled();
  });

  it("fires the Local AI choice", async () => {
    const { onPickOpenRouter, onPickLocal, user } = setup();
    await user.click(screen.getByRole("button", { name: /set up local ai/i }));
    expect(onPickLocal).toHaveBeenCalledOnce();
    expect(onPickOpenRouter).not.toHaveBeenCalled();
  });

  it("fires the skip escape hatch", async () => {
    const { onSkip, user } = setup();
    await user.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});
