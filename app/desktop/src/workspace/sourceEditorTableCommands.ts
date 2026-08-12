import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";

import {
  drawsCellChrome,
  tableRowBoundaries,
  tableStructuralEdit,
  type TableRowBoundary,
} from "./sourceEditorTableDelimiterGuard";
import {
  monospaceWidth,
  tableColumnWidths,
  tableDelimiterRanges,
  tableModelAt,
  type TableDelimiterRange,
  type TableModel,
  type TableRowModel,
} from "./sourceEditorTableModel";
import { setRevealedTableSource, tableSourceRevealed } from "./sourceEditorTableReveal";

interface CellLocation {
  readonly rowIndex: number;
  readonly column: number;
}

/**
 * The one selection range these commands act on, or null when the user has
 * several.
 *
 * Every command below answers for `selection.main` and returns a single-cursor
 * selection, and `toCommand` then reports the key as handled — so with more
 * than one cursor the other cursors were dropped AND the default binding never
 * ran: the keystroke did nothing at all. Falling through hands it to the
 * default keymap and to `tableDelimiterFilter`, which is the layer that vets a
 * multicursor change, whole, and is tested for exactly that.
 */
function soleRange(state: EditorState): SelectionRange | null {
  return state.selection.ranges.length === 1 ? state.selection.main : null;
}

/** Rows a caret can occupy. The delimiter row is structural, never tabbed into. */
function contentRows(model: TableModel): number[] {
  return model.rows.flatMap((row, index) => (row.kind === "delimiter" ? [] : [index]));
}

function locateCell(model: TableModel, pos: number): CellLocation | null {
  for (const rowIndex of contentRows(model)) {
    const row = model.rows[rowIndex]!;
    if (pos < row.from || pos > row.to) continue;
    const exact = row.slots.find((slot) => pos >= slot.from && pos <= slot.to);
    if (exact) return { rowIndex, column: exact.column };
    // Caret sits on a pipe or in a cell's whitespace. Rank by distance to the
    // whole span: ranking on `from` alone resolved a caret in a cell's trailing
    // spaces to the NEXT cell, which turned Tab into "append a row".
    const nearest = [...row.slots].sort(
      (left, right) => distanceToSlot(left, pos) - distanceToSlot(right, pos),
    )[0];
    if (nearest) return { rowIndex, column: nearest.column };
  }
  return null;
}

/** Distance from a position to a slot's span; zero when inside it. */
function distanceToSlot(slot: { from: number; to: number }, pos: number): number {
  return Math.max(slot.from - pos, 0, pos - slot.to);
}

/**
 * The model, but only when the caret is genuinely inside the table. `active()`
 * in the preview layer is exclusive of `to`, so at exactly `table.to` the table
 * still renders as a read-only widget. The commands must agree, or Enter writes
 * a row to a table the user sees as rendered.
 */
function activeTableAt(state: EditorState, pos: number): TableModel | null {
  const model = tableModelAt(state, pos);
  if (!model || pos < model.from || pos >= model.to) return null;
  return model;
}

function selectSlot(row: TableRowModel, column: number): TransactionSpec | null {
  const slot = row.slots.find((candidate) => candidate.column === column);
  if (!slot) return null;
  return {
    selection: EditorSelection.single(slot.from, slot.to),
    scrollIntoView: true,
  };
}

/** `|  |  |` sized to the table, with the caret offset of each empty cell. */
function emptyRow(columnCount: number): { text: string; cellOffsets: number[] } {
  let text = "|";
  const cellOffsets: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    text += " ";
    cellOffsets.push(text.length);
    text += " |";
  }
  return { text, cellOffsets };
}

/**
 * The block prefix a row's line carries before the row itself starts: `> `
 * inside a blockquote, indentation inside a list item, nothing at top level.
 */
function linePrefix(state: EditorState, row: TableRowModel): string {
  return state.sliceDoc(state.doc.lineAt(row.from).from, row.from);
}

function appendRow(state: EditorState, model: TableModel, column: number): TransactionSpec {
  const { text, cellOffsets } = emptyRow(model.columnCount);
  // Carry the last row's prefix into the new line. Without it the appended row
  // leaves the blockquote or list item the table is nested in, and Obsidian
  // renders the orphan as a paragraph reading `|  |  |` — the bytes changed
  // meaning, not just their layout. `isTopLevelRow` already guards the deletion
  // branch below for the same reason.
  const prefix = linePrefix(state, model.rows.at(-1)!);
  const anchor = model.to + 1 + prefix.length + (cellOffsets[column] ?? cellOffsets[0] ?? 1);
  return {
    changes: { from: model.to, insert: `\n${prefix}${text}` },
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
  };
}

