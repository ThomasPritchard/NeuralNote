import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  applySourceChanges,
  loadSourceText,
  serializeSourceText,
  SourcePreservationError,
  type SourceText,
} from "./sourceText";

describe("sourceText", () => {
  it.each([
    ["empty", ""],
    ["BOM only", "\uFEFF"],
    ["LF", "one\ntwo\n"],
    ["CRLF", "one\r\ntwo\r\n"],
    ["CR", "one\rtwo\r"],
    ["mixed", "one\r\ntwo\nthree\rfour"],
    ["blank lines", "one\n\n\nthree"],
    ["whitespace and Unicode", "\uFEFF\t café  \r\n漢字\t\r"]
  ])("rebuilds an unchanged %s document byte for byte", (_name, source) => {
    expect(serializeSourceText(loadSourceText(source))).toBe(source);
  });

  it("retains unchanged separators and inherits the nearest separator for inserted lines", () => {
    const source = loadSourceText("alpha\r\nbeta\ngamma");
    const changes = ChangeSet.of(
      { from: source.text.indexOf("beta") + 4, insert: "\ninserted" },
      source.text.length,
    );

    const next = applySourceChanges(source, changes);

    expect(next.text).toBe("alpha\nbeta\ninserted\ngamma");
    expect(serializeSourceText(next)).toBe("alpha\r\nbeta\ninserted\ngamma");
  });

  it("maps separators through a deletion that joins logical lines", () => {
    const source = loadSourceText("one\r\ntwo\nthree\rfour");
    const start = source.text.indexOf("\n");
    const changes = ChangeSet.of({ from: start, to: start + 4 }, source.text.length);

    const next = applySourceChanges(source, changes);

    expect(next.text).toBe("one\nthree\nfour");
    expect(serializeSourceText(next)).toBe("one\nthree\rfour");
  });

  it("maps replacement and multi-range edits without normalizing untouched boundaries", () => {
    const source = loadSourceText("a\r\nb\nc\rd");
    const changes = ChangeSet.of(
      [
        { from: 0, to: 1, insert: "A\nA2" },
        { from: source.text.indexOf("c"), to: source.text.indexOf("c") + 1, insert: "C" },
      ],
      source.text.length,
    );

    const next = applySourceChanges(source, changes);

    expect(serializeSourceText(next)).toBe("A\r\nA2\r\nb\nC\rd");
  });

  it("takes a retyped line's ending from the region it replaced, not a distant stray", () => {
    // Regression: separators were chosen by absolute byte proximity across the
    // WHOLE document, so retyping three LF lines inherited CRLF from an
    // unrelated line four lines away. The plan requires the "nearest edited
    // region" — the endings actually being overwritten.
    const original = "intro\r\nalpha\nbeta\ngamma\ndelta\n";
    const source = loadSourceText(original);
    const from = source.text.indexOf("alpha");
    const changes = ChangeSet.of(
      { from, to: from + "alpha\nbeta\ngamma".length, insert: "A\nB\nC" },
      source.text.length,
    );

    expect(serializeSourceText(applySourceChanges(source, changes)))
      .toBe("intro\r\nA\nB\nC\ndelta\n");
  });

  it("introduces no line ending that the original document did not contain", () => {
    for (const original of ["a\nb\nc\n", "a\r\nb\r\nc\r\n", "a\rb\rc\r"]) {
      const source = loadSourceText(original);
      const changes = ChangeSet.of(
        { from: 0, to: source.text.length, insert: "X\nY\nZ\n" },
        source.text.length,
      );
      const result = serializeSourceText(applySourceChanges(source, changes));
      const endings = new Set(result.match(/\r\n|\r|\n/g) ?? []);
      const permitted = new Set(original.match(/\r\n|\r|\n/g) ?? []);

      for (const ending of endings) {
        expect({ original, ending, permitted: [...permitted] })
          .toEqual({ original, ending, permitted: expect.arrayContaining([ending]) });
      }
    }
  });

  it("reuses the ending it overwrote, not the one after the edit", () => {
    // The replaced region held a CRLF and the text after it ends with LF. The
    // newline the user typed replaces the CRLF, so it should be CRLF. Distinct
    // from the line-terminator rule, which would reach past the edit for LF.
    const source = loadSourceText("a\r\nbcd\nef");
    const changes = ChangeSet.of({ from: 0, to: 4, insert: "XY\nZW" }, source.text.length);

    expect(serializeSourceText(applySourceChanges(source, changes))).toBe("XY\r\nZWd\nef");
  });

  it("actually reaches the dominant-separator fallback", () => {
    // The previous implementation could never reach its own `?? defaultSeparator`
    // branch, so `dominantSeparator` influenced no real document. Poison it and
    // assert the sentinel appears, or this fallback is dead code again.
    const source = { ...loadSourceText("a\r\nb\r\nc"), defaultSeparator: "\r" as const };
    // Append past the final boundary: nothing was replaced and no boundary
    // follows, which is the only route to the fallback.
    const changes = ChangeSet.of(
      { from: source.text.length, insert: "\ntail" },
      source.text.length,
    );

    expect(serializeSourceText(applySourceChanges(source, changes))).toBe("a\r\nb\r\nc\rtail");
  });

  it("uses the dominant separator, then LF, when no nearby boundary exists", () => {
    const dominant = loadSourceText("a\r\nb\r\nc\nd");
    const dominantInsert = ChangeSet.of({ from: 0, insert: "x\ny\n" }, dominant.text.length);
    expect(serializeSourceText(applySourceChanges(dominant, dominantInsert))).toBe(
      "x\r\ny\r\na\r\nb\r\nc\nd",
    );

    const empty = loadSourceText("");
    const emptyInsert = ChangeSet.of({ from: 0, insert: "x\ny" }, 0);
    expect(serializeSourceText(applySourceChanges(empty, emptyInsert))).toBe("x\ny");
  });

  it("preserves a terminal separator, trailing spaces, tabs, BOM, and Unicode after a real edit", () => {
    const source = loadSourceText("\uFEFFtitle  \r\n\t😀\r\n");
    const emoji = source.text.indexOf("😀");
    const changes = ChangeSet.of({ from: emoji, to: emoji + 2, insert: "漢字" }, source.text.length);

    expect(serializeSourceText(applySourceChanges(source, changes))).toBe(
      "\uFEFFtitle  \r\n\t漢字\r\n",
    );
  });

  it("rejects an ambiguous separator map instead of normalizing a recoverable draft", () => {
    const invalid = {
      ...loadSourceText("a\r\nb"),
      separators: [],
    } satisfies SourceText;
    const changes = ChangeSet.of({ from: 1, insert: "x" }, invalid.text.length);

    expect(() => applySourceChanges(invalid, changes)).toThrow(SourcePreservationError);
    expect(invalid.text).toBe("a\nb");
  });
});
