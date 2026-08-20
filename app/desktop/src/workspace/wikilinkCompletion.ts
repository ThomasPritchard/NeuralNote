import {
  closeCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import type { NoteIndexEntry } from "./linkResolve";
import type { VaultTreeStatus } from "./useVaultTree";
import {
  filterWikilinkSuggestions,
  findWikilinkTrigger,
  type WikilinkSuggestion,
  insertWikilink,
} from "./wikilinkAutocomplete";

const MAX_TRIGGER_SCAN = 2_048;

/** Picking a notice closes the popup and leaves the `[[` the user typed exactly
 *  as they typed it.
 *
 *  Closing is this callback's job, not a side effect of being picked. Enter
 *  reaches a notice through `acceptCompletion`, which consumes the key and — for
 *  a function `apply` — dispatches nothing itself. A callback that did nothing
 *  would therefore leave the popup open swallowing that Enter and every one
 *  after it, until the user found Escape. */
const CLOSE_WITHOUT_INSERTING = (view: EditorView) => {
  closeCompletion(view);
};

/** What the popup says when the index cannot answer. An index that failed (or
 *  has not finished) reading is NOT a vault with no notes, and offering nothing
 *  reads as broken links rather than a failed read (issue #209). */
const INDEX_NOTICE: Record<Exclude<VaultTreeStatus, "ready">, Completion> = {
  loading: { label: "Reading the vault…", apply: CLOSE_WITHOUT_INSERTING },
  failed: {
    label: "Vault index unavailable",
    detail: "Refresh the vault to retry",
    apply: CLOSE_WITHOUT_INSERTING,
  },
};

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

export function createWikilinkCompletionSource(
  index: readonly NoteIndexEntry[],
  indexStatus: VaultTreeStatus,
): CompletionSource {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const scanFrom = Math.max(line.from, context.pos - MAX_TRIGGER_SCAN);
    const value = context.state.sliceDoc(scanFrom, context.pos);
    const trigger = findWikilinkTrigger(value, value.length);
    if (!trigger || /[#|]/.test(trigger.prefix)) return null;

    const suggestions = filterWikilinkSuggestions([...index], trigger.prefix);
    if (suggestions.length === 0 && indexStatus !== "ready") {
      return {
        from: scanFrom + trigger.start + 2,
        to: context.pos,
        filter: false,
        options: [INDEX_NOTICE[indexStatus]],
      };
    }
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
