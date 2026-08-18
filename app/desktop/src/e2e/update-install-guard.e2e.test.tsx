// Journey: installing an update must cross the same unsaved-edit guard as every
// other path to process exit (issue #205). "Install and relaunch" kills the
// process, and the consent the user gave in the update dialog was about release
// notes — not about losing unsaved notes. There is no autosave, so an
// unguarded relaunch destroys every dirty buffer with no way back.
//
// Only the app-owned updater boundary (`../updater`) is faked here: the whole
// coordinator -> vault -> workspace -> guard wiring this journey exists to prove
// runs for real, through the real editor, the real toast, and the real dialogs.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { UpdateState } from "../updater";

const mocks = vi.hoisted(() => {
  let stateListener: ((state: UpdateState) => void) | undefined;
  return {
    service: {
      getState: vi.fn<() => UpdateState>(() => ({ status: "idle" })),
      getLastAutomaticError: vi.fn<() => string | null>(() => null),
      check: vi.fn().mockResolvedValue({ status: "idle" }),
      installAndRelaunch: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((listener: (state: UpdateState) => void) => {
        stateListener = listener;
        return vi.fn();
      }),
      subscribeAutomaticErrors: vi.fn(() => vi.fn()),
    },
    publishState(state: UpdateState) {
      stateListener?.(state);
    },
    resetListeners() {
      stateListener = undefined;
    },
  };
});

vi.mock("../updater", async (importOriginal) => {
  const original = await importOriginal<typeof import("../updater")>();
  return { ...original, updateService: mocks.service };
});

import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const AVAILABLE: UpdateState = {
  status: "available",
  update: { version: "0.9.9", notes: "A safer alpha." },
};

const ONE_NOTE: SeedEntry[] = [{ kind: "file", relPath: "A.md", content: "aaa body" }];

async function openVault(): Promise<RenderAppResult> {
  const result = renderApp({ seed: ONE_NOTE, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  return result;
}

/** Open note A in its in-place editor and dirty its buffer. */
async function openAndDirty({ user }: RenderAppResult) {
  await user.click(await screen.findByRole("button", { name: "A.md" }));
  await screen.findByRole("heading", { name: "A", level: 1 });
  const editor = await screen.findByRole("textbox", { name: "Note content" });
  await user.click(editor);
  await user.keyboard("{Control>}{End}{/Control}");
  await user.type(editor, " edit");
  expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
}

/** Accept the available-update toast and press the dialog's install button. */
async function pressInstallAndRelaunch({ user }: RenderAppResult) {
  act(() => mocks.publishState(AVAILABLE));
  await user.click(await screen.findByRole("button", { name: "Review update" }));
  const dialog = await screen.findByRole("dialog", {
    name: "NeuralNote 0.9.9 is available",
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Install and relaunch" }),
  );
}

describe("Journey: update install crosses the unsaved-edit guard", () => {
  beforeEach(() => {
    mocks.resetListeners();
    mocks.service.installAndRelaunch.mockReset().mockResolvedValue(undefined);
  });

  it("installs with no extra prompt when nothing is unsaved", async () => {
    const ctx = await openVault();
    await ctx.user.click(await screen.findByRole("button", { name: "A.md" }));
    await screen.findByRole("heading", { name: "A", level: 1 });

    await pressInstallAndRelaunch(ctx);

    await waitFor(() =>
      expect(mocks.service.installAndRelaunch).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("holds a dirty note's install behind explicit consent, then installs", async () => {
    const ctx = await openVault();
    await openAndDirty(ctx);

    await pressInstallAndRelaunch(ctx);

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Install update and relaunch?")).toBeInTheDocument();
    expect(mocks.service.installAndRelaunch).not.toHaveBeenCalled();

    await ctx.user.click(
      within(confirm).getByRole("button", { name: "Install and relaunch" }),
    );

    await waitFor(() =>
      expect(mocks.service.installAndRelaunch).toHaveBeenCalledOnce(),
    );
  });

  it("keeps the dirty note and installs nothing when consent is refused", async () => {
    const ctx = await openVault();
    await openAndDirty(ctx);

    await pressInstallAndRelaunch(ctx);

    const confirm = await screen.findByRole("alertdialog");
    await ctx.user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(mocks.service.installAndRelaunch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });
});
