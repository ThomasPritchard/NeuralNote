// Pure logic for the composer's `@` skill picker: trigger detection at the
// caret, filtering the backend catalogue, and the removal arithmetic that
// swaps the typed trigger for a chip. No DOM, no React — ChatPane wires these
// to its (controlled) textarea and the popup UI. Modelled on the editor's
// `[[` autocomplete (`wikilinkAutocomplete.ts`), adapted to mention semantics:
// an `@` only triggers at the start of the buffer or after whitespace, so an
// address like `tom@example.com` never traps normal typing.

/** What the picker needs to know about one offerable skill. A structural
 *  subset of the backend's `SkillListing` (bindings/SkillListing.ts), so the
 *  `listSkills()` result feeds these functions directly — the catalogue's
 *  source of truth is the Rust `SkillRegistry`, never a frontend copy. */
export interface SkillPickerEntry {
  /** Stable skill id — the value `chat`'s `activeSkills` carries. */
  id: string;
  /** Human name shown in the picker and on chips. */
  name: string;
  /** One-line description shown in the picker. */
  description: string;
}

export interface SkillTrigger {
  /** Index of the `@` in the buffer. */
  start: number;
  /** Text between the `@` and the caret. */
  query: string;
}

/** The active `@` trigger at `caret`, or null. The `@` must sit at the buffer
 *  start or after whitespace (mention semantics), and the query between it and
 *  the caret must contain no whitespace or second `@` — normal prose and email
 *  addresses are never trapped. */
export function findSkillTrigger(
  value: string,
  caret: number,
): SkillTrigger | null {
  const at = value.lastIndexOf("@", caret - 1);
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  const query = value.slice(at + 1, caret);
  if (/[\s@]/.test(query)) return null;
  return { start: at, query };
}

/** Skill suggestions for a query: case-insensitive, prefix matches (on name or
 *  id) ranked before substring matches, each group in catalogue order. Skills
 *  already picked as chips are excluded — a chip is a one-per-skill state, not
 *  a repeatable insertion. */
export function filterSkillSuggestions<T extends SkillPickerEntry>(
  catalogue: readonly T[],
  query: string,
  pickedIds: readonly string[],
): T[] {
  const q = query.trim().toLowerCase();
  const picked = new Set(pickedIds);
  const starts: T[] = [];
  const contains: T[] = [];
  for (const entry of catalogue) {
    if (picked.has(entry.id)) continue;
    const name = entry.name.toLowerCase();
    const id = entry.id.toLowerCase();
    if (q === "" || name.startsWith(q) || id.startsWith(q)) {
      starts.push(entry);
    } else if (name.includes(q) || id.includes(q)) {
      contains.push(entry);
    }
  }
  return [...starts, ...contains];
}

/** Remove the trigger text (from its `@` through the caret) — picking a skill
 *  adds a chip, so the typed mention must not linger in the prompt. Returns the
 *  new buffer and the caret position where the trigger began. */
export function removeSkillTrigger(
  value: string,
  triggerStart: number,
  caret: number,
): { value: string; caret: number } {
  return {
    value: value.slice(0, triggerStart) + value.slice(caret),
    caret: triggerStart,
  };
}
