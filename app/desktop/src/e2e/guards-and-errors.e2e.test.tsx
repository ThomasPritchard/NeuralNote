// Journeys 8–9: the safety rails.
//   8. Unsaved-edit guard — note navigation preserves a dirty buffer in its own
//      tab, while the destructive OS window-close path still requires explicit
//      discard consent.
//   9. Error surfacing — when a backend command rejects, the failure is shown in
//      a real error channel; it is never swallowed.

import { describe, it, expect } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

function placeCaretAtEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

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
  await waitFor(() =>
    expect(editor.closest(".nn-rich-editor")).toHaveAttribute("aria-busy", "false"),
  );
  await user.click(editor);
  placeCaretAtEnd(editor);
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
    await waitFor(() => expect(editor).toHaveTextContent("aaa body edit"));
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
});
