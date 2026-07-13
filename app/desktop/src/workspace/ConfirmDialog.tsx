import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  onCancel,
}: Readonly<ConfirmDialogProps>) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        role="alertdialog"
        hideClose
        className="max-w-sm p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmRef.current?.focus();
        }}
      >
        <button
          type="button"
          aria-label="Dismiss dialog"
          tabIndex={-1}
          onClick={onCancel}
          className="sr-only"
        />
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-2">{message}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button tone="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            tone={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