function rowIsBlank(state: EditorState, row: TableRowModel): boolean {
  return row.slots.every((slot) => state.sliceDoc(slot.from, slot.to).trim().length === 0);
}

/**
 * Move one cell forward or back, wrapping across rows. Returns null at the
 * table edges so the caller can fall through to the default key behaviour,
 * which is what keeps Tab available for escaping the editor.
 */
export function tableCellStep(state: EditorState, direction: 1 | -1): TransactionSpec | null {
  const range = soleRange(state);
  if (!range) return null;
  const model = activeTableAt(state, range.head);
  if (!model) return null;
  const location = locateCell(model, range.head);
  if (!location) return null;

  const row = model.rows[location.rowIndex]!;
  const nextColumn = location.column + direction;
  if (nextColumn >= 0 && nextColumn < row.slots.length) {
    return selectSlot(row, nextColumn);
  }

  const order = contentRows(model);
  const position = order.indexOf(location.rowIndex);
  const neighbour = order[position + direction];
  if (neighbour === undefined) {
    // At either edge Tab falls through to the browser, so keyboard focus can
    // always leave the editor (WCAG 2.1.2). Growing the table here would both
    // trap focus and write to a file the user only navigated through; Enter is
    // the affordance for adding a row.
    return null;
  }
  const target = model.rows[neighbour]!;
  return selectSlot(target, direction === 1 ? 0 : target.slots.length - 1);
}

/**
 * Enter moves down a column. On the last row it appends one, unless that row is
 * already blank, in which case the blank row is removed and the caret leaves the
 * table. That gives a way out without stranding an empty row behind.
 */
export function tableRowStep(state: EditorState): TransactionSpec | null {
  const range = soleRange(state);
  if (!range) return null;
  const model = activeTableAt(state, range.head);
  if (!model) return null;
  const location = locateCell(model, range.head);
  if (!location) return null;

  const order = contentRows(model);
  const next = order[order.indexOf(location.rowIndex) + 1];
  if (next !== undefined) {
    // Clamp rather than bail: a ragged next row missing this column would
    // otherwise return null and let defaultKeymap split the table mid-row.
    const target = model.rows[next]!;
    const column = Math.min(location.column, Math.max(0, target.slots.length - 1));
    const step = selectSlot(target, column);
    if (step) return step;
  }

  const row = model.rows[location.rowIndex]!;
  if (rowIsBlank(state, row) && row.kind === "body" && isTopLevelRow(state, row)) {
    // Drop the blank row and land below the table. Delete from the END of the
    // previous line, not `row.from - 1`: inside a blockquote or list item the
    // character before the row is the block prefix, not a newline, and cutting
    // there strands an orphaned "> " behind.
    const line = state.doc.lineAt(row.from);
    const from = line.number > 1 ? state.doc.line(line.number - 1).to : model.from;
    // Bound by the blank row's OWN line, never by `model.to`. A blank row in the
    // middle of a table has rows after it, and deleting to the end of the table
    // silently destroyed every one of them. It stayed invisible because a blank
    // row is normally the last thing in a table, which makes the two bounds
    // identical — so every existing test agreed with the broken arithmetic.
    return {
      changes: { from, to: line.to, insert: "\n" },
      selection: EditorSelection.cursor(from + 1),
      scrollIntoView: true,
    };
  }
  return appendRow(state, model, location.column);
}

/**
 * True when the row starts its own line. A table nested in a blockquote or list
 * carries a prefix (`> `, indentation) that the row node excludes, so range
 * arithmetic around the row would eat into that prefix.
 */
function isTopLevelRow(state: EditorState, row: TableRowModel): boolean {
  return state.doc.lineAt(row.from).from === row.from;
}

