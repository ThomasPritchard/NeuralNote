// The one place the "your other window is still using the previous key" notice
// lives — its copy and its presentation together, so the two surfaces that can
// raise it (the settings card and the chat pane's guided setup) cannot drift
// into telling the user two different things about the same fact.
//
// `save_api_key` / `clear_api_key` resolve to a `KeyChangeOutcome`. The keychain
// change itself is committed by the time they resolve — that part either threw or
// worked. `revisionPublished` carries the OTHER guarantee: that every other
// running copy of the app was told to stop trusting the key it had cached. When
// it is false the key really is stored (or really is gone) and a second window
// keeps using the previous one until it restarts, which is exactly why this must
// not render as an unqualified success.
//
// It is a CAVEAT, not a failure, so it must not borrow `InlineError`'s
// destructive colour: telling the user their save failed is the opposite false
// report to the one this fixes. Warning tokens, and `text-foreground` for the
// body — `text-warning` on `bg-warning/10` measures 4.16:1, under the 4.5:1 AA
// bar for 12px text, so the tone rides on the border and the glyph instead
// (6.87:1 body / 4.16:1 glyph / 3.17:1 boundary on the settings card; 7.20 /
// 4.36 / 3.38 in the chat pane). That is also exactly how the app already paints
// a `warning` toast, so the same news looks the same wherever it lands.
//
// The wording is written for a SAVE because saving is the only key change the UI
// can currently make: `api.clearApiKey` has no production caller (checked
// 2026-08-15). A revocation needs its own sentence — the user believes access is
// already gone — so add one here when a "remove key" control appears rather than
// reusing this.

import { AlertTriangle, X } from "lucide-react";

/** Plain language on purpose: a user cannot act on "the revision could not be
 *  published", and can act on "restart your other window". Conditional on
 *  purpose too — a failed publish does not prove a second window exists, and
 *  asserting one that isn't there is its own false report. */
export const KEY_CHANGE_CAVEAT_MESSAGE =
  "Key saved. If NeuralNote is open in another window, that window will keep " +
  "using your previous key until you restart it.";

/** The completed-with-a-caveat notice raised after a key change that could not
 *  be announced to the app's other windows.
 *
 *  `role="alert"` for the announcement, not for the tone: it always appears as
 *  the direct result of pressing Save, and both surfaces move on underneath it
 *  (the settings form closes, the chat pane swaps to the transcript), so a
 *  polite region mounted with its text already inside it is not reliably read
 *  out. Assertive insertion is — and it is what `NotePane` already uses for the
 *  same shape of banner. */
export function KeyChangeCaveat({ onDismiss }: Readonly<{ onDismiss: () => void }>) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-[0.75rem] leading-snug text-foreground"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{KEY_CHANGE_CAVEAT_MESSAGE}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss this notice"
        className="-my-0.5 grid min-h-6 min-w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
