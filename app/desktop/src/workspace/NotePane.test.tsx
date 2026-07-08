import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../lib/types";

// Read mode mounts the Reader's backlinks panel, which fetches; keep the
// fetch pending so these pane-level tests stay deterministic (panel behaviour
// is covered in BacklinksPanel.test.tsx).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, readBacklinks: vi.fn() };
});

import * as api from "../lib/api";
import { NotePane } from "./NotePane";
import type { OpenNote } from "./useOpenNote";

beforeEach(() => {
  vi.mocked(api.readBacklinks).mockReset();
  vi.mocked(api.readBacklinks).mockReturnValue(new Promise(() => {}));
});

function note(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/v/n.md",
    relPath: "folder/n.md",
    title: "My Note",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "body",
    raw: "# My Note\n\nbody",
    contentHash: "h",
    binary: false,
    lossyText: false,
    ...overrides,
  };
}

function openNote(overrides: Partial<OpenNote> = {}): OpenNote {
  return {
    path: "/v/n.md",
    note: note(),
    loading: false,
    error: null,
    mode: "read",
    draft: "# My Note\n\nbody",
    dirty: false,
    saving: false,
    saveError: null,
    conflict: false,
    open: vi.fn(),
    reload: vi.fn(),
    overwrite: vi.fn(),
    repath: vi.fn(),
    setMode: vi.fn(),
    setDraft: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("NotePane — non-loaded states", () => {
  it("shows the empty prompt when nothing is open", () => {
    render(<NotePane open={openNote({ path: null, note: null })} onClose={vi.fn()} />);
    expect(screen.getByText(/Select a note from the sidebar/i)).toBeInTheDocument();
  });

  it("shows a spinner while loading", () => {
    render(<NotePane open={openNote({ loading: true })} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Loading note")).toBeInTheDocument();
  });

  it("shows the read error with a retry that reloads", async () => {
    const open = openNote({ error: "boom", note: null });
    render(<NotePane open={open} onClose={vi.fn()} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(open.reload).toHaveBeenCalled();
  });

  it("shows a generic message when there is no note and no explicit error", () => {
    render(<NotePane open={openNote({ error: null, note: null })} onClose={vi.fn()} />);
    expect(screen.getByText(/couldn't be opened/i)).toBeInTheDocument();
  });
});

describe("NotePane — loaded read mode", () => {
  it("renders the reader, breadcrumb and no save button", () => {
    render(<NotePane open={openNote()} onClose={vi.fn()} />);
    expect(screen.getByText("folder/n.md")).toBeInTheDocument();
    expect(screen.getAllByText("My Note").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows the dirty dot when there are unsaved edits", () => {
    render(<NotePane open={openNote({ dirty: true })} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("closes via the tab close button", async () => {
    const onClose = vi.fn();
    render(<NotePane open={openNote()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close note" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("switches to edit mode via the toggle", async () => {
    const open = openNote();
    render(<NotePane open={open} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Edit/i }));
    expect(open.setMode).toHaveBeenCalledWith("edit");
  });

  it("hides the edit/save controls and never edits a binary attachment", () => {
    // A binary (non-UTF-8) note has no editable text body; even if mode is "edit"
    // it must stay in the reader with no edit toggle, no save, and no editor.
    render(
      <NotePane
        open={openNote({ mode: "edit", note: note({ binary: true, body: "", raw: "" }) })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note source")).not.toBeInTheDocument();
  });

  it("shows the non-UTF-8 encoding notice in read mode", () => {
    render(
      <NotePane open={openNote({ note: note({ lossyText: true }) })} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/isn't valid UTF-8/i)).toBeInTheDocument();
  });

  it("still shows the encoding notice in edit mode (where saving bakes it in)", () => {
    render(
      <NotePane
        open={openNote({ mode: "edit", note: note({ lossyText: true }) })}
        onClose={vi.fn()}
      />,
    );
    // The warning must be visible exactly where the destructive save is triggered.
    expect(screen.getByText(/isn't valid UTF-8/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("NotePane — edit mode", () => {
  it("renders the editor and a disabled save when clean", () => {
    render(<NotePane open={openNote({ mode: "edit", dirty: false })} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Note source")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("enables save when dirty and triggers it", async () => {
    const open = openNote({ mode: "edit", dirty: true });
    render(<NotePane open={open} onClose={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(open.save).toHaveBeenCalled();
  });

  it("shows the saving state", () => {
    render(
      <NotePane
        open={openNote({ mode: "edit", dirty: true, saving: true })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("can switch back to read mode", async () => {
    const open = openNote({ mode: "edit" });
    render(<NotePane open={open} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Read/i }));
    expect(open.setMode).toHaveBeenCalledWith("read");
  });

  it("wires the editor's conflict actions to overwrite and reload", async () => {
    const open = openNote({ mode: "edit", dirty: true, conflict: true });
    render(<NotePane open={open} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Overwrite/i }));
    expect(open.overwrite).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Reload/i }));
    expect(open.reload).toHaveBeenCalled();
  });
});
