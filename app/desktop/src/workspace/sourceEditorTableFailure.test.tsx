// Spec rule 6: "A decoration failure removes the decoration and leaves the
// source editable." (specs/source-native-live-preview-editor.md)
//
// The existing proof of that rule (sourceEditorDecorations.test.ts) injects a
// throwing collector into `safeCollectMarkdownPreview` — the one seam that was
// already guarded. The table decoration path was not, and it is reached from
// `StateField.create` and `StateField.update`.
//
// That matters because CodeMirror evaluates `this.state.update(...)` as an
// ARGUMENT to `dispatchTransactions` (@codemirror/view index.js:7920-7925), so
// a throw inside a state field never reaches the editor's own try/catch in
// SourceNoteEditor. It kills the keystroke, and from `create` it prevents the
// editor mounting at all.
//
// These tests throw from inside `alignmentRanges` instead, by making the table
// model explode.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sourceEditorTableModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sourceEditorTableModel")>();
  return {
    ...actual,
    tableModelAt: vi.fn(actual.tableModelAt),
  };
});

const { tableModelAt } = await import("./sourceEditorTableModel");
const { SourceNoteEditor } = await import("./SourceNoteEditor");

const NOTE = [
  "# Commitments",
  "",
  "| Start date | Commitment |",
  "| --- | --- |",
  "| 2026-04-03 | DJ gig |",
].join("\n");

function explode() {
  vi.mocked(tableModelAt).mockImplementation(() => {
    throw new Error("synthetic table decoration failure");
  });
}

/**
 * alignmentRanges only runs for a table the caret is INSIDE. Mounting with the
 * default caret at offset 0 leaves the table rendered as an inactive widget and
 * the failing path is never entered — which would make every assertion here a
 * false green.
 */
function caretIntoTable(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.dispatch({ selection: { anchor: NOTE.indexOf("DJ gig") } });
  return view;
}

describe("a failure in the table decoration path", () => {
  beforeEach(() => {
    vi.mocked(tableModelAt).mockReset();
  });

  it("still mounts the editor and keeps the source editable", async () => {
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        sessionKey="table-throw-mount"
        loadedHash="table-throw-mount"
        value={NOTE}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onPreviewError={onPreviewError}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Note content" });
    const view = caretIntoTable(container);

    // Rule 6: the editor survives and the exact source is intact.
    expect(editor).toBeInTheDocument();
    expect(view.state.doc.toString()).toBe(NOTE);
    expect(container.querySelectorAll(".nn-lp-table-pad")).toHaveLength(0);
    expect(vi.mocked(tableModelAt)).toHaveBeenCalled();
  });

  it("reports the failure instead of swallowing it", async () => {
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        sessionKey="table-throw-report"
        loadedHash="table-throw-report"
        value={NOTE}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onPreviewError={onPreviewError}
      />,
    );

    await screen.findByRole("textbox", { name: "Note content" });
    caretIntoTable(container);

    await waitFor(() => {
      expect(onPreviewError).toHaveBeenCalledWith(
        expect.stringContaining("Your source is unchanged"),
      );
    });
  });

  it("does not report a preservation failure on a byte-clean note", async () => {
    explode();
    const onPreservationError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        sessionKey="table-throw-preservation"
        loadedHash="table-throw-preservation"
        value={NOTE}
        onChange={vi.fn()}
        onPreservationError={onPreservationError}
        onPreviewError={vi.fn()}
      />,
    );

    await screen.findByRole("textbox", { name: "Note content" });
    caretIntoTable(container);
    // A rendering bug must never be reported as "saving is blocked".
    expect(onPreservationError).not.toHaveBeenCalledWith(
      expect.stringContaining("line endings"),
    );
  });

  it("keeps accepting keystrokes after the failure", async () => {
    explode();
    const onChange = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        sessionKey="table-throw-typing"
        loadedHash="table-throw-typing"
        value={NOTE}
        onChange={onChange}
        onPreservationError={vi.fn()}
        onPreviewError={vi.fn()}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Note content" });
    caretIntoTable(container);
    await userEvent.click(editor);
    await userEvent.keyboard("Z");

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.lastCall?.[0]).toContain("Commitments");
  });
});
