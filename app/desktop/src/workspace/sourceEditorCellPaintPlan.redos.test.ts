import { describe, expect, it } from "vitest";

import { SUPERLINEAR_RATIO, growthRatio } from "../test/superlinearGrowth";
import { type InlineWikilink, inlineWikilinks } from "./sourceEditorCellPaintPlan";

/**
 * Issue #143 — the wikilink scan was quadratic in the length of a LINE
 * (`typescript:S5852`).
 *
 * `/(!)?\[\[([^\]\r\n]+)\]\]/g` starts a greedy run at every `[[`, and because
 * the run's character class excludes `]` it stops only at the next `]` or line
 * break. On a line with many unclosed `[[` there is no `]` at all, so every
 * opener scans to the end of the line: quadratic per line. The same character
 * count spread over ordinary 80-character lines cost ~4 orders of magnitude
 * less. One enormous line is the whole hazard, and a captured source — a
 * transcript, a pasted table, minified data — is how one arrives.
 *
 * The scan reaches the whole document, not just the viewport:
 * `collectObsidianPreview`'s `visibleRanges` parameter DEFAULTS to
 * `[{ from: 0, to: state.doc.length }]`, so a non-view caller scans everything.
 *
 * Two halves, and the fix needs both. {@link SUPERLINEAR_RATIO} says the cost
 * grew linearly; the differential corpus says the answers did not move. A faster
 * scanner that disagreed with the old one by a single character would replace a
 * performance bug with a rendering-corruption bug, because `obsidianLivePreview`
 * and `cellPaintPlan` share THIS function precisely so that the span one
 * replaces and the span the other projects are one answer, not two.
 */

/** The pathological shape: unclosed openers, no `]` anywhere, all one line. */
const unclosedOpeners = (length: number): string => "[[".repeat(length / 2);

const SMALL_LENGTH = 8_192;
const LARGE_LENGTH = SMALL_LENGTH * 4;

describe("inlineWikilinks, on a line of unclosed openers", () => {
  it("stays linear in the length of the line", () => {
    const small = unclosedOpeners(SMALL_LENGTH);
    const large = unclosedOpeners(LARGE_LENGTH);
    expect(large.length / small.length).toBeCloseTo(4, 1);

    expect(growthRatio(() => void inlineWikilinks(small), () => void inlineWikilinks(large)))
      .toBeLessThanOrEqual(SUPERLINEAR_RATIO);
  });

  it("still finds nothing in a line that never closes an opener", () => {
    expect(inlineWikilinks(unclosedOpeners(LARGE_LENGTH))).toEqual([]);
  });
});

/**
 * The scan as it was before issue #143, character for character.
 *
 * `label` is deliberately absent: it is `wikilinkLabel(rawTarget)` on both
 * sides, a pure function of `rawTarget` that this change does not touch, and
 * `sourceEditorCellPaintPlan.test.ts` already covers it. Identical `rawTarget`
 * sequences therefore mean identical `label` sequences — the suite below still
 * spot-checks two labels rather than take that on trust.
 */
function legacyScan(source: string, base = 0): Omit<InlineWikilink, "label">[] {
  return [...source.matchAll(/(!)?\[\[([^\]\r\n]+)\]\]/g)].map((match) => ({
    from: base + match.index,
    to: base + match.index + match[0].length,
    embed: match[1] === "!",
    rawTarget: match[2]!,
  }));
}

const scanOf = (source: string, base = 0): Omit<InlineWikilink, "label">[] =>
  inlineWikilinks(source, base)
    .map(({ from, to, embed, rawTarget }) => ({ from, to, embed, rawTarget }));

/**
 * The whole corpus scanned, each result carried alongside the source that
 * produced it, so one `toEqual` over the lot names the offending input in its
 * diff. `expect(value, message)` would say the same thing and is what oxlint's
 * `vitest(valid-expect)` forbids.
 */
const scanCorpus = (corpus: readonly string[], base = 0) =>
  corpus.map((source) => ({ source, links: scanOf(source, base) }));

const legacyCorpus = (corpus: readonly string[], base = 0) =>
  corpus.map((source) => ({ source, links: legacyScan(source, base) }));

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
 * Fragments, not single characters. Drawn uniformly from an alphabet of
 * CHARACTERS, a random string almost never assembles a whole `[[x]]`, so a
 * corpus built that way agrees on 4,000 strings the scan rejects and never
 * exercises a match at all — which the corpus-quality guards below exist to
 * catch, and did.
 *
 * Includes what breaks scanners written in code units: a CJK character, an
 * astral emoji (a surrogate PAIR, which the un-flagged source regex sees as two
 * code units), a lone high surrogate, and `\u2028`, which is a line separator to
 * `String.prototype.split` and to a regex `.` but is NOT `\r` or `\n`, and so
 * does NOT end a wikilink target.
 */
