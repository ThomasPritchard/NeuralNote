// The cross-cell corruption path, and the exact shape of its refusal.
//
// At HEAD `tableRanges` hides the whole `" | "` gap between two cells, so a
// drag-selection across that gap covers characters nothing on screen accounts
// for. Typing one character then rewrites `| aa | bb |` to `| aabb |`: the row
// loses a column while the delimiter row still declares two, and nothing warns.
//
// Every "refused" assertion below checks the ANNOUNCE EFFECT, not merely that
// the document is unchanged. A transaction that was never dispatched also leaves
// the document unchanged, so an unchanged document proves nothing on its own.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withPublishedParse } from "../test/publishedParse";

// The model is mocked as a pass-through so one test can make it explode. A
// throw from a transaction filter is fatal in a way an ordinary throw is not
// (see the last describe block), so that path needs its own proof.
vi.mock("./sourceEditorTableModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sourceEditorTableModel")>();
  return { ...actual, tableModelAt: vi.fn(actual.tableModelAt) };
});

const { tableModelAt } = await import("./sourceEditorTableModel");
const { formatTableAt } = await import("./sourceEditorTableCommands");
const {
  collectMarkdownPreview,
  MAX_TABLE_PREVIEW_ROWS,
} = await import("./sourceEditorDecorationsPreview");
const {
  drawsCellChrome,
  hiddenTableDelimiters,
  REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT,
  REFUSED_TABLE_EDIT_ANNOUNCEMENT,
  tableDelimiterGuard,
  tableStructuralEdit,
} = await import("./sourceEditorTableDelimiterGuard");

const realTableModelAt = vi.mocked(tableModelAt).getMockImplementation()!;
afterEach(() => {
  vi.mocked(tableModelAt).mockImplementation(realTableModelAt);
});

// `| aa | bb |` — pipes at 0, 5 and 10, so the hidden divider spans [4, 7).
const TABLE = ["| aa | bb |", "| --- | --- |", "| cc | dd |"].join("\n");

const DIVIDER = { from: TABLE.indexOf("aa") + 2, to: TABLE.indexOf("bb") };

/**
 * A guarded state whose finished parse the tree actually holds.
 *
 * The guard is a transaction filter that finds the table it protects by walking
 * `syntaxTree(state)`. A truncated tree therefore does not merely weaken these
 * tests, it INVERTS them: with no table in the tree there is nothing to protect,
 * the corrupting change sails through, and the refusal these assertions look for
 * never happens. Measured red: "groups the hidden spans of every table in the
 * requested ranges" found 1 table of 2, once in 8 full-suite runs under 20 CPU
 * burners. See `src/test/publishedParse.ts`.
 *
 * The oversized fixture needs it most of all. `tableWithBodyRows(201)` is 3,033
 * characters, past the 3,000 `Work.InitViewport` slice
 * (`@codemirror/language/dist/index.js:539-545`), so an unpublished parse can
 * report FEWER body rows than the fixture has — and "no chrome for an oversized
 * table" would then pass because the table looked small, which is the opposite
 * of what it claims.
 */
function guarded(doc: string, ranges: Array<{ anchor: number; head?: number }> = [{ anchor: 0 }]) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: EditorSelection.create(
        ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head ?? anchor)),
      ),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        tableDelimiterGuard,
      ],
    }),
    doc,
  );
}

/** A table with `count` body rows, after a heading so the caret can sit outside it. */
function tableWithBodyRows(count: number): string {
  return [
    "# Head",
    "",
    "| Key | Value |",
    "| --- | --- |",
    ...Array.from({ length: count }, (_, index) => `| k${index} | v${index} |`),
  ].join("\n");
}

/** The announced reason, or null when the transaction was not refused. */
function announcement(transaction: Transaction): string | null {
  for (const effect of transaction.effects) {
    if (effect.is(EditorView.announce)) return effect.value;
  }
  return null;
}

const selectionOf = (state: EditorState) =>
  state.selection.ranges.map((range) => [range.anchor, range.head]);

