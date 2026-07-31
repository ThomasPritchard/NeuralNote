import { syntaxTree } from "@codemirror/language";
import {
  Annotation,
  EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { MAX_TABLE_PREVIEW_CHARS, MAX_TABLE_PREVIEW_ROWS } from "./sourceEditorDecorationsPreview";
import type { VisibleRange } from "./sourceEditorDecorationsTypes";
import {
  tableDelimiterRanges,
  tableModelAt,
  type TableDelimiterRange,
  type TableModel,
} from "./sourceEditorTableModel";

/**
 * Announced when a change is refused. `EditorView.announce` is rendered by
 * CodeMirror itself into a visually hidden `aria-live="polite"` region, which is
 * why the refusal never has to call into React from inside a transaction filter.
 */
export const REFUSED_TABLE_EDIT_ANNOUNCEMENT =
  "Edit refused: it would delete hidden table structure. The note is unchanged.";

/**
 * Marks a transaction as one of the explicit structural table commands — add a
 * row, step a cell, reformat. Those commands rewrite whole rows and the
 * delimiter row on purpose, at the user's request, with the result visible; the
 * filter below refuses exactly that shape of change when it arrives from
 * ordinary editing, where the same bytes would vanish unexplained.
 *
 * Attached once, in `toCommand` (`sourceEditorTableCommands.ts`), because that
 * is the single seam every one of those commands dispatches through.
 */
export const tableStructuralEdit = Annotation.define<boolean>();

/**
 * Whether a table is drawn as cells — and so has its `" | "` gaps and its
 * delimiter row hidden — rather than left as literal source.
 *
 * The one definition of that bound, shared by the paint path (`tableRanges`),
 * the atomic ranges and the transaction filter. They must agree: protecting a
 * delimiter the user can plainly see would refuse a legitimate edit, and
 * painting one the filter does not protect reopens the corruption path.
 *
 * Count BODY rows, and still draw at exactly `MAX_TABLE_PREVIEW_ROWS` of them.
 * `tablePreview` tests `rows.length >= MAX_TABLE_PREVIEW_ROWS` BEFORE pushing
 * each row, so it renders a table with exactly that many and bails one row
 * later; mirroring its bare `>=` here left the two one row apart, and at the
 * bound the same table drew as a widget with the caret outside and as raw pipes
 * with it inside. Pinned by "drawsCellChrome agrees with the preview at the
 * exact bound" in `sourceEditorTableDelimiterGuard.test.ts`, which drives the
 * real preview rather than restating this arithmetic.
 */
export function drawsCellChrome(model: TableModel): boolean {
  const bodyRows = model.rows.reduce((total, row) => total + (row.kind === "body" ? 1 : 0), 0);
  return model.to - model.from <= MAX_TABLE_PREVIEW_CHARS && bodyRows <= MAX_TABLE_PREVIEW_ROWS;
}

/**
 * The join between two consecutive rows: the newline, plus whatever block
 * prefix the next row carries (`> ` inside a blockquote, indentation inside a
 * list item).
 *
 * Deliberately NOT part of {@link tableDelimiterRanges}: those spans are
 * painted over as chrome and made atomic, and a line break is neither. It is
 * protected all the same. The alignment row is hidden whole and drawn as a 1px
 * rule, so the caret can sit at its start — atomic ranges snap it there — with
 * nothing on screen to say the character behind it is what holds the table
 * together. One Backspace merged the header into the alignment row and the
 * construct stopped being a table.
 */
export interface TableRowBoundary {
  readonly from: number;
  readonly to: number;
}

/** @see TableRowBoundary */
export function tableRowBoundaries(model: TableModel): TableRowBoundary[] {
  const boundaries: TableRowBoundary[] = [];
  for (let index = 0; index < model.rows.length - 1; index += 1) {
    const from = model.rows[index]!.to;
    const to = model.rows[index + 1]!.from;
    if (to > from) boundaries.push({ from, to });
  }
  return boundaries;
}

/** One table's protected spans, kept grouped so the table's own bounds stay known. */
export interface HiddenTableDelimiters {
  readonly from: number;
  readonly to: number;
  readonly delimiters: readonly TableDelimiterRange[];
  /** @see TableRowBoundary */
  readonly rowBoundaries: readonly TableRowBoundary[];
}

/**
 * Every hidden delimiter span of every table intersecting `ranges`, grouped by
 * table, with the line boundaries between that table's rows alongside them.
 * Callers supply the ranges: the visible viewport for the atomic ranges, the
 * changed spans of a transaction for the filter.
 *
 * Only `delimiters` is drawn and made atomic. `rowBoundaries` is protection
 * only, which is why the two stay separate fields rather than one list.
 */
export function hiddenTableDelimiters(
  state: EditorState,
  ranges: readonly VisibleRange[],
): HiddenTableDelimiters[] {
  return drawnTables(state, ranges).map((model) => ({
    from: model.from,
    to: model.to,
    delimiters: tableDelimiterRanges(model),
    rowBoundaries: tableRowBoundaries(model),
  }));
}

/** The tables intersecting `ranges` that are drawn as cells, in document order. */
function drawnTables(state: EditorState, ranges: readonly VisibleRange[]): TableModel[] {
  try {
    return tableStarts(state, ranges).flatMap((start) => {
      const model = tableModelAt(state, start);
      return model && drawsCellChrome(model) ? [model] : [];
    });
  } catch {
    // Spec rule 6: a decoration failure removes the decoration and leaves the
    // source editable. Nothing is hidden here either — `tableDecorationSet`
    // catches the same failure and drops every decoration — so no invisible
    // delimiter is left to protect, and refusing edits anyway would freeze the
    // whole note. The failure is already surfaced, once, through
    // `tablePreviewErrorSink`.
    //
    // Both callers make this mandatory rather than tidy. A throw from a
    // transaction filter escapes through `state.update()`, which CodeMirror
    // evaluates as an ARGUMENT to `dispatchTransactions`, and a throw from an
    // `atomicRanges` provider lands inside the view's update cycle. Neither is
    // caught by the editor, so both lose the keystroke outright.
    return [];
  }
}

/** Start offsets of the tables intersecting `ranges`, in document order. */
function tableStarts(state: EditorState, ranges: readonly VisibleRange[]): number[] {
  const starts = new Set<number>();
  const tree = syntaxTree(state);
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name === "Table") starts.add(node.from);
      },
    });
  }
  return [...starts].sort((left, right) => left - right);
}

