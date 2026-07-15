import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteDoc } from "../lib/types";
import { NotePane } from "./NotePane";
import { clearSourceEditorSessions } from "./sourceEditorSession";
import type { OpenNote } from "./useOpenNote";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, readBacklinks: vi.fn(() => new Promise(() => {})) };
});

beforeEach(clearSourceEditorSessions);

function note(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/v/n.md",
    relPath: "folder/n.md",
    title: "My Note",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "# My Note\n\nbody",
    raw: "# My Note\n\nbody",
    contentHash: "hash-1",
    binary: false,
    lossyText: false,
    ...overrides,
  };
}

function openNote(overrides: Partial<OpenNote> = {}): OpenNote {
  return {
    sessionKey: "note-tab-1",
    sessionHash: "hash-1",
    path: "/v/n.md",
    note: note(),
    loading: false,
    error: null,
    draft: "# My Note\n\nbody",
    dirty: false,
    saving: false,
    saveError: null,
    preservationError: null,
    conflict: false,
    open: vi.fn(),
    reload: vi.fn(),
    overwrite: vi.fn(),
    repath: vi.fn(),
    setDraft: vi.fn(),
    setPreservationError: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("NotePane", () => {
  it("shows empty, loading, and read-error states", async () => {
    const { rerender } = render(<NotePane open={openNote({ sessionKey: null, path: null, note: null })} />);
    expect(screen.getByText(/Select a note/i)).toBeInTheDocument();

    rerender(<NotePane open={openNote({ loading: true })} />);
    expect(screen.getByLabelText("Loading note")).toBeInTheDocument();

    const failed = openNote({ note: null, error: "boom" });
    rerender(<NotePane open={failed} />);
    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(failed.reload).toHaveBeenCalled();
  });

  it("mounts one lazy source editor immediately with no pill, compatibility request, or mode warning", async () => {
    render(<NotePane open={openNote()} />);

    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent(
      "# My Note",
    );
    expect(screen.queryByText("Markdown")).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking Markdown compatibility/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Continue in raw Markdown/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it.each([
    "<script>alert(1)</script>",
    "export const x = 1\n<Component />",
    "```dataview\nTABLE file.name\n```",
    "| a | b |\n| - | - |",
    "> [!NOTE] callout",
    "[[unclosed",
  ])("keeps unsupported or malformed source editable and inert: %s", async (source) => {
    render(<NotePane open={openNote({ note: note({ raw: source, body: source }), draft: source })} />);
    expect(await screen.findByRole("textbox", { name: "Note content" })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[src]")).toBeNull();
  });

  it("lets a matching leading source H1 own the visible title without removing its source", async () => {
    render(<NotePane open={openNote()} />);
    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent("# My Note");
    expect(screen.queryByRole("heading", { level: 1, name: "My Note" })).not.toBeInTheDocument();
  });

  it("lets a different leading source H1 replace the non-editable derived title", async () => {
    const source = "# Body heading\n\nbody";
    render(<NotePane open={openNote({ note: note({ raw: source, body: source }), draft: source })} />);
    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent(
      "# Body heading",
    );
    expect(screen.queryByRole("heading", { level: 1, name: "My Note" })).not.toBeInTheDocument();
  });

  it("offers a source-backed editable title when the note has no leading H1", async () => {
    const source = "The hierarchy follows a basic model.";
    const open = openNote({ note: note({ raw: source, body: source, title: "Azure Hierarchy" }), draft: source });
    render(<NotePane open={open} />);

    expect(screen.getByRole("heading", { level: 1, name: "Azure Hierarchy" })).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit title: Azure Hierarchy" }),
    );
    expect(open.setDraft).toHaveBeenCalledWith(
      "# Azure Hierarchy\n\nThe hierarchy follows a basic model.",
    );
  });

  it("retains the external title when closed frontmatter is parser-invalid", async () => {
    const source = "---\ntitle: [\n---\nbody";
    render(<NotePane open={openNote({
      note: note({ raw: source, body: "body", frontmatterError: "bad YAML" }),
      draft: source,
    })} />);

    expect(screen.getByRole("heading", { level: 1, name: "My Note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit title: My Note" })).toBeNull();
    expect(await screen.findByRole("textbox", { name: "Note content" })).toBeInTheDocument();
  });

  it("keeps binary notes non-editable", () => {
    render(<NotePane open={openNote({ note: note({ binary: true, raw: "", body: "" }) })} />);
    expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("keeps lossy-text, frontmatter, conflict, overwrite, reload, and save errors visible", async () => {
    const open = openNote({
      note: note({
        lossyText: true,
        frontmatterError: "bad YAML",
        frontmatterRaw: "title: [",
      }),
      dirty: true,
      conflict: true,
      saveError: "disk full",
    });
    render(<NotePane open={open} />);

    expect(screen.getByText(/isn't valid UTF-8/i)).toBeInTheDocument();
    expect(screen.getByText(/bad YAML/i)).toBeInTheDocument();
    expect(screen.getAllByText(/disk full/i)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /Overwrite/i }));
    await userEvent.click(screen.getByRole("button", { name: /Reload/i }));
    expect(open.overwrite).toHaveBeenCalled();
    expect(open.reload).toHaveBeenCalled();
  });

  it("disables saving while exact-source preservation is blocked", () => {
    render(<NotePane open={openNote({ dirty: true, preservationError: "Line endings are ambiguous" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Line endings are ambiguous");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables explicit save only for a dirty, safe source draft", async () => {
    const open = openNote({ dirty: true });
    render(<NotePane open={open} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(open.save).toHaveBeenCalled();
  });
});
