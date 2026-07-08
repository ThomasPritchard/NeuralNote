import { describe, expect, it } from "vitest";
import type { NoteIndexEntry } from "./linkResolve";
import {
  filterWikilinkSuggestions,
  findWikilinkTrigger,
  insertWikilink,
} from "./wikilinkAutocomplete";

const INDEX: NoteIndexEntry[] = [
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "References/NeuralNote.md", stem: "neuralnote" },
  { relPath: "Beta/Topic.md", stem: "topic" },
  { relPath: "Alfa/Topic.md", stem: "topic" },
];

describe("findWikilinkTrigger", () => {
  it("fires right after an unclosed [[ with an empty prefix", () => {
    expect(findWikilinkTrigger("see [[", 6)).toEqual({ start: 4, prefix: "" });
  });

  it("carries the typed prefix", () => {
    expect(findWikilinkTrigger("see [[Dee", 9)).toEqual({
      start: 4,
      prefix: "Dee",
    });
  });

  it("is null with no [[ before the caret", () => {
    expect(findWikilinkTrigger("plain text", 5)).toBeNull();
  });

  it("is null once the link is closed (`]` in the prefix)", () => {
    expect(findWikilinkTrigger("[[Done]]", 8)).toBeNull();
    expect(findWikilinkTrigger("[[Done]", 7)).toBeNull();
  });

  it("is null when a newline separates the [[ from the caret", () => {
    expect(findWikilinkTrigger("[[a\nb", 5)).toBeNull();
  });

  it("uses the innermost opener for stacked brackets", () => {
    // "a[[[": openers at 1 and 2; the trigger anchors on the last one.
    expect(findWikilinkTrigger("a[[[", 4)).toEqual({ start: 2, prefix: "" });
  });

  it("only looks before the caret", () => {
    expect(findWikilinkTrigger("ab [[later", 2)).toBeNull();
  });
});

describe("filterWikilinkSuggestions", () => {
  it("lists everything alphabetically for an empty prefix", () => {
    expect(filterWikilinkSuggestions(INDEX, "").map((s) => s.name)).toEqual([
      "Daily",
      "Deep Work",
      "NeuralNote",
      "Topic",
      "Topic",
    ]);
  });

  it("filters case-insensitively and keeps original casing", () => {
    expect(filterWikilinkSuggestions(INDEX, "dee")).toEqual([
      { name: "Deep Work", relPath: "Areas/Deep Work.md" },
    ]);
  });

  it("ranks prefix matches before substring matches", () => {
    expect(filterWikilinkSuggestions(INDEX, "ne").map((s) => s.name)).toEqual([
      "NeuralNote", // starts with "ne"
    ]);
    expect(filterWikilinkSuggestions(INDEX, "o").map((s) => s.relPath)).toEqual([
      // no name starts with "o"; substring matches alphabetical, relPath tiebreak
      "Areas/Deep Work.md",
      "References/NeuralNote.md",
      "Alfa/Topic.md",
      "Beta/Topic.md",
    ]);
  });

  it("returns nothing when no name matches", () => {
    expect(filterWikilinkSuggestions(INDEX, "zzz")).toEqual([]);
  });

  it("caps the list at the limit", () => {
    expect(filterWikilinkSuggestions(INDEX, "", 2)).toHaveLength(2);
  });
});

describe("insertWikilink", () => {
  it("replaces the trigger and prefix with the closed link", () => {
    expect(insertWikilink("see [[Dee tail", 4, 9, "Deep Work")).toEqual({
      value: "see [[Deep Work]] tail",
      caret: 17,
    });
  });

  it("auto-closes when nothing follows the caret", () => {
    expect(insertWikilink("[[", 0, 2, "Daily")).toEqual({
      value: "[[Daily]]",
      caret: 9,
    });
  });

  it("consumes a ]] the user already typed after the caret", () => {
    expect(insertWikilink("[[Dai]]", 0, 5, "Daily")).toEqual({
      value: "[[Daily]]",
      caret: 9,
    });
  });
});