/**
 * Backspace, Delete and the arrow keys across hidden table structure.
 *
 * `atomicRanges` cannot do this: both its motion guard
 * (`@codemirror/view` index.js:3734) and its deletion guard
 * (`@codemirror/commands` index.js:1197) require a position strictly inside the
 * range, and a row written `|a|b|` yields a one-character gap that has none. So
 * the keys are owned here instead of delegated.
 *
 * A boundary keystroke MOVES rather than deletes. Removing an invisible
 * delimiter would silently change the table's shape with nothing on screen to
 * explain it; emptying the cell first, then deleting, is the honest path. Rows
 * and columns are removed by their own explicit commands.
 *
 * Returns null whenever the caret is not against one of those spans, so
 * ordinary editing — including deleting the table itself from outside — is
 * untouched.
 */
export function guardTableDelimiter(
  state: EditorState,
  direction: 1 | -1,
): TransactionSpec | null {
  const range = soleRange(state);
  if (!range?.empty) return null;

  const model = activeTableAt(state, range.head);
  // Nothing is hidden in a table too large to draw as cells: it renders as
  // literal source, every pipe on screen. Refusing to delete a character the
  // user is plainly looking at — and jumping the caret past it — is a bug, and
  // this is the bound every other consumer already checks.
  if (!model || !drawsCellChrome(state, model)) return null;

  const adjacent = guardedSpans(model, direction).find((span) =>
    direction === -1 ? span.to === range.head : span.from === range.head,
  );
  if (!adjacent) return null;

  return {
    selection: EditorSelection.cursor(direction === -1 ? adjacent.from : adjacent.to),
    scrollIntoView: true,
  };
}

/**
 * The spans a keystroke in `direction` may not eat: every hidden delimiter, and
 * every line boundary between two rows.
 *
 * The table's outer edge is deliberately excluded — a leading delimiter reached
 * backwards, or a trailing one reached forwards — because falling through there
 * is what lets the user delete the table.
 */
function guardedSpans(
  model: TableModel,
  direction: 1 | -1,
): ReadonlyArray<TableDelimiterRange | TableRowBoundary> {
  const outerEdge = direction === -1 ? "leading" : "trailing";
  return [
    ...tableDelimiterRanges(model).filter((delimiter) => delimiter.kind !== outerEdge),
    ...tableRowBoundaries(model),
  ];
}

function delimiterCell(width: number, alignment: string): string {
  if (alignment === "center") return `:${"-".repeat(Math.max(1, width - 2))}:`;
  if (alignment === "left") return `:${"-".repeat(Math.max(1, width - 1))}`;
  if (alignment === "right") return `${"-".repeat(Math.max(1, width - 1))}:`;
  return "-".repeat(Math.max(1, width));
}

/**
 * Write the visual alignment into the file for real. This is the one command
 * here that REWRITES existing bytes — `tableRowStep` inserts a row and deletes a
 * blank one, but never touches text the user wrote — and only ever on an
 * explicit request (Shift-Alt-f).
 *
 * Unlike the keystroke commands it does not fall through on a multicursor
 * selection: it is an explicit request, it formats the table holding the
 * primary cursor, and it returns no selection of its own, so every cursor is
 * mapped through the change and survives.
 */
export function formatTableAt(state: EditorState): TransactionSpec | null {
  // `activeTableAt`, not `tableModelAt`: at exactly `table.to` the preview layer
  // still draws the read-only widget, and `tableCellStep` and `tableRowStep`
  // already refuse there. This is the one command that rewrites existing bytes,
  // so it disagreeing meant Format table could reformat a table the user was
  // looking at as rendered output.
  const model = activeTableAt(state, state.selection.main.head);
  if (!model) return null;
  const widths = tableColumnWidths(state, model);

  // The DELIMITER row defines a GFM table's arity, not the widest row. Sizing
  // every row to the maximum gave the delimiter row an extra cell, so Obsidian
  // then rendered a column that had not existed and previously-discarded text
  // became visible data: formatting changed the document's meaning rather than
  // its whitespace.
  const arity = model.rows.find((row) => row.kind === "delimiter")?.slots.length
    ?? model.columnCount;

  // One change per row, so the line boundaries between rows are never rewritten.
  const changes = model.rows.map((row) => {
    const cells = Array.from({ length: arity }, (_, column) => {
      const slot = row.slots.find((candidate) => candidate.column === column);
      const width = widths[column] ?? 0;
      if (row.kind === "delimiter") {
        return delimiterCell(width, model.alignments[column] ?? "none");
      }
      const text = slot ? state.sliceDoc(slot.from, slot.to) : "";
      return text + " ".repeat(Math.max(0, width - monospaceWidth(text)));
    });

    // Cells beyond the table's arity are left exactly as authored. Renderers
    // already discard them; deleting the user's text to tidy the file would be
    // worse than leaving the row ragged.
    const surplus = row.slots
      .filter((slot) => slot.column >= arity)
      .map((slot) => state.sliceDoc(slot.from, slot.to));
    const tail = surplus.length > 0 ? ` ${surplus.join(" | ")} |` : "";

    return { from: row.from, to: row.to, insert: `| ${cells.join(" | ")} |${tail}` };
  });

  if (changes.every((change) => state.sliceDoc(change.from, change.to) === change.insert)) {
    return null;
  }
  return { changes, scrollIntoView: true };
}

