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
// These tests throw from inside `tableRanges` instead, by making the table
// model explode.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forceParsing } from "@codemirror/language";
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
const { refreshSourceEditorDecorations } = await import("./sourceEditorDecorations");
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
 * Put the failing path within reach, which takes two guarantees rather than one.
 *
 * **The table has to be in the published tree.** `tableRanges` finds a table by
 * walking `syntaxTree(state)`, and `LanguageState.init` publishes only what it
 * parsed inside `Work.Apply` — 20ms of WALL CLOCK
 * (`@codemirror/language/dist/index.js:527-546`). A loaded machine loses that
 * race even on a note this short, and CodeMirror then finishes the parse on an
 * IDLE callback, long after a synchronous assertion has run. That is not a
 * production defect — `reparsed` (`sourceEditorDecorations.ts:73`) recomputes
 * every decoration when the finished tree lands — but it does mean a test must
 * force the parse instead of assuming it. `forceParsing` both completes the
 * parse and dispatches the transaction that publishes it (`ibid.:225-230`).
 *
 * **The caret has to be INSIDE the table.** `tableRanges` only runs for a table
 * the caret is in; mounting with the default caret at offset 0 leaves the table
 * an inactive widget and never enters the failing path.
 *
 * Miss either one and every assertion here is a false green.
 */
function caretIntoTable(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  if (!forceParsing(view, view.state.doc.length, 30_000)) {
    throw new Error("the note did not parse in full; the table path would never be entered");
  }
  view.dispatch({ selection: { anchor: NOTE.indexOf("DJ gig") } });
  return view;
}

/** Long enough for React to settle after `tableErrorPlugin` reports. */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("a failure in the table decoration path", () => {
  beforeEach(() => {
    vi.mocked(tableModelAt).mockReset();
  });

  it("still mounts the editor and keeps the source editable", async () => {
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        noteIndexStatus="ready"
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
    expect(container.querySelectorAll(".nn-lp-cell-chrome")).toHaveLength(0);
    expect(vi.mocked(tableModelAt)).toHaveBeenCalled();
  });

  it("reports the failure instead of swallowing it", async () => {
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        noteIndexStatus="ready"
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

  it("keeps the table failure reported when an unrelated preview succeeds", async () => {
    // The two preview passes have different triggers. The table field recomputes
    // on a document, selection, viewport, remeasure or reparse; the inline
    // plugin also on focus and on the refresh effect a vault-index rebuild
    // dispatches (`SourceNoteEditor.tsx:303-304`). Sharing one callback lets the
    // inline pass's success clear a banner raised by the table pass — and every
    // table on screen is still raw pipes when it does.
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        noteIndexStatus="ready"
        sessionKey="table-throw-channel"
        loadedHash="table-throw-channel"
        value={NOTE}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onPreviewError={onPreviewError}
      />,
    );

    await screen.findByRole("textbox", { name: "Note content" });
    const view = caretIntoTable(container);
    await waitFor(() => {
      expect(onPreviewError).toHaveBeenCalledWith(expect.stringContaining("Table preview"));
    });

    view.dispatch({ effects: refreshSourceEditorDecorations.of(null) });
    await flushMicrotasks();

    // Assert over the history FROM the first table failure, not over calls made
    // after a `mockClear()`. With the channels collapsed the spurious `null` is
    // emitted before that clear would run, so clearing first left this checking
    // an empty list — it passed against zero calls, for the wrong reason, while
    // the defect it names was present.
    //
    // A `null` before the table has failed is legitimate: the inline pass really
    // has nothing to report yet. A `null` after it is the bug — the table is
    // still raw pipes and the banner has just been taken down.
    const messages = onPreviewError.mock.calls.map(([message]) => message);
    const firstTableFailure = messages.findIndex(
      (message) => typeof message === "string" && message.includes("Table preview"),
    );

    expect(firstTableFailure).toBeGreaterThanOrEqual(0);
    expect(messages.slice(firstTableFailure)).not.toContain(null);
  });

  it("clears the banner once the table path stops failing", async () => {
    // The other half of the same contract. A reporter that never clears would
    // pass the test above while leaving a stale banner on screen for the rest of
    // the session.
    explode();
    const onPreviewError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        noteIndexStatus="ready"
        sessionKey="table-throw-recovery"
        loadedHash="table-throw-recovery"
        value={NOTE}
        onChange={vi.fn()}
        onPreservationError={vi.fn()}
        onPreviewError={onPreviewError}
      />,
    );

    await screen.findByRole("textbox", { name: "Note content" });
    const view = caretIntoTable(container);
    await waitFor(() => {
      expect(onPreviewError).toHaveBeenCalledWith(expect.stringContaining("Table preview"));
    });

    // `mockReset` restores the implementation `vi.fn(actual.tableModelAt)` was
    // built with, so the real model is back; the selection move is what asks the
    // field for a fresh answer.
    vi.mocked(tableModelAt).mockReset();
    view.dispatch({ selection: { anchor: NOTE.indexOf("Commitment") } });

    await waitFor(() => { expect(onPreviewError).toHaveBeenLastCalledWith(null); });
  });

  it("does not report a preservation failure on a byte-clean note", async () => {
    explode();
    const onPreservationError = vi.fn();

    const { container } = render(
      <SourceNoteEditor
        noteIndexStatus="ready"
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
        noteIndexStatus="ready"
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
