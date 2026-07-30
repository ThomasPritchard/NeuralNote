// Issue #31 journeys: an open note must follow its file on disk SAFELY when the
// vault changes externally (Obsidian, a git pull, a sync).
//   - External edit of a CLEAN open note reloads the reader — a burst of
//     watcher pings coalesces into ONE reconcile read (300 ms debounce).
//   - External deletion surfaces an explicit notice; the note + draft are kept.
//   - A DIRTY draft is never clobbered: the conflict notice surfaces and
//     "Reload (discard edits)" resolves it explicitly.
//   - An in-app save's own watcher ping never loops into a spurious reload.
//   - An in-app rename moves the tab; an external edit at the NEW path lands.
//   - Closing the vault tears the listener down: no reconcile fires after.
//   - Edge (#82 × #31): a clean note that grows past the 8 MiB editable limit
//     externally lands on the size-limit state — the reconcile never mounts
//     the oversized content into the editor.
//
// The mock backend mutates "on disk" OUTSIDE the IPC seam (applyExternalEdit /
// applyExternalDelete — no command logged, exactly like another editor); the
// test then plays the notify watcher's ping by emitting TREE_CHANGED through
// the real mockIPC event bridge, so the app's genuine onTreeChanged
// subscriptions (store tree refresh + useNoteTabs reconcile) both run.

import { describe, it, expect } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { TREE_CHANGED } from "../lib/bindings/events";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";
import { MAX_EDITABLE_NOTE_BYTES } from "./mockVaultNotes";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const SEED: SeedEntry[] = [
  { kind: "file", relPath: "Alpha.md", content: "Alpha body." },
  { kind: "file", relPath: "Beta.md", content: "Beta body." },
];

// The reconcile debounce is 300 ms; negative assertions wait well past it.
const PAST_DEBOUNCE_MS = 600;

/** Open the recent vault and wait until the workspace tree has rendered. */
async function openVault(seed: SeedEntry[] = SEED): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name");
  return result;
}

/** Play the file watcher's ping through the real event bus, flushed under act. */
async function fireWatcher(times = 1): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await emit(TREE_CHANGED);
  });
}

const readNoteCalls = (backend: RenderAppResult["backend"]) =>
  backend.calls.filter((cmd) => cmd === "read_note").length;

const noteEditor = () => screen.findByRole("textbox", { name: "Note content" });

/** Fresh editor handle per assertion: a reload rebuilds the CodeMirror view
 *  (the old session is destroyed so new content mounts clean), so a captured
 *  element reference goes stale — always re-query. */
const getEditor = () => screen.getByRole("textbox", { name: "Note content" });

describe("Journey: external edit reloads a clean open note (issue #31)", () => {
  it("updates the reader, coalescing a watcher burst into one reconcile read", async () => {
    const { user, backend } = await openVault();
    await user.click(await screen.findByRole("button", { name: "Alpha.md" }));
    expect(await noteEditor()).toHaveTextContent("Alpha body.");
    expect(readNoteCalls(backend)).toBe(1); // the initial open

    backend.applyExternalEdit("Alpha.md", "edited elsewhere");
    await fireWatcher(3); // a git-pull-style burst must collapse into one read

    await waitFor(() => expect(getEditor()).toHaveTextContent("edited elsewhere"), {
      timeout: 3000,
    });
    // Clean reload: no unsaved indicator, no conflict, no deletion notice.
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deleted on disk/)).not.toBeInTheDocument();
    expect(readNoteCalls(backend)).toBe(2); // one debounced reconcile, not three
  });
});

