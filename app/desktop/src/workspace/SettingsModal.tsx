// The app settings surface: a modal with a left section nav (VS Code /
// Obsidian style) and a content pane. The overlay/backdrop/Esc idiom matches
// ConfirmDialog; being a full dialog rather than a one-question alert, it also
// traps Tab inside itself and hands focus back to the opener on close. The
// dialog body is mounted fresh per open (`open ? … : null`) so section state,
// initial focus, and the AI page's data loads all reset naturally.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Brain,
  Info,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { AiSettingsPage } from "./AiSettingsPage";

export type SettingsSection = "general" | "ai" | "about";

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "ai", label: "Configure the AI", icon: Sparkles },
  { id: "about", label: "About", icon: Info },
];

/** Everything focusable inside the panel; the tabIndex=-1 backdrop and panel
 *  itself are deliberately excluded so the trap cycles real controls only. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function GeneralSection() {
  return (
    <section aria-labelledby="settings-general-heading" className="flex flex-col gap-1.5">
      <h3
        id="settings-general-heading"
        className="nn-heading text-sm font-semibold text-foreground"
      >
        General
      </h3>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        More settings coming soon.
      </p>
    </section>
  );
}

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
            markdown on your disk, while the AI files, links, and recalls them —
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
  const panelRef = useRef<HTMLDivElement>(null);

  // Take focus on open; hand it back to the opener on close (best-effort — the
  // opener may itself have unmounted, in which case focus simply stays put).
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Keep Tab cycling inside the dialog (the modal contract aria-modal claims). */
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
      {/* Same accessible click-outside affordance as ConfirmDialog: a real
          <button> kept out of the tab order; the dialog is a sibling, so inside
          clicks never reach it. */}
      <button
        type="button"
        aria-label="Dismiss settings"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={trapTab}
        className="relative flex h-[min(80vh,40rem)] w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl focus:outline-none"
      >
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
            {section === "general" && <GeneralSection />}
            {section === "ai" && <AiSettingsPage />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
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
