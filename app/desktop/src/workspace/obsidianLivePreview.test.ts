import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import type { NoteIndexEntry } from "./linkResolve";
import {
  collectObsidianPreview,
  obsidianLivePreview,
  openTagSearchAtCaret,
} from "./obsidianLivePreview";
import { cellPaintPlan, TAG_MASKED_NODES } from "./sourceEditorCellPaintPlan";

const INDEX: NoteIndexEntry[] = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
];

const EXTENSIONS = [markdown({ base: markdownLanguage, completeHTMLTags: false })];

/** Generous: a fixture parse needs microseconds, and only a stalled machine needs the rest. */
const PARSE_BUDGET_MS = 10_000;

/**
 * A fixture whose syntax tree covers the whole document.
 *
 * CodeMirror bounds its initial parse twice over — to the document's first 3 KB,
 * and to 20 ms of *wall-clock* work — then hands back whatever tree it reached.
 * A machine running the rest of the suite in parallel can lose that race, so a
 * fixture built with `EditorState.create` alone measures the scheduler as much
 * as the masking rule, which is what made this file fail one run in three
 * (issue #129). Forcing the parse removes that input; the partial-tree
 * behaviour is exercised deliberately below rather than arriving at random.
 */
function state(doc: string, anchor = doc.length): EditorState {
  const created = EditorState.create({ doc, selection: { anchor }, extensions: EXTENSIONS });
  if (!ensureSyntaxTree(created, created.doc.length, PARSE_BUDGET_MS)) {
    throw new Error(`fixture parse did not finish within ${PARSE_BUDGET_MS}ms`);
  }
  // `ensureSyntaxTree` advances the parse context, but `syntaxTree` reads the
  // snapshot taken when the state field was built. Only a fresh transaction
  // re-snapshots it, so without this the forced work stays invisible.
  const parsed = created.update({}).state;
  if (syntaxTree(parsed).length < parsed.doc.length) {
    throw new Error("forced parse did not reach the end of the fixture");
  }
  return parsed;
}

/**
 * A fixture whose syntax tree stops short of the end, which is the condition the
 * masking has to survive. Asserted rather than assumed: a fixture that parsed
 * completely would exercise nothing and pass for the wrong reason.
 *
 * The caret defaults to the document start, where `EditorState.create` puts it
 * anyway; the keyboard fixtures below place it deliberately.
 */
function partiallyParsedState(
  doc: string,
  extensions: Extension = EXTENSIONS,
  anchor = 0,
): EditorState {
  const created = EditorState.create({ doc, selection: { anchor }, extensions });
  if (syntaxTree(created).length >= created.doc.length) {
    throw new Error("fixture parsed completely, so it cannot exercise a partial tree");
  }
  return created;
}

/** Comfortably past the 20 ms the initial parse is given. */
const BUDGET_OVERRUN_MS = 50;

/**
 * The reported flake, on demand: the initial parse measures its 20 ms budget
 * with `Date.now`, so a process descheduled mid-parse keeps only the tree it had
 * reached. A clock that outruns the budget reproduces that every run.
 */
function budgetExhaustedState(doc: string, extensions: Extension = EXTENSIONS): EditorState {
  return withExhaustedParseBudget(() => partiallyParsedState(doc, extensions));
}

/**
 * Runs `body` with the parse budget already spent, by the same means: a clock
 * that outruns any deadline measured against it.
 *
 * `budgetExhaustedState` needs that only while the state field is built.
 * `decorationAtCaret` spends its budget inside the keystroke instead, so a note
 * too large to parse in 20 ms is reproduced by holding the clock across the
 * event rather than across construction.
 */
function withExhaustedParseBudget<T>(body: () => T): T {
  let clock = Date.now();
  const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += BUDGET_OVERRUN_MS));
  try {
    return body();
  } finally {
    now.mockRestore();
  }
}

const previewTags = (editor: EditorState): (string | undefined)[] =>
  collectObsidianPreview(editor, INDEX)
    .filter((item) => item.className === "nn-lp-tag")
    .map((item) => item.tag);

