// The app settings surface: a modal with a left section nav (VS Code /
// Obsidian style) and a content pane. A native <dialog> opened with
// showModal(): the top layer makes everything outside inert (the focus trap),
// and focus is handed back to the opener on close. The accessible
// backdrop-click affordance matches ConfirmDialog. The dialog body is mounted
// fresh per open (`open ? … : null`) so section state, initial focus, and the
// AI page's data loads all reset naturally.

import { useEffect, useRef, useState } from "react";
import { Brain, Info, Sparkles, X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { AiSettingsPage } from "./AiSettingsPage";

export type SettingsSection = "ai" | "about";

// No "General" section yet: a nav entry whose page is only "coming soon" copy
// is a shipped placeholder (PA-017). Reintroduce the id + entry here alongside
// the first real general setting.
const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "ai", label: "Configure the AI", icon: Sparkles },
  { id: "about", label: "About", icon: Info },
];

function AboutSection() {
  return (
    <section aria-labelledby="settings-about-heading" className="flex flex-col gap-4">
      <h3
        id="settings-about-heading"
        className="nn-heading text-sm font-semibold text-foreground"
      >
        About
      </h3>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_22px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
          <Brain className="size-5" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <p className="nn-heading text-[14px] font-semibold text-foreground">
            NeuralNote
          </p>
          <p className="max-w-[28rem] text-[12px] leading-relaxed text-muted-foreground">
            An AI-native second brain. Your notes stay plain, Obsidian-compatible
            markdown on your disk, while the AI answers questions across them —
            with citations back to the exact source.
          </p>
        </div>
      </div>
    </section>
  );
}

function SettingsDialog({
  onClose,
  initialSection,
}: Readonly<{ onClose: () => void; initialSection: SettingsSection }>) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open as a native modal — showModal() puts the dialog in the top layer and
  // makes the rest of the document inert, which is the focus trap the old
  // hand-rolled Tab loop provided. Take focus on open; hand it back to the
  // opener on close (best-effort — the opener may itself have unmounted, in
  // which case focus simply stays put). The `open` guard keeps StrictMode's
  // dev double-mount from calling showModal() on an already-open dialog.
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.focus();
    return () => {
      // Leave the top layer BEFORE restoring focus: while the dialog is still
      // modal, everything outside it is inert and opener.focus() is silently
      // ignored (verified in real Chromium). `dialog` is closure-captured —
      // the ref may already be nulled by the time this cleanup runs.
      if (dialog?.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Esc closes. An explicit document-level listener (rather than the native
  // cancel path alone) keeps the close under React's control and observable in
  // jsdom; its preventDefault() also stops the UA turning the same keystroke
  // into a cancel/close pass of its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // The <dialog> is styled as the full-screen overlay itself (UA fit-content
    // sizing, border, and Canvas colours reset), so the ::backdrop goes
    // transparent — the overlay already dims and blurs the app behind it.
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      onCancel={(e) => {
        // A UA close request that bypassed the keydown listener: keep the
        // close under React's control — the dialog unmounts rather than being
        // left mounted with [open] silently removed.
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-50 m-0 grid h-full max-h-none w-full max-w-none place-items-center border-0 bg-background/70 p-4 text-foreground backdrop-blur-sm focus:outline-none [&::backdrop]:bg-transparent"
    >
      {/* Same accessible click-outside affordance as ConfirmDialog: a real
          <button> kept out of the tab order; the panel is a sibling, so inside
          clicks never reach it. */}
      <button
        type="button"
        aria-label="Dismiss settings"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 cursor-default"
      />
      <div className="relative flex h-[min(80vh,40rem)] w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <nav
          aria-label="Settings sections"
          className="flex w-48 shrink-0 flex-col gap-1 border-r border-border bg-sidebar/60 p-3"
        >
          <h2
            id="settings-title"
            className="nn-heading px-2.5 pb-2 pt-1 text-sm font-semibold text-foreground"
          >
            Settings
          </h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? "true" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                section === s.id
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <s.icon className="size-4 shrink-0" aria-hidden />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {section === "ai" && <AiSettingsPage />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </dialog>
  );
}

export function SettingsModal({
  open,
  onClose,
  initialSection = "ai",
}: Readonly<{
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}>) {
  if (!open) return null;
  return <SettingsDialog onClose={onClose} initialSection={initialSection} />;
}