const FUZZ_ALPHABET = [
  "[", "]", "!", "\n", "\r", " ", "\t", "a", "|", "#", "/", ".",
  "界", "😀", "\uD83D", "\u2028", " ",
  "[[", "]]", "![[", "[[a]]", "]]]", "[[[", "Note", "ab",
];

const FUZZ_CASES = 4_000;
const FUZZ_MAX_FRAGMENTS = 16;

function fuzzCorpus(): string[] {
  const random = seededRandom(0x14_3B_A5_E1);
  return Array.from({ length: FUZZ_CASES }, () => {
    const fragments = 1 + Math.floor(random() * FUZZ_MAX_FRAGMENTS);
    let source = "";
    for (let index = 0; index < fragments; index += 1) {
      source += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)]!;
    }
    return source;
  });
}

const NAMED_CORPUS: readonly string[] = [
  "",
  "no links here at all",
  "[[Daily Note]]",
  "![[Daily Note]]",
  "!![[Daily Note]]",
  "text ![[Embed]] and [[Link]] together",
  "[[a]][[b]][[c]]",
  "[[a]] ![[b]] [[c]]",
  "[[a]]![[b]]",
  // Nested and unbalanced brackets.
  "[[[Nested]]]",
  "[[[[Double]]]]",
  "[[prefix [inner] suffix]]",
  "![prefix [[Daily]] suffix](x.png)",
  "[[a][b]]",
  "[[a][[b]]",
  "[[]]",
  "[[]]]]",
  "[ [Not a link] ]",
  // Unclosed openers, and closers with no opener.
  "[[unclosed",
  "[[unclosed]",
  "[[one [[two]]",
  "[[one [[two]] three]]",
  "]] stray closer",
  "]][[Link]]]]",
  "[[a]] ]] [[b]]",
  // Line breaks: a target may not span one.
  "[[start\nend]]",
  "[[start\r\nend]]",
  "[[start\rend]]",
  "[[good]]\n[[also good]]",
  "line one\n[[Link]]\nline three",
  "![[a]]\r\n![[b]]",
  "[[a\n]]b]]",
  // Unicode.
  "[[日本語のノート]]",
  "[[Café ☕ Notes]]",
  "[[😀 emoji target 😀]]",
  "[[\uD83D lone surrogate]]",
  "[[line\u2028separator]]",
  "![[界]] [[界|alias]]",
  // Aliases, headings, paths — what `wikilinkLabel` reads.
  "[[folder/Note.md#Heading|Alias]]",
  "[[folder/sub/Note]]",
  "[[Note#Heading]]",
  "[[Note|]]",
  "[[|Alias]]",
  "[[ ]]",
  "[[#]]",
  "[[!]]",
];

describe("inlineWikilinks, against the pre-#143 scan", () => {
  it("agrees on every hand-written case, at offset 0 and at a document offset", () => {
    expect(scanCorpus(NAMED_CORPUS)).toEqual(legacyCorpus(NAMED_CORPUS));
    expect(scanCorpus(NAMED_CORPUS, 4_096)).toEqual(legacyCorpus(NAMED_CORPUS, 4_096));
  });

  it("agrees on every case of a seeded bracket-heavy fuzz corpus", () => {
    const corpus = fuzzCorpus();
    expect(corpus).toHaveLength(FUZZ_CASES);
    // Agreeing proves nothing unless the corpus actually contains links, and
    // embeds, and cases the old scan rejected.
    expect(corpus.filter((source) => legacyScan(source).length > 0).length).toBeGreaterThan(100);
    expect(corpus.filter((source) => legacyScan(source).some((link) => link.embed)).length)
      .toBeGreaterThan(10);
    expect(corpus.filter((source) => source.includes("[[") && legacyScan(source).length === 0).length)
      .toBeGreaterThan(100);

    expect(scanCorpus(corpus)).toEqual(legacyCorpus(corpus));
  });

  it("builds the same fuzz corpus every run", () => {
    expect(fuzzCorpus()).toEqual(fuzzCorpus());
  });

  it("still labels a wikilink from its alias, and otherwise from its bare note name", () => {
    expect(inlineWikilinks("[[folder/Note.md#Heading|Alias]]")[0]?.label).toBe("Alias");
    expect(inlineWikilinks("[[folder/sub/Note.md#Heading]]")[0]?.label).toBe("Note");
  });
});
