// Pure logic for the editor's `[[` autocomplete: trigger detection at the
// caret, case-insensitive filtering of the vault's note names, and the
// insertion arithmetic. No DOM, no React — the Editor wires these to its
// (uncontrolled) textarea and the popup UI.

import type { NoteIndexEntry } from "./linkResolve";

export interface WikilinkTrigger {
  /** Index of the `[[` opener in the buffer. */
  start: number;
  /** Text between the `[[` and the caret. */
  prefix: string;
}

export interface WikilinkSuggestion {
  /** Display name — the note's file stem, original casing preserved. */
  name: string;
  /** Vault-relative path, shown to disambiguate same-named notes. */
  relPath: string;
}

/** Cap the rendered list — beyond this, typing narrows faster than scrolling. */
export const MAX_SUGGESTIONS = 50;

/** The active `[[` trigger at `caret`, or null. The caret must sit after an
 *  unclosed `[[` whose prefix contains no `]`/`[` (a close in progress or a
 *  new opener) and no newline — normal typing must never be trapped. */
export function findWikilinkTrigger(
  value: string,
  caret: number,
): WikilinkTrigger | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("[[");
  if (start === -1) return null;
  const prefix = before.slice(start + 2);
  if (/[\n\r[\]]/.test(prefix)) return null;
  return { start, prefix };
}

/** File stem of a relPath with its original casing (NoteIndexEntry.stem is
 *  lowercased for resolution, so it can't be displayed). */
function displayName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

const byName = (a: WikilinkSuggestion, b: WikilinkSuggestion): number => {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.relPath < b.relPath) return -1;
  if (a.relPath > b.relPath) return 1;
  return 0;
};

/** Note-name suggestions for a prefix: case-insensitive, prefix matches
 *  ranked before substring matches, each group alphabetical. An empty prefix
 *  lists everything (alphabetical), capped at `limit`. */
export function filterWikilinkSuggestions(
  index: NoteIndexEntry[],
  prefix: string,
  limit: number = MAX_SUGGESTIONS,
): WikilinkSuggestion[] {
  const q = prefix.trim().toLowerCase();
  const starts: WikilinkSuggestion[] = [];
  const contains: WikilinkSuggestion[] = [];
  for (const entry of index) {
    const name = displayName(entry.relPath);
    const lower = name.toLowerCase();
    if (q === "" || lower.startsWith(q)) {
      starts.push({ name, relPath: entry.relPath });
    } else if (lower.includes(q)) {
      contains.push({ name, relPath: entry.relPath });
    }
  }
  starts.sort(byName);
  contains.sort(byName);
  return [...starts, ...contains].slice(0, limit);
}

/** Replace the trigger (from its `[[` through the caret) with a completed
 *  `[[name]]`, consuming a `]]` the user already typed right after the caret
 *  so auto-closing never doubles it. Returns the new buffer and the caret
 *  position just past the inserted link. */
export function insertWikilink(
  value: string,
  triggerStart: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const end = value.startsWith("]]", caret) ? caret + 2 : caret;
  const link = `[[${name}]]`;
  return {
    value: value.slice(0, triggerStart) + link + value.slice(end),
    caret: triggerStart + link.length,
  };
}
