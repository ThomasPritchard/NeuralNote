// Journey 9: OpenRouter reasoning opt-in, end-to-end through the REAL Tauri IPC seam.
//
// The AiSettingsPage component tests stub `../lib/api` wholesale, so they never
// reach `invoke`. That leaves the `set_reasoning` command contract unverified:
// ts-rs generates the *struct* `AiStatus`, but nothing type-checks a command's
// name string or its return type, so `invoke<AiStatus>("set_reasoning", …)` in
// `api.ts` is a hand-written assertion. This journey drives it against the
// stateful `mockVault` backend, which mirrors the Rust command pair.
//
// Reasoning tokens are BILLED. Two properties matter more than the happy path:
//
//   1. Off unless asked for — a keyed user whose config predates the flag sees an
//      unticked box and a plain statement that the tokens cost money.
//   2. The box never lies about what is persisted. `set_reasoning` returns the
//      freshly written status and the toggle renders *that*, rather than issuing a
//      follow-up `ai_status` read whose failure `refreshStatus` would swallow —
//      which would show "off" while the config said "on", billing the user for
//      reasoning they never consented to.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const TOGGLE = { name: /show model reasoning/i };

/** Render the app and open the recent vault, resolving once the chat pane mounts. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI"); // the chat pane header, in every view
  return result;
}

/** Open Settings from the ribbon cog, navigate to AI, and return the live dialog. */
async function openSettings(user: Awaited<ReturnType<typeof openWorkspace>>["user"]) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "AI" }));
  return dialog;
}

describe("Journey 9: OpenRouter reasoning — opt-in", () => {
  it("is off for a keyed user, and says the tokens are billed", async () => {
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await openSettings(user);

    // `ProviderConfig.reasoning` is `#[serde(default)]`, so a config written before
    // the field existed reads back false. The user is never opted in by default.
    const toggle = await within(dialog).findByRole("checkbox", TOGGLE);
    expect(toggle).not.toBeChecked();

    // The cost is stated where the choice is made, not buried in docs.
    expect(
      within(dialog).getByText("Reasoning tokens are billed by OpenRouter."),
    ).toBeInTheDocument();
  });

  it("persists the opt-in across a Settings close and reopen", async () => {
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("checkbox", TOGGLE));
    expect(await within(dialog).findByRole("checkbox", TOGGLE)).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await screen.findByLabelText("Ask across your vault");

    // Reopening re-reads `ai_status` from the backend. The tick survives, so the
    // write really landed in the config rather than only in React state — this is
    // the round trip `invoke("set_reasoning")` → `invoke("ai_status")`.
    const reopened = await openSettings(user);
    expect(await within(reopened).findByRole("checkbox", TOGGLE)).toBeChecked();
  });

  it("shows the opt-in even when the next status read fails", async () => {
    const { user, backend } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await openSettings(user);
    const toggle = await within(dialog).findByRole("checkbox", TOGGLE);
    expect(toggle).not.toBeChecked();

    // Every `ai_status` read from here on fails. The write itself still succeeds,
    // so reasoning IS persisted — and the box must say so. Rendering the status the
    // write returned is what makes that true; a follow-up read would have been
    // swallowed by `refreshStatus`, leaving the box unticked and the user billed.
    backend.setFailure("ai_status", { kind: "io", message: "config unreadable" });

    await user.click(toggle);

    expect(await within(dialog).findByRole("checkbox", TOGGLE)).toBeChecked();
  });

  it("leaves the box untouched and surfaces the error when the write fails", async () => {
    const { user, backend } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await openSettings(user);
    backend.setFailure("set_reasoning", {
      kind: "io",
      message: "could not write your AI settings",
    });

    await user.click(await within(dialog).findByRole("checkbox", TOGGLE));

    // Nothing was persisted, so the control never claims the opt-in — and the
    // failure is visible, never a silent no-op.
    expect(
      await within(dialog).findByText("could not write your AI settings"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", TOGGLE)).not.toBeChecked();
  });
});
