// The `@` skill picker's pure logic: trigger detection (mention semantics —
// normal prose and email addresses must never be trapped), catalogue
// filtering, and the removal arithmetic that swaps the trigger for a chip.

import { describe, expect, it } from "vitest";
import {
  filterSkillSuggestions,
  findSkillTrigger,
  removeSkillTrigger,
  type SkillPickerEntry,
} from "./skillAutocomplete";

const CATALOGUE: SkillPickerEntry[] = [
  { id: "fixture-note-workflow", name: "Fixture note workflow", description: "Demo skill." },
  { id: "youtube-distil", name: "YouTube distil", description: "Distil a video." },
];

describe("findSkillTrigger", () => {
  it("triggers on @ at the start of the buffer", () => {
    expect(findSkillTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(findSkillTrigger("@fix", 4)).toEqual({ start: 0, query: "fix" });
  });

  it("triggers on @ after whitespace, capturing the query up to the caret", () => {
    expect(findSkillTrigger("distil @you", 11)).toEqual({ start: 7, query: "you" });
    expect(findSkillTrigger("line one\n@f", 11)).toEqual({ start: 9, query: "f" });
  });

  it("uses the caret, not the end of the buffer", () => {
    // Caret sits inside the query: only the typed-so-far part is the query.
    expect(findSkillTrigger("@fixture", 4)).toEqual({ start: 0, query: "fix" });
  });

  it("never traps an email address (@ preceded by a non-space)", () => {
    expect(findSkillTrigger("mail tom@example", 16)).toBeNull();
  });

  it("dissolves once the query contains whitespace — normal prose resumes", () => {
    expect(findSkillTrigger("@fix the bug", 12)).toBeNull();
    expect(findSkillTrigger("@fix\nnext", 9)).toBeNull();
  });

  it("rejects a second @ inside the query and re-triggers on the later one", () => {
    // The later `@` is preceded by a non-space, so neither triggers.
    expect(findSkillTrigger("@a@b", 4)).toBeNull();
    // A later, properly separated `@` wins.
    expect(findSkillTrigger("@one two @th", 12)).toEqual({ start: 9, query: "th" });
  });

  it("returns null with no @ before the caret", () => {
    expect(findSkillTrigger("plain question", 5)).toBeNull();
    expect(findSkillTrigger("", 0)).toBeNull();
  });
});

describe("filterSkillSuggestions", () => {
  it("lists the whole catalogue for an empty query", () => {
    expect(filterSkillSuggestions(CATALOGUE, "", []).map((s) => s.id)).toEqual([
      "fixture-note-workflow",
      "youtube-distil",
    ]);
  });

  it("matches case-insensitively on name or id, prefix before substring", () => {
    // "you" prefixes "YouTube distil" (name) and "youtube-distil" (id).
    expect(filterSkillSuggestions(CATALOGUE, "You", []).map((s) => s.id)).toEqual([
      "youtube-distil",
    ]);
    // "note" is a substring of both the fixture's name and id — substring hits
    // still surface (ranked after any prefix hits).
    expect(filterSkillSuggestions(CATALOGUE, "note", []).map((s) => s.id)).toEqual([
      "fixture-note-workflow",
    ]);
  });

  it("excludes skills already picked as chips", () => {
    expect(
      filterSkillSuggestions(CATALOGUE, "", ["fixture-note-workflow"]).map((s) => s.id),
    ).toEqual(["youtube-distil"]);
  });

  it("returns nothing when the query matches no skill", () => {
    expect(filterSkillSuggestions(CATALOGUE, "zzz", [])).toEqual([]);
  });
});

describe("removeSkillTrigger", () => {
  it("removes the trigger from its @ through the caret", () => {
    expect(removeSkillTrigger("distil @you please", 7, 11)).toEqual({
      value: "distil  please",
      caret: 7,
    });
  });

  it("removes a trigger at the start of the buffer", () => {
    expect(removeSkillTrigger("@fix", 0, 4)).toEqual({ value: "", caret: 0 });
  });
});
