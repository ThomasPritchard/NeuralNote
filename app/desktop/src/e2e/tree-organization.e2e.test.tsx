// Journey 7: create a folder, then move a note into it (the drag → move →
// refresh path). The note is open, so the breadcrumb must follow it to its new
// home — proving the move re-points the reader as well as the tree.
// Journey 11: the sidebar filename filter — narrowing, auto-expanding collapsed
// folders that hold a match, Escape-to-clear with collapse state preserved, and
// the explicit no-match message.

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

describe("Journey 11: sidebar filename filter", () => {
  it("narrows the tree, auto-expands collapsed matches, and restores collapse state on Escape", async () => {
    const seed: SeedEntry[] = [
      { kind: "file", relPath: "Projects/Rocket.md", content: "rocket body" },
      { kind: "file", relPath: "Archive/Old ideas.md", content: "old" },
      { kind: "file", relPath: "Todo.md", content: "todo" },
    ];
    const { user } = renderApp({ seed, recents });
    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));
    await screen.findByText("Todo.md");

    // Collapse "Projects" — its child leaves the tree. (The toggle's accessible
    // name is "Projects 1": folder name + child-count badge.)
    await user.click(screen.getByRole("button", { name: /^Projects/ }));
    expect(screen.queryByText("Rocket.md")).not.toBeInTheDocument();

    // Filter: non-matching rows disappear; the collapsed folder holding the
    // match auto-expands so the hit is visible.
    const filter = screen.getByLabelText("Filter files by name");
    await user.type(filter, "rocket");
    expect(await screen.findByText("Rocket.md")).toBeInTheDocument();
    expect(screen.queryByText("Todo.md")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    expect(screen.queryByText("Old ideas.md")).not.toBeInTheDocument();

    // Escape clears the filter; the full tree returns with collapse state
    // intact — Projects stays collapsed, Archive stays expanded.
    await user.keyboard("{Escape}");
    expect(filter).toHaveValue("");
    expect(await screen.findByText("Todo.md")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.getByText("Old ideas.md")).toBeInTheDocument();
    expect(screen.queryByText("Rocket.md")).not.toBeInTheDocument();

    // A query matching nothing states so explicitly — never a silently bare tree.
    await user.type(filter, "zzz");
    expect(await screen.findByText(/No files match/)).toBeInTheDocument();
    expect(screen.queryByText("Todo.md")).not.toBeInTheDocument();
  });
});
