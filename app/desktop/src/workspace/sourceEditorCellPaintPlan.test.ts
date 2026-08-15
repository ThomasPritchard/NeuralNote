import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { withPublishedParse } from "../test/publishedParse";
import type { NoteIndexEntry } from "./linkResolve";
import { collectObsidianPreview } from "./obsidianLivePreview";
import {
  CELL_MARK_CLASS_BY_NODE,
  cellPaintPlan,
  type CellPaintContext,
  type CellPaintPlan,
} from "./sourceEditorCellPaintPlan";
import { collectMarkdownPreview } from "./sourceEditorDecorationsPreview";
import { TABLE_CONTRACT_FIXTURE } from "./sourceEditorTableContractFixture";
import { tableModelAt } from "./sourceEditorTableModel";

const INDEX: NoteIndexEntry[] = [{ relPath: "Roadmap.md", stem: "roadmap" }];

// `cellPaintPlan` is entirely a reading of `syntaxTree(state)`: no `Emphasis`
// node in the tree means no marker is hidden and `visibleText` comes back as the
// raw source. A state built but never republished can hold a truncated tree, so
// every plan below goes through the shared publisher — see
// `src/test/publishedParse.ts`. Measured red: "hides an escape's backslash and
// paints the character it protects", at 20 CPU burners.
function editorState(doc: string, anchor = 0) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false })],
    }),
    doc,
  );
}

/** The span of `cellText` inside `doc`, as the table model would report it. */
function cellRange(doc: string, cellText: string) {
  const from = doc.indexOf(cellText);
  if (from < 0) throw new Error(`fixture does not contain ${JSON.stringify(cellText)}`);
  return { from, to: from + cellText.length };
}

/**
 * Plan the cell whose source is `cellText`, inside a one-row table preceded by a
 * paragraph so offset 0 is outside every construct in it.
 */
function planFor(
  cellText: string,
  options: { anchorOn?: string; anchorOffset?: number; context?: CellPaintContext } = {},
): { plan: CellPaintPlan; doc: string; cell: { from: number; to: number } } {
  const doc = ["lead", "", "| Header |", "| --- |", `| ${cellText} |`].join("\n");
  const cell = cellRange(doc, cellText);
  const anchor = options.anchorOn === undefined
    ? 0
    : doc.indexOf(options.anchorOn) + (options.anchorOffset ?? 0);
  const plan = cellPaintPlan(editorState(doc, anchor), cell, {
    context: options.context ?? "body",
  });
  return { plan, doc, cell };
}

const runShape = (plan: CellPaintPlan) =>
  plan.runs.map((run) => ({ kind: run.kind, text: run.text, classNames: run.classNames }));