/**
 * The single seam every structural table command dispatches through, and so the
 * one place the delimiter guard's exemption is declared. These commands rewrite
 * whole rows and the delimiter row on purpose, with the result on screen;
 * `tableDelimiterGuard` refuses that same shape of change when it arrives from
 * ordinary editing, where the bytes would vanish unexplained.
 */
function toCommand(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    const spec = build(view.state);
    if (!spec) return false;
    view.dispatch(spec, { annotations: tableStructuralEdit.of(true) });
    return true;
  };
}

export const guardTableDelimiterBackward = toCommand((state) => guardTableDelimiter(state, -1));
export const guardTableDelimiterForward = toCommand((state) => guardTableDelimiter(state, 1));
export const nextTableCell = toCommand((state) => tableCellStep(state, 1));
export const previousTableCell = toCommand((state) => tableCellStep(state, -1));
export const nextTableRow = toCommand(tableRowStep);
export const formatTable = toCommand(formatTableAt);

/**
 * Show the literal source of the table at the caret, or hide it again.
 *
 * This is the command the parent spec's hidden-delimiter exemption is
 * conditional on (`specs/source-native-live-preview-editor.md:90-95`): the
 * `" | "` gaps and the alignment row may only be hidden because this exists to
 * bring them back. It is also the only route to editing a column's alignment,
 * and the route for anyone who genuinely wants to type a structural pipe.
 *
 * It changes NO bytes — revealing is a rendering change — and it is never
 * invoked on the user's behalf. The integrity guard refuses a blind edit and
 * says so; it does not reveal the source as a silent fallback
 * (`specs/in-place-table-cell-editing.md:763-770`).
 */
export function revealTableSourceAt(state: EditorState): TransactionSpec | null {
  const model = activeTableAt(state, state.selection.main.head);
  if (!model) return null;
  const revealed = tableSourceRevealed(state, model);
  return {
    effects: setRevealedTableSource.of(revealed ? null : { from: model.from, to: model.to }),
  };
}

/**
 * Deliberately NOT built with `toCommand`: that seam annotates every
 * transaction as a structural table edit so the delimiter guard lets it
 * through, and this one has no document change for the guard to vet. Claiming
 * an exemption it does not need would make the annotation meaningless where it
 * does.
 */