/** Every construct a tag can hide behind, in one document. `#body` is the only real tag. */
const MIXED_SYNTAX_DOC = [
  "---",
  "tags: [#yaml]",
  "---",
  "\\#escaped `#inline` [label](Note.md#fragment) ![x](asset#image)",
  "[[Note#Heading|#alias]] <span data-tag=\"#attribute\"> #body</span>",
  "",
  "    #indented-code",
  "```md",
  "#fenced",
  "```",
].join("\n");

describe("obsidianLivePreview", () => {
  it("recognizes resolved links, aliases, fragments, inert embeds, callouts, and block IDs", () => {
    const doc = [
      "[[Daily]] [[Daily#Heading|today]] [[Daily#^block-id]]",
      "![[Areas/Deep Work.md]]",
      "> [!NOTE] Callout",
      "A paragraph ^evidence-id",
    ].join("\n");

    const preview = collectObsidianPreview(state(doc), INDEX);

    expect(preview.filter((item) => item.className === "nn-lp-wikilink-resolved")).toHaveLength(3);
    expect(preview).toContainEqual(expect.objectContaining({
      kind: "widget",
      className: "nn-lp-embed",
      label: "Embed: Deep Work",
    }));
    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-callout" }));
    expect(preview).toContainEqual(expect.objectContaining({ className: "nn-lp-block-id" }));
  });


  it("paints a wikilink inside a table cell exactly as the cell-paint plan projects it", () => {
    const cellText = "[[Areas/Deep Work.md#Focus|deep]]";
    const doc = ["| Note |", "| --- |", `| ${cellText} |`].join("\n");
    const from = doc.indexOf(cellText);
    const editor = state(doc, 0);

    const painted = collectObsidianPreview(editor, INDEX).find((item) => item.kind === "widget");
    const plan = cellPaintPlan(editor, { from, to: from + cellText.length }, {
      context: "body",
      index: INDEX,
    });

    // Both sides read `inlineWikilinks`, so this goes red the moment either one
    // grows a second answer to "what does this wikilink paint as".
    expect(painted?.label).toBe("deep");
    expect(painted?.className).toBe("nn-lp-wikilink-resolved");
    expect(plan.visibleText).toBe(painted?.label);
    expect(plan.runs[0]?.classNames).toEqual([painted?.className]);
  });

  it("keeps unresolved links distinct and non-navigating", () => {
    const preview = collectObsidianPreview(state("before [[Missing]] after", 0), INDEX);
    expect(preview).toEqual([
      expect.objectContaining({
        kind: "widget",
        className: "nn-lp-wikilink-unresolved",
        target: null,
      }),
    ]);
  });

  it("reveals complete source at the caret instead of replacing it", () => {
    const doc = "before [[Daily|today]] after";
    const preview = collectObsidianPreview(state(doc, doc.indexOf("Daily") + 2), INDEX);

    expect(preview).toEqual([
      expect.objectContaining({ kind: "mark", className: "nn-lp-wikilink-active" }),
    ]);
  });

  it("reveals wikilink source when the caret lands immediately after it", () => {
    const doc = "before [[Daily|today]] after";
    const afterLink = doc.indexOf("]]") + 2;

    expect(collectObsidianPreview(state(doc, afterLink), INDEX)).toEqual([
      expect.objectContaining({ kind: "mark", className: "nn-lp-wikilink-active" }),
    ]);
  });

  it("does not decorate malformed links or constructs inside inline and fenced code", () => {
    const doc = "[[unclosed\n`[[Daily]]`\n```md\n[[Daily]]\n```";
    expect(collectObsidianPreview(state(doc), INDEX)).toEqual([]);
  });

  it("marks only an Obsidian inline tag token without turning its line into a heading", () => {
    const doc = "#SaaS Software As A Service:";

    expect(collectObsidianPreview(state(doc), INDEX)).toEqual([
      {
        from: 0,
        to: 5,
        kind: "mark",
        className: "nn-lp-tag",
        tag: "#SaaS",
      },
    ]);
  });

  it("recognizes nested, separated, underscored, Unicode, and emoji tags", () => {
    const doc = "#inbox/to-read #release-2026 #two_words #café #🧠notes";

    expect(previewTags(state(doc))).toEqual([
      "#inbox/to-read",
      "#release-2026",
      "#two_words",
      "#café",
      "#🧠notes",
    ]);
  });

  it("rejects invalid tag boundaries and numeric-only tags", () => {
    const doc = "# #1984 word#tag (#paren) ##heading https://example.test/#anchor";

    expect(previewTags(state(doc))).toEqual([]);
  });

  it("ignores tag-like text in frontmatter, code, links, wikilinks, escapes, and HTML syntax", () => {
    expect(previewTags(state(MIXED_SYNTAX_DOC))).toEqual(["#body"]);
  });

  it("does not manufacture tag boundaries after masked syntax or inside link references", () => {
    const doc = [
      "`code`#after-code [[Note]]#after-wikilink <span>#after-html",
      "[label #in-definition]: target.md",
      "[visible #in-reference][label]",
      "",
      "[ref]:",
      "  /url",
      "  \"title #in-multiline-reference\"",
      "",
      "[shortcut #in-shortcut]",
      "",
      "[shortcut #in-shortcut]: /target",
      "",
      "A real #body tag",
    ].join("\n");

    expect(previewTags(state(doc))).toEqual(["#body"]);
  });

  it("never turns embed or image text into a fetching DOM URL", () => {
    const preview = collectObsidianPreview(
      state("![[https://example.com/a.png]] ![x](https://example.com/x.png)"),
      INDEX,
    );
    expect(preview.every((item) => !("src" in item) && !("href" in item))).toBe(true);
  });

  it("does not make wikilink-shaped text inside a standard image navigable", () => {
    const preview = collectObsidianPreview(
      state("![prefix [[Daily]] suffix](local.png)"),
      INDEX,
    );

    expect(preview.filter((item) => item.className.includes("wikilink"))).toEqual([]);
  });

  it("does not copy or scan the complete document for a narrow viewport", () => {
    const doc = `${"outside\n".repeat(50_000)}[[Daily]] visible`;
    const editor = state(doc, 0);
    const linkFrom = doc.indexOf("[[Daily]]");
    vi.spyOn(editor.doc, "toString").mockImplementation(() => {
      throw new Error("complete document copied");
    });

    expect(
      collectObsidianPreview(editor, INDEX, [{ from: linkFrom, to: doc.length }]),
    ).toEqual([
      expect.objectContaining({ className: "nn-lp-wikilink-resolved" }),
    ]);
  });
});

