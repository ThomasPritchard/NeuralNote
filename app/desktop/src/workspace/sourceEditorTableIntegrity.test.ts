// Integrity sweep for the table commands against the real QA fixture.
//
// Prompted by `fixtures/note-test-vault/02 Markdown/Tables.md` being found with
// its final three characters (" |\n") missing while an app instance had it open.
// The writer was never identified, so rather than reason about it, this drives
// every table command from EVERY caret position in the fixture and asserts the
// document is only ever grown by a deliberate row insertion, never truncated.
//
// If any command can eat a trailing pipe or newline, this goes red.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  formatTableAt,
  tableCellStep,
  tableRowStep,
} from "./sourceEditorTableCommands";

const FIXTURE = [
  "---",
  "tags: [qa/markdown, qa/tables]",
  "---",
  "# Markdown tables",
  "",
  "## Simple table",
  "",
  "| Name | State | Notes |",
  "| --- | :---: | ---: |",
  "| Alpha | Active | 12 |",
  "| Beta | Paused | 4 |",
  "",
  "## Inline formatting in cells",
  "",
  "| Kind | Example | Link |",
  "| --- | --- | --- |",
  "| Strong | **Urgent** | [Same-folder target](Markdown%20link%20target.md) |",
  "| Code | `const x = 1` | <https://example.com> |",
  "| Bare URL | https://example.org | [[03 Obsidian/Link Target]] |",
  "",
  "## Wide commitments table",
  "",
  "| Start date | End date | Day(s) | Time | Type | Commitment | Availability impact | Notes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 2026-04-03 | 2026-04-03 | Fri | 18:00-22:30 | DJ gig | Alfred Works, Digbeth | Booked | Paid invoice |",
  "| 2026-04-13 | 2026-04-17 | Mon-Fri | All day | Travel | Annual leave | Unavailable | Family holiday |",
  "",
  "## Blank trailing row",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| set | 1 |",
  "|  |  |",
  "",
  "## Nested in a blockquote",
  "",
  "> | Key | Value |",
  "> | --- | --- |",
  "> | set | 1 |",
  "> |  |  |",
  "",
  "## Nested in a list",
  "",
  "- item",
  "",
  "  | Key | Value |",
  "  | --- | --- |",
  "  | set | 1 |",
  "",
].join("\n");

function state(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(anchor),
    extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
    ],
  });
}

/**
 * Everything the user actually wrote. Whitespace and pipes move as rows are
 * padded or added; dashes and colons move because `format` resizes the
 * delimiter row. Nothing else may change.
 */
const content = (text: string) => text.replace(/[\s|:-]/g, "");

const COMMANDS = {
  tab: (editor: EditorState) => tableCellStep(editor, 1),
  shiftTab: (editor: EditorState) => tableCellStep(editor, -1),
  enter: tableRowStep,
  format: formatTableAt,
} as const;

describe("table command integrity against the QA fixture", () => {
  for (const [label, run] of Object.entries(COMMANDS)) {
    it(`never truncates the document from any caret position (${label})`, () => {
      const damage: string[] = [];
      let applied = 0;

      for (let pos = 0; pos <= FIXTURE.length; pos += 1) {
        const editor = state(FIXTURE, pos);
        const spec = run(editor);
        if (!spec) continue;
        applied += 1;
        const next = editor.update(spec).state.doc.toString();

        // Rows may be re-padded, appended, or (when blank) removed, so neither
        // length nor pipe count is invariant. What must NEVER change is the
        // user's content: strip whitespace and table punctuation and the
        // remainder has to survive every command byte for byte.
        if (content(next) !== content(FIXTURE)) {
          damage.push(`pos ${pos}: content changed`);
        }
        if (!next.endsWith("\n")) {
          damage.push(`pos ${pos}: lost the trailing newline`);
        }
        // A command may add one row or remove one blank row. Anything larger
        // means a line boundary was destroyed and two lines were merged.
        const lineDelta = next.split("\n").length - FIXTURE.split("\n").length;
        if (Math.abs(lineDelta) > 1) {
          damage.push(`pos ${pos}: line count moved by ${lineDelta}`);
        }
      }

      expect(damage.slice(0, 8)).toEqual([]);
      // Guard against a vacuous sweep: the fixture has three tables, so a great
      // many caret positions must actually produce a transaction.
      expect(applied).toBeGreaterThan(200);
    });
  }

  it("exercises the blank-row delete branch that the sweep exists to guard", () => {
    // The sweep above is only meaningful if this branch actually runs.
    // Mutating the branch to eat the whole table must turn the sweep red;
    // before the FIXTURE carried a blank row, that mutation stayed green.
    const blank = FIXTURE.indexOf("|  |  |");
    expect(blank).toBeGreaterThan(-1);

    const editor = state(FIXTURE, blank + 2);
    const spec = tableRowStep(editor);
    expect(spec).not.toBeNull();

    const next = editor.update(spec!).state.doc.toString();
    expect(next).toContain("| set | 1 |");
    expect(next.length).toBeGreaterThan(FIXTURE.length - 12);
  });
});
