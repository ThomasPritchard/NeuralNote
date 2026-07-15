// The app settings surface: a modal with a left section nav (VS Code /
// Obsidian style) and a content pane. Radix owns the modal layer, focus trap,
// Escape handling, and focus return. The accessible backdrop-click affordance
// matches ConfirmDialog. The dialog body is mounted
// fresh per open (`open ? … : null`) so section state, initial focus, and the
// AI page's data loads all reset naturally.

import { useRef, useState } from "react";
import {
  Info,
  LayoutTemplate,
  Megaphone,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { AiMark } from "@/components/neural/patterns";
import { cn } from "../lib/cn";
import { AiSettingsPage } from "./AiSettingsPage";
import { SkillsSettingsPage } from "./SkillsSettingsPage";
import { GeneralSettingsPage } from "./GeneralSettingsPage";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";
import { TemplatesSettingsPage } from "./TemplatesSettingsPage";
import { ReleaseNotesArticle } from "../whats-new/ReleaseNotesArticle";

export type SettingsSection =
  | "whatsNew"
  | "general"
  | "appearance"
  | "templates"
  | "ai"
  | "skills"
  | "about";

const SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "whatsNew", label: "What's new", icon: Megaphone },
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "skills", label: "Skills", icon: Wand2 },
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
        <AiMark className="size-11 rounded-xl" />
        <div className="flex flex-col gap-1">
          <p className="nn-heading text-[0.875rem] font-semibold text-foreground">
            NeuralNote
          </p>
          <p className="max-w-[28rem] text-[0.75rem] leading-relaxed text-muted-foreground">
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
  const dialogRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={dialogRef}
        hideClose
        className="flex h-[min(82vh,42rem)] max-w-4xl flex-col overflow-hidden p-0 sm:flex-row"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogRef.current?.focus();
        }}
      >
      <button
        type="button"
        aria-label="Dismiss settings"
        tabIndex={-1}
        onClick={onClose}
        className="sr-only"
      />
      <DialogTitle className="sr-only">Settings</DialogTitle>
      <DialogDescription className="sr-only">
        Review what's new and configure general behaviour, appearance,
        templates, AI, skills, and application information.
      </DialogDescription>
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-sidebar/60 p-3 sm:hidden">
          <span className="nn-heading text-sm font-semibold text-foreground">
            Settings
          </span>
          <select
            aria-label="Settings section"
            value={section}
            onChange={(event) => setSection(event.currentTarget.value as SettingsSection)}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SECTIONS.map((settingsSection) => (
              <option key={settingsSection.id} value={settingsSection.id}>
                {settingsSection.label}
              </option>
            ))}
          </select>
        </div>
        <nav
          aria-label="Settings sections"
          className="hidden w-48 shrink-0 flex-col gap-1 border-r border-border bg-sidebar/60 p-3 sm:flex sm:w-48"
        >
          <h2 className="nn-heading w-full px-2.5 pb-2 pt-1 text-sm font-semibold text-foreground">
            Settings
          </h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? "true" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
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
          <IconButton
            label="Close settings"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 size-7"
          >
            <X className="size-4" aria-hidden />
          </IconButton>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {section === "whatsNew" && <ReleaseNotesArticle />}
            {section === "general" && <GeneralSettingsPage />}
            {section === "appearance" && <AppearanceSettingsPage />}
            {section === "templates" && <TemplatesSettingsPage />}
            {section === "ai" && <AiSettingsPage />}
            {section === "skills" && <SkillsSettingsPage />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsModal({
  open,
  onClose,
  initialSection = "whatsNew",
}: Readonly<{
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}>) {
  if (!open) return null;
  return <SettingsDialog onClose={onClose} initialSection={initialSection} />;
}
