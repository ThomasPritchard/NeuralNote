// Journeys 8–9: the safety rails.
//   8. Unsaved-edit guard — navigating away (and the OS window-close path) from a
//      dirty buffer raises the discard confirm; cancel keeps the buffer, discard
//      proceeds.
//   9. Error surfacing — when a backend command rejects, the failure is shown in
//      a real error channel; it is never swallowed.

import { describe, it, expect } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

async function openVault(seed: SeedEntry[]): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  return result;
}

/** Open note A in edit mode and dirty its buffer. */
async function openAndDirty({ user }: RenderAppResult) {
  await user.click(await screen.findByRole("button", { name: "A.md" }));
  await screen.findByRole("heading", { name: "A", level: 1 });
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.type(screen.getByRole("textbox", { name: "Note source" }), " edit");
  expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
}

const TWO_NOTES: SeedEntry[] = [
  { kind: "file", relPath: "A.md", content: "aaa body" },
  { kind: "file", relPath: "B.md", content: "bbb body" },
];

describe("Journey 8: unsaved-edit guard", () => {
  it("blocks navigation: cancel keeps the buffer, discard proceeds", async () => {
    const ctx = await openVault(TWO_NOTES);
    const { user } = ctx;
    await openAndDirty(ctx);

    // Attempt to open B → discard confirm appears.
    await user.click(screen.getByRole("button", { name: "B.md" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard unsaved changes?")).toBeInTheDocument();

    // Cancel → dialog dismissed, still editing A, buffer intact.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note source" })).toBeInTheDocument();

    // Try again → discard → B opens (read mode), buffer gone.
    await user.click(screen.getByRole("button", { name: "B.md" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("heading", { name: "B", level: 1 })).toBeInTheDocument();
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("intercepts the OS window-close request and destroys only on discard", async () => {
    const ctx = await openVault(TWO_NOTES);
    const { user, backend } = ctx;
    await openAndDirty(ctx);

    // OS close request with a dirty buffer → held open behind the discard guard.
    await act(async () => {
      await emit("tauri://close-requested");
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(backend.wasDestroyed()).toBe(false); // not closed yet

    // Discard → the window is destroyed for real.
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(backend.wasDestroyed()).toBe(true));
  });
});

describe("Journey 9: error surfacing", () => {
  it("surfaces a failed file operation inline (never silent)", async () => {
    const { user, backend } = await openVault([
      { kind: "file", relPath: "Welcome.md", content: "# Welcome" },
    ]);
    backend.setFailure("create_note", {
      kind: "alreadyExists",
      message: 'A note named "Dup.md" already exists.',
    });

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByLabelText("New note name"), "Dup{Enter}");

    // The rejection is shown, and the input stays open for correction.
    expect(await screen.findByText('A note named "Dup.md" already exists.')).toBeInTheDocument();
    expect(screen.getByLabelText("New note name")).toBeInTheDocument();
  });

  it("surfaces a failed note read with a retry affordance", async () => {
    const { user, backend } = await openVault([
      { kind: "file", relPath: "Welcome.md", content: "# Welcome" },
    ]);
    backend.setFailure("read_note", {
      kind: "io",
      message: "could not read note from disk",
    });

    await user.click(await screen.findByRole("button", { name: "Welcome.md" }));

    expect(await screen.findByText("could not read note from disk")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
