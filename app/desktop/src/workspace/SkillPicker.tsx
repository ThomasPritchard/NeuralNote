// The composer's skill affordances: the `@` suggestion popup (the editor's
// wikilink-autocomplete combobox pattern — DOM focus stays in the textarea,
// aria-activedescendant drives the "focused" option) and the removable chip
// row that shows which skills the next send will activate. Pure presentation;
// trigger/filter logic lives in `skillAutocomplete.ts`, state in ChatPane.

import { Wand2, X } from "lucide-react";
import { cn } from "../lib/cn";
import type { SkillPickerEntry } from "./skillAutocomplete";

export const SKILL_LISTBOX_ID = "nn-skill-listbox";
export const skillOptionId = (index: number): string => `nn-skill-option-${index}`;

/** What the popup shows while the backend catalogue isn't usable yet: a quiet
 *  one-line notice in place of the option list — never a blank popup, and
 *  never a silent failure. */
export interface SkillPickerNotice {
  kind: "loading" | "error";
  message: string;
}

/** The `@` suggestion popup, anchored above the composer (the composer hugs
 *  the pane's bottom edge, so up is the only direction with room). */
export function SkillSuggestions({
  suggestions,
  notice = null,
  active,
  onPick,
  onHover,
}: Readonly<{
  suggestions: readonly SkillPickerEntry[];
  /** Rendered instead of the list while the catalogue loads or after it
   *  failed; ignored once there are options to show. */
  notice?: SkillPickerNotice | null;
  active: number;
  onPick: (skill: SkillPickerEntry) => void;
  onHover: (index: number) => void;
}>) {
  if (suggestions.length === 0 && notice === null) return null;
  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
      <p className="px-2.5 pt-1.5 text-[0.5625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        Skills
      </p>
      {suggestions.length === 0 && notice !== null && (
        // A quiet status line, announced politely — the composer keeps focus
        // and typing continues; the popup just says why it has nothing yet.
        <output
          className={cn(
            "block px-2.5 pb-2 pt-1 text-[0.6875rem] leading-snug",
            notice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground/70",
          )}
        >
          {notice.message}
        </output>
      )}
      {suggestions.length > 0 && (
      <ul // NOSONAR(S6819): correct ARIA combobox pattern — DOM focus stays in the composer textarea, which drives this popup via aria-activedescendant (the editor's wikilink popup precedent)
        role="listbox"
        id={SKILL_LISTBOX_ID}
        aria-label="Skill suggestions"
        className="max-h-56 overflow-y-auto p-1"
      >
        {suggestions.map((skill, i) => (
          // The textarea keeps DOM focus; the row's mousedown is swallowed so
          // the click can pick before any blur closes the popup.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <li
            key={skill.id}
            id={skillOptionId(i)}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(skill)}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
              i === active ? "bg-accent text-accent-foreground" : "text-foreground/90",
            )}
          >
            <Wand2
              className="mt-0.5 size-3.5 shrink-0 text-primary/80"
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.75rem] font-medium leading-snug">
                {skill.name}
              </span>
              <span className="block truncate text-[0.625rem] leading-snug text-muted-foreground">
                {skill.description}
              </span>
            </span>
          </li>
        ))}
      </ul>
      )}
      {suggestions.length > 0 && (
        <p className="border-t border-border bg-muted/40 px-2.5 py-1 text-[0.625rem] leading-relaxed text-muted-foreground/70">
          ↑↓ navigate · ↵ add skill · esc dismiss
        </p>
      )}
    </div>
  );
}

/** The active-skill chips the next send will activate. Each chip is a quiet
 *  primary pill (the same "on" register as the reasoning chip) whose only
 *  interactive part is its remove button. */
export function SkillChips({
  skills,
  onRemove,
}: Readonly<{
  skills: readonly SkillPickerEntry[];
  onRemove: (id: string) => void;
}>) {
  if (skills.length === 0) return null;
  return (
    <ul aria-label="Active skills" className="mb-2 flex flex-wrap gap-1.5">
      {skills.map((skill) => (
        <li
          key={skill.id}
          className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-0.5 text-[0.625rem] font-medium text-primary ring-1 ring-inset ring-primary/30"
        >
          <Wand2 className="size-3 shrink-0" aria-hidden />
          {skill.name}
          <button
            type="button"
            onClick={() => onRemove(skill.id)}
            aria-label={`Remove skill: ${skill.name}`}
            className="rounded-full p-0.5 transition-colors hover:bg-primary/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-3" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
