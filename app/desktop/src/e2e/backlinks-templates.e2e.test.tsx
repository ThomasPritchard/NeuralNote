// Journeys 14-19: backlinks, wikilinks, autocomplete, and templates.
//   14–15. Wikilinks use the source-preserving raw fallback in 0.2.0.
//   16. The backlinks panel shows linked + unlinked mentions, and a linked row
//       opens its source note.
//   17. The editor's [[ autocomplete lists matching notes and inserts a link.
//   18. The dedicated template action creates a note with the rendered body.
//   19. Ordinary New note stays blank-note-simple and never loads templates.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

const FEATURE_SEED: SeedEntry[] = [
  { kind: "file", relPath: "Target.md", content: "Target body." },
  { kind: "file", relPath: "Link Hub.md", content: "Go to [[Target]]." },
  { kind: "file", relPath: "Unresolved.md", content: "This points at [[Missing Note]]." },
  { kind: "file", relPath: "Source Wiki.md", content: "This links [[Target]] from wiki." },
  { kind: "file", relPath: "Source Md.md", content: "This links [Target](Target.md) from markdown." },
  { kind: "file", relPath: "Plain Mention.md", content: "A plain Target mention without a link." },
  { kind: "file", relPath: "Templates/Starter.md", content: "Template body for {{title}}." },
];

async function openVault(seed: SeedEntry[]): Promise<RenderAppResult> {
  const result = renderApp({ seed, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name");
  return result;
}

describe("Journey 14: resolved wikilink fallback", () => {
  it("keeps a resolved [[wikilink]] exact in the raw editor", async () => {
    const { user } = await openVault(FEATURE_SEED);

    await user.click(await screen.findByRole("button", { name: "Link Hub.md" }));
    expect(await screen.findByRole("heading", { name: "Link Hub", level: 1 })).toBeInTheDocument();

    expect(await screen.findByText(/Wikilinks are open as raw Markdown/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note source" })).toHaveValue(
      "Go to [[Target]].",
    );
    expect(screen.queryByRole("link", { name: "Target" })).not.toBeInTheDocument();
  });
});

describe("Journey 15: unresolved wikilink fallback", () => {
  it("keeps an unresolved [[wikilink]] exact and editable as Markdown", async () => {
    const { user } = await openVault(FEATURE_SEED);

    await user.click(await screen.findByRole("button", { name: "Unresolved.md" }));
    expect(await screen.findByRole("heading", { name: "Unresolved", level: 1 })).toBeInTheDocument();

    expect(await screen.findByText(/Wikilinks are open as raw Markdown/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note source" })).toHaveValue(
      "This points at [[Missing Note]].",
    );
  });
});

describe("Journey 16: backlinks panel", () => {
  it("shows linked and unlinked mentions, and opens a linked source row", async () => {
    const { user } = await openVault(FEATURE_SEED);

    await user.click(await screen.findByRole("button", { name: "Target.md" }));
    expect(await screen.findByRole("heading", { name: "Target", level: 1 })).toBeInTheDocument();

    const panel = await screen.findByRole("region", { name: "Backlinks" });
    const linked = await within(panel).findByRole("button", { name: /Linked mentions/ });
    expect(within(linked).getByText("3")).toBeInTheDocument();
    expect(within(panel).getByText("Link Hub")).toBeInTheDocument();
    expect(within(panel).getByText("Go to [[Target]].")).toBeInTheDocument();
    expect(within(panel).getByText("Source Wiki")).toBeInTheDocument();
    expect(within(panel).getByText("This links [[Target]] from wiki.")).toBeInTheDocument();
    expect(within(panel).getByText("Source Md")).toBeInTheDocument();
    expect(within(panel).getByText("This links [Target](Target.md) from markdown.")).toBeInTheDocument();

    const unlinked = within(panel).getByRole("button", { name: /Unlinked mentions/ });
    expect(within(unlinked).getByText("1")).toBeInTheDocument();
    await user.click(unlinked);
    expect(within(panel).getByText("Plain Mention")).toBeInTheDocument();
    expect(within(panel).getByText("A plain Target mention without a link.")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /Source Wiki/ }));
    expect(await screen.findByRole("heading", { name: "Source Wiki", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText("Source Wiki.md")).toHaveLength(2);
  });
});

describe("Journey 17: editor wikilink autocomplete", () => {
  it("shows suggestions for [[ plus a prefix and inserts the chosen note", async () => {
    const { user } = await openVault([
      { kind: "file", relPath: "Draft.md", content: "[[Target]]" },
      { kind: "file", relPath: "Target.md", content: "Target body." },
    ]);

    await user.click(await screen.findByRole("button", { name: "Draft.md" }));
    expect(await screen.findByRole("heading", { name: "Draft", level: 1 })).toBeInTheDocument();
    const textarea = screen.getByRole("textbox", { name: "Note source" });
    await user.clear(textarea);
    await user.type(textarea, "Refer to [[[[Ta");

    const listbox = await screen.findByRole("listbox", { name: "Link to note" });
    expect(within(listbox).getByRole("option", { name: /Target/ })).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(textarea).toHaveValue("Refer to [[Target]]");
  });
});

describe("Journey 18: create from template", () => {
  it("creates a note from the chosen template and renders {{title}} into the body", async () => {
    const { user, backend } = await openVault(FEATURE_SEED);

    await user.click(screen.getByRole("button", { name: "Insert from template" }));
    const picker = await screen.findByRole("dialog", { name: "Insert from template" });
    await user.click(
      within(picker).getByRole("button", {
        name: "Starter, Templates/Starter.md",
      }),
    );
    await user.type(within(picker).getByLabelText("Note name"), "Project Plan");
    expect(within(picker).getByLabelText("Destination folder")).toHaveValue(VAULT_ROOT);
    await user.click(within(picker).getByRole("button", { name: "Create note" }));

    expect(await screen.findByRole("heading", { name: "Project Plan", level: 1 })).toBeInTheDocument();
    const article = screen.getByRole("article");
    expect(within(article).getByText("Template body for Project Plan.")).toBeInTheDocument();
    expect(within(article).queryByText(/{{title}}/)).not.toBeInTheDocument();
    expect(backend.calls).toContain("list_templates");
    expect(backend.calls).toContain("create_note_from_template");
  });
});

describe("Journey 19: create without templates", () => {
  it("keeps the create flow unchanged and opens a blank note when no templates exist", async () => {
    const { user, backend } = await openVault([
      { kind: "file", relPath: "Existing.md", content: "Existing body." },
    ]);

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(screen.getByLabelText("New note name"), "Scratch{Enter}");

    expect(await screen.findByRole("heading", { name: "Scratch", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent("");
    expect(backend.calls).toContain("create_note");
    expect(backend.calls).not.toContain("list_templates");
    expect(backend.calls).not.toContain("create_note_from_template");
  });
});
