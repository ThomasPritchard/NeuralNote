import { describe, expect, it } from "vitest";
import {
  buildLocalNoteDigest,
  LEAD_CAPTURE_LIMIT,
  notePreviewFocusScreenX,
  notePreviewMetrics,
  notePreviewPlacement,
} from "./notePreviewModel";

describe("buildLocalNoteDigest", () => {
  it("uses the first meaningful sentence and removes inline markdown", () => {
    const digest = buildLocalNoteDigest(`
# Project Atlas

\`\`\`
const ignored = "code";
\`\`\`

The **first useful sentence** links to [source material](https://example.com) and [[Maps|a map]]. A later sentence is not part of the lead.
`);

    expect(digest.lead).toBe(
      "The first useful sentence links to source material and a map.",
    );
  });

  it("reports bounded local reading statistics", () => {
    const body = [
      "# One",
      "alpha beta gamma",
      "## Two",
      ...Array.from({ length: 219 }, () => "word"),
    ].join("\n");

    expect(buildLocalNoteDigest(body)).toMatchObject({
      sectionCount: 2,
      wordCount: 222,
      readingMinutes: 2,
    });
  });

  it("keeps an extremely long first passage within the preview budget", () => {
    const digest = buildLocalNoteDigest(
      `This ${"deliberately verbose ".repeat(20)}passage has no early punctuation`,
    );

    expect(digest.lead.length).toBeLessThanOrEqual(133);
    expect(digest.lead).toMatch(/…$/);
  });

  it("returns an explicit fallback when no readable prose exists", () => {
    expect(buildLocalNoteDigest("```\nconst only = true;\n```").lead).toBe(
      "No readable text.",
    );
  });

  it("keeps prose that immediately follows an ATX heading", () => {
    expect(buildLocalNoteDigest("## Context\nFirst useful sentence.").lead).toBe(
      "First useful sentence.",
    );
  });

  it("recognises indented ATX headings and tilde fences", () => {
    expect(
      buildLocalNoteDigest(
        "   ## Context\n~~~ts\nconst ignored = true;\n~~~\nVisible sentence.",
      ),
    ).toMatchObject({
      lead: "Visible sentence.",
      sectionCount: 1,
      wordCount: 2,
    });
  });

  it("does not treat a fenced code line with an info suffix as a closing fence", () => {
    expect(
      buildLocalNoteDigest(
        "```js\n`````js\n## ignored\n```\nVisible sentence.",
      ),
    ).toMatchObject({
      lead: "Visible sentence.",
      sectionCount: 0,
      wordCount: 2,
    });
  });

  it("counts an empty ATX heading at end of line", () => {
    expect(buildLocalNoteDigest("###")).toMatchObject({
      lead: "No readable text.",
      sectionCount: 1,
      wordCount: 0,
    });
  });

  it("stops a local digest at Unicode sentence punctuation", () => {
    expect(buildLocalNoteDigest("第一句话。第二句话。").lead).toBe("第一句话。");
  });

  it("does not split an emoji at the lead boundary", () => {
    const digest = buildLocalNoteDigest(`${"a".repeat(131)}😀 trailing text`);

    expect(digest.lead).toBe(`${"a".repeat(131)}😀…`);
    expect(digest.lead).not.toContain("�");
  });

  it("stays bounded on a legal adversarial unmatched-link body", () => {
    const started = performance.now();

    buildLocalNoteDigest("[".repeat(100_000));

    expect(performance.now() - started).toBeLessThan(500);
  });

  /** A link whose visible label is one character but whose source is 96 UTF-16
   * units, so the module's capture budget is spent long before the lead's
   * 132-character budget is. That is what lets a capture-boundary cut survive
   * into the rendered lead instead of being truncated away later. */
  const wideLink = `[a](https://example.com/${"p".repeat(70)}) `;

  /** Build a body whose emoji starts exactly at `highSurrogateIndex`, asserting
   * the alignment so the probe can never go vacuous if the padding drifts. */
  const lineWithEmojiAt = (highSurrogateIndex: number) => {
    const links = wideLink.repeat(10);
    const padding = "z".repeat(highSurrogateIndex - links.length);
    const line = `${links}${padding}😀 tail`;
    expect(line.codePointAt(highSurrogateIndex)).toBe(0x1_f600);
    return { line, expectedLead: `${"a ".repeat(10)}${padding}` };
  };

  it("never emits an unpaired surrogate, wherever the capture boundary falls", () => {
    // Walks the emoji across the budget so the run is guaranteed to include the
    // alignment that straddles it (high surrogate on the last captured unit).
    for (const offset of [-3, -2, -1, 0]) {
      const index = LEAD_CAPTURE_LIMIT + offset;
      const { line } = lineWithEmojiAt(index);

      expect(buildLocalNoteDigest(line).lead).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });

  it("drops a character the capture budget cannot hold whole, keeping the rest", () => {
    const { line, expectedLead } = lineWithEmojiAt(LEAD_CAPTURE_LIMIT - 1);

    expect(buildLocalNoteDigest(line).lead).toBe(expectedLead);
  });

  it("counts CJK, emoji and explicit surrogate pairs as whitespace-delimited words", () => {
    expect(buildLocalNoteDigest("汉字 😀😀 𝐀𝐁 plain")).toMatchObject({
      wordCount: 4,
    });
  });

  it("trims Unicode whitespace around an astral character without splitting it", () => {
    expect(buildLocalNoteDigest("　 😀 tail   ")).toMatchObject({
      lead: "😀 tail",
      wordCount: 2,
    });
  });

  it("strips CR from a CRLF body whose lines end in astral characters", () => {
    expect(buildLocalNoteDigest("# 見出し\r\n本文です😀\nsecond line.")).toMatchObject({
      lead: "本文です😀 second line.",
      sectionCount: 1,
      wordCount: 3,
    });
  });

  it("strips an ASCII ordered-list marker without eating the CJK text after it", () => {
    expect(buildLocalNoteDigest("12. 第一句话。第二句话。").lead).toBe("第一句话。");
  });

  it("leaves a full-width numeral alone: only ASCII digits mark an ordered list", () => {
    expect(buildLocalNoteDigest("１２． 第一句话。").lead).toBe("１２． 第一句话。");
  });

  it("ends the lead at the first blank line, ignoring later paragraphs", () => {
    expect(buildLocalNoteDigest("Opening line\n\nSecond paragraph").lead).toBe(
      "Opening line",
    );
  });

  it.each([
    ["blockquote", "> Quoted opening 😀"],
    ["bullet", "- Quoted opening 😀"],
    ["star bullet", "* Quoted opening 😀"],
    ["plus bullet", "+ Quoted opening 😀"],
  ])("strips a %s marker from the lead", (_label, body) => {
    expect(buildLocalNoteDigest(body).lead).toBe("Quoted opening 😀");
  });

  it("keeps a bullet character that does not open a list", () => {
    expect(buildLocalNoteDigest("-not a bullet 漢字").lead).toBe("-not a bullet 漢字");
  });

  it("reduces an image and an alias-less wiki link to their visible text", () => {
    expect(buildLocalNoteDigest("![図 😀](https://example.com/a.png) and [[漢字]].").lead).toBe(
      "図 😀 and 漢字.",
    );
  });

  it("keeps astral characters inside wiki-link aliases and inline-link labels", () => {
    expect(
      buildLocalNoteDigest("See [[Maps|地図 😀]] and [図表 𝐀](https://example.com).")
        .lead,
    ).toBe("See 地図 😀 and 図表 𝐀.");
  });
});

describe("notePreviewMetrics", () => {
  it("clamps the tight preview inside the graph without shrinking the canvas", () => {
    expect(notePreviewMetrics(240, 520)).toEqual({
      width: 198,
      height: 292,
      compact: true,
      tight: true,
      toolbarClearance: 132,
    });
  });

  it("uses the roomy treatment when the graph pane can support it", () => {
    expect(notePreviewMetrics(960, 640)).toEqual({
      width: 304,
      height: 432,
      compact: false,
      tight: false,
      toolbarClearance: 82,
    });
  });

  it("reserves the stacked toolbar at intermediate pane widths", () => {
    expect(notePreviewMetrics(700, 525)).toEqual({
      width: 260,
      height: 292,
      compact: true,
      tight: false,
      toolbarClearance: 132,
    });
  });
});

describe("notePreviewPlacement", () => {
  it("keeps an automatically placed bubble inside every canvas edge", () => {
    const metrics = notePreviewMetrics(240, 520);

    const placement = notePreviewPlacement({ x: 236, y: 510 }, metrics, 240, 520);

    expect(placement.bubbleX).toBe(24);
    expect(placement.bubbleY).toBeGreaterThanOrEqual(132);
    expect(placement.bubbleY + metrics.height).toBeLessThanOrEqual(506);
  });

  it.each([
    [700, 525],
    [429, 525],
    [240, 525],
  ])("keeps the selected star outside the bubble at %d×%d", (width, height) => {
    const metrics = notePreviewMetrics(width, height);
    const focusX = notePreviewFocusScreenX(width, metrics);
    expect(focusX).not.toBeNull();

    const placement = notePreviewPlacement(
      { x: focusX!, y: height / 2 },
      metrics,
      width,
      height,
    );

    expect(focusX).toBeLessThan(placement.bubbleX);
    expect(placement.tetherLength).toBeGreaterThanOrEqual(metrics.tight ? 14 : 48);
    expect(placement.bubbleX + metrics.width).toBeLessThanOrEqual(width - 14);
  });

  it("tolerates sub-pixel camera projection error at an exactly fitting edge", () => {
    const width = 429;
    const height = 525;
    const metrics = notePreviewMetrics(width, height);
    const intendedFocusX = notePreviewFocusScreenX(width, metrics)!;
    const projectedFocusX = intendedFocusX + 1e-9;

    const placement = notePreviewPlacement(
      { x: projectedFocusX, y: height / 2 },
      metrics,
      width,
      height,
    );

    expect(placement.bubbleX).toBeGreaterThan(projectedFocusX);
    expect(placement.tetherLength).toBeGreaterThanOrEqual(47.99);
  });

  it("clamps a dragged bubble while preserving its tether to the node", () => {
    const metrics = notePreviewMetrics(800, 600);
    const placement = notePreviewPlacement(
      { x: 400, y: 300 },
      metrics,
      800,
      600,
      { x: 9_999, y: -500 },
    );

    expect(placement.bubbleX).toBe(482);
    expect(placement.bubbleY).toBe(82);
    expect(placement.tetherLength).toBeGreaterThan(0);
  });
});
