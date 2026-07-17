// Journey 7: create a folder, then move a note into it (the drag → move →
// refresh path). The note is open, so the breadcrumb must follow it to its new
// home — proving the move re-points the reader as well as the tree.
// Journey 11: the sidebar filename filter — narrowing, auto-expanding collapsed
// folders that hold a match, Escape-to-clear with collapse state preserved, and
// the explicit no-match message.

import { describe, it, expect } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
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

    // Create a folder through the native File menu action.
    await act(async () => {
      await emit("menu://action", { action: "new-folder" });
    });
    await user.type(await screen.findByLabelText("New folder name"), "Archive{Enter}");

    // Folders start collapsed and load lazily, so the child-count badge only
    // appears once the folder is expanded. Expand the (empty) Archive → badge 0.
    expect(await screen.findByText("Archive")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Archive/ }));
    await waitFor(() => expect(within(archiveRow()).getByText("0")).toBeInTheDocument());

    // Drag the note onto the folder and drop.
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Note.md" }), { dataTransfer });
    fireEvent.drop(archiveRow(), { dataTransfer });

    // The folder's child badge goes 0 → 1, and the note is now listed nested
    // under the (expanded) Archive …
    await waitFor(() => expect(within(archiveRow()).getByText("1")).toBeInTheDocument());
    expect(screen.getByText("Note.md")).toBeInTheDocument();
    // … and the open-note breadcrumb followed it to "Archive/Note.md".
    expect(await screen.findByText("Archive/Note.md")).toBeInTheDocument();
  });
});

describe("Journey 11: sidebar filename filter", () => {
  it("narrows the tree and auto-expands a match cached behind a collapsed folder", async () => {
    const seed: SeedEntry[] = [
      { kind: "file", relPath: "Projects/Rocket.md", content: "rocket body" },
      { kind: "file", relPath: "Archive/Old ideas.md", content: "old" },
      { kind: "file", relPath: "Todo.md", content: "todo" },
    ];
    const { user } = renderApp({ seed, recents });
    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));
    await screen.findByText("Todo.md");

    // Folders start collapsed and lazily loaded. Expand Archive (it stays open),
    // and expand → then collapse Projects so its child is CACHED behind a
    // collapsed folder: the filter matches loaded nodes, so a folder must have
    // been opened once for the filter to reach into it.
    await user.click(screen.getByRole("button", { name: /^Archive/ }));
    expect(await screen.findByText("Old ideas.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Projects/ })); // expand → loads Rocket.md
    expect(await screen.findByText("Rocket.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Projects/ })); // collapse → cached, hidden
    expect(screen.queryByText("Rocket.md")).not.toBeInTheDocument();

    // Filter: non-matching rows disappear; the collapsed folder holding the
    // (cached) match auto-expands so the hit is visible.
    const filter = screen.getByLabelText("Filter files by name");
    await user.type(filter, "rocket");
    expect(await screen.findByText("Rocket.md")).toBeInTheDocument();
    expect(screen.queryByText("Todo.md")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
    expect(screen.queryByText("Old ideas.md")).not.toBeInTheDocument();
  });
});
