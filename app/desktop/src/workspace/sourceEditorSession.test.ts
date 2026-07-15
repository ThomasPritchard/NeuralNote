import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Facet } from "@codemirror/state";
import { foldEffect, foldGutter, foldedRanges } from "@codemirror/language";
import { afterEach, describe, expect, it } from "vitest";

import { loadSourceText } from "./sourceText";
import {
  acquireSourceEditorSession,
  clearSourceEditorSessions,
  destroySourceEditorSession,
  sourceEditorSessionCount,
  updateSourceEditorSession,
} from "./sourceEditorSession";

afterEach(clearSourceEditorSessions);

describe("sourceEditorSession", () => {
  it("restores document, selection, scroll position, and undo history for one loaded tab", () => {
    const session = acquireSourceEditorSession("tab-1", "hash-1", "alpha", [history()]);
    const changed = session.state.update({
      changes: { from: 5, insert: " beta" },
      selection: EditorSelection.cursor(10),
    });
    updateSourceEditorSession("tab-1", {
      ...session,
      state: changed.state,
      source: loadSourceText("alpha beta"),
      scrollTop: 73,
    });

    const restored = acquireSourceEditorSession("tab-1", "hash-1", "ignored", [history()]);
    expect(restored.state.doc.toString()).toBe("alpha beta");
    expect(restored.state.selection.main.head).toBe(10);
    expect(restored.scrollTop).toBe(73);

    let undone: EditorState | null = null;
    expect(
      undo({
        state: restored.state,
        dispatch: (transaction) => {
          undone = transaction.state;
        },
      }),
    ).toBe(true);
    expect(undone!.doc.toString()).toBe("alpha");
  });

  it("creates a fresh session when the loaded content hash changes", () => {
    acquireSourceEditorSession("tab-1", "old", "old draft", []);
    const fresh = acquireSourceEditorSession("tab-1", "new", "disk source", []);

    expect(fresh.state.doc.toString()).toBe("disk source");
    expect(sourceEditorSessionCount()).toBe(1);
  });

  it("retains fold state with the owning tab session", () => {
    const session = acquireSourceEditorSession("tab-fold", "hash", "# H\nbody", [foldGutter()]);
    const folded = session.state.update({ effects: foldEffect.of({ from: 3, to: 8 }) });
    updateSourceEditorSession("tab-fold", { ...session, state: folded.state });

    const restored = acquireSourceEditorSession("tab-fold", "hash", "ignored", [foldGutter()]);
    expect(foldedRanges(restored.state).size).toBe(1);
  });

  it("reconfigures remounted sessions without losing their document state", () => {
    const currentValue = Facet.define<string, string>({ combine: (values) => values[0] ?? "" });
    const session = acquireSourceEditorSession("tab-props", "hash", "alpha", [
      history(),
      currentValue.of("old"),
    ]);
    const changed = session.state.update({ changes: { from: 5, insert: " beta" } });
    updateSourceEditorSession("tab-props", { ...session, state: changed.state });

    const restored = acquireSourceEditorSession("tab-props", "hash", "ignored", [
      history(),
      currentValue.of("new"),
    ]);
    expect(restored.state.facet(currentValue)).toBe("new");
    expect(restored.state.doc.toString()).toBe("alpha beta");
    expect(undo({ state: restored.state, dispatch: () => {} })).toBe(true);
  });

  it("destroys one tab session or every vault session explicitly", () => {
    acquireSourceEditorSession("one", "a", "1", []);
    acquireSourceEditorSession("two", "b", "2", []);

    destroySourceEditorSession("one");
    expect(sourceEditorSessionCount()).toBe(1);

    clearSourceEditorSessions();
    expect(sourceEditorSessionCount()).toBe(0);
  });

  it("bounds retained sessions", () => {
    for (let index = 0; index < 40; index += 1) {
      acquireSourceEditorSession(`tab-${index}`, `${index}`, `${index}`, []);
    }
    expect(sourceEditorSessionCount()).toBeLessThanOrEqual(32);
  });
});