describe("obsidianLivePreview tag masking", () => {
  const CONTROL_TAG = "#body";

  /**
   * One fixture per node in `TAG_MASKED_NODES`, keyed by the node it exercises.
   * `sourceEditorCellPaintPlan.ts` owns that list and the table cells read it
   * too, so the keys are asserted against the constant itself rather than
   * transcribed: an entry pruned there cannot quietly stop being covered here,
   * and one added there arrives without a fixture and fails.
   */
  const MASKED_FIXTURES: Record<string, { readonly source: string; readonly token: string }> = {
    Autolink: { source: "<https://example.test/#anchor>", token: "#anchor" },
    CodeBlock: { source: "    #indented-code", token: "#indented-code" },
    Escape: { source: "\\#escaped", token: "#escaped" },
    FencedCode: { source: "```md\n#fenced\n```", token: "#fenced" },
    HTMLTag: { source: "text <span data-tag=\"tag #attribute\"> end", token: "#attribute" },
    Image: { source: "![alt #image](asset.png)", token: "#image" },
    InlineCode: { source: "`code #inline`", token: "#inline" },
    Link: { source: "[label #linked](Note.md)", token: "#linked" },
    LinkLabel: { source: "[label #in-definition]: target.md", token: "#in-definition" },
    LinkReference: { source: "[ref #in-reference]: target.md", token: "#in-reference" },
    URL: { source: "[label](<Note.md #in-url>)", token: "#in-url" },
  };

  /**
   * The two nodes whose own shape forbids a whitespace-preceded `#` inside them:
   * an `Escape` is a backslash and the one character it escapes, and an
   * `Autolink` may not contain a space at all. The tag scan opens a token only
   * at the document start or after whitespace (the boundary rule guarding
   * `inlineTagAt` in `obsidianLivePreview.ts`), so
   * for these two that boundary rule rejects the token before the mask is ever
   * consulted, and their cases cover the boundary rule instead. Named here so
   * the difference is asserted rather than mistaken for an oversight.
   *
   * `sourceEditorCellPaintPlan.ts:458` applies the same boundary rule, so its
   * `Autolink` and `Escape` entries are unreachable there too.
   */
  const BOUNDARY_REJECTED: ReadonlySet<string> = new Set(["Autolink", "Escape"]);

  it("has one fixture for every node in the shared mask", () => {
    expect(Object.keys(MASKED_FIXTURES).sort()).toEqual([...TAG_MASKED_NODES].sort());
  });

  it.each(Object.entries(MASKED_FIXTURES))("reads no tag inside %s", (node, { source, token }) => {
    const doc = `${source}\n\nA real ${CONTROL_TAG} tag`;
    const editor = state(doc);
    const tokenFrom = doc.indexOf(token);
    const tokenTo = tokenFrom + token.length;

    const overlapping: string[] = [];
    syntaxTree(editor).iterate({
      enter({ name, from, to }) {
        if (from < tokenTo && to > tokenFrom) overlapping.push(name);
      },
    });

    // A fixture has to produce the node it is filed under, overlapping the token
    // the way `overlapsMasked` compares them. Without this a fixture that
    // stopped parsing as its node would still pass, proving nothing about the
    // entry it is named for.
    expect(overlapping).toContain(node);
    // And the token has to survive the boundary rule, or the mask is never
    // reached and the case passes with its node removed from the shared list.
    expect(tokenFrom === 0 || /\s/u.test(doc[tokenFrom - 1]!)).toBe(!BOUNDARY_REJECTED.has(node));
    // Exactly the control tag: a leak out of the construct adds one, and a mask
    // grown too broad drops it.
    expect(previewTags(editor)).toEqual([CONTROL_TAG]);
  });
});

