// The reveal-source command, and the alignment row it makes editable.
//
// `specs/in-place-table-cell-editing.md:755-761` approves the command and fixes
// its scope: the table at the caret, `false` outside a table. The parent spec
// (`specs/source-native-live-preview-editor.md:90-95`) makes the whole
// hidden-delimiter exemption CONDITIONAL on this command existing, so these
// tests are the branch's evidence that it may hide those delimiters at all.
//
// Every "refused" assertion checks the ANNOUNCE EFFECT rather than an unchanged
// document, for the reason `sourceEditorTableDelimiterGuard.test.ts` gives: a
// transaction that was never dispatched also leaves the document unchanged.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  revealTableSourceAt,
  revealTableSource,
} from "./sourceEditorTableCommands";
import {
  drawsCellChrome,
  hiddenTableDelimiters,
  REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT,
  REFUSED_TABLE_EDIT_ANNOUNCEMENT,
  tableDelimiterGuard,
} from "./sourceEditorTableDelimiterGuard";
import { revealedTableSource } from "./sourceEditorTableReveal";
import { tableModelAt } from "./sourceEditorTableModel";

const TABLE = [
  "# Notes",
  "",
  "| Start | End |",
  "| --- | --- |",
  "| a | b |",
  "",
  "Outside the table.",
].join("\n");

const TABLE_START = TABLE.indexOf("| Start");
const ALIGNMENT_ROW = TABLE.indexOf("| --- |");
/** Just after `| ` on the alignment row — where a `:` turns `---` into `:---`. */
const ALIGNMENT_CELL = ALIGNMENT_ROW + 2;
const OUTSIDE = TABLE.indexOf("Outside");

function editor(anchor: number, doc = TABLE) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      revealedTableSource,
      tableDelimiterGuard,
    ],
  });
}

/** Apply the reveal command's spec, as the keymap would. */
function reveal(state: EditorState): EditorState {
  const spec = revealTableSourceAt(state);
  return spec ? state.update(spec).state : state;
}

/** The announced reason, or null when the transaction was not refused. */
function announcement(transaction: Transaction): string | null {
  for (const effect of transaction.effects) {
    if (effect.is(EditorView.announce)) return effect.value;
  }
  return null;
}

/** Whether the table holding `pos` still has hidden delimiters. */
function hidesDelimiters(state: EditorState, pos: number): boolean {
  return hiddenTableDelimiters(state, [{ from: pos, to: pos }])
    .some((table) => table.delimiters.length > 0);
}

describe("the reveal-source command", () => {
  it("returns false outside a table", () => {
    // Spec :758 — "returning `false` outside a table". A command that claimed
    // the key everywhere would swallow Shift-Alt-\ in ordinary prose.
    expect(revealTableSourceAt(editor(OUTSIDE))).toBeNull();

    const view = { state: editor(OUTSIDE), dispatch: () => {} } as unknown as EditorView;
    expect(revealTableSource(view)).toBe(false);
  });

  it("reveals every hidden delimiter of the table at the caret", () => {
    // Spec :1133 — "restores every pipe for the table at the caret".
    const before = editor(ALIGNMENT_CELL);
    expect(hidesDelimiters(before, TABLE_START)).toBe(true);

    const after = reveal(before);
    expect(hidesDelimiters(after, TABLE_START)).toBe(false);
  });

  it("stops the table drawing cell chrome, so its source renders literally", () => {
    // `drawsCellChrome` is the ONE bound shared by the paint path, the atomic
    // ranges and the transaction filter. Reveal has to move that bound, or the
    // three disagree and a visible delimiter stays protected.
    const after = reveal(editor(ALIGNMENT_CELL));
    const model = tableModelAt(after, TABLE_START)!;
    expect(drawsCellChrome(after, model)).toBe(false);
  });

  it("never changes the document", () => {
    // The project invariant: bytes change only through an explicit user edit.
    // Revealing is a rendering change.
    const after = reveal(editor(ALIGNMENT_CELL));
    expect(after.doc.toString()).toBe(TABLE);
  });

  it("holds while the caret stays in the table and lapses when it leaves", () => {
    // The spec does not name a dismissal, so this follows the editor's own
    // caret-scoped reveal model (parent spec rules 1 and 3).
    const revealed = reveal(editor(ALIGNMENT_CELL));
    expect(revealed.field(revealedTableSource)).not.toBeNull();

    const moved = revealed.update({ selection: EditorSelection.cursor(TABLE.indexOf("| a |")) }).state;
    expect(moved.field(revealedTableSource)).not.toBeNull();

    const left = revealed.update({ selection: EditorSelection.cursor(OUTSIDE) }).state;
    expect(left.field(revealedTableSource)).toBeNull();
    expect(hidesDelimiters(left, TABLE_START)).toBe(true);
  });

  it("survives an edit inside the table it revealed", () => {
    // Load-bearing, not incidental: `:---:` is two keystrokes. A reveal that
    // lapsed on the first one would re-hide the alignment row mid-edit and
    // refuse the second, which is the original defect wearing a new hat.
    const revealed = reveal(editor(ALIGNMENT_CELL));
    const typed = revealed.update({ changes: { from: ALIGNMENT_CELL, insert: ":" } }).state;
    expect(typed.field(revealedTableSource)).not.toBeNull();

    const again = typed.update({
      changes: { from: typed.doc.toString().indexOf("---", ALIGNMENT_CELL) + 3, insert: ":" },
    });
    expect(announcement(again)).toBeNull();
    expect(again.state.doc.toString()).toContain("| :---: |");
  });

  it("hides the source again when invoked a second time in the same table", () => {
    const revealed = reveal(editor(ALIGNMENT_CELL));
    const hiddenAgain = reveal(revealed);
    expect(hiddenAgain.field(revealedTableSource)).toBeNull();
    expect(hidesDelimiters(hiddenAgain, TABLE_START)).toBe(true);
  });
});