describe("cellPaintPlan", () => {
  it("paints plain text as one unstyled run and hides nothing", () => {
    const { plan, cell } = planFor("Start date");

    expect(plan.visibleText).toBe("Start date");
    expect(runShape(plan)).toEqual([{ kind: "text", text: "Start date", classNames: [] }]);
    expect(plan.hiddenRanges).toEqual([]);
    expect(plan.runs[0]).toMatchObject({ from: cell.from, to: cell.to });
  });

  it("hides strong emphasis markers and marks only the text between them", () => {
    const { plan, doc } = planFor("**DJ gig** at the Bell");

    expect(plan.visibleText).toBe("DJ gig at the Bell");
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "DJ gig", classNames: ["nn-lp-strong"] },
      { kind: "text", text: " at the Bell", classNames: [] },
    ]);
    const openFrom = doc.indexOf("**DJ");
    expect(plan.hiddenRanges).toEqual([
      { from: openFrom, to: openFrom + 2 },
      { from: openFrom + 8, to: openFrom + 10 },
    ]);
  });

  it("hides emphasis, strikethrough and inline-code markers with their own classes", () => {
    expect(runShape(planFor("*soft*").plan)).toEqual([
      { kind: "text", text: "soft", classNames: ["nn-lp-emphasis"] },
    ]);
    expect(runShape(planFor("~~gone~~").plan)).toEqual([
      { kind: "text", text: "gone", classNames: ["nn-lp-strikethrough"] },
    ]);
    expect(runShape(planFor("`soundcheck`").plan)).toEqual([
      { kind: "text", text: "soundcheck", classNames: ["nn-lp-inline-code"] },
    ]);
  });

  it("hides a Markdown link's brackets and destination, painting only its text", () => {
    const { plan } = planFor("[Docs](https://example.com)");

    expect(plan.visibleText).toBe("Docs");
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "Docs", classNames: ["nn-lp-link"] },
    ]);
  });

  it("nests mark classes outermost first", () => {
    const { plan } = planFor("**bold `code` tail**");

    expect(plan.visibleText).toBe("bold code tail");
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "bold ", classNames: ["nn-lp-strong"] },
      { kind: "text", text: "code", classNames: ["nn-lp-strong", "nn-lp-inline-code"] },
      { kind: "text", text: " tail", classNames: ["nn-lp-strong"] },
    ]);
  });

  it("marks an Obsidian tag without hiding any of its characters", () => {
    const { plan } = planFor("due #soon");

    expect(plan.visibleText).toBe("due #soon");
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "due ", classNames: [] },
      { kind: "text", text: "#soon", classNames: ["nn-lp-tag"] },
    ]);
  });

  it("does not read a hash that is not on a word boundary as a tag", () => {
    expect(runShape(planFor("issue#soon").plan)).toEqual([
      { kind: "text", text: "issue#soon", classNames: [] },
    ]);
  });

  it("leaves a tag inside inline code as ordinary code text", () => {
    // The hash must be preceded by whitespace or the scanner rejects it on the
    // word-boundary rule above and never reaches the masking branch this test
    // names — `` `#soon` `` passes whether or not masking works at all.
    const { plan } = planFor("`code #soon`");

    expect(runShape(plan)).toEqual([
      { kind: "text", text: "code #soon", classNames: ["nn-lp-inline-code"] },
    ]);
  });

  it("hides an escape's backslash and paints the character it protects", () => {
    // GFM reads `\|` in a table cell as a literal pipe rather than a column
    // break, and the `Escape` node spans BOTH characters — so hiding it whole
    // would drop the very character the escape exists to produce.
    const { plan, doc } = planFor("a \\| b");

    expect(plan.visibleText).toBe("a | b");
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "a ", classNames: [] },
      { kind: "text", text: "| b", classNames: [] },
    ]);
    const backslash = doc.indexOf("\\|");
    expect(plan.hiddenRanges).toEqual([{ from: backslash, to: backslash + 1 }]);
  });

  it("leaves an escape inside inline code as literal source", () => {
    // Nothing is inline-parsed inside a code span, so there is no `Escape` node
    // to hide and the backslash is content the user typed.
    expect(runShape(planFor("`a \\| b`").plan)).toEqual([
      { kind: "text", text: "a \\| b", classNames: ["nn-lp-inline-code"] },
    ]);
  });

  it("leaves a tag inside a revealed wikilink unmarked", () => {
    const { plan } = planFor("[[Roadmap #soon]]", { anchorOn: "Roadmap #soon", anchorOffset: 2 });

    expect(plan.visibleText).toBe("[[Roadmap #soon]]");
    expect(plan.runs.flatMap((run) => run.classNames)).not.toContain("nn-lp-tag");
  });

  it("reveals a construct's markers while the caret is inside it", () => {
    const { plan } = planFor("**DJ gig** at the Bell", { anchorOn: "DJ gig", anchorOffset: 2 });

    expect(plan.visibleText).toBe("**DJ gig** at the Bell");
    expect(plan.hiddenRanges).toEqual([]);
    // A revealed marker is painted, not dropped, and `nn-lp-marker-active` puts
    // it in the monospace face — so it measures differently from the text it
    // wraps, and the plan has to say so.
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "**", classNames: ["nn-lp-strong", "nn-lp-marker-active"] },
      { kind: "text", text: "DJ gig", classNames: ["nn-lp-strong"] },
      { kind: "text", text: "**", classNames: ["nn-lp-strong", "nn-lp-marker-active"] },
      { kind: "text", text: " at the Bell", classNames: [] },
    ]);
  });

  it("joins revealed markers that abut into one run rather than fragmenting them", () => {
    const { plan } = planFor("[Docs](https://example.com)", { anchorOn: "Docs", anchorOffset: 1 });

    expect(plan.visibleText).toBe("[Docs](https://example.com)");
    // `]` and `(` are two separate LinkMark nodes carrying identical classes.
    // Left unmerged they measure as two runs, and a run boundary is a place a
    // measurement can round twice.
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "[", classNames: ["nn-lp-link", "nn-lp-marker-active"] },
      { kind: "text", text: "Docs", classNames: ["nn-lp-link"] },
      {
        kind: "text",
        text: "](https://example.com)",
        classNames: ["nn-lp-link", "nn-lp-marker-active"],
      },
    ]);
  });

  it("keeps a neighbouring construct's markers hidden when the caret is in another", () => {
    const { plan } = planFor("**one** *two*", { anchorOn: "one", anchorOffset: 1 });

    expect(plan.visibleText).toBe("**one** two");
  });

  it("plans an empty cell as nothing painted and nothing hidden", () => {
    const doc = ["| Header |", "| --- |", "|  |"].join("\n");
    const from = doc.lastIndexOf("|  |") + 2;
    const plan = cellPaintPlan(editorState(doc), { from, to: from }, { context: "body" });

    expect(plan.visibleText).toBe("");
    expect(plan.runs).toEqual([]);
    expect(plan.hiddenRanges).toEqual([]);
  });

  it("records the header or body context it was asked for", () => {
    expect(planFor("Notes", { context: "header" }).plan.context).toBe("header");
    expect(planFor("Notes", { context: "body" }).plan.context).toBe("body");
  });

  it("tiles the cell exactly: every source position is painted, replaced or hidden", () => {
    const { plan, cell } = planFor("**DJ gig** at [Docs](https://example.com) #soon");

    const spans = [
      ...plan.runs.map((run) => ({ from: run.from, to: run.to })),
      ...plan.hiddenRanges,
    ].sort((left, right) => left.from - right.from);

    expect(spans[0]?.from).toBe(cell.from);
    expect(spans.at(-1)?.to).toBe(cell.to);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.from).toBe(spans[index - 1]!.to);
    }
  });
});

