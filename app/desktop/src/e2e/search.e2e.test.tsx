// Journey 10: full-text vault search.
//   a. Ribbon Search → focused panel → type → grouped results (file header +
//      <mark>-highlighted match rows) → click a match → the note opens in the
//      reader while the sidebar stays on search.
//   b. ⌘K from anywhere in the workspace opens the panel and focuses the input.
//   c. A file whose NAME matches ranks before content-only hits.
//   d. A backend failure surfaces in the toast AND the panel — never silent.
//
// The panel's 200 ms debounce is driven by a fake clock so each journey waits
// on the real boundary without spending wall-clock time or hiding timer drift.

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];
const SEARCH_DEBOUNCE_MS = 200;

async function triggerDebouncedSearch(
  trigger: () => void,
  beforeExpiry?: () => void,
): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => {
      trigger();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    });
    beforeExpiry?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  } finally {
    vi.useRealTimers();
  }
}

/** Open the recent vault and wait until the workspace has rendered. */
async function openVault(
  seed: SeedEntry[],
  mockIpcScenario?: string,
): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents, mockIpcScenario });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name"); // files sidebar = workspace up
  return result;
}

describe("Journey 10: full-text vault search", () => {
  it("clicks an inline tag into an exact, hierarchical tag search", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Source.md", content: "#SaaS overview" },
      { kind: "file", relPath: "Exact.md", content: "Uses #SaaS" },
      { kind: "file", relPath: "Nested.md", content: "Uses #SaaS/cloud" },
      { kind: "file", relPath: "Prefix.md", content: "Uses #SaaSExtra" },
      { kind: "file", relPath: "Code.md", content: "`#SaaS`" },
      { kind: "file", relPath: "Property.md", content: "---\ntags: [SaaS]\n---\nBody" },
    ], "search-inline-tags");

    await user.click(screen.getByRole("button", { name: "Source.md" }));
    await screen.findByRole("textbox", { name: "Note content" });
    await triggerDebouncedSearch(
      () => fireEvent.mouseDown(document.querySelector(".nn-lp-tag")!),
      () => expect(screen.queryByRole("list", { name: "Search results" })).toBeNull(),
    );

    const input = await screen.findByLabelText("Search vault");
    await waitFor(() => expect(input).toHaveValue("tag:#SaaS"));
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("Source.md")).toBeInTheDocument();
    expect(within(results).getByText("Exact.md")).toBeInTheDocument();
    expect(within(results).getByText("Nested.md")).toBeInTheDocument();
    expect(within(results).getByText("Property.md")).toBeInTheDocument();
    expect(within(results).queryByText("Prefix.md")).toBeNull();
    expect(within(results).queryByText("Code.md")).toBeNull();
  });

  it("clicks a YAML property tag into the same filtered search", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Property source.md", content: "---\ntags: [SaaS]\n---\nBody" },
      { kind: "file", relPath: "Exact.md", content: "Uses #SaaS" },
      { kind: "file", relPath: "Nested.md", content: "---\ntags: [SaaS/cloud]\n---\nBody" },
      { kind: "file", relPath: "Prefix.md", content: "Uses #SaaSExtra" },
    ], "search-property-tags");

    await user.click(screen.getByRole("button", { name: "Property source.md" }));
    const tagButton = await screen.findByRole("button", { name: "Search for #SaaS" });
    await triggerDebouncedSearch(() => fireEvent.click(tagButton));

    const input = await screen.findByLabelText("Search vault");
    await waitFor(() => expect(input).toHaveValue("tag:#SaaS"));
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("Property source.md")).toBeInTheDocument();
    expect(within(results).getByText("Exact.md")).toBeInTheDocument();
    expect(within(results).getByText("Nested.md")).toBeInTheDocument();
    expect(within(results).queryByText("Prefix.md")).toBeNull();
  });

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
    ], "search-recipe");

    // Ribbon Search → the panel replaces the file tree, input focused.
    await user.click(screen.getByRole("button", { name: "Search" }));
    const input = await screen.findByLabelText("Search vault");
    await waitFor(() => expect(input).toHaveFocus());
    expect(
      screen.getByLabelText("Filter files by name").closest(".nn-primary-sidebar-panel"),
    ).toHaveAttribute("hidden");

    // Enter a ≥2-char query and advance the exact 200 ms debounce.
    await triggerDebouncedSearch(() =>
      fireEvent.change(input, { target: { value: "recipe" } }),
    );
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
    const editor = await screen.findByRole("textbox", { name: "Note content" });
    await waitFor(() => expect(editor).toHaveTextContent("Tried a new recipe today."));
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
    expect(
      screen.getByLabelText("Filter files by name").closest(".nn-primary-sidebar-panel"),
    ).toHaveAttribute("hidden");
  });

  it("ranks a file whose name matches above content-only hits", async () => {
    const { user } = await openVault([
      // Walk order puts Apple.md (content-only hit) FIRST; ranking must still
      // put the name hit on top.
      { kind: "file", relPath: "Apple.md", content: "alpha mention inside." },
      { kind: "file", relPath: "Zebra alpha.md", content: "stripes and stars." },
    ], "search-alpha");

    await user.click(screen.getByRole("button", { name: "Search" }));
    const input = await screen.findByLabelText("Search vault");
    await triggerDebouncedSearch(() =>
      fireEvent.change(input, { target: { value: "alpha" } }),
    );

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
    const input = await screen.findByLabelText("Search vault");
    await triggerDebouncedSearch(() =>
      fireEvent.change(input, { target: { value: "body" } }),
    );

    // The shared toast carries the backend message …
    expect(await screen.findByText("disk exploded")).toBeInTheDocument();
    // … and the panel shows an inline failed state (not "no results").
    expect(
      screen.getByText("Search failed. See the error notice for details."),
    ).toBeInTheDocument();
  });
});
