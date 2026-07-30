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

        // Row content may be re-padded and rows may be appended, but no command
        // may shorten the document or disturb the terminal newline.
        if (next.length < FIXTURE.length) {
          damage.push(`pos ${pos}: shortened ${FIXTURE.length} -> ${next.length}`);
        }
        if (!next.endsWith("\n")) {
          damage.push(`pos ${pos}: lost the trailing newline`);
        }
        const pipesBefore = (FIXTURE.match(/\|/g) ?? []).length;
        const pipesAfter = (next.match(/\|/g) ?? []).length;
        if (pipesAfter < pipesBefore) {
          damage.push(`pos ${pos}: lost pipes ${pipesBefore} -> ${pipesAfter}`);
        }
      }

      expect(damage.slice(0, 8)).toEqual([]);
      // Guard against a vacuous sweep: the fixture has three tables, so a great
      // many caret positions must actually produce a transaction.
      expect(applied).toBeGreaterThan(200);
    });
  }

  it("treats a row with no parsable cells as unsafe to delete", () => {
    // `[].every()` is true, so a slot-less row would read as blank and Enter
    // would delete from it to the end of the table.
    const doc = "| a | b |\n| --- | --- |\n| x | y |\n|\n";
    const editor = state(doc, doc.indexOf("|\n", doc.indexOf("| x")) + 1);
    const spec = tableRowStep(editor);
    const next = spec ? editor.update(spec).state.doc.toString() : doc;

    expect(next.length).toBeGreaterThanOrEqual(doc.length - 1);
    expect(next).toContain("| x | y |");
  });
});
