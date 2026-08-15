import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withPublishedParse } from "../test/publishedParse";
import * as previewModule from "./sourceEditorDecorationsPreview";
import { MAX_TABLE_PREVIEW_ROWS } from "./sourceEditorDecorationsPreview";
import {
  collectMarkdownPreview,
  safeCollectMarkdownPreview,
  sourceEditorDecorations,
  tableAtomicRanges,
  type PreviewDecoration,
} from "./sourceEditorDecorations";
import { tableModelAt } from "./sourceEditorTableModel";

/**
 * A state whose finished parse the syntax tree actually holds.
 *
 * Every collector below reads `syntaxTree(state)`, so a state left holding
 * whatever `LanguageState.init` reached inside its 20 ms wall-clock budget makes
 * the whole file report on an empty document — and it reports it as a
 * DECORATION MISSING, which is indistinguishable from the collector being
 * broken. Measured red: "plans live preview for the supported standard Markdown
 * constructs", once in 8 full-suite runs under 20 CPU burners. See
 * `src/test/publishedParse.ts`.
 *
 * The `describe("decorations after a deferred parse")` block at the foot of this
 * file is the deliberate exception and must NOT come through here: it asserts
 * `syntaxTreeAvailable(...) === false` and drives the parse itself, so it builds
 * its states through the unpublished `withDecorations` below.
 */
function state(doc: string, ranges: Array<{ anchor: number; head?: number }> = [{ anchor: doc.length }]) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: EditorSelection.create(
        ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head ?? anchor)),
      ),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      ],
    }),
    doc,
  );
}

const classes = (items: PreviewDecoration[]) => items.map((item) => item.className);