/**
 * Filler long enough to push what follows past the initial parse window, in
 * separate blocks on purpose: one unbroken paragraph is consumed by a single
 * parser step however narrow the window, which would leave the tree complete
 * and the fixture vacuous.
 */
const PARSE_WINDOW_FILLER = Array.from(
  { length: 120 },
  (_, index) => `Filler paragraph ${index} carrying enough words to advance the offset.`,
).join("\n\n");

/**
 * One `#tag` in front of the initial parse frontier and one on the final line
 * behind it, so a single document exercises both sides of the caret path's
 * budget with the two cases differing in nothing but caret position.
 */
const FRONTIER_STRADDLING_DOC =
  `An early #early tag\n\n${PARSE_WINDOW_FILLER}\n\nA trailing #inbox tag`;

/**
 * An editor wired the way `SourceNoteEditor` wires one: the tag binding ahead of
 * CodeMirror's defaults (`SourceNoteEditor.tsx:224-227` vs `:260`).
 *
 * That ordering is what every keyboard case below turns on. A command returning
 * `false` hands bare Enter to `insertNewlineAndIndent`, so declining is not a
 * no-op — masking the caret's line edits the note.
 */
function tagSearchView(
  doc: string,
  caret: number,
  searched: string[],
): { readonly view: EditorView; readonly cleanup: () => void } {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    state: partiallyParsedState(
      doc,
      [
        EXTENSIONS,
        keymap.of([
          { key: "Enter", run: openTagSearchAtCaret((tag) => searched.push(tag)) },
          ...defaultKeymap,
        ]),
      ],
      caret,
    ),
    parent: host,
  });
  return { view, cleanup: () => { view.destroy(); host.remove(); } };
}

