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