describe("sourceEditorDecorations", () => {
  it("plans live preview for the supported standard Markdown constructs", () => {
    const doc = [
      "# Heading",
      "",
      "*em* **strong** ~~strike~~ `code`",
      "- [ ] task",
      "1. ordered",
      "> quote",
      "---",
      "```ts",
      "code",
      "```",
      "[text](https://example.com) ![alt](https://example.com/a.png)",
      "| a | b |",
      "| - | - |",
      "| c | d |",
    ].join("\n");

    const preview = collectMarkdownPreview(state(doc));
    const found = new Set(classes(preview));

    expect(found).toEqual(
      expect.objectContaining(
        new Set([
          "nn-lp-heading-1",
          "nn-lp-emphasis",
          "nn-lp-strong",
          "nn-lp-strikethrough",
          "nn-lp-inline-code",
          "nn-lp-list-marker",
          "nn-lp-task",
          "nn-lp-blockquote",
          "nn-lp-thematic-break",
          "nn-lp-fenced-code",
          "nn-lp-link",
          "nn-lp-image",
          "nn-lp-table",
        ]),
      ),
    );
    expect(preview.some((item) => item.kind === "widget" && item.className === "nn-lp-image")).toBe(true);
  });

  it("applies heading typography to complete Setext headings", () => {
    const doc = "Primary\n=======\nSecondary\n---------";
    const found = new Set(classes(collectMarkdownPreview(state(doc))));
    expect(found).toContain("nn-lp-heading-1");
    expect(found).toContain("nn-lp-heading-2");
  });

  it("leaves Obsidian embeds to the dedicated inert embed preview", () => {
    const preview = collectMarkdownPreview(state("![[Secret note]]"));

    expect(preview.some((item) => item.className === "nn-lp-image")).toBe(false);
  });

  it("keeps complete bracketed alt text in an inert image label", () => {
    const preview = collectMarkdownPreview(state("![prefix [[Daily]] suffix](local.png)"));

    expect(preview).toContainEqual(expect.objectContaining({
      kind: "widget",
      className: "nn-lp-image",
      label: "Image: prefix [[Daily]] suffix",
    }));
  });

  it("replaces syntax markers only when their complete construct is outside every selection", () => {
    const doc = "# Heading\n\n*em* and **strong**";
    const headingCaret = state(doc, [{ anchor: 3 }, { anchor: doc.indexOf("strong") + 2 }]);
    const preview = collectMarkdownPreview(headingCaret);

    const headingMarker = preview.find((item) => item.from === 0 && item.to === 1);
    const emphasisMarker = preview.find(
      (item) => item.from === doc.indexOf("*em*") && item.to === doc.indexOf("*em*") + 1,
    );
    const strongMarker = preview.find(
      (item) => item.from === doc.indexOf("**strong**") && item.to === doc.indexOf("**strong**") + 2,
    );

    expect(headingMarker?.kind).toBe("mark");
    expect(emphasisMarker?.kind).toBe("replace");
    expect(strongMarker?.kind).toBe("mark");
  });

  it("hides an inactive autolink's angle brackets and reveals them for editing", () => {
    // `Autolink` belongs in `CONSTRUCT_NAMES` for the same reason every other
    // name there does. Without it `enclosingConstruct` climbs to the `Document`,
    // whose span holds the caret wherever the caret is, so the markers rendered
    // ACTIVE for ever — while `cellPaintPlan` and the read-only table widget
    // both dropped them.
    const doc = "See <https://example.org> for more";
    const open = doc.indexOf("<");

    expect(collectMarkdownPreview(state(doc, [{ anchor: 0 }])))
      .toContainEqual({ from: open, to: open + 1, kind: "replace", className: "nn-lp-marker" });
    expect(collectMarkdownPreview(state(doc, [{ anchor: open + 3 }])))
      .toContainEqual({ from: open, to: open + 1, kind: "mark", className: "nn-lp-marker-active" });
  });

  it("keeps heading markers visible while typing at the end of the active line", () => {
    const doc = "##";
    const preview = collectMarkdownPreview(state(doc, [{ anchor: doc.length }]));

    expect(preview).toContainEqual({
      from: 0,
      to: 2,
      kind: "mark",
      className: "nn-lp-marker-active",
    });
  });

  it("plans a semantic table widget while inactive and reveals exact source while active", () => {
    const doc = [
      "| Start date | Commitment |",
      "| --- | --- |",
      "| 2026-04-03 | DJ gig |",
    ].join("\n");

    expect(collectMarkdownPreview(state(doc))).toContainEqual(expect.objectContaining({
      from: 0,
      to: doc.length,
      kind: "widget",
      className: "nn-lp-table",
      table: {
        headers: ["Start date", "Commitment"],
        rows: [["2026-04-03", "DJ gig"]],
      },
    }));

    expect(collectMarkdownPreview(state(doc, [{ anchor: doc.indexOf("DJ gig") + 2 }]))).toContainEqual(
      expect.objectContaining({
        from: 0,
        to: doc.length,
        kind: "mark",
        className: "nn-lp-table-source",
      }),
    );
  });

  it("renders every table cell through the one cell-paint projection", () => {
    const doc = [
      "| Note |",
      "| --- |",
      "| **DJ gig** at the Bell |",
      "| [[Roadmap]] |",
      "| `soundcheck` |",
    ].join("\n");

    const table = collectMarkdownPreview(state(doc)).find((item) => item.table)?.table;

    // The widget and the drawn cell must show the same characters. A wikilink is
    // the case the widget used to get wrong on its own: it has no Markdown node,
    // so a second list of hidden node names never saw it.
    expect(table?.rows).toEqual([["DJ gig at the Bell"], ["Roadmap"], ["soundcheck"]]);
  });

  it("does not project a table's cells while the caret is inside it", () => {
    const doc = ["| a | b |", "| - | - |", "| **c** | d |"].join("\n");
    const editor = state(doc, [{ anchor: doc.indexOf("**c**") + 2 }]);
    const sliceDoc = vi.spyOn(editor, "sliceDoc");

    const preview = collectMarkdownPreview(editor);

    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-table-source" }));
    // The rendered widget is discarded for an active table, so reading any of
    // its interior is pure cost on the keystroke path.
    expect(sliceDoc.mock.calls.filter(([from = 0, to = doc.length]) => from > 0 && to < doc.length))
      .toEqual([]);
  });

  it("limits table preview work to the requested visible range", () => {
    const first = "| First | Value |\n| --- | --- |\n| one | 1 |";
    const second = "| Second | Value |\n| --- | --- |\n| two | 2 |";
    const doc = `${first}\n\n${"plain\n".repeat(2_000)}${second}`;
    const editor = state(doc);
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    const preview = collectMarkdownPreview(editor, [{ from: 0, to: first.length }]);
    const tables = preview.filter((item) => item.table);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.table?.headers).toEqual(["First", "Value"]);
  });

  it("keeps an oversized table as editable source instead of building an unbounded widget", () => {
    const doc = [
      "| Key | Value |",
      "| --- | --- |",
      ...Array.from({ length: 250 }, (_, index) => `| ${index} | ${"x".repeat(160)} |`),
    ].join("\n");
    const preview = collectMarkdownPreview(state(doc), [{ from: 0, to: 100 }]);

    expect(preview.some((item) => item.table)).toBe(false);
    expect(preview).toContainEqual(expect.objectContaining({
      from: 0,
      to: doc.length,
      kind: "mark",
      className: "nn-lp-table-source",
    }));
  });

  it("hides an inactive Markdown destination and reveals it for source editing", () => {
    const doc = "before [Azure Account](Azure%20Account.md) after";
    const linkTo = doc.indexOf(")") + 1;
    const inactive = collectMarkdownPreview(state(doc, [{ anchor: 0 }]));
    const urlFrom = doc.indexOf("Azure%20");
    expect(inactive).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
      kind: "replace",
    }));

    const active = collectMarkdownPreview(state(doc, [{ anchor: urlFrom + 2 }]));
    expect(active).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
      kind: "mark",
      className: "nn-lp-marker-active",
    }));

    const adjacent = collectMarkdownPreview(state(doc, [{ anchor: linkTo }]));
    expect(adjacent).toContainEqual(expect.objectContaining({
      from: urlFrom,
      to: linkTo - 1,
      kind: "mark",
      className: "nn-lp-marker-active",
    }));
  });

  it("renders inactive task markers as accessible, source-backed checkbox widgets", () => {
    const doc = "- [ ] open\n- [x] done";
    const preview = collectMarkdownPreview(state(doc));
    const tasks = preview.filter((item) => item.className.startsWith("nn-lp-task"));

    expect(tasks).toEqual([
      expect.objectContaining({ kind: "widget", checked: false, label: "Mark task complete" }),
      expect.objectContaining({ kind: "widget", checked: true, label: "Mark task incomplete" }),
    ]);
  });

  it("keeps malformed and partially typed constructs literal", () => {
    const doc = "#unterminated *em and [link and ```";
    const preview = collectMarkdownPreview(state(doc));

    expect(preview.every((item) => item.kind !== "replace" && item.kind !== "widget")).toBe(true);
  });

  it("builds only inside the requested visible range", () => {
    const doc = `${"plain\n".repeat(200)}# Visible\n${"tail\n".repeat(200)}`;
    const from = doc.indexOf("# Visible");
    const preview = collectMarkdownPreview(state(doc), [{ from, to: from + 10 }]);

    expect(preview.length).toBeGreaterThan(0);
    expect(preview.every((item) => item.from >= from && item.to <= from + 10)).toBe(true);
  });

  it("does not copy the complete document to decorate tasks and images", () => {
    const editor = state("- [ ] task ![alt](local.png)");
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    const preview = collectMarkdownPreview(editor, [{ from: 0, to: editor.doc.length }]);
    expect(classes(preview)).toEqual(expect.arrayContaining(["nn-lp-task", "nn-lp-image"]));
  });

  it("turns decoration failures into undecorated editable source", () => {
    const result = safeCollectMarkdownPreview(state("# source"), undefined, () => {
      throw new Error("parser failed");
    });

    expect(result.decorations).toEqual([]);
    expect(result.error).toBe("Live preview is temporarily unavailable. Your source is unchanged.");
  });

  it("reports a table-decoration failure through the preview error callback", async () => {
    const originalSafeCollect = previewModule.safeCollectMarkdownPreview;
    const collect = vi.spyOn(previewModule, "safeCollectMarkdownPreview");
    collect
      .mockReturnValueOnce({
        decorations: [],
        error: "Live preview is temporarily unavailable. Your source is unchanged.",
      })
      .mockImplementation(originalSafeCollect);
    const onError = vi.fn();
    const view = new EditorView({
      state: EditorState.create({
        doc: "| A |\n| - |\n| B |",
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          sourceEditorDecorations(onError),
        ],
      }),
      parent: document.body,
    });

    try {
      await Promise.resolve();

      expect(onError).toHaveBeenCalledWith(
        "Live preview is temporarily unavailable. Your source is unchanged.",
      );

      view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
      await Promise.resolve();

      expect(onError).toHaveBeenLastCalledWith(null);
    } finally {
      view.destroy();
      collect.mockRestore();
    }
  });

  it("recomputes a retained table error before reporting to reconfigured callbacks", () => {
    const originalSafeCollect = previewModule.safeCollectMarkdownPreview;
    const collect = vi.spyOn(previewModule, "safeCollectMarkdownPreview");
    collect
      .mockReturnValueOnce({
        decorations: [],
        error: "Live preview is temporarily unavailable. Your source is unchanged.",
      })
      .mockImplementation(originalSafeCollect);
    const firstOnError = vi.fn();
    const view = new EditorView({
      state: EditorState.create({
        doc: "| A |\n| - |\n| B |",
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          sourceEditorDecorations(firstOnError),
        ],
      }),
      parent: document.body,
    });

    try {
      const nextOnError = vi.fn();
      view.dispatch({
        effects: StateEffect.reconfigure.of([
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          sourceEditorDecorations(nextOnError),
        ]),
      });

      expect(nextOnError).not.toHaveBeenCalledWith(
        "Live preview is temporarily unavailable. Your source is unchanged.",
      );
      expect(nextOnError).toHaveBeenLastCalledWith(null);
    } finally {
      view.destroy();
      collect.mockRestore();
    }
  });
});