describe("cellPaintPlan signature", () => {
  it("is identical for the same cell at a different source offset", () => {
    const near = ["| Header |", "| --- |", "| **DJ gig** at the Bell |"].join("\n");
    const far = [
      "filler paragraph",
      "",
      "| Header |",
      "| --- |",
      "| **DJ gig** at the Bell |",
    ].join("\n");
    const cellText = "**DJ gig** at the Bell";

    const nearPlan = cellPaintPlan(editorState(near), cellRange(near, cellText), { context: "body" });
    const farPlan = cellPaintPlan(editorState(far), cellRange(far, cellText), { context: "body" });

    expect(nearPlan.runs[0]?.from).not.toBe(farPlan.runs[0]?.from);
    expect(nearPlan.signature).toBe(farPlan.signature);
  });

  it("separates a header cell from a body cell with the same text", () => {
    expect(planFor("Notes", { context: "header" }).plan.signature)
      .not.toBe(planFor("Notes", { context: "body" }).plan.signature);
  });

  it("separates cells whose painted text matches but whose marks differ", () => {
    const strong = planFor("**same**").plan;
    const emphasis = planFor("*same*").plan;

    expect(strong.visibleText).toBe(emphasis.visibleText);
    expect(strong.signature).not.toBe(emphasis.signature);
  });

  it("separates cells whose marks match but whose painted text differs", () => {
    expect(planFor("**one**").plan.signature).not.toBe(planFor("**two**").plan.signature);
  });
});

