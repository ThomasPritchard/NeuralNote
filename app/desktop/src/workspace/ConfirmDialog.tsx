// A small, themed confirmation modal. Shared by the destructive delete action
// in the tree and the "discard unsaved edits" guard when navigating away.

import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" tints the confirm button destructive (e.g. delete). */
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
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
      {/* Click-outside-to-dismiss as a real <button> so the affordance is
          keyboard- and screen-reader-accessible (a div backdrop with onClick is
          a non-native interactive element). tabIndex={-1} keeps it out of the
          tab order — keyboard users dismiss via Esc or the Cancel button — while
          mouse users can still click the backdrop. The dialog is a sibling (not
          a descendant), so clicks inside it never reach this button; no
          stopPropagation needed. */}
      <button
        type="button"
        aria-label="Dismiss dialog"
        tabIndex={-1}
        onClick={onCancel}
        className="fixed inset-0 cursor-default"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl"
      >
        <h2 id="confirm-title" className="nn-heading text-sm font-semibold text-foreground">
          {title}
        </h2>
        <p id="confirm-message" className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2",
              tone === "danger"
                ? "bg-destructive text-primary-foreground hover:opacity-90 focus-visible:ring-destructive"
                : "bg-primary text-primary-foreground hover:opacity-90 focus-visible:ring-primary",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
