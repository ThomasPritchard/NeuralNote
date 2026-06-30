// Journey 7: create a folder, then move a note into it (the drag → move →
// refresh path). The note is open, so the breadcrumb must follow it to its new
// home — proving the move re-points the reader as well as the tree.

import { describe, it, expect } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

/** A minimal DataTransfer stand-in — jsdom doesn't implement one. */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "",
    setData: (key: string, value: string) => {
      store[key] = value;
    },
    getData: (key: string) => store[key] ?? "",
  };
}

const archiveRow = (): HTMLElement =>
  screen.getByText("Archive").closest('[role="treeitem"]') as HTMLElement;

describe("Journey 7: create a folder and move a note into it", () => {
  it("moves the open note into a new folder and follows it in the breadcrumb", async () => {
    const seed: SeedEntry[] = [{ kind: "file", relPath: "Note.md", content: "note body" }];
    const { user } = renderApp({ seed, recents });
    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

    // Open the note — breadcrumb shows its root-level rel-path.
    await user.click(await screen.findByRole("button", { name: "Note.md" }));
    await screen.findByRole("heading", { name: "Note", level: 1 });
    expect(screen.getAllByText("Note.md")).toHaveLength(2); // tree row + breadcrumb

    // Create a folder via the vault menu (sidebar header → "New folder"). The
    // workspace header carries the opened vault's name = basename(path) = "vault".
    await user.click(screen.getByRole("button", { name: /vault/i }));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    await user.type(await screen.findByLabelText("New folder name"), "Archive{Enter}");

    // Empty folder badge reads 0.
    expect(await screen.findByText("Archive")).toBeInTheDocument();
    expect(within(archiveRow()).getByText("0")).toBeInTheDocument();

    // Drag the note onto the folder and drop.
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Note.md" }), { dataTransfer });
    fireEvent.drop(archiveRow(), { dataTransfer });

    // The folder's child badge goes 0 → 1, and the note is still listed (now
    // nested under Archive) …
    await waitFor(() => expect(within(archiveRow()).getByText("1")).toBeInTheDocument());
    expect(screen.getByText("Note.md")).toBeInTheDocument();
    // … and the open-note breadcrumb followed it to "Archive/Note.md".
    expect(await screen.findByText("Archive/Note.md")).toBeInTheDocument();
  });
});
