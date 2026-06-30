// Journeys 1–2: getting into a vault.
//   1. Welcome → open an existing vault (recent path AND folder-picker path) →
//      the file tree renders the seeded nodes.
//   2. Welcome → create a new vault → land in the empty workspace.
//
// Drives the real <App/> over the real IPC seam (mockIPC) — no component is
// stubbed; the genuine store + welcome + workspace tree run end-to-end.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, NEW_VAULT_PARENT, type SeedEntry } from "./mockVault";

const SEED: SeedEntry[] = [
  { kind: "file", relPath: "Welcome.md", content: "# Welcome\n\nYour second brain." },
  { kind: "file", relPath: "Meeting.md", content: "---\ntitle: Standup\ntags: [team, daily]\n---\n\nNotes." },
  { kind: "folder", relPath: "Projects" },
  { kind: "file", relPath: "Projects/Roadmap.md", content: "# Roadmap" },
];

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

describe("Journey 1: open an existing vault", () => {
  it("opens a recent vault and renders its seeded tree", async () => {
    const { user } = renderApp({ seed: SEED, recents });

    // Welcome screen first.
    expect(screen.getByRole("heading", { name: "NeuralNote", level: 1 })).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

    // Workspace is up and the seeded tree rendered.
    expect(await screen.findByRole("button", { name: /^Rename Welcome\.md$/ })).toBeInTheDocument();
    expect(screen.getByText("Welcome.md")).toBeInTheDocument();
    expect(screen.getByText("Meeting.md")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    // The footer status bar reflects the tree counts (3 notes incl. the nested one).
    expect(screen.getByText("3 notes")).toBeInTheDocument();
    expect(screen.getByText("1 folder")).toBeInTheDocument();
  });

  it("opens a vault chosen through the native folder picker", async () => {
    const { user } = renderApp({ seed: SEED, recents: [], pickFolder: VAULT_ROOT });

    // No recents → the empty-state hint is shown.
    expect(await screen.findByText(/No recent vaults yet/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open vault/ }));

    expect(await screen.findByText("Welcome.md")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("does nothing when the folder picker is cancelled", async () => {
    const { user } = renderApp({ seed: SEED, recents: [], pickFolder: null });

    await user.click(await screen.findByRole("button", { name: /Open vault/ }));

    // Still on the welcome screen — no workspace, no error.
    expect(screen.getByRole("heading", { name: "NeuralNote", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Welcome.md")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Journey 2: create a new vault", () => {
  it("creates a vault and lands in the empty workspace", async () => {
    const { user } = renderApp({ seed: [], recents: [], pickNewLocation: NEW_VAULT_PARENT });

    await user.click(await screen.findByRole("button", { name: /New vault/ }));

    // The inline naming step shows the chosen parent directory.
    const nameField = await screen.findByLabelText("Vault name");
    expect(screen.getByText(NEW_VAULT_PARENT)).toBeInTheDocument();

    await user.type(nameField, "Fresh");
    await user.click(screen.getByRole("button", { name: /Create vault/ }));

    // Lands in the workspace, named "Fresh", with the empty-vault hint.
    expect(
      await screen.findByText("This vault is empty. Use the + above to create your first note."),
    ).toBeInTheDocument();
    expect(screen.getByText("Select a note from the sidebar, or create one to begin.")).toBeInTheDocument();
    // Sidebar header carries the new vault name.
    const sidebar = screen.getByRole("button", { name: /^Fresh/ });
    expect(within(sidebar).getByText("Fresh")).toBeInTheDocument();
  });
});