/** Bare Enter, as the browser delivers it. */
function dispatchEnter(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  }));
}

/**
 * Enter with the parse budget already spent, held across the event rather than
 * across construction: this is the budget `decorationAtCaret` spends INSIDE the
 * keystroke, and the whole question is what it does when that runs out.
 */
function dispatchEnterOnSpentBudget(view: EditorView): void {
  withExhaustedParseBudget(() => dispatchEnter(view));
}

describe("obsidianLivePreview over an unfinished parse", () => {
  /** Tags the partial parse paints that the complete parse does not: always none. */
  const leaked = (partial: EditorState, complete: EditorState): (string | undefined)[] => {
    const allowed = previewTags(complete);
    return previewTags(partial).filter((tag) => !allowed.includes(tag));
  };

  it("still paints a tag the parser has already reached", () => {
    const doc = `An early #early tag\n\n${PARSE_WINDOW_FILLER}\n\n\`\`\`md\n#fenced\n\`\`\``;
    const partial = partiallyParsedState(doc);
    const earlyTo = doc.indexOf("#early") + "#early".length;

    // The other direction, and the one `leaked` cannot see: it counts only tags
    // the partial parse invents, so fewer tags always reads as clean and a mask
    // widened until it blanks the note passes every assertion above. This one
    // pins the near side of the frontier — parsed, therefore painted.
    expect(syntaxTree(partial).length).toBeGreaterThanOrEqual(earlyTo);
    expect(syntaxTree(partial).length).toBeLessThan(doc.indexOf("```md"));
    expect(previewTags(partial)).toEqual(["#early"]);
  });

  it("opens tag search on Enter past the frontier instead of typing a newline", async () => {
    const doc = `${PARSE_WINDOW_FILLER}\n\nA real #inbox tag`;
    const tagFrom = doc.indexOf("#inbox");
    const searched: string[] = [];
    const { view, cleanup } = tagSearchView(doc, tagFrom + 1, searched);

    try {
      expect(syntaxTree(view.state).length).toBeLessThan(tagFrom);

      dispatchEnter(view);
      await Promise.resolve();

      expect(view.state.doc.toString()).toBe(doc);
      expect(searched).toEqual(["#inbox"]);
    } finally {
      cleanup();
    }
  });

  it("types a newline on Enter inside a fenced block past the frontier", async () => {
    const doc = `${PARSE_WINDOW_FILLER}\n\n\`\`\`md\n#fenced\n\`\`\``;
    const caret = doc.indexOf("#fenced") + 1;
    const searched: string[] = [];
    // The opposite direction of the same decision as its sibling above: there
    // the command has to fire, here it has to decline and let
    // `insertNewlineAndIndent` have the key.
    const { view, cleanup } = tagSearchView(doc, caret, searched);

    try {
      // The fence has to open past where the tree stops, or `FencedCode` is
      // present and the command was never deciding without a tree at all.
      expect(syntaxTree(view.state).length).toBeLessThan(doc.indexOf("```md"));

      dispatchEnter(view);
      await Promise.resolve();

      expect(searched).toEqual([]);
      expect(view.state.doc.toString()).toBe(`${doc.slice(0, caret)}\n${doc.slice(caret)}`);
    } finally {
      cleanup();
    }
  });

  it("declines a final-line tag while the whole-document parse is behind", async () => {
    const caret = FRONTIER_STRADDLING_DOC.indexOf("#inbox") + 1;
    const searched: string[] = [];
    const { view, cleanup } = tagSearchView(FRONTIER_STRADDLING_DOC, caret, searched);

    try {
      // The boundary itself, and the only thing separating this case from its
      // sibling below. On the last line `line.to` IS `doc.length`, and a limit
      // at or past the end is discarded rather than applied
      // (`@codemirror/language/dist/index.js:344-345`), so the 20 ms has to
      // cover the whole document. Asserted because a line appended to the
      // fixture would silently stop testing that and leave this passing.
      expect(view.state.doc.lineAt(caret).to).toBe(FRONTIER_STRADDLING_DOC.length);
      // And the tag has to sit past the frontier, or the parse had no work left
      // to run out of and this would pass having exercised nothing.
      expect(syntaxTree(view.state).length).toBeLessThan(caret);

      dispatchEnterOnSpentBudget(view);
      await Promise.resolve();

      expect(searched).toEqual([]);
      expect(view.state.doc.toString()).toBe(
        `${FRONTIER_STRADDLING_DOC.slice(0, caret)}\n${FRONTIER_STRADDLING_DOC.slice(caret)}`,
      );
    } finally {
      cleanup();
    }
  });

  it("still opens tag search on an already-parsed line under the same spent budget", async () => {
    const caret = FRONTIER_STRADDLING_DOC.indexOf("#early") + 1;
    const searched: string[] = [];
    const { view, cleanup } = tagSearchView(FRONTIER_STRADDLING_DOC, caret, searched);

    try {
      // Not the last line, so the limit survives — and the line is already
      // parsed, so `ensureSyntaxTree` answers from `isDone` without doing any
      // work at all (`@codemirror/language/dist/index.js:202,505-508`) and never
      // reads the spent clock. Same document and same spent budget as above, so
      // this is what makes that decline specific to the FINAL line rather than
      // to an exhausted budget in general.
      expect(view.state.doc.lineAt(caret).to).toBeLessThan(FRONTIER_STRADDLING_DOC.length);
      expect(syntaxTree(view.state).length).toBeGreaterThanOrEqual(caret + "#early".length);

      dispatchEnterOnSpentBudget(view);
      await Promise.resolve();

      expect(searched).toEqual(["#early"]);
      expect(view.state.doc.toString()).toBe(FRONTIER_STRADDLING_DOC);
    } finally {
      cleanup();
    }
  });

  it("masks a fenced block sitting past the initial parse window", () => {
    const doc = `${PARSE_WINDOW_FILLER}\n\n\`\`\`md\n#fenced\n\`\`\`\n\nA real #body tag`;
    const complete = state(doc);
    const partial = partiallyParsedState(doc);

    // The fence has to be on the far side of where the tree stops, or the
    // fixture would be masking something already parsed and prove nothing.
    expect(syntaxTree(partial).length).toBeLessThan(doc.indexOf("```md"));
    expect(previewTags(complete)).toEqual(["#body"]);
    expect(leaked(partial, complete)).toEqual([]);
  });

  it("masks the constructs the parser never reached when its budget expired", () => {
    const complete = state(MIXED_SYNTAX_DOC);
    const partial = budgetExhaustedState(MIXED_SYNTAX_DOC);

    expect(syntaxTree(partial).length).toBeLessThan(MIXED_SYNTAX_DOC.indexOf("```md"));
    expect(previewTags(complete)).toEqual(["#body"]);
    expect(leaked(partial, complete)).toEqual([]);
  });

  it("paints the tag once the parser catches up with it", () => {
    const doc = "First paragraph.\n\nSecond paragraph.\n\nA real #body tag";
    const host = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      state: budgetExhaustedState(doc, [EXTENSIONS, obsidianLivePreview([], () => {}, () => {})]),
      parent: host,
    });
    const paintedTags = () =>
      [...host.querySelectorAll<HTMLElement>(".nn-lp-tag")].map((element) => element.dataset.nnTag);

    try {
      // Same vacuity guard as its two siblings: at 44 of 53 characters `#body`
      // is close enough to the end that a parse stopping just short of it would
      // leave this passing while masking nothing.
      expect(syntaxTree(view.state).length).toBeLessThan(doc.indexOf("#body"));
      // Masked while the parse stops short of it, so the fail-closed rule above
      // never becomes a permanent blank: the tree arrives on an idle callback
      // carrying no document, selection or viewport change of its own.
      expect(paintedTags()).toEqual([]);
      forceParsing(view, view.state.doc.length, PARSE_BUDGET_MS);
      expect(paintedTags()).toEqual(["#body"]);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