describe("cellPaintPlan widget-backed content", () => {
  it("paints a wikilink as its label and hides none of the source it stands for", () => {
    const { plan, doc } = planFor("[[Roadmap]]");

    expect(plan.visibleText).toBe("Roadmap");
    expect(runShape(plan)).toEqual([
      { kind: "widget", text: "Roadmap", classNames: ["nn-lp-wikilink-unresolved"] },
    ]);
    const from = doc.indexOf("[[Roadmap]]");
    expect(plan.runs[0]).toMatchObject({ from, to: from + "[[Roadmap]]".length });
    expect(plan.hiddenRanges).toEqual([]);
  });

  it("paints a wikilink's alias, and its resolved class when the vault has the note", () => {
    const doc = ["| Header |", "| --- |", "| [[Roadmap#Q3|later]] |"].join("\n");
    const plan = cellPaintPlan(editorState(doc), cellRange(doc, "[[Roadmap#Q3|later]]"), {
      context: "body",
      index: INDEX,
    });

    expect(plan.visibleText).toBe("later");
    expect(plan.runs[0]?.classNames).toEqual(["nn-lp-wikilink-resolved"]);
  });

  it("paints an embed with its own class and prefix", () => {
    expect(runShape(planFor("![[Roadmap]]").plan)).toEqual([
      { kind: "widget", text: "Embed: Roadmap", classNames: ["nn-lp-embed"] },
    ]);
  });

  it("reveals a wikilink's source while the caret touches it", () => {
    const { plan } = planFor("[[Roadmap]]", { anchorOn: "Roadmap]]", anchorOffset: 2 });

    expect(plan.visibleText).toBe("[[Roadmap]]");
    // A revealed wikilink is a MARK, so it composes rather than replaces — and
    // the Markdown tree reads the inner `[Roadmap]` as a Link, which the preview
    // collector paints too. The plan reports the composition because that is
    // what the screen shows; it is not this module's place to overrule it.
    expect(runShape(plan)).toEqual([
      { kind: "text", text: "[", classNames: ["nn-lp-wikilink-active"] },
      {
        kind: "text",
        text: "[",
        classNames: ["nn-lp-wikilink-active", "nn-lp-link", "nn-lp-marker-active"],
      },
      { kind: "text", text: "Roadmap", classNames: ["nn-lp-wikilink-active", "nn-lp-link"] },
      {
        kind: "text",
        text: "]",
        classNames: ["nn-lp-wikilink-active", "nn-lp-link", "nn-lp-marker-active"],
      },
      { kind: "text", text: "]", classNames: ["nn-lp-wikilink-active"] },
    ]);
  });

  it("keeps a wikilink's widget while the editor is unfocused, caret or not", () => {
    const doc = ["| Header |", "| --- |", "| [[Roadmap]] |"].join("\n");
    const caretInside = doc.indexOf("Roadmap") + 2;
    const plan = cellPaintPlan(editorState(doc, caretInside), cellRange(doc, "[[Roadmap]]"), {
      context: "body",
      selectionActive: false,
    });

    expect(plan.visibleText).toBe("Roadmap");
    expect(plan.runs[0]?.kind).toBe("widget");
  });

  it("leaves a wikilink inside inline code as literal code text", () => {
    expect(planFor("`[[Roadmap]]`").plan.visibleText).toBe("[[Roadmap]]");
  });

  it("paints an inactive image as its drawn label", () => {
    const { plan } = planFor("![diagram](a.png)");

    expect(plan.visibleText).toBe("Image: diagram");
    expect(runShape(plan)).toEqual([
      { kind: "widget", text: "Image: diagram", classNames: ["nn-lp-image"] },
    ]);
  });

  it("keeps nested brackets whole in an image's drawn label", () => {
    // Matching the first `]` cut the label short, so the column was sized to a
    // label the screen never showed. Deliberately NOT a `[[wikilink]]` in the
    // alt text: a drawn wikilink replaces the image widget outright, so that
    // fixture would pass whether the bracket counting works or not.
    const { plan } = planFor("![prefix [Daily] suffix](a.png)");

    expect(plan.visibleText).toBe("Image: prefix [Daily] suffix");
  });

  it("reveals an image's source while the caret is inside it", () => {
    const { plan } = planFor("![diagram](a.png)", { anchorOn: "diagram", anchorOffset: 2 });

    expect(plan.visibleText).toBe("![diagram](a.png)");
  });
});

