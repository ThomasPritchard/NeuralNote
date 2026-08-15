import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ChangeSet, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { collectObsidianPreview } from "./obsidianLivePreview";
import { collectMarkdownPreview } from "./sourceEditorDecorations";
import { applySourceChanges, loadSourceText, serializeSourceText, type SourceText } from "./sourceText";

// EVERY state in this file is deliberately left with the parse CodeMirror gave
// it, which is the opposite of the rule the rest of the suite now follows (see
// `src/test/publishedParse.ts`). Nothing here reads the tree for its CONTENT:
// both assertions are a cost, so a short tree makes this file cheaper and never
// wrong, and there is no "found nothing" failure for a published parse to
// prevent.
//
// Publishing was tried and measured, because forcing a parse looks free and is
// not. `LanguageState.apply` bounds an UNFINISHED parse to the mapped tree
// length or the viewport, whichever is further
// (`@codemirror/language/dist/index.js:527-538`) — a small, equal charge on both
// arms — while a FINISHED one is re-advanced across the whole document on every
// keystroke, inside the timed region and in proportion to note size. Measured on
// this machine at 20 CPU burners, 9 samples each: unpublished held 3.73-4.57,
// published spread 2.53-5.08, and a published run of the full suite hit 8.97
// against a ceiling of 8. The parse is not what this file measures, and paying
// for it here only makes the ratio noisier.

// v8 coverage instrumentation multiplies wall-clock time per instrumented
// function call, so these wall-clock budgets measure the *instrument*, not the
// code, when run under `npm run coverage` (which sets VITEST_COVERAGE=1). The
// real budget gate runs uninstrumented in `test:unit` (both Node versions, every
// PR and push); we only skip the redundant, timing-invalid coverage re-run.
// @types/node is intentionally absent from this project, so read the flag off
// globalThis rather than a bare `process`.
const UNDER_COVERAGE_INSTRUMENTATION =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITEST_COVERAGE === "1";

const PARAGRAPH = "A representative paragraph with **strong text**, [[Vault Link]], Unicode café 界, and trailing spaces.  ";

/** A note of `paragraphs` paragraphs. Longer notes extend shorter ones verbatim. */
const note = (paragraphs: number): string => Array.from(
  { length: paragraphs },
  (_, index) => `## Heading ${index}\n\n${PARAGRAPH}`,
).join("\r\n\r\n");

const FIXTURE = note(5_000);
const LINKS = [{ relPath: "Vault Link.md", stem: "vault link" }];

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** One note being typed into, carried across keystrokes so each edit builds on the last. */
interface Typist {
  readonly text: string;
  source: SourceText;
  state: EditorState;
  keystrokes: number;
}

function typist(text: string): Typist {
  const source = loadSourceText(text);
  return {
    text,
    source,
    state: EditorState.create({
      doc: source.text,
      extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false })],
    }),
    keystrokes: 0,
  };
}

/**
 * One keystroke, end to end: reconstruct the exact source, advance the editor
 * state, repaint the visible window. Returns the elapsed milliseconds.
 */
function keystroke(subject: Typist): number {
  const position = Math.min(subject.source.text.length, 512 + subject.keystrokes * 997);
  const changes = ChangeSet.of(
    { from: position, insert: subject.keystrokes % 4 === 0 ? "\n" : "x" },
    subject.source.text.length,
  );
  subject.keystrokes += 1;

  const started = performance.now();
  subject.source = applySourceChanges(subject.source, changes);
  subject.state = subject.state.update({ changes }).state;
  const visible = [{
    from: Math.max(0, position - 4_096),
    to: Math.min(subject.state.doc.length, position + 4_096),
  }];
  collectMarkdownPreview(subject.state, visible);
  collectObsidianPreview(subject.state, LINKS, visible);
  serializeSourceText(subject.source);
  return performance.now() - started;
}

const SAMPLES = 21;

/**
 * How much dearer `costlier` is than `cheaper`, sampled ALTERNATELY and reduced
 * by median.
 *
 * Alternating is what makes the answer a statement about the code rather than
 * about the machine: a scheduling stall lands inside one PAIR, inflating both
 * halves of one ratio, and the median then discards that pair outright. Measured
 * on a 14-core machine, the median below moved from 3.55 to 3.66-3.83 between an
 * idle machine and one at load average 98 — under 8% — while the wall-clock p95
 * it replaced moved from 7.3 ms to 47.6 ms and failed its budget three runs in a
 * row.
 */
function costRatio(costlier: () => number, cheaper: () => number): number {
  const ratios: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const costlierMs = costlier();
    const cheaperMs = cheaper();
    ratios.push(costlierMs / cheaperMs);
  }
  return median(ratios);
}

/**
 * Quadruple the note, and a linear reconstruction costs four times as much while
 * a quadratic one costs sixteen. Measured: 3.55-3.85 as it stands, 18.8 with the
 * separator lookup in `applySourceChanges` changed from a map to a scan — so the
 * ceiling sits almost exactly halfway between the two, in the ratio's own log
 * scale.
 *
 * What this does NOT catch is a constant-factor regression: an extra whole-
 * document pass measured at 8% and a duplicated text rebuild at 12%, both inside
 * the noise of any ratio that survives a busy machine. The 50 ms absolute this
 * replaced did not catch them either — it carried 6.7x headroom on an idle
 * machine — so nothing is lost, and superlinearity is now caught on ANY machine
 * rather than only on a quiet one.
 */
const SUPERLINEAR_RATIO = 8;

describe("source editor performance budgets", () => {
  it.skipIf(UNDER_COVERAGE_INSTRUMENTATION)("opens the visible portion of a 500 KiB / 5,000-paragraph fixture within budget", () => {
    expect(new TextEncoder().encode(FIXTURE).byteLength).toBeGreaterThanOrEqual(500 * 1024);
    const samples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      // The bounded first parse is inside the timed region on purpose: it is
      // part of what opening a note costs the user.
      const started = performance.now();
      const state = EditorState.create({
        doc: loadSourceText(FIXTURE).text,
        extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false })],
      });
      const visible = [{ from: 0, to: Math.min(8_192, state.doc.length) }];
      collectMarkdownPreview(state, visible);
      collectObsidianPreview(state, LINKS, visible);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    expect(samples[2]).toBeLessThanOrEqual(1_500);
  });

  it.skipIf(UNDER_COVERAGE_INSTRUMENTATION)("keeps exact-source reconstruction linear in the size of the note", () => {
    // What the 50 ms key-to-paint p95 was reaching for, in a unit a busy machine
    // cannot move. Both notes are typed into alternately in this one run, so the
    // machine that slows the numerator slows the denominator with it.
    const small = typist(note(1_250));
    const large = typist(note(5_000));

    expect(large.text.length / small.text.length).toBeCloseTo(4, 1);
    expect(costRatio(() => keystroke(large), () => keystroke(small)))
      .toBeLessThanOrEqual(SUPERLINEAR_RATIO);
  });
});
