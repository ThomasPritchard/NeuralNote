import { describe, expect, it } from "vitest";

import { SUPERLINEAR_RATIO, growthRatio } from "../test/superlinearGrowth";
import { sourceTitleMode, withoutAtxClosingSequence } from "./sourceDocumentTitle";

/**
 * Issue #143 — stripping a heading's closing sequence was quadratic in the
 * length of the heading line (`typescript:S5852`).
 *
 * `/[ \t]+#+[ \t]*$/` starts a fresh greedy run of `[ \t]+` at every whitespace
 * character, consumes the rest of the line, then backtracks one character at a
 * time looking for a `#` that isn't there. A note whose first heading is `# `
 * followed by ~64K spaces cost 1.75 s to compute a title for, and
 * `TOP_SCAN_LIMIT` does not save that — it DEFINES it, as the worst case.
 *
 * NeuralNote captures whole sources — articles, transcripts, pasted data — so a
 * captured note with one enormous line is the realistic way in.
 *
 * Two halves, and the fix needs both. {@link SUPERLINEAR_RATIO} says the cost
 * grew linearly; the differential corpus says the answers did not move.
 */

/** The pathological shape: a heading whose text is one character then padding. */
const paddedHeading = (padding: number): string => `# x${" ".repeat(padding)}`;

const SMALL_PADDING = 8_192;
const LARGE_PADDING = SMALL_PADDING * 4;

describe("source title computation, on a pathologically padded heading", () => {
  it("stays linear in the length of the heading line", () => {
    const small = paddedHeading(SMALL_PADDING);
    const large = paddedHeading(LARGE_PADDING);
    expect(large.length / small.length).toBeCloseTo(4, 1);

    expect(growthRatio(() => void sourceTitleMode(small), () => void sourceTitleMode(large)))
      .toBeLessThanOrEqual(SUPERLINEAR_RATIO);
  });

  it("still reads the padded heading as a source-backed title", () => {
    expect(sourceTitleMode(paddedHeading(LARGE_PADDING))).toBe("source");
  });
});

/** The strip as it was before issue #143, character for character. */
const legacyStrip = (text: string): string => text.replace(/[ \t]+#+[ \t]*$/, "");

/** Mulberry32 — a seeded PRNG, so the fuzz corpus is identical run to run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Everything the rule reads — `#`, space, tab — plus ordinary title characters
 * and the ones that break scanners written in code units: a CJK character, an
 * astral emoji (a surrogate PAIR) and a lone high surrogate. Fragments as well
 * as single characters, so whole closing sequences assemble often enough for the
 * corpus-quality guards below to pass.
 *
 * `\u00A0`, `\v` and `\f` are whitespace to `String.prototype.trim` but are NOT
 * the space or tab a closing sequence needs, so they must survive where a space
 * would be eaten. Nothing distinguished a strip from a strip-then-trim until
 * they were here.
 */
const FUZZ_ALPHABET = [
  "#", " ", "\t", "a", "Z", "-", "界", "😀", "\uD83D",
  "##", "  ", " # ", "x ", " ###", "\t#",
  "\u00A0", "\v", "\f", "\u00A0 ##  ",
];

const FUZZ_CASES = 4_000;
const FUZZ_MAX_FRAGMENTS = 12;

function fuzzCorpus(): string[] {
  const random = seededRandom(0x14_3B_C1_05);
  return Array.from({ length: FUZZ_CASES }, () => {
    const fragments = 1 + Math.floor(random() * FUZZ_MAX_FRAGMENTS);
    let text = "";
    for (let index = 0; index < fragments; index += 1) {
      text += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)]!;
    }
    return text;
  });
}

const NAMED_CORPUS: readonly string[] = [
  "",
  " ",
  "   ",
  "\t",
  "Plain title",
  "Title with trailing spaces   ",
  // Closing sequences, which the rule strips.
  "Title #",
  "Title ##",
  "Title ###   ",
  "Title\t#\t",
  "Title  ##  ",
  "Title # ## ",
  "a ## ##  ",
  " # ",
  "\t#\t",
  // Hashes that are NOT a closing sequence.
  "###",
  "Title#",
  "Title#  ",
  "a#  ",
  "Title # and more",
  "Title ## text ##text",
  "Not a sequence #x",
  // Hashes inside the title, with a real closing sequence after them.
  "C# programming ##",
  "Issue #143 fixed #",
  "#tag #another ##  ",
  // The adversarial shapes.
  `x${" ".repeat(64)}`,
  `${" ".repeat(64)}#`,
  `x${" ".repeat(64)}#`,
  `x${" ".repeat(64)}#${" ".repeat(64)}`,
  `${"#".repeat(64)}x`,
  `x ${"#".repeat(64)}`,
  `x${"\t".repeat(64)}#`,
  // Whitespace that `trim` eats but a closing sequence does not accept.
  "Title\u00A0 ##  ",
  "Title\u00A0##  ",
  "Title\v ##",
  "Title\f ##  ",
  "Title \u00A0 ##",
  "Title\u00A0",
  // Unicode.
  "日本語の見出し ##",
  "Café ☕ ##  ",
  "😀 emoji title 😀 #",
  "\uD83D lone surrogate #",
];

const strippedBy = (strip: (text: string) => string) =>
  (corpus: readonly string[]) => corpus.map((text) => ({ text, stripped: strip(text) }));

const scanned = strippedBy(withoutAtxClosingSequence);
const legacy = strippedBy(legacyStrip);

describe("withoutAtxClosingSequence, against the pre-#143 strip", () => {
  it("agrees on every hand-written case", () => {
    expect(scanned(NAMED_CORPUS)).toEqual(legacy(NAMED_CORPUS));
  });

  it("agrees on every case of a seeded hash-and-whitespace fuzz corpus", () => {
    const corpus = fuzzCorpus();
    expect(corpus).toHaveLength(FUZZ_CASES);
    // Agreeing proves nothing unless the corpus actually contains cases the rule
    // strips, and cases carrying a `#` that it deliberately leaves alone.
    expect(corpus.filter((text) => legacyStrip(text) !== text).length).toBeGreaterThan(500);
    expect(corpus.filter((text) => legacyStrip(text) === text && text.includes("#")).length)
      .toBeGreaterThan(500);

    expect(scanned(corpus)).toEqual(legacy(corpus));
  });

  it("builds the same fuzz corpus every run", () => {
    expect(fuzzCorpus()).toEqual(fuzzCorpus());
  });
});
