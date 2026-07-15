import { useEffect } from "react";
import { onQuarantineRecovery } from "../lib/api";
import type { QuarantineRecoveryEntry } from "../lib/bindings/QuarantineRecoveryEntry";
import { useToast, type ToastController } from "./ToastProvider";

// Surfaces the vault-open quarantine-recovery report (issue #18) so a crash-time
// note recovery is never silent. The `QUARANTINE_RECOVERY` event is emitted during
// `open_vault`, so this listener lives at app root (inside ToastProvider, above the
// workspace that remounts on every vault change) — otherwise the workspace might
// not be mounted yet when the event fires and the report would be dropped.
export function QuarantineRecoveryListener() {
  const toast = useToast();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onQuarantineRecovery((report) => {
      for (const entry of report.entries) surfaceEntry(toast, entry);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // A dead subscription only loses live recovery notices; reopening the
        // vault re-emits. Never throw from the listener setup.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [toast]);

  return null;
}

// Recovered / removed are informational; conflict and retained need the user to
// act (a note is parked under a hidden name, or a record couldn't be resolved),
// so they surface as warnings. The engine's own `message` is appended when present.
function surfaceEntry(toast: ToastController, entry: QuarantineRecoveryEntry): void {
  const dedupKey = `quarantine-recovery:${entry.status}:${entry.relPath}`;
  const detail = entry.message ? ` — ${entry.message}` : "";
  switch (entry.status) {
    case "recovered":
      toast.success(`Recovered "${entry.relPath}" after an interrupted undo${detail}`, { dedupKey });
      break;
    case "removedInterruptedWrite":
      toast.info(`Cleaned up an interrupted draft of "${entry.relPath}"${detail}`, { dedupKey });
      break;
    case "conflict":
      toast.warning(`"${entry.relPath}" couldn't be restored automatically${detail}`, { dedupKey });
      break;
    case "retained":
      toast.warning(`Kept a recovery record for "${entry.relPath}" to resolve${detail}`, { dedupKey });
      break;
  }
}