const FIRST_TABLE = ["| aa | bb |", "| --- | --- |", "| cc | dd |"].join("\n");
const SECOND_TABLE = ["| ee | ff |", "| --- | --- |", "| gg | hh |"].join("\n");
const TWO_TABLES = `${FIRST_TABLE}\n\nbetween\n\n${SECOND_TABLE}`;

function spans(set: DecorationSet): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    found.push({ from: cursor.from, to: cursor.to });
  }
  return found;
}

describe("tableAtomicRanges", () => {
  it("covers every table in the visible ranges, not only the one holding the caret", () => {
    // It used to derive its single table from `state.selection.main.head`, so a
    // second table on screen was left unprotected.
    const editor = state(TWO_TABLES, [{ anchor: 3 }]);
    const secondFrom = TWO_TABLES.indexOf(SECOND_TABLE);
    const found = spans(tableAtomicRanges(editor, [{ from: 0, to: TWO_TABLES.length }]));

    expect(found.some((span) => span.to <= FIRST_TABLE.length)).toBe(true);
    expect(found.some((span) => span.from >= secondFrom)).toBe(true);
    expect(found.every((span) => span.to > span.from)).toBe(true);
  });

  it("marks nothing for an oversized table, whose pipes are still painted", () => {
    // The visual path bails above the preview bounds and leaves the source
    // literal. Making visible pipes atomic would stop the caret on characters
    // the user can see.
    //
    // Sized off the constant, not off a literal. `tablePreview` still renders a
    // table with exactly MAX_TABLE_PREVIEW_ROWS body rows — it tests the count
    // BEFORE pushing each row — so a literal 200 named a table that IS drawn,
    // and this test only passed while `drawsCellChrome` was a row out of step
    // with the preview it claims to match.
    const oversized = [
      "| Key | Value |",
      "| --- | --- |",
      ...Array.from(
        { length: MAX_TABLE_PREVIEW_ROWS + 1 },
        (_, index) => `| k${index} | v${index} |`,
      ),
    ].join("\n");
    const editor = state(oversized);
    // The premise, asserted rather than trusted. `LanguageState.init` parses
    // only `Work.InitViewport` (3,000) characters and abandons even that after
    // 20 ms of WALL CLOCK, and this fixture is a shade past 3,000 — so on a busy
    // machine the tree can hold no `Table` node at all, `tableStarts` finds
    // nothing, and the assertion below passes against an empty document.
    const bodyRows = tableModelAt(editor, 0)?.rows.filter((row) => row.kind === "body");

    expect(bodyRows).toHaveLength(MAX_TABLE_PREVIEW_ROWS + 1);
    expect(spans(tableAtomicRanges(editor, [{ from: 0, to: oversized.length }]))).toEqual([]);
  });

  it("marks nothing when no range is visible", () => {
    expect(spans(tableAtomicRanges(state(FIRST_TABLE), []))).toEqual([]);
  });
});

