import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../lib/types";

// Read mode mounts the Reader's backlinks panel, which fetches; keep the
// fetch pending so these pane-level tests stay deterministic (panel behaviour
// is covered in BacklinksPanel.test.tsx).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    onMenu: vi.fn(() => Promise.resolve(vi.fn())),
    readBacklinks: vi.fn(),
    readRichNote: vi.fn(),
  };
});

vi.mock("./RichNoteEditor", () => ({
  RichNoteEditor: ({ body, sourceRelPath, onBodyChange, onOpenLink }: {
    body: string;
    sourceRelPath: string;
    onBodyChange: (value: string) => void;
    onOpenLink?: (relPath: string) => void;
  }) => {
    const leadingH1 = /^#\s+([^\n]+)/.exec(body)?.[1];
    return (
      <>
        <output data-testid="rich-source-rel-path">{sourceRelPath}</output>
        {leadingH1 && <h1>{leadingH1}</h1>}
        <textarea
          aria-label="Note content"
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
        />
        <button type="button" onClick={() => onOpenLink?.("Areas/Deep Work.md")}>
          Open rich link
        </button>
      </>
    );
  },
}));

import * as api from "../lib/api";
import { NotePane } from "./NotePane";
import type { OpenNote } from "./useOpenNote";

beforeEach(() => {
  vi.mocked(api.readBacklinks).mockReset();
  vi.mocked(api.readBacklinks).mockReturnValue(new Promise(() => {}));
  vi.mocked(api.readRichNote).mockReset();
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
  const richDocument = {
    revision: "h",
    frontmatterPrefix: "# My Note\n\n",
    body: "body",
    disposition: { kind: "rich" as const },
    blocks: [{ id: "a", leadingSeparator: "", markdown: "body", trailingSeparator: "" }],
  };
  return {
    path: "/v/n.md",
    note: note(),
    loading: false,
    error: null,
    mode: "read",
    richDocument,
    richBody: "body",
    richError: null,
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
    setRichDocument: vi.fn(),
    setRichError: vi.fn(),
    setRichBody: vi.fn(),
    undoRich: vi.fn(),
    redoRich: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("NotePane — non-loaded states", () => {
  it("shows the empty prompt when nothing is open", () => {
    render(<NotePane open={openNote({ path: null, note: null })} />);
    expect(screen.getByText(/Select a note from the sidebar/i)).toBeInTheDocument();
  });

  it("shows a spinner while loading", () => {
    render(<NotePane open={openNote({ loading: true })} />);
    expect(screen.getByLabelText("Loading note")).toBeInTheDocument();
  });

  it("shows the read error with a retry that reloads", async () => {
    const open = openNote({ error: "boom", note: null });
    render(<NotePane open={open} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(open.reload).toHaveBeenCalled();
  });

  it("shows a generic message when there is no note and no explicit error", () => {
    render(<NotePane open={openNote({ error: null, note: null })} />);
    expect(screen.getByText(/couldn't be opened/i)).toBeInTheDocument();
  });
});

describe("NotePane — loaded read mode", () => {
  it("renders one in-place editor, breadcrumb and a disabled save when clean", async () => {
    render(<NotePane open={openNote()} />);
    expect(screen.getByText("folder/n.md")).not.toHaveClass("nn-mono");
    expect(await screen.findByLabelText("Note content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Read" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("threads rich-note navigation through the pane callback", async () => {
    const onOpenLink = vi.fn();
    render(<NotePane open={openNote()} onOpenLink={onOpenLink} />);

    await userEvent.click(await screen.findByRole("button", { name: "Open rich link" }));

    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Deep Work.md");
    expect(screen.getByTestId("rich-source-rel-path")).toHaveTextContent("folder/n.md");
  });

  // The tab (title, dirty dot, close) lives in the window titlebar now —
  // its tests live in TitleBar.test.tsx.

  it("hides the edit/save controls and never edits a binary attachment", () => {
    // A binary (non-UTF-8) note has no editable text body; even if mode is "edit"
    // it must stay in the reader with no edit toggle, no save, and no editor.
    render(
      <NotePane
        open={openNote({ mode: "edit", note: note({ binary: true, body: "", raw: "" }) })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note source")).not.toBeInTheDocument();
  });

  it("shows the non-UTF-8 encoding notice above the raw fallback", () => {
    render(
      <NotePane open={openNote({ note: note({ lossyText: true }), richDocument: null, richError: "Not valid UTF-8" })} />,
    );
    expect(screen.getByText(/isn't valid UTF-8/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Note source")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("NotePane — in-place editing", () => {
  it("shows a derived leading H1 once while keeping its exact source editable", async () => {
    const body = "# My Note\n\nbody";
    const richDocument = {
      ...openNote().richDocument!,
      frontmatterPrefix: "",
      body,
      blocks: [{ id: "a", leadingSeparator: "", markdown: body, trailingSeparator: "" }],
    };
    render(
      <NotePane
        open={openNote({
          note: note({ body, raw: body }),
          richDocument,
          richBody: body,
          draft: body,
        })}
      />,
    );

    expect(await screen.findAllByRole("heading", { name: "My Note", level: 1 })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveValue(body);
  });

  it("suppresses the outer title when an unsaved rich edit adds a matching leading H1", async () => {
    const richDocument = {
      ...openNote().richDocument!,
      frontmatterPrefix: "",
    };
    const initial = openNote({ richDocument, draft: "body" });
    const { rerender } = render(<NotePane open={initial} />);
    expect(await screen.findAllByRole("heading", { name: "My Note", level: 1 })).toHaveLength(1);

    const richBody = "# My Note\n\nbody";
    rerender(
      <NotePane
        open={openNote({
          note: initial.note,
          richDocument,
          richBody,
          draft: richBody,
          dirty: true,
        })}
      />,
    );

    expect(screen.getAllByRole("heading", { name: "My Note", level: 1 })).toHaveLength(1);
  });

  it("restores the outer title when an unsaved rich edit removes the matching leading H1", async () => {
    const savedBody = "# My Note\n\nbody";
    const savedNote = note({ body: savedBody, raw: savedBody });
    const richDocument = {
      ...openNote().richDocument!,
      frontmatterPrefix: "",
      body: savedBody,
      blocks: [{ id: "a", leadingSeparator: "", markdown: savedBody, trailingSeparator: "" }],
    };
    const { rerender } = render(
      <NotePane
        open={openNote({
          note: savedNote,
          richDocument,
          richBody: savedBody,
          draft: savedBody,
        })}
      />,
    );
    expect(await screen.findAllByRole("heading", { name: "My Note", level: 1 })).toHaveLength(1);

    rerender(
      <NotePane
        open={openNote({
          note: savedNote,
          richDocument,
          richBody: "body",
          draft: "body",
          dirty: true,
        })}
      />,
    );

    expect(screen.getAllByRole("heading", { name: "My Note", level: 1 })).toHaveLength(1);
  });

  it("keeps one assertive live region mounted for save failures", () => {
    const { rerender, container } = render(
      <NotePane open={openNote({ saveError: "disk full" })} />,
    );
    const region = container.querySelector('[aria-live="assertive"]');
    expect(region).toHaveTextContent("Couldn't save: disk full");

    rerender(<NotePane open={openNote({ saveError: null })} />);
    expect(container.querySelector('[aria-live="assertive"]')).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });

  it("keeps one polite live region mounted through saving and saved states", async () => {
    const { rerender, container } = render(
      <NotePane open={openNote({ dirty: true })} />,
    );
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeEmptyDOMElement();

    rerender(<NotePane open={openNote({ dirty: true, saving: true })} />);
    await waitFor(() => expect(region).toHaveTextContent("Saving…"));
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);

    rerender(<NotePane open={openNote({ dirty: false, saving: false })} />);
    await waitFor(() => expect(region).toHaveTextContent("Saved."));
    expect(container.querySelector('[aria-live="polite"]')).toBe(region);

    rerender(<NotePane open={openNote({ dirty: true, saving: false })} />);
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  it("clears the polite save status when an assertive save failure arrives", async () => {
    const { rerender, container } = render(
      <NotePane open={openNote({ dirty: true, saving: true })} />,
    );
    const politeRegion = container.querySelector('[aria-live="polite"]');
    await waitFor(() => expect(politeRegion).toHaveTextContent("Saving…"));

    rerender(
      <NotePane
        open={openNote({ dirty: true, saving: false, saveError: "disk full" })}
      />,
    );

    await waitFor(() => expect(politeRegion).toBeEmptyDOMElement());
    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent(
      "Couldn't save: disk full",
    );
  });

  it("never announces a conflicted save as saved", async () => {
    const { rerender, container } = render(
      <NotePane open={openNote({ dirty: true, saving: true })} />,
    );
    const politeRegion = container.querySelector('[aria-live="polite"]');
    await waitFor(() => expect(politeRegion).toHaveTextContent("Saving…"));

    rerender(
      <NotePane
        open={openNote({
          dirty: true,
          saving: false,
          saveError: null,
          conflict: true,
        })}
      />,
    );

    await waitFor(() => expect(politeRegion).toBeEmptyDOMElement());
    expect(politeRegion).not.toHaveTextContent("Saved.");
  });

  it("loads rich compatibility once and attaches the matching source document", async () => {
    const open = openNote({ richDocument: null });
    const loaded = { ...openNote().richDocument! };
    vi.mocked(api.readRichNote).mockResolvedValue(loaded);
    render(<NotePane open={open} />);

    await waitFor(() => expect(open.setRichDocument).toHaveBeenCalledWith(loaded));
    expect(api.readRichNote).toHaveBeenCalledWith("/v/n.md");
  });

  it("enables save when dirty and triggers it", async () => {
    const open = openNote({ dirty: true });
    render(<NotePane open={open} />);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(open.save).toHaveBeenCalled();
  });

  it("shows the saving state", () => {
    render(<NotePane open={openNote({ dirty: true, saving: true })} />);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
  });

  it("shows a concise reason and raw editor for an incompatible note", () => {
    render(
      <NotePane
        open={openNote({
          richDocument: {
            ...openNote().richDocument!,
            disposition: {
              kind: "raw",
              reason: { code: "unsupported_syntax", message: "Tables use raw Markdown editing in 0.2.0" },
            },
            blocks: [],
          },
        })}
      />,
    );
    expect(screen.getByText(/Tables use raw Markdown/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Note source")).toBeInTheDocument();
  });

  it("wires the editor's conflict actions to overwrite and reload", async () => {
    const open = openNote({ dirty: true, conflict: true, richDocument: null, richError: "Raw fallback" });
    render(<NotePane open={open} />);
    await userEvent.click(screen.getByRole("button", { name: /Overwrite/i }));
    expect(open.overwrite).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Reload/i }));
    expect(open.reload).toHaveBeenCalled();
  });
});
