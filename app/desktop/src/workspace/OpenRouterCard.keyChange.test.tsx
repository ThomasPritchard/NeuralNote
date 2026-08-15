// OpenRouterCard: what the card does with the outcome of a key save, beyond
// "it worked".
//
// `save_api_key` resolves to a `KeyChangeOutcome`. The keychain write is done by
// the time it resolves; `revisionPublished` says whether the app's other windows
// were told to drop the key they had cached. A `false` there is a save that
// really happened plus a caveat — so it belongs neither in the unqualified
// success the card used to show, nor in the red `keyError` channel, which would
// tell the user the save failed. This suite pins both halves of that.
//
// The journey suite (`src/e2e/key-change.e2e.test.tsx`) proves the same thing
// through the real IPC seam. What lives here instead is the card's own state
// rules, which the journey has no cheap way to drive: a stale notice being
// cleared when another save is set up, and a genuinely failed save keeping the
// error channel to itself.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  // `errorMessage` stays real, so any text the failure path surfaces is the text
  // a user would actually read.
  return { ...actual, saveApiKey: vi.fn(), setReasoning: vi.fn() };
});

import * as api from "../lib/api";
import { OpenRouterCard } from "./OpenRouterCard";
import { KEY_CHANGE_CAVEAT_MESSAGE } from "./KeyChangeCaveat";
import { ALWAYS_ASK_APPROVAL_STATUS } from "../lib/approvalStatusFixture";

const mockSaveKey = vi.mocked(api.saveApiKey);

const OR_ACTIVE: AiStatus = {
  activeProvider: "openRouter",
  reasoningSupported: "unknown",
  openrouter: { hasKey: true, model: "anthropic/claude-sonnet-4.5", reasoning: false },
  local: { activeModelTag: null },
  approval: ALWAYS_ASK_APPROVAL_STATUS,
};

function setup() {
  const user = userEvent.setup();
  render(
    <OpenRouterCard
      status={OR_ACTIVE}
      switching={false}
      onActivate={() => Promise.resolve()}
      refreshStatus={() => Promise.resolve()}
      applyStatus={vi.fn()}
    />,
  );
  return { user };
}

/** Fill in the key form and submit it. */
async function saveKey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /update key…/i }));
  await user.type(screen.getByLabelText("OpenRouter API key"), "sk-or-new");
  await user.click(screen.getByRole("button", { name: "Save key" }));
}

const caveat = () => screen.queryByText(KEY_CHANGE_CAVEAT_MESSAGE);

beforeEach(() => {
  mockSaveKey.mockReset();
});

describe("OpenRouterCard — a save the other windows were not told about", () => {
  it("keeps the save a success and adds the caveat, in the warning channel", async () => {
    mockSaveKey.mockResolvedValue({ revisionPublished: false });
    const { user } = setup();

    await saveKey(user);

    // Still a success: the form closed, and nothing red was raised.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save key" })).not.toBeInTheDocument();
    });
    const notice = caveat()?.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(notice).toHaveClass("border-warning/40");
    expect(notice!.className).not.toMatch(/destructive/);
  });

  it("says nothing extra when the other windows were told", async () => {
    mockSaveKey.mockResolvedValue({ revisionPublished: true });
    const { user } = setup();

    await saveKey(user);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Save key" })).not.toBeInTheDocument();
    });
    expect(caveat()).not.toBeInTheDocument();
  });

  it("clears the notice when another save is set up, so it can't describe the wrong key", async () => {
    mockSaveKey.mockResolvedValue({ revisionPublished: false });
    const { user } = setup();

    await saveKey(user);
    await waitFor(() => expect(caveat()).toBeInTheDocument());

    // The notice is a receipt of the save it came from. Opening the form starts
    // a save that will replace that key, so carrying it over would attach it to
    // a key it was never about.
    await user.click(screen.getByRole("button", { name: /update key…/i }));

    expect(caveat()).not.toBeInTheDocument();
  });

  it("stays dismissible, because the app cannot tell when the other window restarts", async () => {
    mockSaveKey.mockResolvedValue({ revisionPublished: false });
    const { user } = setup();

    await saveKey(user);
    await waitFor(() => expect(caveat()).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));

    expect(caveat()).not.toBeInTheDocument();
  });

  it("reports a save that really failed as an error, and raises no caveat", async () => {
    mockSaveKey.mockRejectedValue(new Error("keychain is locked"));
    const { user } = setup();

    await saveKey(user);

    // The form stays open with the failure inline — the existing behaviour, and
    // the one thing the caveat must never be confused with.
    expect(await screen.findByText(/keychain is locked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save key" })).toBeInTheDocument();
    expect(caveat()).not.toBeInTheDocument();
  });
});