/**
 * Deliberately UNPUBLISHED, unlike `state` above: the deferred-parse block at
 * the foot of this file mounts through it and asserts that the tree has NOT
 * reached the table yet, so publishing here would delete the very condition
 * those tests reproduce.
 */
const withDecorations = (doc: string) => EditorState.create({
  doc,
  extensions: [
    markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    sourceEditorDecorations(() => {}),
  ],
});

/**
 * The same extensions, with the parse published — for the two tests below, which
 * ask what the composed extension array REGISTERS and need the table to be found
 * for either answer to mean anything.
 */
const withParsedDecorations = (doc: string) => withPublishedParse(withDecorations(doc), doc);

describe("sourceEditorDecorations extensions", () => {
  it("registers the delimiter guard, so the editor component needs no wiring", () => {
    // The array returned here is already consumed at SourceNoteEditor.tsx:139.
    // Registering the filter alongside the decorations is what makes the
    // refusal reach the running editor without touching the component.
    const editor = withParsedDecorations(FIRST_TABLE);
    const gap = { from: FIRST_TABLE.indexOf("aa") + 2, to: FIRST_TABLE.indexOf("bb") };
    const transaction = editor.update({ changes: { from: gap.from, to: gap.to } });

    expect(transaction.effects.some((effect) => effect.is(EditorView.announce))).toBe(true);
    expect(transaction.state.doc.toString()).toBe(FIRST_TABLE);
  });

  it("registers an atomic-ranges provider that reads the live viewport", () => {
    const editor = withParsedDecorations(TWO_TABLES);
    const providers = editor.facet(EditorView.atomicRanges);
    expect(providers).toHaveLength(1);

    const viewport = { state: editor, visibleRanges: [{ from: 0, to: TWO_TABLES.length }] };
    expect(spans(providers[0]!(viewport as unknown as EditorView)).length).toBeGreaterThan(0);
  });
});

