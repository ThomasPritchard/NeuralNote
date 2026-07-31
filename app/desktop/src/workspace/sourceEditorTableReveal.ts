import {
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from "@codemirror/state";

/**
 * The span of the one table whose literal source the user has asked to see.
 *
 * Kept as a plain span rather than a table identity because the field must
 * update on every transaction, and re-deriving a `TableModel` there would mean
 * walking the syntax tree mid-transaction — expensive, and unreliable while the
 * parser is still catching up with the document.
 */
export interface RevealedTableSource {
  readonly from: number;
  readonly to: number;
}

/** Reveal the given table's source, or clear the reveal with `null`. */
export const setRevealedTableSource = StateEffect.define<RevealedTableSource | null>();

/**
 * Which table, if any, is currently showing its literal delimiters.
 *
 * The reveal HOLDS while the caret stays in the revealed table and lapses when
 * it leaves. `specs/in-place-table-cell-editing.md:755-761` fixes the command's
 * scope ("the table at the caret") and insists it is never invoked on the user's
 * behalf, but it does not name a dismissal. This follows the editor's own
 * caret-scoped reveal model instead — the parent spec's rules 1 and 3, and the
 * delimiter row's own "revealing its source only when the caret is explicitly
 * placed inside it" (`:180`) — so reveal behaves like every other marker
 * reveal in the editor rather than becoming a mode the user can leave switched
 * on without noticing.
 *
 * Never holds more than one table: reveal is scoped to the table at the caret,
 * and a second reveal elsewhere replaces the first rather than accumulating
 * unprotected tables behind the user.
 */
export const revealedTableSource = StateField.define<RevealedTableSource | null>({
  create: () => null,
  update(value, transaction) {
    const requested = requestedIn(transaction);
    const next = requested === undefined ? mapped(value, transaction) : requested;
    return next && holdsCaret(next, transaction) ? next : null;
  },
});

/**
 * Whether `table` is the revealed one, and so is drawn as literal source.
 *
 * Reads the field OPTIONALLY. Several call sites build an `EditorState` from
 * the markdown extension alone, and a table that simply stays drawn is the
 * harmless answer; throwing would take out the paint path and the transaction
 * filter together.
 */
export function tableSourceRevealed(
  state: EditorState,
  table: { readonly from: number; readonly to: number },
): boolean {
  const revealed = state.field(revealedTableSource, false);
  if (!revealed) return false;
  // Overlap rather than an exact match: an edit inside the table moves its
  // bounds, and the mapped span only approximates them afterwards. Tables
  // cannot overlap each other, so an overlap still identifies exactly one.
  return table.from < revealed.to && table.to > revealed.from;
}

/** The last reveal request in this transaction, or undefined when it made none. */
function requestedIn(transaction: Transaction): RevealedTableSource | null | undefined {
  let requested: RevealedTableSource | null | undefined;
  for (const effect of transaction.effects) {
    if (effect.is(setRevealedTableSource)) requested = effect.value;
  }
  return requested;
}

/**
 * Follow the revealed span through a change. Associations are chosen so the
 * span GROWS with text typed at either edge, which is what keeps a table
 * revealed while the user edits the very cells they revealed it to reach.
 */
function mapped(
  value: RevealedTableSource | null,
  transaction: Transaction,
): RevealedTableSource | null {
  if (!value || !transaction.docChanged) return value;
  const from = transaction.changes.mapPos(value.from, -1);
  const to = transaction.changes.mapPos(value.to, 1);
  return to > from ? { from, to } : null;
}

/**
 * `newSelection`, never `transaction.state`: reading the new state from inside
 * a field's own update is circular, because computing it needs this field.
 */
function holdsCaret(span: RevealedTableSource, transaction: Transaction): boolean {
  const head = transaction.newSelection.main.head;
  return head >= span.from && head <= span.to;
}
