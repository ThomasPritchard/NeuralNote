// The one confirmation that stands between a user and YOLO mode (§9.6.5).
//
// **The list of irreversible actions is GENERATED, never written here.** It
// arrives on `aiStatus.approval.irreversibleActions`, which Rust derives from
// the same reversibility table the gate itself consults. That is a safety
// mechanism, not a convenience: classifying a new tool as irreversible changes
// what this warning says, and a hand-written list would let a newly-destructive
// tool ship without anyone noticing it had been left out of the sentence.
//
// The only thing this file composes is the grammar joining the items, and the
// paragraph around them — which is exactly what the golden test pins, as a
// literal string. Asserting the rendered list equals the derived list would
// compare a value against its own source and pass forever.
//
// Two deliberate choices about the controls, both because this is a permission
// being widened rather than a task being completed:
//
//   • Cancel takes focus. The confirmation exists to be READ; opening it with
//     the destructive action pre-armed hands a return-key reflex the outcome the
//     dialog was written to prevent.
//   • The confirm button is the destructive tone, not the primary one. Primary
//     means "the thing you probably came here to do".
//
// ONE confirmation, on entry, and never again. No per-run banner and no
// "are you sure?" before each write: a mode that re-asks is a mode users
// click-train themselves out of reading, which would spend the single moment
// this warning actually lands. The standing indicator, not repetition, is what
// keeps the mode visible afterwards.

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { listSentence, YOLO_CONFIRM } from "./approvalCopy";

export function YoloConfirmDialog({
  irreversibleActions,
  onConfirm,
  onCancel,
}: Readonly<{
  /** From `aiStatus.approval.irreversibleActions` — plain-language consequences,
   *  in the order Rust generated them. Never a hand-written list. */
  irreversibleActions: readonly string[];
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const irreversible = listSentence(irreversibleActions);

  // Radix's own autofocus lands on the first focusable child; this moves it to
  // Cancel explicitly so the safe choice stays the default however the markup
  // is later reordered.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        role="alertdialog"
        hideClose
        className="max-w-md p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogTitle>{YOLO_CONFIRM.title}</DialogTitle>
        <div className="mt-3 flex flex-col gap-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          <p>{YOLO_CONFIRM.intro}</p>
          {irreversible !== null && (
            <p>
              {YOLO_CONFIRM.irreversibleLead}{" "}
              <strong className="font-semibold text-foreground">{irreversible}</strong>.
            </p>
          )}
          <p>{YOLO_CONFIRM.reassurance}</p>
          <p>{YOLO_CONFIRM.reversible}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} tone="ghost" onClick={onCancel}>
            {YOLO_CONFIRM.cancel}
          </Button>
          <Button tone="danger" onClick={onConfirm}>
            {YOLO_CONFIRM.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
