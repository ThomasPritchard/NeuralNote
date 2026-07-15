import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state";

import { applyFormat, type FormatAction } from "./markdownFormat";

interface LocalFormat {
  from: number;
  to: number;
  insert: string;
  selectionFrom: number;
  selectionTo: number;
}

function minimalChange(before: string, after: string): { from: number; to: number; insert: string } {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { from, to: beforeEnd, insert: after.slice(from, afterEnd) };
}

export function formatSourceSelections(
  state: EditorState,
  action: FormatAction,
): TransactionSpec {
  const source = state.doc.toString();
  const edits: LocalFormat[] = state.selection.ranges.map((range) => {
    const result = applyFormat(action, { value: source, start: range.from, end: range.to });
    const change = minimalChange(source, result.value);
    return {
      ...change,
      selectionFrom: result.start - change.from,
      selectionTo: result.end - change.from,
    };
  });

  const uniqueChanges = edits.filter(
    (edit, index) =>
      edits.findIndex(
        (candidate) =>
          candidate.from === edit.from &&
          candidate.to === edit.to &&
          candidate.insert === edit.insert,
      ) === index,
  );
  const changes = state.changes(
    uniqueChanges.map(({ from, to, insert }) => ({ from, to, insert })),
  );
  const selection = EditorSelection.create(
    edits.map((edit) => {
      const base = changes.mapPos(edit.from, -1);
      return EditorSelection.range(base + edit.selectionFrom, base + edit.selectionTo);
    }),
    state.selection.mainIndex,
  );
  return { changes, selection, scrollIntoView: true };
}
