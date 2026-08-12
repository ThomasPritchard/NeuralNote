// The note pane's two quiet notices — the lazy editor's loading fallback and the
// live-preview failure — are native <output> elements. Their "status" role is
// implicit, so nothing in the markup names it and a text-only assertion would
// stay green while the announcement silently disappeared. These specs pin the
// live-region contract instead: a preview failure that never reaches assistive
// tech is exactly the silent failure this app refuses to ship.
//
// The lazy SourceNoteEditor is stubbed here so the preview-failure path can be
// driven directly; the happy-path editor behaviour stays in NotePane.test.tsx.

import { render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteDoc } from "../lib/types";
import type { OpenNote } from "./useOpenNote";

const stub = vi.hoisted(() => ({ previewFailure: null as string | null }));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, readBacklinks: vi.fn(() => new Promise(() => {})) };
});

vi.mock("./SourceNoteEditor", async () => {
  const { useEffect } = await import("react");
  return {
    SourceNoteEditor: ({
      onPreviewError,
    }: Readonly<{ onPreviewError: (message: string | null) => void }>) => {
      useEffect(() => {
        if (stub.previewFailure) onPreviewError(stub.previewFailure);
      }, [onPreviewError]);
      return null;
    },
  };
});

import { NotePane } from "./NotePane";

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
    exceedsEditableSize: false,
    sizeBytes: 0,
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
    externalDeleted: false,
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

beforeEach(() => {
  stub.previewFailure = null;
});

describe("NotePane — live region semantics", () => {
  // MUST stay the first render in this file: React.lazy caches its resolved
  // payload on the module-level lazy component, so the fallback is only
  // reachable on the very first mount. A reorder turns this red, not silent.
  it("announces the lazy editor's loading fallback as a status region", async () => {
    render(<NotePane open={openNote()} />);

    expect(screen.getByText("Loading source editor…")).toHaveRole("status");
    // Let the lazy chunk settle so the suspense resolution stays inside the test.
    await waitForElementToBeRemoved(() => screen.queryByText("Loading source editor…"));
  });

  it("announces a live-preview failure as a status region, not silence", async () => {
    stub.previewFailure = "the renderer stopped responding";
    render(<NotePane open={openNote()} />);

    const notice = await screen.findByText(/Live preview is temporarily unavailable/);
    expect(notice).toHaveRole("status");
    expect(notice).toHaveTextContent("the renderer stopped responding");
  });

  it("shows no preview notice while the live preview is healthy", async () => {
    render(<NotePane open={openNote()} />);

    await waitFor(() => expect(screen.queryByText("Loading source editor…")).toBeNull());
    expect(screen.queryByText(/Live preview is temporarily unavailable/)).toBeNull();
  });
});