describe("Journey: external deletion of an open note (issue #31)", () => {
  it("surfaces the deletion notice and keeps the note and draft on screen", async () => {
    const { user, backend } = await openVault();
    await user.click(await screen.findByRole("button", { name: "Alpha.md" }));
    expect(await noteEditor()).toHaveTextContent("Alpha body.");

    backend.applyExternalDelete("Alpha.md");
    await fireWatcher();

    expect(
      await screen.findByText(/deleted on disk/, undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
    // Nothing is dropped: the tab stays open with its content, and the
    // contradictory "changed on disk" conflict notice does NOT show.
    expect(screen.getByRole("tab", { name: /^Alpha$/ })).toBeInTheDocument();
    expect(await noteEditor()).toHaveTextContent("Alpha body.");
    expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
  });
});

describe("Journey: external edit under a dirty draft (issue #31)", () => {
  it("surfaces the conflict, preserves the draft, and Reload resolves it explicitly", async () => {
    const { user, backend } = await openVault();
    await user.click(await screen.findByRole("button", { name: "Alpha.md" }));
    const editor = await noteEditor();
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}");
    await user.type(editor, " my unsaved work");
    await screen.findByLabelText("Unsaved changes");

    backend.applyExternalEdit("Alpha.md", "changed under me");
    await fireWatcher();

    // The conflict surfaces — and the draft is never clobbered.
    expect(
      await screen.findByText(/changed on disk since you opened it/, undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
    expect(editor).toHaveTextContent("my unsaved work");
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();

    // The user resolves it explicitly: Reload takes the disk version.
    await user.click(screen.getByRole("button", { name: /Reload \(discard edits\)/ }));
    await waitFor(() => expect(getEditor()).toHaveTextContent("changed under me"), {
      timeout: 3000,
    });
    expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    expect(getEditor()).not.toHaveTextContent("my unsaved work");
  });
});

describe("Journey: in-app save does not self-trigger a reload (issue #31)", () => {
  it("treats the save's own watcher ping as a no-op — no reload, no conflict", async () => {
    const { user, backend } = await openVault();
    await user.click(await screen.findByRole("button", { name: "Alpha.md" }));
    const editor = await noteEditor();
    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}");
    await user.type(editor, " saved in app");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument(),
    );

    // The save wrote the file, which fires the watcher: the reconcile reads it
    // back, finds the hash unchanged, and leaves the tab exactly as saved.
    await fireWatcher();
    await act(() => new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS)));

    expect(editor).toHaveTextContent("saved in app");
    expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deleted on disk/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    expect(backend.calls).toContain("write_note");
  });
});

describe("Journey: rename of an open note (issue #31)", () => {
  it("moves the tab with the rename and reconciles an external edit at the new path", async () => {
    const { user, backend } = await openVault([
      { kind: "file", relPath: "Old.md", content: "Old note body" },
    ]);
    await user.click(await screen.findByRole("button", { name: "Old.md" }));
    expect(await noteEditor()).toHaveTextContent("Old note body");

    await user.click(screen.getByRole("button", { name: "Rename Old.md" }));
    const input = await screen.findByLabelText("Rename Old.md");
    await user.clear(input);
    await user.type(input, "New{Enter}");
    // The tab follows the rename — tree label and breadcrumb both update.
    expect(await screen.findByRole("button", { name: "Rename New.md" })).toBeInTheDocument();
    expect(screen.queryByText("Old.md")).not.toBeInTheDocument();

    // An external edit landing at the NEW path reloads the same tab.
    backend.applyExternalEdit("New.md", "edited at the new path");
    await fireWatcher();
    await waitFor(() => expect(getEditor()).toHaveTextContent("edited at the new path"), {
      timeout: 3000,
    });
    expect(screen.queryByText(/deleted on disk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
  });
});

describe("Journey: vault close tears down the reconcile listener (issue #31)", () => {
  it("never reconciles after the workspace unmounts", async () => {
    const { user, backend } = await openVault();
    await user.click(await screen.findByRole("button", { name: "Alpha.md" }));
    expect(await noteEditor()).toHaveTextContent("Alpha body.");
    const readsWhileOpen = readNoteCalls(backend);

    await user.click(screen.getByRole("button", { name: /vault/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Close vault" }));
    await screen.findByRole("heading", { name: "NeuralNote", level: 1 }); // welcome

    // A watcher ping after close must reach no listener: no reconcile read.
    backend.applyExternalEdit("Alpha.md", "edited while closed");
    await fireWatcher();
    await act(() => new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS)));
    expect(readNoteCalls(backend)).toBe(readsWhileOpen);
  });
});

describe("Journey: external change grows a clean note past the editable limit (#31 × #82)", () => {
  it(
    "lands on the explicit size-limit state — the oversized content never mounts an editor",
    { timeout: 20_000 },
    async () => {
      const { user, backend } = await openVault([
        { kind: "file", relPath: "Grow.md", content: "small enough" },
      ]);
      await user.click(await screen.findByRole("button", { name: "Grow.md" }));
      expect(await noteEditor()).toHaveTextContent("small enough");

      // Another editor inflates the file past 8 MiB; the watcher pings.
      backend.applyExternalEdit("Grow.md", "x".repeat(MAX_EDITABLE_NOTE_BYTES + 1));
      await fireWatcher();

      // The flagged read-side doc flows through the SAME reconcile path: the
      // tab lands on the size-limit notice, never in CodeMirror.
      expect(
        await screen.findByText(/too large to edit/i, undefined, { timeout: 3000 }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
      expect(screen.queryByText(/changed on disk/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    },
  );
});
