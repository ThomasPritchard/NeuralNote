// A key change that committed to the keychain but could not be announced to the
// app's other windows, end-to-end through the REAL Tauri IPC seam.
//
// `save_api_key` resolves to a `KeyChangeOutcome`. The keychain write is done by
// the time it resolves; `revisionPublished` carries the other guarantee — that
// every other running copy of the app was told to drop the key it had cached.
// While `api.ts` typed the command as `invoke<void>` the payload was erased
// rather than contradicted, so both call sites discarded it in silence and a
// half-completed change rendered as a clean success.
//
// This is the tier that can catch that. The component suites stub `../lib/api`,
// so they agree with whatever outcome the stub is told to return; only the
// journey runs the real `invoke` against a backend answering the real shape.
// Both user-facing paths that can change a key are driven here:
//
//   1. The chat pane's guided first-run setup, where the panel that raised the
//      save is swapped out for the transcript the moment it succeeds.
//   2. The OpenRouter card in Settings, where the form closes on success.
//
// Each is asserted twice over: the caveat is shown when the change could not be
// announced, and — the half that would otherwise go unnoticed — it is absent
// when it could.
//
// Queries go through the notice's own copy rather than `byRole("alert")`. The
// app raises an unrelated "automatic update check failed" error toast during
// these journeys, which is also an alert; matching the role alone found two
// elements on the positive case, and would have let the negative cases pass by
// simply racing that toast.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import { KEY_CHANGE_CAVEAT_MESSAGE } from "../workspace/KeyChangeCaveat";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

/** Render the app and open the recent vault, resolving once the chat pane mounts. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI"); // the chat pane header, in every view
  return result;
}

/** Walk the first-run picker into guided setup and save a key. */
async function saveKeyFromChatPane(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: /connect an openrouter key/i }));
  await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-test-secret");
  await user.click(screen.getByRole("button", { name: /save & start chatting/i }));
}

/** Open Settings on the AI page and save a key through the OpenRouter card. */
async function saveKeyFromSettings(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "AI" }));
  await user.click(await within(dialog).findByRole("button", { name: /update key…/i }));
  await user.type(within(dialog).getByLabelText("OpenRouter API key"), "sk-or-test-secret");
  await user.click(within(dialog).getByRole("button", { name: "Save key" }));
  return dialog;
}

/** The notice element itself, reached from the copy the user reads — which also
 *  proves the copy sits inside a live region rather than merely on the page. */
function noticeAround(text: HTMLElement): HTMLElement {
  const notice = text.closest<HTMLElement>('[role="alert"]');
  if (notice === null) {
    throw new Error("the key notice rendered outside any live region — it would never be announced");
  }
  return notice;
}

/** A caveat is not an error: the save worked, so the notice must not borrow the
 *  destructive treatment that says it didn't. */
function expectCaveatToning(notice: HTMLElement) {
  expect(notice).toHaveClass("border-warning/40");
  expect(notice.className).not.toMatch(/destructive/);
}

describe("a key change the app's other windows were not told about", () => {
  it("qualifies the chat pane's guided setup instead of reporting a clean success", async () => {
    const { user, backend } = await openWorkspace({
      apiKey: { hasKey: false }, // nothing configured → first-run picker
      keyRevisionPublished: false,
    });

    await saveKeyFromChatPane(user);

    // The save really did land, so the pane must still open for chat — a caveat
    // that blocked the flow would be its own false report.
    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "save_api_key")).toHaveLength(1);

    // And the notice outlives the setup panel that raised it.
    const text = await screen.findByText(KEY_CHANGE_CAVEAT_MESSAGE);
    expect(text).toHaveTextContent(/another window/i);
    expect(text).toHaveTextContent(/restart/i);
    expectCaveatToning(noticeAround(text));
  });

  it("leaves the chat pane unqualified when the other windows were told", async () => {
    // The same journey with the ordinary outcome. Without this the assertion
    // above passes just as well against a pane that always shows the notice.
    const { user } = await openWorkspace({ apiKey: { hasKey: false } });

    await saveKeyFromChatPane(user);

    expect(await screen.findByLabelText("Ask across your vault")).toBeInTheDocument();
    expect(screen.queryByText(KEY_CHANGE_CAVEAT_MESSAGE)).not.toBeInTheDocument();
  });

  it("qualifies the settings card, and lets the user dismiss the notice", async () => {
    const { user, backend } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
      keyRevisionPublished: false,
    });

    const dialog = await saveKeyFromSettings(user);

    // The form closed, because the key really is stored.
    expect(within(dialog).queryByRole("button", { name: "Save key" })).not.toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "save_api_key")).toHaveLength(1);

    const notice = noticeAround(await within(dialog).findByText(KEY_CHANGE_CAVEAT_MESSAGE));
    expectCaveatToning(notice);

    await user.click(within(notice).getByRole("button", { name: "Dismiss this notice" }));
    expect(within(dialog).queryByText(KEY_CHANGE_CAVEAT_MESSAGE)).not.toBeInTheDocument();
  });

  it("leaves the settings card unqualified when the other windows were told", async () => {
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" },
    });

    const dialog = await saveKeyFromSettings(user);

    // Settle on the reopened "Update key…" button rather than on an absence, so
    // the assertion below is made after the save resolved and not before it.
    expect(
      await within(dialog).findByRole("button", { name: /update key…/i }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(KEY_CHANGE_CAVEAT_MESSAGE)).not.toBeInTheDocument();
  });
});