/**
 * Whether replacing `[from, to)` would edit structure the user cannot see: a
 * hidden delimiter, or the line boundary between two rows of a drawn table.
 *
 * Overlap, not strict containment: a selection drawn exactly around the hidden
 * `" | "` destroys it just as thoroughly as one drawn through it. For a pure
 * insertion (`from === to`) the same expression reduces to strict interior, so
 * typing at either edge of a gap — which is what typing at a cell boundary is,
 * and what typing at either end of a row is — stays untouched.
 */
function editsHiddenTableStructure(state: EditorState, from: number, to: number): boolean {
  return hiddenTableDelimiters(state, [{ from, to }]).some((table) => {
    // Removing or replacing a table WHOLE is not blind editing: the user can see
    // everything they selected. Select All, and cutting a table out, keep working.
    if (from <= table.from && to >= table.to) return false;
    return [...table.delimiters, ...table.rowBoundaries]
      .some((span) => from < span.to && to > span.from);
  });
}

/**
 * Refuse — whole, and out loud — any transaction that would edit structure
 * hidden behind drawn cell chrome: a `" | "` gap, the alignment row, or the
 * line boundary that keeps two rows two rows.
 *
 * All-or-nothing by design. A partially applied multicursor edit is its own
 * silent corruption, so one unsafe component rejects every component, and the
 * document plus every selection range survive exactly as they were.
 *
 * INVARIANT, and the one thing this filter structurally cannot do: history
 * dispatches undo and redo with `filter: false`
 * (`@codemirror/commands/dist/index.js:536`), and `resolveTransaction` then
 * skips `filterTransaction` altogether (`@codemirror/state/dist/index.js:2416`).
 * No transaction filter can vet a history replay. This one is sufficient only
 * because a refused transaction is never applied, so nothing unsafe reaches
 * history to be replayed. Both halves of that argument are pinned by tests in
 * `sourceEditorTableDelimiterGuard.test.ts`; if a future change lets an unsafe
 * transaction through, undo is unprotected and the argument fails with it.
 */
export function tableDelimiterFilter(
  transaction: Transaction,
): TransactionSpec | readonly TransactionSpec[] {
  if (!transaction.docChanged) return transaction;
  if (transaction.annotation(tableStructuralEdit)) return transaction;

  const before = transaction.startState;
  let refused = false;
  transaction.changes.iterChangedRanges((from, to) => {
    if (!refused) refused = editsHiddenTableStructure(before, from, to);
  }, true);
  if (!refused) return transaction;

  // No changes and no selection: the document and every cursor are left exactly
  // as `startState` had them, and the reason is the only thing that survives.
  return { effects: EditorView.announce.of(REFUSED_TABLE_EDIT_ANNOUNCEMENT) };
}

/**
 * The transaction layer of the delimiter protection, registered by
 * `sourceEditorDecorations()`. Not to be confused with `guardTableDelimiter`
 * (`sourceEditorTableCommands.ts`), which is the keystroke layer: that one turns
 * a Backspace or arrow key ADJACENT to a hidden gap into a move, before any
 * transaction exists. This is the backstop for everything a keymap cannot see —
 * paste, drop, drag, non-empty selections, multicursor.
 */
export const tableDelimiterGuard: Extension =
  EditorState.transactionFilter.of(tableDelimiterFilter);
