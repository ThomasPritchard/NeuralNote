// Journeys 8–9: the safety rails.
//   8. Unsaved-edit guard — note navigation preserves a dirty buffer in its own
//      tab, while the destructive OS window-close path still requires explicit
//      discard consent.
//   9. Error surfacing — when a backend command rejects, the failure is shown in
//      a real error channel; it is never swallowed — and, where the failure has
//      a lasting on-screen consequence, that surface tells the truth for the
//      rest of the session rather than only until a toast is dismissed.

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

const TWO_NOTES: SeedEntry[] = [
  { kind: "file", relPath: "A.md", content: "aaa body" },
  { kind: "file", relPath: "B.md", content: "bbb body" },
];

describe("Journey 8: unsaved-edit guard", () => {
  it("preserves a dirty note in its tab when navigating to another note", async () => {
    const ctx = await openVault(TWO_NOTES);
    const { user } = ctx;
    await openAndDirty(ctx);

    // Opening B is non-destructive: the dirty A buffer stays in a background tab.
    await user.click(screen.getByRole("button", { name: "B.md" }));
    expect(await screen.findByRole("heading", { name: "B", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "A, unsaved changes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");

    // Returning to A restores its exact edit buffer rather than re-reading disk.
    await user.click(screen.getByRole("tab", { name: "A, unsaved changes" }));
    const editor = await screen.findByRole("textbox", { name: "Note content" });
    await waitFor(() => expect(editor).toHaveTextContent("aaa body"));
    expect(editor).toHaveTextContent("edit");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
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

  it("never renders a failed vault-index read as a note count, and retries in place", async () => {
    // The read must fail on the FIRST index read, before the workspace mounts —
    // that is the shape that used to leave `tree` at its initial `[]` for the
    // whole session (issue #209).
    const { user, backend } = renderApp({ seed: TWO_NOTES, recents });
    backend.setFailure("read_tree", { kind: "io", message: "vault root unreadable" });

    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

    // The sidebar reads through the separate lazy `list_dir` path, so the real
    // contents are on screen — which is what made "0 notes" a visible lie.
    expect(await screen.findByText("A.md")).toBeInTheDocument();
    expect(screen.getByText("B.md")).toBeInTheDocument();

    // The failure reaches a toast AND stays on the footer after it is gone.
    expect(await screen.findByText("vault root unreadable")).toBeInTheDocument();
    expect(await screen.findByText("Counts unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0 notes")).not.toBeInTheDocument();
    expect(screen.queryByText("0 folders")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-health")).toHaveAttribute("data-health", "unavailable");

    // Retry re-reads the index in place — no reopening the vault.
    backend.clearFailure("read_tree");
    await user.click(screen.getByRole("button", { name: "Retry reading the vault" }));

    expect(await screen.findByText("2 notes")).toBeInTheDocument();
    expect(screen.getByText("0 folders")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Counts unavailable")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("vault-health")).toHaveAttribute("data-health", "healthy");
  });

  it("says the [[ index is unavailable rather than offering an empty list", async () => {
    // The same failed read, followed all the way down the other branch of the
    // chain: Workspace -> WorkspacePanes -> NotePane -> SourceNoteEditor -> the
    // completion source. Nothing is stubbed between them here, so a severed
    // status prop at any hop shows up as an empty popup — which reads as "this
    // vault has no notes to link to" rather than "the index could not be read"
    // (issue #209).
    const { user, backend } = renderApp({ seed: TWO_NOTES, recents });
    backend.setFailure("read_tree", { kind: "io", message: "vault root unreadable" });
    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

    await user.click(await screen.findByRole("button", { name: "A.md" }));
    const editor = await screen.findByRole("textbox", { name: "Note content" });
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}");
    // userEvent reads "[[" as its own escape for a single "[".
    await user.type(editor, " [[[[");

    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Vault index unavailable")).toBeInTheDocument();
    expect(within(listbox).getByText("Refresh the vault to retry")).toBeInTheDocument();
  });
});