export const revealTableSource: Command = (view) => {
  const spec = revealTableSourceAt(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};

/**
 * The chord contract the macOS bindings below are registered under:
 *
 * > Inside a table the chord is a COMMAND; outside a table it is a CHARACTER.
 *
 * A CodeMirror binding claims a keystroke only when its `run` returns true, so
 * the command's own verdict is not enough: `formatTableAt` returns null for a
 * table it has nothing left to align, which is the state the user is in
 * immediately after every successful format, and the unclaimed keystroke then
 * typed `Ï` into the cell — pressing Shift-Option-F twice was the whole
 * reproduction. Claiming the key whenever a table is under the caret is the
 * missing half.
 *
 * The table question is asked of {@link activeTableAt} rather than derived
 * again here, so the chord agrees with what the preview layer draws and with
 * every other command in this module, `table.to` exclusivity included: at
 * exactly `to` there is no active table, so the character types, which is the
 * right answer for a caret the user sees outside the rendered widget.
 *
 * `revealTableSourceAt` cannot currently decline while a table is active, so
 * for that command this is a no-op today. It is applied to both because the
 * contract is one rule about the chords, not a patch to the one command that
 * exposed it.
 */
function claimedInsideTable(command: Command): Command {
  return (view) =>
    command(view) || activeTableAt(view.state, view.state.selection.main.head) !== null;
}

export const formatTableChord = claimedInsideTable(formatTable);
export const revealTableSourceChord = claimedInsideTable(revealTableSource);

/**
 * The table block of `SourceNoteEditor`'s keymap, in registration order.
 *
 * It lives here, with the commands, so the binding order is testable against
 * the real thing rather than restated in a test. Its POSITION in the editor's
 * keymap is load-bearing and documented at the splice site: after
 * `completionKeymap`, so an open completion popup keeps Enter, and before
 * `foldKeymap` and `defaultKeymap`, so a table command beats the default.
 *
 * `Shift-Alt-\` sits immediately after `Shift-Alt-f` as the spec asks
 * (`specs/in-place-table-cell-editing.md:1133-1135`), and
 * `sourceEditorTableKeymap.test.ts` proves nothing else in the editor claims it.
 */
export const tableKeymap: readonly KeyBinding[] = [
  // Before defaultKeymap's delete commands: a hidden delimiter must move the
  // caret, never be deleted. See guardTableDelimiter.
  { key: "Backspace", run: guardTableDelimiterBackward },
  { key: "Delete", run: guardTableDelimiterForward },
  { key: "ArrowLeft", run: guardTableDelimiterBackward },
  { key: "ArrowRight", run: guardTableDelimiterForward },
  { key: "Tab", run: nextTableCell },
  { key: "Shift-Tab", run: previousTableCell },
  { key: "Enter", run: nextTableRow },
  { key: "Shift-Alt-f", run: formatTable },
  { key: "Shift-Alt-\\", run: revealTableSource },

  // macOS never delivers those last two by their base key. `KeyboardEvent.key`
  // carries the character Option PRODUCES, and CodeMirror deliberately declines
  // to fall back to the base-layout name for Option combinations there —
  // "Alt-combinations on macOS tend to be typed characters"
  // (`@codemirror/view/dist/index.js:9188-9189`). `Shift-Alt-Ï` and
  // `Shift-Alt-»` are therefore the only names its resolver ever looks up for
  // these chords, and binding them is the whole of the fix for #97; without
  // them the keystroke goes unclaimed and WebKit types the character into the
  // cell.
  //
  // Separate entries rather than a `mac` field on the two above, because
  // `buildKeymap` reads `binding[platform] || binding.key` and never both
  // (`:9136`): folding them in would UNBIND the base names on macOS, and buy
  // nothing for it — a separate entry already registers the Option characters.
  //
  // Those base names are NOT reached on macOS by the base-layout fallback; that
  // is precisely the branch `:9189` switches off. One route to them survives:
  // `:9199-9200` retries `Shift-` plus the event's OWN `key`, which matches
  // when the event carries the unshifted base character (`f`, `\`). Nothing in
  // production sends that — a macOS keyboard sends `Ï`/`»`, and a driver sends
  // the SHIFTED character, measured rather than assumed: a Playwright press of
  // `Shift+Alt+Backslash` on macOS reports `key: "|"` on both WebKit and
  // Chromium, which is the Windows/Linux route (`:9190-9191`) where the base
  // fallback is still on. So the surviving route is reached only by a
  // hand-built synthetic press, and that is what `sourceEditorTableKeymap.test.ts`
  // uses to prove the base names are still registered here. Keeping the entries
  // separate is free; folding them in would spend that for nothing. Carrying no
  // `key` is what keeps the two entries below from registering anywhere but
  // macOS.
  //
  // `claimedInsideTable` is what makes the pair a contract rather than two
  // lucky cases; its docblock carries the reasoning. The cost it accepts,
  // recorded as a decision rather than left to be discovered: inside a table
  // cell `Ï` and `»` become untypeable — and `»` is the French closing
  // guillemet, which a macOS user types with exactly this chord. A keymap keyed
  // on `key` cannot separate "the user meant the command" from "the user meant
  // the character", so one of the two has to lose inside a cell; a table cell
  // is the one place where the command is overwhelmingly the likelier intent,
  // and the source is one Shift-Option-\ away for anyone who needs the
  // character. `preventDefault: true` was the alternative and is worse: it pays
  // the same cost across the whole note, prose included.
  //
  // The characters are the US layout's; a layout that puts something else on
  // those chords is not covered, and no keymap keyed on `key` can be.
  { mac: "Shift-Alt-Ï", run: formatTableChord },
  { mac: "Shift-Alt-»", run: revealTableSourceChord },
];
