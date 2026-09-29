// A key save succeeded, but other windows were not notified to invalidate
// cached credentials. Keep this caveat distinct from a failed keychain write.

import { AlertTriangle, X } from "lucide-react";

export const KEY_CHANGE_CAVEAT_MESSAGE =
  "Key saved. If NeuralNote is open in another window, that window will keep " +
  "using your previous key until you restart it.";

/** Assertive announcement survives the save form closing. Foreground body text
 *  preserves contrast; warning tokens identify the caveat on its border/icon. */
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
