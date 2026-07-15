import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { formatSourceSelections } from "./sourceEditorFormatting";

function apply(source: string, ranges: Array<[number, number]>, action: Parameters<typeof formatSourceSelections>[1]) {
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  return state.update(formatSourceSelections(state, action)).state;
}

describe("formatSourceSelections", () => {
  it("formats every selection in one undoable transaction", () => {
    const state = apply("one two", [[0, 3], [4, 7]], "format-bold");
    expect(state.doc.toString()).toBe("**one** **two**");
    expect(state.selection.ranges.map((range) => state.sliceDoc(range.from, range.to))).toEqual(["one", "two"]);
  });

  it("formats multiple heading lines without shifting the wrong caret", () => {
    const state = apply("one\ntwo", [[0, 0], [4, 4]], "format-h2");
    expect(state.doc.toString()).toBe("## one\n## two");
    expect(state.selection.ranges.map((range) => range.head)).toEqual([3, 10]);
  });

  it("deduplicates the same line edit for multiple carets", () => {
    const state = apply("one two", [[0, 0], [4, 4]], "format-h2");
    expect(state.doc.toString()).toBe("## one two");
    expect(state.selection.ranges.map((range) => range.head)).toEqual([3, 7]);
  });

  it("places a selected link's caret in its inert URL slot", () => {
    const state = apply("label", [[0, 5]], "format-link");
    expect(state.doc.toString()).toBe("[label]()");
    expect(state.selection.main.head).toBe(8);
  });
});