/**
 * What the paint layer renders for `[from, to)`, read off the decorations the two
 * collectors emit. Deliberately an INDEPENDENT reading of the same question: it
 * shares no code with the plan, so it goes red if either side drifts.
 */
function paintedText(
  state: ReturnType<typeof editorState>,
  from: number,
  to: number,
  index: NoteIndexEntry[],
): string {
  const hiding = [
    ...collectMarkdownPreview(state),
    ...collectObsidianPreview(state, index),
  ]
    .filter((item) => item.from >= from && item.to <= to)
    .filter((item) => item.kind === "replace" || item.kind === "widget")
    .sort((left, right) => left.from - right.from);

  let text = "";
  let position = from;
  for (const item of hiding) {
    if (item.from < position) continue;
    text += state.sliceDoc(position, item.from);
    if (item.kind === "widget") text += item.label ?? "";
    position = item.to;
  }
  return text + state.sliceDoc(position, to);
}

describe("cellPaintPlan agreement with the paint layer", () => {
  it("renders the same characters the decoration collectors do", () => {
    const content = "**bold** `code` [[Roadmap]] #soon";
    const paragraphDoc = ["lead", "", content, ""].join("\n");
    const paragraph = editorState(paragraphDoc, 0);
    const from = paragraphDoc.indexOf(content);
    const oracle = paintedText(paragraph, from, from + content.length, INDEX);

    // Pinned literally too: an oracle that silently returned the raw source
    // would agree with a plan that did nothing.
    expect(oracle).toBe("bold code Roadmap #soon");
    expect(planFor(content).plan.visibleText).toBe(oracle);
  });

  it("labels each construct with the class the preview collector paints over it", () => {
    const sourceByNode: Record<string, string> = {
      Emphasis: "*em*",
      StrongEmphasis: "**strong**",
      Strikethrough: "~~strike~~",
      InlineCode: "`code`",
      Link: "[text](https://example.com)",
    };

    for (const [node, className] of CELL_MARK_CLASS_BY_NODE) {
      const source = sourceByNode[node];
      expect(source, `no probe source for ${node}`).toBeDefined();
      const doc = ["lead", "", source!, ""].join("\n");
      const from = doc.indexOf(source!);
      const mark = collectMarkdownPreview(editorState(doc, 0)).find((item) =>
        item.kind === "mark" && item.from === from && item.to === from + source!.length);

      expect(mark?.className, `class for ${node}`).toBe(className);
    }
  });
});

describe("cellPaintPlan agreement with the CT-1 golden fixture", () => {
  it("reproduces every drawn cell's text in the committed contract", () => {
    let compared = 0;

    for (const table of TABLE_CONTRACT_FIXTURE) {
      const state = editorState(table.source);
      const model = tableModelAt(state, 0);
      expect(model, `no model for ${table.name}`).not.toBeNull();

      const contentRows = table.rows.filter((row) => row.kind !== "delimiter");
      const modelRows = model!.rows.filter((row) => row.kind !== "delimiter");
      expect(contentRows).toHaveLength(modelRows.length);

      contentRows.forEach((contractRow, rowIndex) => {
        const declared = contractRow.children.filter((child) =>
          child.className.startsWith("nn-lp-cell")
          && !child.className.includes("chrome")
          && !child.className.includes("filler"));
        const slots = modelRows[rowIndex]!.slots;
        expect(declared, `${table.name} row ${rowIndex}`).toHaveLength(slots.length);

        slots.forEach((slot, column) => {
          const plan = cellPaintPlan(state, { from: slot.from, to: slot.to }, {
            context: contractRow.kind === "header" ? "header" : "body",
          });
          expect(plan.visibleText, `${table.name} row ${rowIndex} column ${column}`)
            .toBe(declared[column]!.text);
          compared += 1;
        });
      });
    }

    // A fixture walk that reached no cell would pass silently. 3 header + 3 + 3
    // body for full-topology, 2 for one-row, 3 header + 2 declared for ragged.
    expect(compared).toBe(16);
  });
});
