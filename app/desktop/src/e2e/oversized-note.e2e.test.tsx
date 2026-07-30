// Issue #82 journeys: an oversized note (past the 8 MiB editable limit) must
// never freeze the webview — opened directly OR restored as a previously open
// tab on launch. Both journeys drive the real <App/> over the mockIPC seam
// with an 8 MiB+1 single-line note (the same shape as the
// `07 Exact-byte and size/Oversized editable note.md` fixture), and prove the
// app lands on the explicit size-limit state with no editor mount, while
// close-tab / tab-switch / close-vault all stay responsive.

import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";
import { MAX_EDITABLE_NOTE_BYTES } from "./mockVaultNotes";

const OVERSIZED_REL = "Oversized editable note.md";
// One byte past the limit, a single gigantic line with no newlines — the exact
// fixture shape that froze the webview.
const OVERSIZED_BODY = "x".repeat(MAX_EDITABLE_NOTE_BYTES + 1);

const SEED: SeedEntry[] = [
  { kind: "file", relPath: "Welcome.md", content: "# Welcome\n\nYour second brain." },
  { kind: "file", relPath: OVERSIZED_REL, content: OVERSIZED_BODY },
];

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

// The 8 MiB seed makes these journeys slower than the 5s default testTimeout,
// especially under coverage instrumentation. Measured ~4s locally, but the
// full-suite CI runner (2 cores, parallel workers) ran >5x slower and tripped
// a 20s budget on Node 24 — keep generous headroom. A real restore-gate hang
// (the regression this guards) still fails here, just later.
const JOURNEY_TIMEOUT = 60_000;

describe("Journey: open an oversized note directly (issue #82)", () => {
  it(
    "shows the explicit size-limit state, never mounts the editor, and stays responsive",
    { timeout: JOURNEY_TIMEOUT },
    async () => {
      const { user } = renderApp({ seed: SEED, recents });

      await user.click(await screen.findByRole("button", { name: "Open My Brain" }));
      await user.click(
        await screen.findByRole("button", { name: "Oversized editable note.md" }),
      );

      // The terminal size-limit state — NOT a spinner that never resolves.
      expect(await screen.findByText(/too large to edit/i)).toBeInTheDocument();
      expect(screen.getByText(/8\.0 MiB/)).toBeInTheDocument();
      expect(screen.getByText(/file on disk is unchanged/i)).toBeInTheDocument();
      // No editor, no Save: the 8 MiB string never reaches CodeMirror, and the
      // empty on-the-wire draft can never be written back over the real file.
      expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

      // The webview is fully responsive: another note opens instantly (the clean
      // oversized tab is reused, per the single-tab reuse rule) and edits fine…
      await user.click(screen.getByRole("button", { name: "Welcome.md" }));
      expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent(
        "# Welcome",
      );
      // …and flipping straight back to the oversized note lands on the
      // size-limit state again — no freeze in either direction.
      await user.click(screen.getByRole("button", { name: "Oversized editable note.md" }));
      expect(await screen.findByText(/too large to edit/i)).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();

      // Closing the tab is immediate — no guard dialog, no hang.
      await user.click(
        screen.getByRole("button", { name: "Close Oversized editable note" }),
      );
      expect(
        screen.queryByRole("tab", { name: /Oversized editable note/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Select a note from the sidebar, or create one to begin."),
      ).toBeInTheDocument();
    },
  );
});

describe("Journey: restore a workspace with an oversized open tab (issue #82)", () => {
  it(
    "restores around the oversized tab without stalling the restore gate",
    { timeout: JOURNEY_TIMEOUT },
    async () => {
      const { user, backend } = renderApp({
        seed: SEED,
        recents,
        // As if the app was quit with both tabs open, oversized one active.
        workspaceState: {
          openPaths: [OVERSIZED_REL, "Welcome.md"],
          activePath: OVERSIZED_REL,
        },
      });

      await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

      // The restored oversized tab reaches the terminal size-limit state — the
      // restore-completion gate does NOT stall waiting on a tab stuck `loading`.
      expect(await screen.findByText(/too large to edit/i)).toBeInTheDocument();
      expect(screen.queryByLabelText("Loading note")).not.toBeInTheDocument();

      // The gate completed: the oversized tab counts as restored (its file is
      // intact — only editing is declined), so there is no skipped-tabs toast…
      expect(
        screen.queryByText(/skipped because the note could not be opened/i),
      ).not.toBeInTheDocument();
      // …the workspace state writer is live again (it only schedules once the
      // restore gate marks the workspace ready)…
      await waitFor(() => expect(backend.calls).toContain("save_workspace_state"));
      // …and the healthy restored tab is right there and switches in instantly.
      await user.click(screen.getByRole("tab", { name: /^Welcome$/i }));
      expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent(
        "# Welcome",
      );

      // Back on the oversized tab, closing the whole vault works with it open.
      await user.click(screen.getByRole("tab", { name: /Oversized editable note/i }));
      expect(await screen.findByText(/too large to edit/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /vault/i }));
      await user.click(await screen.findByRole("menuitem", { name: "Close vault" }));
      // Lands back on the welcome screen — the process never had to be killed.
      expect(
        await screen.findByRole("heading", { name: "NeuralNote", level: 1 }),
      ).toBeInTheDocument();
    },
  );
});