describe("the divider is protected exactly where it is invisible", () => {
  it("refuses a cross-cell selection replacement and announces why", () => {
    // The live defect: drag from inside `aa` to inside `bb`, type one character.
    const editor = guarded(TABLE, [{ anchor: 3, head: 8 }]);
    const before = selectionOf(editor);

    const transaction = editor.update({ changes: { from: 3, to: 8, insert: "x" } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.docChanged).toBe(false);
    expect(transaction.state.doc.toString()).toBe(TABLE);
    expect(selectionOf(transaction.state)).toEqual(before);
  });

  it("refuses a deletion that covers the hidden gap exactly", () => {
    // A strict-interior test would miss this one: `from` and `to` sit ON the
    // boundaries, yet the result is still `| aabb |`.
    const editor = guarded(TABLE, [{ anchor: DIVIDER.from, head: DIVIDER.to }]);
    const transaction = editor.update({ changes: { from: DIVIDER.from, to: DIVIDER.to } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
  });

  it("refuses an insertion dropped strictly inside the hidden gap", () => {
    const onThePipe = DIVIDER.from + 1;
    const transaction = guarded(TABLE, [{ anchor: onThePipe }])
      .update({ changes: { from: onThePipe, insert: "x" } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
  });

  it("refuses an edit inside the delimiter row, naming the alignment row", () => {
    // The refusal stands; only the WORDING changed. The alignment row is the
    // one hidden span with a command that reveals it, so it gets a message that
    // names it and points there rather than the generic structural refusal.
    const insideRule = TABLE.indexOf("| --- |") + 3;
    const transaction = guarded(TABLE, [{ anchor: insideRule }])
      .update({ changes: { from: insideRule, insert: ":" } });

    expect(announcement(transaction)).toBe(REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
  });

  it("rejects the whole transaction when only one cursor of many is unsafe", () => {
    // All-or-nothing. The safe insertion must NOT land: a partially applied
    // multicursor edit is its own silent corruption.
    const editor = guarded(TABLE, [{ anchor: 3 }, { anchor: DIVIDER.from, head: DIVIDER.to }]);
    const before = selectionOf(editor);

    const transaction = editor.update({
      changes: [
        { from: 3, insert: "z" },
        { from: DIVIDER.from, to: DIVIDER.to, insert: "z" },
      ],
    });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
    expect(selectionOf(transaction.state)).toEqual(before);
  });
});

describe("the line boundaries between a drawn table's rows are protected too", () => {
  // The alignment row is hidden whole and drawn as a rule, so the caret can sit
  // at its start with nothing on screen to say the character behind it is what
  // holds the table together. One Backspace there produced
  // `| aa | bb || --- | --- |` and the construct stopped parsing as a table.
  //
  // `guardTableDelimiter` is the first line of defence, but it only sees single
  // cursors and single keystrokes; paste, drag and multicursor arrive here.

  const RULE = TABLE.indexOf("| --- |");
  const BODY = TABLE.indexOf("| cc");

  it("refuses a Backspace that would merge the header into the alignment row", () => {
    const transaction = guarded(TABLE, [{ anchor: RULE }])
      .update({ changes: { from: RULE - 1, to: RULE } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
  });

  it("refuses a Delete that would merge two body rows", () => {
    const transaction = guarded(TABLE, [{ anchor: BODY - 1 }])
      .update({ changes: { from: BODY - 1, to: BODY } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(transaction.state.doc.toString()).toBe(TABLE);
  });

  it("still allows typing at the start and the end of a row", () => {
    // The boundary between two top-level rows is one newline, which has no
    // interior — so an insertion at either end of a row, which is what typing
    // at a row's edge is, stays ordinary editing.
    for (const pos of [RULE - 1, BODY]) {
      const transaction = guarded(TABLE, [{ anchor: pos }])
        .update({ changes: { from: pos, insert: "x" } });

      expect(announcement(transaction)).toBeNull();
      expect(transaction.docChanged).toBe(true);
    }
  });
});

describe("ordinary editing is untouched", () => {
  it("allows typing in the middle of a cell", () => {
    const transaction = guarded(TABLE, [{ anchor: 3 }])
      .update({ changes: { from: 3, insert: "x" } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toContain("| axa |");
  });

  it("allows typing at either boundary of a hidden gap", () => {
    for (const pos of [DIVIDER.from, DIVIDER.to]) {
      const transaction = guarded(TABLE, [{ anchor: pos }])
        .update({ changes: { from: pos, insert: "x" } });

      expect(announcement(transaction)).toBeNull();
      expect(transaction.docChanged).toBe(true);
    }
  });

  it("allows a backspace that stops at the boundary of a hidden gap", () => {
    const transaction = guarded(TABLE, [{ anchor: DIVIDER.from }])
      .update({ changes: { from: DIVIDER.from - 1, to: DIVIDER.from } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString().startsWith("| a | bb |")).toBe(true);
  });

  it("allows edits elsewhere in a note that happens to contain a table", () => {
    const doc = `# Heading\n\n${TABLE}\n\ntail`;
    const transaction = guarded(doc, [{ anchor: 2 }])
      .update({ changes: { from: 2, insert: "x" } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toContain("# xHeading");
  });
});

describe("the two exceptions without which ordinary editing breaks", () => {
  it("allows a change that replaces an affected table entirely (Select All, cut)", () => {
    // Exception 2. Without it Select-All-and-type, and cutting a table out,
    // both become impossible.
    const doc = `# Heading\n\n${TABLE}\n\ntail`;
    const editor = guarded(doc, [{ anchor: 0, head: doc.length }]);
    const transaction = editor.update({ changes: { from: 0, to: doc.length, insert: "gone" } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toBe("gone");
  });

  it("allows cutting a whole table out of the middle of a note", () => {
    const doc = `# Heading\n\n${TABLE}\n\ntail`;
    const from = doc.indexOf("| aa");
    const to = from + TABLE.length;
    const transaction = guarded(doc, [{ anchor: from, head: to }])
      .update({ changes: { from, to } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toBe("# Heading\n\n\n\ntail");
  });

  it("allows an annotated structural table command to rewrite the delimiters", () => {
    // Exception 1. `formatTableAt` rewrites every row from `row.from` to
    // `row.to`, which covers every hidden gap in the table.
    const editor = guarded(TABLE, [{ anchor: 3 }]);
    const spec = formatTableAt(editor);
    expect(spec).not.toBeNull();

    const allowed = editor.update(spec!, { annotations: tableStructuralEdit.of(true) });

    expect(announcement(allowed)).toBeNull();
    expect(allowed.docChanged).toBe(true);
  });

  it("refuses the identical change when it is NOT annotated", () => {
    // The negative control for exception 1: without it, the exception could be
    // vacuous and this suite would never notice.
    const editor = guarded(TABLE, [{ anchor: 3 }]);
    const refused = editor.update(formatTableAt(editor)!);

    expect(announcement(refused)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    expect(refused.state.doc.toString()).toBe(TABLE);
  });
});

describe("only tables whose delimiters are actually hidden are protected", () => {
  const OVERSIZED = tableWithBodyRows(MAX_TABLE_PREVIEW_ROWS + 1);

  it("leaves an oversized table alone, because its pipes are plainly visible", () => {
    // Above the preview bounds `tableRanges` bails and the source renders
    // literally. Refusing an edit to text the user can see would be a bug.
    const first = OVERSIZED.indexOf("| k0 | v0 |");
    const gapFrom = first + "| k0".length;
    const gapTo = first + "| k0 | ".length;

    const transaction = guarded(OVERSIZED, [{ anchor: gapFrom, head: gapTo }])
      .update({ changes: { from: gapFrom, to: gapTo } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.docChanged).toBe(true);
  });

  it("leaves the line boundary between two of its rows alone as well", () => {
    const boundary = OVERSIZED.indexOf("| k1 | v1 |");

    const transaction = guarded(OVERSIZED, [{ anchor: boundary }])
      .update({ changes: { from: boundary - 1, to: boundary } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.docChanged).toBe(true);
  });

  it("reports no hidden delimiters for an oversized table", () => {
    expect(hiddenTableDelimiters(guarded(OVERSIZED), [{ from: 0, to: OVERSIZED.length }]))
      .toEqual([]);
  });
});

describe("drawsCellChrome agrees with the preview at the exact bound", () => {
  // `drawsCellChrome`'s comment claims it matches `tablePreview` exactly, and
  // that claim is load-bearing: with the caret OUTSIDE, the preview decides
  // whether the table is a drawn widget; with the caret INSIDE, this bound
  // decides whether it is drawn as cells or left as literal pipes. At HEAD they
  // were one row apart, so at exactly MAX_TABLE_PREVIEW_ROWS body rows the same
  // table appeared two different ways depending on where the caret was — the
  // flip this whole feature exists to remove.

  /** Whether the preview draws the table as a widget, with the caret outside. */
  function previewDrawsWidget(doc: string): boolean {
    // Published for the reason `guarded` is, and for one more: this arm is
    // compared against that one, so the two have to be reading the same tree or
    // "they agree" is a comparison of two different documents.
    const outside = withPublishedParse(
      EditorState.create({
        doc,
        selection: EditorSelection.cursor(0),
        extensions: [markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false })],
      }),
      doc,
    );
    const table = collectMarkdownPreview(outside).find((item) => item.className.startsWith("nn-lp-table"));
    expect(table).toBeDefined();
    return table!.kind === "widget";
  }

  const chromeDrawn = (doc: string) =>
    drawsCellChrome(guarded(doc), tableModelAt(guarded(doc), doc.indexOf("| Key"))!);

  for (const rows of [1, MAX_TABLE_PREVIEW_ROWS - 1, MAX_TABLE_PREVIEW_ROWS]) {
    it(`draws ${rows} body rows both ways`, () => {
      const doc = tableWithBodyRows(rows);
      expect(previewDrawsWidget(doc)).toBe(true);
      expect(chromeDrawn(doc)).toBe(true);
    });
  }

  it(`draws ${MAX_TABLE_PREVIEW_ROWS + 1} body rows neither way`, () => {
    // The negative control: without it "they agree" is satisfied by a bound
    // that never bites.
    const doc = tableWithBodyRows(MAX_TABLE_PREVIEW_ROWS + 1);
    expect(previewDrawsWidget(doc)).toBe(false);
    expect(chromeDrawn(doc)).toBe(false);
  });
});

describe("hiddenTableDelimiters", () => {
  it("groups the hidden spans of every table in the requested ranges", () => {
    const second = ["| ee | ff |", "| --- | --- |", "| gg | hh |"].join("\n");
    const doc = `${TABLE}\n\ntext\n\n${second}`;
    const tables = hiddenTableDelimiters(guarded(doc), [{ from: 0, to: doc.length }]);

    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ from: 0, to: TABLE.length });
    expect(tables[1]?.from).toBe(doc.indexOf(second));
    for (const table of tables) {
      expect(table.delimiters.length).toBeGreaterThan(0);
      expect(table.delimiters.every((span) => span.to > span.from)).toBe(true);
    }
  });

  it("returns nothing for a range with no table in it", () => {
    expect(hiddenTableDelimiters(guarded("# Heading\n\nplain"), [{ from: 0, to: 5 }])).toEqual([]);
  });
});

describe("a table-model failure leaves the source editable", () => {
  it("allows the change instead of throwing out of the transaction filter", () => {
    // Spec rule 6. CodeMirror evaluates `state.update(...)` as an ARGUMENT to
    // `dispatchTransactions`, so a throw from a filter is not caught by the
    // editor: it loses the keystroke outright. And when the model cannot be
    // built the painter cannot hide anything either, so there is no invisible
    // delimiter left to protect.
    const editor = guarded(TABLE, [{ anchor: DIVIDER.from, head: DIVIDER.to }]);
    vi.mocked(tableModelAt).mockImplementation(() => {
      throw new Error("synthetic table model failure");
    });

    const transaction = editor.update({ changes: { from: DIVIDER.from, to: DIVIDER.to } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toContain("| aabb |");
  });
});

describe("the filter cannot protect undo or redo — and does not need to", () => {
  it("does not run at all for a transaction dispatched with filter:false", () => {
    // `history` dispatches undo and redo with `filter: false`
    // (`@codemirror/commands/dist/index.js:536`), and `resolveTransaction`
    // then skips `filterTransaction` entirely
    // (`@codemirror/state/dist/index.js:2416-2427`). No transaction filter,
    // this one included, can protect a history replay.
    //
    // If this test ever goes red because the document survived, the filter has
    // grown a second enforcement path and the reasoning below must be redone.
    const transaction = guarded(TABLE, [{ anchor: DIVIDER.from, head: DIVIDER.to }])
      .update({ changes: { from: DIVIDER.from, to: DIVIDER.to }, filter: false });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toContain("| aabb |");
  });

  it("keeps undo safe by keeping the unsafe change out of history in the first place", () => {
    // The whole safety argument, executable: because the corrupting transaction
    // is refused before it is applied, it never becomes a history entry, so
    // there is nothing corrupt for the unfiltered undo path to replay.
    // Built here rather than through `guarded` because it needs `history()`,
    // but published exactly as `guarded` publishes: the refusal in the middle of
    // this sequence is the whole argument, and an unparsed table would let the
    // corrupting change through and leave undo replaying it.
    let editor = withPublishedParse(
      EditorState.create({
        doc: TABLE,
        selection: EditorSelection.cursor(3),
        extensions: [
          history(),
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          tableDelimiterGuard,
        ],
      }),
      TABLE,
    );
    const dispatch = (transaction: Transaction) => { editor = transaction.state; };

    editor = editor.update({ changes: { from: 3, insert: "x" } }).state;
    expect(editor.doc.toString()).toContain("| axa |");

    const refused = editor.update({ changes: { from: DIVIDER.from + 1, to: DIVIDER.to + 1 } });
    expect(announcement(refused)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
    editor = refused.state;

    expect(undo({ state: editor, dispatch })).toBe(true);
    expect(editor.doc.toString()).toBe(TABLE);
  });
});
