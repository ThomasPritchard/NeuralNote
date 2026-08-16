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
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { withPublishedParse } from "../test/publishedParse";
import {
  formatTableAt,
  tableCellStep,
  tableRowStep,
} from "./sourceEditorTableCommands";
import {
  hiddenTableDelimiters,
  tableDelimiterGuard,
} from "./sourceEditorTableDelimiterGuard";

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

// Both helpers publish the finished parse before anyone reads the tree — see
// `src/test/publishedParse.ts` for why, and for why fixing only `guardedState`
// (as #118 and #142 did) left the blank-row test below still failing at 20 CPU
// burners through `state()`.
function state(doc: string, anchor: number) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(anchor),
      extensions: [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
      ],
    }),
    doc,
  );
}

function guardedState(doc: string, anchor: number) {
  return withPublishedParse(
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(anchor),
      extensions: [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        tableDelimiterGuard,
      ],
    }),
    doc,
  );
}

/**
 * A GFM alignment row: pipes, dashes, colons and whitespace, with at least one
 * dash. The frontmatter fence `---` is not one — it carries no pipe.
 */
const isAlignmentRow = (line: string) => line.includes("|") && /^[\s>|:-]*-[\s>|:-]*$/.test(line);

/** The block prefix a line carries: blockquote markers and list indentation. */
const blockPrefix = (line: string) => /^[\s>]*/.exec(line)?.[0] ?? "";

/**
 * Everything the user actually wrote. Whitespace and pipes move as rows are
 * padded or added, `format` resizes the alignment rows, and an appended row
 * repeats the block prefix of the row above it — so those three are dropped
 * whole. Every other byte must survive.
 *
 * A dash or a colon ANYWHERE ELSE is content: the fixture's dates
 * (`2026-04-03`) and times (`18:00-22:30`) are made of them, and stripping the
 * two globally left every one of them unprotected — and made a command that
 * deleted an entire alignment row invisible to this sweep. The two things that
 * disappeared with them are asserted on their own terms below instead.
 */
const content = (text: string) =>
  text
    .split("\n")
    .filter((line) => !isAlignmentRow(line))
    .map((line) => line.slice(blockPrefix(line).length))
    .join("")
    .replace(/[\s|]/g, "");

/** How many alignment rows the document declares. Losing one loses a table. */
const alignmentRows = (text: string) => text.split("\n").filter(isAlignmentRow).length;

/**
 * The first table row whose block prefix differs from the row above it, or null.
 *
 * A row appended without its neighbour's prefix leaves the blockquote or list
 * item the table is nested in, and Obsidian renders the orphan as a paragraph
 * reading `|  |  |`. `content` cannot see that — the prefix is structure, not
 * text — and neither could the line count or the trailing newline.
 */
function escapedRow(text: string): string | null {
  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const above = lines[index - 1]!;
    if (!line.includes("|") || !above.includes("|")) continue;
    if (blockPrefix(line) !== blockPrefix(above)) {
      return `line ${index + 1} escaped its block: `
        + `${JSON.stringify(blockPrefix(above))} -> ${JSON.stringify(blockPrefix(line))}`;
    }
  }
  return null;
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
        if (alignmentRows(next) !== alignmentRows(FIXTURE)) {
          damage.push(
            `pos ${pos}: alignment rows went from `
            + `${alignmentRows(FIXTURE)} to ${alignmentRows(next)}`,
          );
        }
        const escaped = escapedRow(next);
        if (escaped) {
          damage.push(`pos ${pos}: ${escaped}`);
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

describe("delimiter guard integrity against the QA fixture", () => {
  // The sweep above asks "can a command destroy the file?". This asks the
  // opposite question of the guard: "can it refuse something it shouldn't?".
  // Over-refusal is the failure mode a suite of hand-picked corrupting gestures
  // cannot see, and the fixture carries the awkward cases — ragged rows, a
  // blockquote-nested table, a list-nested table, a blank trailing row.

  it("refuses a one-character insertion inside hidden structure, and nowhere else", () => {
    // Row boundaries belong in this enumeration alongside the delimiters: they
    // are protected by the same filter, and inside a nested table the boundary
    // is `"\n> "` — three characters with an interior a one-character insertion
    // can land in.
    const hidden = hiddenTableDelimiters(
      guardedState(FIXTURE, 0),
      [{ from: 0, to: FIXTURE.length }],
    ).flatMap((table) => [...table.delimiters, ...table.rowBoundaries]);
    // Six tables' worth of gaps, rules and row boundaries. A fixture the
    // enumeration failed to walk would make every assertion below trivially true.
    expect(hidden.length).toBeGreaterThan(40);

    const insideHidden = (pos: number) =>
      hidden.some((span) => pos > span.from && pos < span.to);

    const disagreements: string[] = [];
    let refusals = 0;
    let applied = 0;

    for (let pos = 0; pos <= FIXTURE.length; pos += 1) {
      const transaction = guardedState(FIXTURE, pos)
        .update({ changes: { from: pos, insert: "x" } });
      const refused = transaction.effects.some((effect) => effect.is(EditorView.announce));

      if (refused) refusals += 1;
      if (transaction.docChanged) applied += 1;
      if (refused === transaction.docChanged) {
        disagreements.push(`pos ${pos}: refused and applied disagree`);
      }
      if (refused !== insideHidden(pos)) {
        disagreements.push(
          `pos ${pos}: refused=${refused}, but insideHidden=${insideHidden(pos)}`,
        );
      }
    }

    // WHAT THIS DOES NOT COVER — measured, not assumed. Both arms derive from
    // `hiddenTableDelimiters`, so a mutation to the ENUMERATION moves them
    // together and this test stays green: emptying `rowBoundaries` shrinks the
    // expected set AND stops the guard refusing, and the two still agree. A
    // mutation to the FILTER (never refuse) reds it immediately.
    //
    // So this is a differential test between the filter and the enumeration,
    // not an absolute one. Errors inside the enumeration are caught next door in
    // `sourceEditorTableDelimiterGuard.test.ts`, where that same `rowBoundaries`
    // mutation reds two tests.
    expect(disagreements.slice(0, 8)).toEqual([]);
    // Both halves must be non-empty, or the property is satisfied vacuously by
    // a guard that refuses everything, or one that refuses nothing.
    expect(refusals).toBeGreaterThan(40);
    expect(applied).toBeGreaterThan(FIXTURE.length / 2);
  });
});
