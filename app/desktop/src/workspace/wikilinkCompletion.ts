import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import type { NoteIndexEntry } from "./linkResolve";
import {
  filterWikilinkSuggestions,
  findWikilinkTrigger,
  type WikilinkSuggestion,
  insertWikilink,
} from "./wikilinkAutocomplete";

const MAX_TRIGGER_SCAN = 2_048;

export function wikilinkCompletionEdit(
  value: string,
  triggerStart: number,
  caret: number,
  target: string,
): { value: string; caret: number } {
  const inserted = insertWikilink(value, triggerStart, caret, target);
  return { value: inserted.value, caret: inserted.caret - 2 };
}

function applyWikilink(target: string): Completion["apply"] {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const triggerStart = from - 2;
    const closeTo = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
    const link = `[[${target}]]`;
    view.dispatch({
      changes: { from: triggerStart, to: closeTo, insert: link },
      selection: { anchor: triggerStart + link.length - 2 },
    });
  };
}

function targetForSuggestion(
  suggestion: WikilinkSuggestion,
  suggestions: readonly WikilinkSuggestion[],
): string {
  const duplicate = suggestions.some(
    (candidate) => candidate !== suggestion && candidate.name.toLowerCase() === suggestion.name.toLowerCase(),
  );
  return duplicate
    ? suggestion.relPath.replace(/\.(?:md|markdown|mdx)$/i, "")
    : suggestion.name;
}

export function createWikilinkCompletionSource(index: readonly NoteIndexEntry[]): CompletionSource {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const scanFrom = Math.max(line.from, context.pos - MAX_TRIGGER_SCAN);
    const value = context.state.sliceDoc(scanFrom, context.pos);
    const trigger = findWikilinkTrigger(value, value.length);
    if (!trigger || /[#|]/.test(trigger.prefix)) return null;

    const suggestions = filterWikilinkSuggestions([...index], trigger.prefix);
    return {
      from: scanFrom + trigger.start + 2,
      to: context.pos,
      filter: false,
      options: suggestions.map((suggestion) => ({
        label: suggestion.name,
        detail: suggestions.some(
          (candidate) => candidate !== suggestion && candidate.name.toLowerCase() === suggestion.name.toLowerCase(),
        )
          ? suggestion.relPath
          : undefined,
        apply: applyWikilink(targetForSuggestion(suggestion, suggestions)),
        type: "text",
      })),
    };
  };
}
