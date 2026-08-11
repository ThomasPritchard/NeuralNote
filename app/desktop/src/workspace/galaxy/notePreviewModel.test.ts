import { describe, expect, it } from "vitest";
import {
  buildLocalNoteDigest,
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