describe("the alignment row", () => {
  it("refuses an alignment change while hidden, naming the row and the way out", () => {
    // The practical defect this whole command exists to fix: with the alignment
    // row hidden unconditionally, `:---` could not be typed in ANY drawn table.
    const transaction = editor(ALIGNMENT_CELL)
      .update({ changes: { from: ALIGNMENT_CELL, insert: ":" } });

    expect(transaction.state.doc.toString()).toBe(TABLE);
    expect(announcement(transaction)).toBe(REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT);
    // It must name the construct it refused and point somewhere, or it is a wall.
    expect(REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT).toMatch(/alignment row/i);
    expect(REFUSED_ALIGNMENT_ROW_ANNOUNCEMENT).toContain("Shift-Alt-\\");
  });

  it("keeps the generic refusal for a hidden cell divider", () => {
    // The two messages must stay distinguishable: naming the alignment row for
    // a divider edit would be the same wrong-construct bug in the other
    // direction. `| a | b |` — the hidden divider sits between the cells.
    const bodyRow = TABLE.indexOf("| a | b |");
    const divider = TABLE.indexOf("| a | b |") + 3;
    const transaction = editor(bodyRow + 2)
      .update({ changes: { from: divider, to: divider + 3, insert: "x" } });

    expect(announcement(transaction)).toBe(REFUSED_TABLE_EDIT_ANNOUNCEMENT);
  });

  it("accepts the same alignment change once revealed", () => {
    // The command's whole purpose. Note this asserts the EDIT LANDS, not merely
    // that nothing was announced: a refused transaction is also silent in the
    // document if you only check for an absent announcement.
    const revealed = reveal(editor(ALIGNMENT_CELL));
    const transaction = revealed.update({ changes: { from: ALIGNMENT_CELL, insert: ":" } });

    expect(announcement(transaction)).toBeNull();
    expect(transaction.state.doc.toString()).toBe(TABLE.replace("| --- |", "| :--- |"));
  });

  it("keeps every other table protected while one is revealed", () => {
    // Reveal is scoped to the table at the caret (spec :1133). A reveal that
    // unprotected the whole document would be a corruption path, not a feature.
    const twoTables = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    const secondStart = twoTables.indexOf("| C | D |");
    const firstAlignment = twoTables.indexOf("| --- |") + 2;

    const revealed = reveal(editor(firstAlignment, twoTables));
    expect(hidesDelimiters(revealed, 0)).toBe(false);
    expect(hidesDelimiters(revealed, secondStart)).toBe(true);
  });
});
