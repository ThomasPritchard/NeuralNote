import {
  autocompletion,
  CompletionContext,
  completionStatus,
  startCompletion,
  type Completion,
} from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import type { NoteIndexEntry } from "./linkResolve";
import {
  createWikilinkCompletionSource,
  wikilinkCompletionEdit,
} from "./wikilinkCompletion";

const INDEX: NoteIndexEntry[] = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Alfa/Topic.md", stem: "topic" },
  { relPath: "Beta/Topic.md", stem: "topic" },
];

function complete(doc: string) {
  const state = EditorState.create({ doc, selection: { anchor: doc.length } });
  return createWikilinkCompletionSource(INDEX, "ready")(
    new CompletionContext(state, doc.length, false),
  );
}

/** Complete against an index that never finished reading — the shape the failed
 *  initial `read_tree` leaves behind (issue #209). */
function completeWithoutIndex(doc: string, status: "loading" | "failed") {
  const state = EditorState.create({ doc, selection: { anchor: doc.length } });
  return createWikilinkCompletionSource([], status)(
    new CompletionContext(state, doc.length, false),
  );
}

function optionsOf(result: ReturnType<typeof complete>) {
  return result && !(result instanceof Promise) ? result.options : [];
}

/** The single notice the source offers for `status`, or a failure if it offered
 *  none — so a test that means to pick a notice can never pass having picked
 *  nothing. */
function noticeFor(status: "loading" | "failed"): Completion {
  const [notice] = optionsOf(completeWithoutIndex("[[", status));
  if (!notice) throw new Error(`no notice was offered for a ${status} index`);
  return notice;
}

/** A view stand-in real enough for the close command: `closeCompletion` reads the
 *  completion state field and dispatches an effect into it. The state carries the
 *  real `autocompletion()` extension and applies whatever is dispatched, so
 *  whether the popup is open is read from CodeMirror rather than inferred from the
 *  shape of a spy call. */
function noticeHarness(doc: string) {
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [
      // The override is what gives `completionState` a source to mark active;
      // the notice under test is taken from its own source, via `noticeFor`.
      autocompletion({
        override: [createWikilinkCompletionSource([], "failed")],
      }),
    ],
  });
  const dispatch = vi.fn((spec: TransactionSpec) => {
    state = state.update(spec).state;
  });
  const view = {
    get state() {
      return state;
    },
    dispatch,
  } as unknown as EditorView;
  return { view, dispatch };
}

/** Pick `option` the way the popup does: through its own `apply`, over the range
 *  the completion source reported. */
function pick(option: Completion, view: EditorView, from: number, to: number) {
  const { apply } = option;
  if (typeof apply !== "function") {
    throw new Error(`a notice must apply a function, got ${typeof apply}`);
  }
  apply(view, option, from, to);
}

describe("wikilinkCompletion", () => {
  it("opens after [[ and inserts an exact closed wikilink", () => {
    const result = complete("see [[Da");
    expect(result && !(result instanceof Promise) ? result.from : null).toBe(6);
    expect(result && !(result instanceof Promise) ? result.options : []).toEqual([
      expect.objectContaining({ label: "Daily", apply: expect.any(Function) }),
    ]);
  });

  it("disambiguates duplicate names by path and inserts the selected path", () => {
    const result = complete("[[Top");
    const options = result && !(result instanceof Promise) ? result.options : [];
    expect(options).toEqual([
      expect.objectContaining({ label: "Topic", detail: "Alfa/Topic.md", apply: expect.any(Function) }),
      expect.objectContaining({ label: "Topic", detail: "Beta/Topic.md", apply: expect.any(Function) }),
    ]);
  });

  it("leaves aliases, heading fragments, block fragments, and display text editable", () => {
    expect(complete("[[Daily#Heading")).toBeNull();
    expect(complete("[[Daily#^block-id")).toBeNull();
    expect(complete("[[Daily|display text")).toBeNull();
  });

  it("consumes an existing close and leaves the caret ready for a fragment or display text", () => {
    expect(wikilinkCompletionEdit("see [[Da]] after", 4, 8, "Daily")).toEqual({
      value: "see [[Daily]] after",
      caret: 11,
    });
  });

  it("does not activate outside an unclosed wikilink", () => {
    expect(complete("plain text")).toBeNull();
    expect(complete("[[Daily]]")).toBeNull();
  });

  it("finds the current-line trigger without copying the complete document", () => {
    const doc = `${"outside\n".repeat(50_000)}[[Da`;
    const editor = EditorState.create({ doc, selection: { anchor: doc.length } });
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    const result = createWikilinkCompletionSource(INDEX, "ready")(
      new CompletionContext(editor, doc.length, false),
    );
    expect(result && !(result instanceof Promise) ? result.options[0]?.label : null).toBe("Daily");
  });

  it("says the index is unavailable rather than silently offering nothing", () => {
    // A vault with no notes and a vault whose index failed to read both filter
    // to zero suggestions. Only the second one is a failure, and offering
    // nothing there reads as broken links rather than an unread index.
    expect(optionsOf(completeWithoutIndex("[[Da", "failed"))).toEqual([
      {
        label: "Vault index unavailable",
        detail: "Refresh the vault to retry",
        apply: expect.any(Function),
      },
    ]);
    expect(optionsOf(completeWithoutIndex("[[Da", "loading"))).toEqual([
      { label: "Reading the vault…", apply: expect.any(Function) },
    ]);
  });

  it("closes the popup without editing the document when a notice is picked", () => {
    // Enter reaches a notice through `acceptCompletion`, which consumes the key
    // whatever `apply` does and dispatches nothing of its own for a function
    // `apply`. So an apply that dispatches nothing leaves the popup open,
    // swallowing that Enter and every one after it: picking a notice has to close
    // the completion itself, while still leaving the typed `[[` alone.
    const doc = "[[";
    const { view, dispatch } = noticeHarness(doc);
    startCompletion(view);
    expect(completionStatus(view.state)).toBe("pending");

    dispatch.mockClear();
    pick(noticeFor("failed"), view, doc.length, doc.length);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("stays silent for a read vault that genuinely has no match", () => {
    expect(optionsOf(complete("[[zzzz"))).toEqual([]);
  });
});
