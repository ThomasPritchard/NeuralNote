// Journeys 3–6: the note lifecycle inside an open vault.
//   3. Create a note → it appears in the tree → it opens → its content shows.
//   4. Edit a note → save → the saved state is reflected (no unsaved indicator).
//   5. Rename a note → the tree label AND the open-note breadcrumb both update.
//   6. Delete a note → it leaves the tree, and the reader clears (was open).

import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

/** Open the recent vault and wait until the workspace tree has rendered. */
async function openVault(seed: SeedEntry[]) {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  return result;
}

describe("Journey 3: create and open a note", () => {
  it("creates a note, lists it in the tree, opens it, and shows its content", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Welcome.md", content: "Hello vault." },
    ]);
    await screen.findByText("Welcome.md");

    // Create from the sidebar header "+".
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByLabelText("New note name"), "Ideas{Enter}");

    // It appears in the tree and auto-opens (the reader shows its title).
    expect(await screen.findByRole("button", { name: "Rename Ideas.md" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Ideas", level: 1 })).toBeInTheDocument();

    // Open the seeded note and confirm the editor is seeded with its raw content.
    await user.click(screen.getByRole("button", { name: "Welcome.md" }));
    await screen.findByRole("heading", { name: "Welcome", level: 1 });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Note source" })).toHaveValue("Hello vault.");
  });
});

describe("Journey 4: edit and save", () => {
  it("reflects the saved state and clears the unsaved indicator", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Edit.md", content: "original draft" },
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit.md" }));
    await screen.findByRole("heading", { name: "Edit", level: 1 }); // stem-derived title
    await user.click(screen.getByRole("button", { name: "Edit" })); // switch to edit mode

    const textarea = screen.getByRole("textbox", { name: "Note source" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // clean buffer
    await user.clear(textarea);
    await user.type(textarea, "updated body");

    // Dirty: the unsaved dot shows and Save enables.
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save" }));

    // Saved: the dot clears and Save disables again.
    await waitFor(() =>
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // Persisted: read mode renders the new body.
    await user.click(screen.getByRole("button", { name: "Read" }));
    expect(await screen.findByText("updated body")).toBeInTheDocument();
  });
});

describe("Journey 5: rename a note", () => {
  it("updates both the tree label and the open-note breadcrumb", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Old.md", content: "Old note body" },
    ]);

    await user.click(await screen.findByRole("button", { name: "Old.md" }));
    await screen.findByRole("heading", { name: "Old", level: 1 });
    // The name shows in the tree row AND the toolbar breadcrumb.
    expect(screen.getAllByText("Old.md")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Rename Old.md" }));
    const input = await screen.findByLabelText("Rename Old.md");
    await user.clear(input);
    await user.type(input, "New{Enter}");

    expect(await screen.findByRole("button", { name: "Rename New.md" })).toBeInTheDocument();
    expect(screen.queryByText("Old.md")).not.toBeInTheDocument();
    // Tree label + breadcrumb both reflect the new name.
    expect(screen.getAllByText("New.md")).toHaveLength(2);
  });
});

describe("Journey 6: delete a note", () => {
  it("removes it from the tree and clears the reader when it was open", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Trash.md", content: "to be deleted" },
    ]);

    await user.click(await screen.findByRole("button", { name: "Trash.md" }));
    await screen.findByRole("heading", { name: "Trash", level: 1 });

    await user.click(screen.getByRole("button", { name: "Delete Trash.md" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete note?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(screen.queryByText("Trash.md")).not.toBeInTheDocument());
    // Reader cleared back to the empty state.
    expect(
      screen.getByText("Select a note from the sidebar, or create one to begin."),
    ).toBeInTheDocument();
  });
});
