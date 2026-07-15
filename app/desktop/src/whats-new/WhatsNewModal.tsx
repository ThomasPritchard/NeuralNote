import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePreferences } from "../preferences/preferences";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";

export function WhatsNewModal() {
  const { preferences, update } = usePreferences();
  const [open, setOpen] = useState(
    () => preferences.lastSeenWhatsNewVersion !== CURRENT_RELEASE_NOTES.version,
  );
  const dialogRef = useRef<HTMLDivElement>(null);

  const dismiss = () => {
    setOpen(false);
    void update(
      { lastSeenWhatsNewVersion: CURRENT_RELEASE_NOTES.version },
      "What's new acknowledged",
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent
        ref={dialogRef}
        className="flex max-h-[min(88vh,46rem)] max-w-3xl flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">{CURRENT_RELEASE_NOTES.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Release notes for the newly installed version of NeuralNote.
        </DialogDescription>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6 pt-7 sm:px-9">
          <ReleaseNotesArticle />
        </div>
        <footer className="flex shrink-0 justify-end border-t border-border bg-card/95 px-7 py-4 sm:px-9">
          <Button tone="primary" onClick={dismiss}>
            Continue to NeuralNote
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
