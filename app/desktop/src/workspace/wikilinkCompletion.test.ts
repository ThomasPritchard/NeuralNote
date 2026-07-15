import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
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
  return createWikilinkCompletionSource(INDEX)(new CompletionContext(state, doc.length, false));
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

    const result = createWikilinkCompletionSource(INDEX)(
      new CompletionContext(editor, doc.length, false),
    );
    expect(result && !(result instanceof Promise) ? result.options[0]?.label : null).toBe("Daily");
  });
});
