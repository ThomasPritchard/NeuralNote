import { describe, expect, it } from "vitest";
import {
  applyFormat,
  insertLink,
  toggleHeading,
  toggleWrap,
  type Selection,
} from "./markdownFormat";

const sel = (value: string, start: number, end = start): Selection => ({
  value,
  start,
  end,
});

describe("toggleWrap", () => {
  it("wraps a selection and keeps the inner text selected", () => {
    const r = toggleWrap(sel("hello", 0, 5), "**");
    expect(r.value).toBe("**hello**");
    expect([r.start, r.end]).toEqual([2, 7]);
    expect(r.value.slice(r.start, r.end)).toBe("hello");
  });

  it("unwraps when the tokens flank the selection", () => {
    const r = toggleWrap(sel("**hello**", 2, 7), "**");
    expect(r.value).toBe("hello");
    expect([r.start, r.end]).toEqual([0, 5]);
  });

  it("unwraps when the markers are inside the selection", () => {
    const r = toggleWrap(sel("**hello**", 0, 9), "**");
    expect(r.value).toBe("hello");
    expect([r.start, r.end]).toEqual([0, 5]);
  });

  it("does not strip a single marker off a longer run (italic over bold)", () => {
    // Selecting bold text and applying italic must not corrupt it to *bold*.
    const r = toggleWrap(sel("**bold**", 0, 8), "*");
    expect(r.value).toBe("***bold***");
  });

  it("inserts an empty pair at a bare caret with the caret between them", () => {
    const r = toggleWrap(sel("ab", 1), "**");
    expect(r.value).toBe("a****b");
    expect(r.start).toBe(3);
    expect(r.end).toBe(3);
  });

  it("removes an empty pair around a bare caret", () => {
    const r = toggleWrap(sel("a****b", 3), "**");
    expect(r.value).toBe("ab");
    expect([r.start, r.end]).toEqual([1, 1]);
  });

  it("wraps with a single-character token for italic", () => {
    const r = toggleWrap(sel("word", 0, 4), "*");
    expect(r.value).toBe("*word*");
    expect(r.value.slice(r.start, r.end)).toBe("word");
  });
});

describe("toggleHeading", () => {
  it("adds a heading marker to a plain line", () => {
    const r = toggleHeading(sel("hello world", 3), 2);
    expect(r.value).toBe("## hello world");
    expect(r.start).toBe(6);
  });

  it("removes the marker when re-applying the same level", () => {
    const r = toggleHeading(sel("## hello", 5), 2);
    expect(r.value).toBe("hello");
    expect(r.start).toBe(2);
  });

  it("changes the level when a different one is applied", () => {
    const r = toggleHeading(sel("# hello", 4), 3);
    expect(r.value).toBe("### hello");
    expect(r.start).toBe(6);
  });

  it("operates only on the line containing the caret", () => {
    const r = toggleHeading(sel("line1\nline2", 8), 1);
    expect(r.value).toBe("line1\n# line2");
    expect(r.start).toBe(10);
  });
});

describe("insertLink", () => {
  it("wraps the selection and drops the caret in the url slot", () => {
    const r = insertLink(sel("see docs", 4, 8));
    expect(r.value).toBe("see [docs]()");
    expect(r.value.slice(0, r.start)).toBe("see [docs](");
    expect(r.start).toBe(r.end);
  });

  it("drops the caret in the text slot when there is no selection", () => {
    const r = insertLink(sel("see ", 4));
    expect(r.value).toBe("see []()");
    expect(r.value.slice(0, r.start)).toBe("see [");
    expect(r.start).toBe(r.end);
  });
});

describe("applyFormat", () => {
  it("routes each action to its transform", () => {
    expect(applyFormat("format-bold", sel("x", 0, 1)).value).toBe("**x**");
    expect(applyFormat("format-italic", sel("x", 0, 1)).value).toBe("*x*");
    expect(applyFormat("format-h1", sel("x", 0)).value).toBe("# x");
    expect(applyFormat("format-h2", sel("x", 0)).value).toBe("## x");
    expect(applyFormat("format-h3", sel("x", 0)).value).toBe("### x");
    expect(applyFormat("format-link", sel("x", 0, 1)).value).toBe("[x]()");
  });
});
