// Journey 10: full-text vault search.
//   a. Ribbon Search → focused panel → type → grouped results (file header +
//      <mark>-highlighted match rows) → click a match → the note opens in the
//      reader while the sidebar stays on search.
//   b. ⌘K from anywhere in the workspace opens the panel and focuses the input.
//   c. A file whose NAME matches ranks before content-only hits.
//   d. A backend failure surfaces in the toast AND the panel — never silent.
//
// Real timers throughout: the panel's 200 ms debounce is ridden out with
// findBy* queries, exactly as a user would wait.

import { describe, it, expect } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

/** Open the recent vault and wait until the workspace has rendered. */
async function openVault(seed: SeedEntry[]): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name"); // files sidebar = workspace up
  return result;
}

describe("Journey 10: full-text vault search", () => {
  it("opens via the ribbon, shows grouped highlighted results, and opens a match in the reader", async () => {
    const { user } = await openVault([
      // Name-only hit: stem matches "recipe", content does not.
      { kind: "file", relPath: "Recipes.md", content: "Cooking ideas live here." },
      // Content hit: one matching line to become a <mark>ed match row.
      {
        kind: "file",
        relPath: "Journal.md",
        content: "Tried a new recipe today.\n\nMore notes tomorrow.",
      },
    ]);

    // Ribbon Search → the panel replaces the file tree, input focused.
    await user.click(screen.getByRole("button", { name: "Search" }));
    const input = await screen.findByLabelText("Search vault");
    expect(input).toHaveFocus();
    expect(screen.queryByLabelText("Filter files by name")).not.toBeInTheDocument();

    // Type a ≥2-char query and ride out the 200 ms debounce.
    await user.type(input, "recipe");
    const results = await screen.findByRole("list", { name: "Search results" });

    // Grouped: both file headers (title + rel path) are present …
    expect(within(results).getByText("Recipes")).toBeInTheDocument();
    expect(within(results).getByText("Recipes.md")).toBeInTheDocument();
    expect(within(results).getByText("Journal")).toBeInTheDocument();
    // … and Journal's content match renders a row with the term <mark>ed.
    expect(within(results).getByText("recipe", { selector: "mark" })).toBeInTheDocument();

    // Click the match row → the note opens in the reader.
    await user.click(within(results).getByRole("button", { name: /Tried a new recipe today/ }));
    expect(await screen.findByRole("heading", { name: "Journal", level: 1 })).toBeInTheDocument();
    expect(
      within(screen.getByRole("article")).getByText("Tried a new recipe today."),
    ).toBeInTheDocument();
    // The sidebar stayed on search (results still visible).
    expect(screen.getByLabelText("Search vault")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Search results" })).toBeInTheDocument();
  });

  it("opens the search panel and focuses the input via the Find menu action", async () => {
    await openVault([{ kind: "file", relPath: "Note.md", content: "body" }]);

    // ⌘K is a native-menu accelerator now; the menu emits menu://action.
    await act(async () => {
      await emit("menu://action", { action: "search" });
    });

    const input = await screen.findByLabelText("Search vault");
    expect(input).toHaveFocus();
    expect(screen.queryByLabelText("Filter files by name")).not.toBeInTheDocument();
  });

  it("ranks a file whose name matches above content-only hits", async () => {
    const { user } = await openVault([
      // Walk order puts Apple.md (content-only hit) FIRST; ranking must still
      // put the name hit on top.
      { kind: "file", relPath: "Apple.md", content: "alpha mention inside." },
      { kind: "file", relPath: "Zebra alpha.md", content: "stripes and stars." },
    ]);

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(await screen.findByLabelText("Search vault"), "alpha");

    const results = await screen.findByRole("list", { name: "Search results" });
    const text = results.textContent ?? "";
    expect(text).toContain("Zebra alpha.md");
    expect(text).toContain("Apple.md");
    expect(text.indexOf("Zebra alpha.md")).toBeLessThan(text.indexOf("Apple.md"));
  });

  it("surfaces a search failure in the toast and the panel — never silent", async () => {
    const { user, backend } = await openVault([
      { kind: "file", relPath: "Note.md", content: "searchable body" },
    ]);
    backend.setFailure("search_vault", { kind: "io", message: "disk exploded" });

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(await screen.findByLabelText("Search vault"), "body");

    // The shared toast carries the backend message …
    expect(await screen.findByText("disk exploded")).toBeInTheDocument();
    // … and the panel shows an inline failed state (not "no results").
    expect(
      screen.getByText("Search failed. See the error notice for details."),
    ).toBeInTheDocument();
  });
});