// A note whose table sits beyond the parser's first slice. `LanguageState.init`
// parses only to `Work.InitViewport` (3,000 chars) and gives up after
// `Work.Apply` (20 ms of wall clock), so on open the tree genuinely has no
// `Table` node here — CodeMirror finishes the parse afterwards, on an idle
// callback (`@codemirror/language/dist/index.js:540-545, 601-624`).
const DEFERRED_PARSE_TABLE = ["| aa | bb |", "| --- | --- |", "| cc | dd |"].join("\n");
const DEFERRED_PARSE_NOTE = `${"word ".repeat(600)}\n\n${DEFERRED_PARSE_TABLE}`;

const mounted: EditorView[] = [];

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

function mountWithDecorations(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ state: withDecorations(doc), parent: host });
  mounted.push(view);
  return view;
}

const drawnTables = (view: EditorView) => view.dom.querySelectorAll("table.nn-lp-table").length;

const hasTableNode = (parsed: EditorState): boolean => {
  let found = false;
  syntaxTree(parsed).iterate({ enter: (node) => { if (node.name === "Table") found = true; } });
  return found;
};

describe("decorations after a deferred parse", () => {
  it("has no table to draw while the parser has not reached one", () => {
    // The premise the next two tests rest on. Without this the fixture could
    // stop reproducing the deferred parse — the table would be in the first
    // slice — and they would pass while proving nothing.
    const view = mountWithDecorations(DEFERRED_PARSE_NOTE);

    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    expect(hasTableNode(view.state)).toBe(false);
    expect(drawnTables(view)).toBe(0);
  });

  it("draws the table once the parse completes, with no edit and no caret move", () => {
    // `forceParsing` finishes the parse and announces it with a transaction that
    // carries no change, no selection and no effect — the same shape the idle
    // `ParseWorker` uses. A field that keys only on those inputs keeps its stale
    // answer and the table never appears.
    const view = mountWithDecorations(DEFERRED_PARSE_NOTE);
    expect(drawnTables(view)).toBe(0);

    forceParsing(view, view.state.doc.length, 5_000);

    expect(hasTableNode(view.state)).toBe(true);
    expect(drawnTables(view)).toBe(1);
  });

  it("paints inline preview past the first slice once the parse completes", () => {
    // The same staleness, one layer up: the preview plugin keys on the same
    // inputs, so every heading, emphasis and wikilink past the first slice stays
    // literal too. Fixing only the table would leave the note half-painted.
    const note = `${"word ".repeat(600)}\n\n**strong text**`;
    const view = mountWithDecorations(note);
    expect(view.dom.querySelectorAll(".nn-lp-strong")).toHaveLength(0);

    forceParsing(view, view.state.doc.length, 5_000);

    expect(view.dom.querySelectorAll(".nn-lp-strong")).toHaveLength(1);
  });

  it("draws it from CodeMirror's own idle parse worker too", async () => {
    // The journey through the real seam: no test-only parse driver, just the
    // worker CodeMirror schedules for itself. Polled rather than slept on, so a
    // busy machine makes this slower and never wrong.
    const view = mountWithDecorations(DEFERRED_PARSE_NOTE);

    for (let poll = 0; poll < 100 && !hasTableNode(view.state); poll += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }

    expect(hasTableNode(view.state)).toBe(true);
    expect(drawnTables(view)).toBe(1);
  });
});

