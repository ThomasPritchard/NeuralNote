// One skill in the Skills settings list: its icon, name, description, and an
// enable switch, plus an inline save-failure alert and the skill's requirement
// rows (or an honest "no extra software needed" line). The card renders the
// enabled state the page reports as PERSISTED — never an optimistic flip — and
// owns none of the toggle/download state, which the composing page threads in.

import { FlaskConical, Wand2, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { SkillListing } from "../lib/types";
import { Switch } from "@/components/ui/switch";
import { LABEL } from "./KeySetupPanel";
import { InlineError } from "./ProviderCard";
import {
  SkillRequirementRow,
  requirementKey,
  type DownloadProgress,
} from "./SkillRequirementRow";

/** Manifest icon names → Lucide. Unknown names fall back to the wand — the
 *  skill iconography the picker and chips already use. */
const SKILL_ICONS: Record<string, LucideIcon> = { flask: FlaskConical };
const skillIcon = (name: string): LucideIcon => SKILL_ICONS[name] ?? Wand2;

/** A real switch: `role="switch"` + `aria-checked`, keyboard-operable as a
 *  button. `checked` is always the last PERSISTED state — the caller never
 *  feeds it an optimistic value. */
function EnableSwitch({
  checked,
  disabled,
  label,
  onToggle,
}: Readonly<{
  checked: boolean;
  /** A write in flight — transient, so native disabled is fine (contrast the
   *  reasoning chip's explanatory aria-disabled state). */
  disabled: boolean;
  label: string;
  onToggle: () => void;
}>) {
  return (
    <Switch
      checked={checked}
      aria-label={label}
      disabled={disabled}
      onCheckedChange={onToggle}
    />
  );
}

export function SkillCard({
  skill,
  toggling,
  toggleError,
  onToggle,
  download,
  cancelling,
  downloadErrors,
  onStartDownload,
  onCancelDownload,
}: Readonly<{
  skill: SkillListing;
  /** This skill's enable write is in flight — its switch disables. */
  toggling: boolean;
  /** An inline save-failure message for this skill, if the last write failed. */
  toggleError?: string;
  onToggle: () => void;
  /** The one in-flight download's freshest frame, or null — owned by the page. */
  download: DownloadProgress | null;
  cancelling: boolean;
  downloadErrors: Record<string, string>;
  onStartDownload: (name: string) => void;
  onCancelDownload: (name: string) => void;
}>) {
  const Icon = skillIcon(skill.icon);
  return (
    <section
      aria-label={skill.name}
      className="rounded-xl bg-background/40 p-4 ring-1 ring-inset ring-border"
    >
      <header className="flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition-colors",
            skill.enabled
              ? "bg-primary/10 text-primary ring-primary/20"
              : "bg-muted text-muted-foreground ring-border",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="nn-heading text-[0.8125rem] font-semibold text-foreground">
            {skill.name}
          </h4>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
            {skill.description}
          </p>
        </div>
        <EnableSwitch
          checked={skill.enabled}
          disabled={toggling}
          label={`Enable ${skill.name}`}
          onToggle={onToggle}
        />
      </header>

      <div className="mt-4 flex flex-col gap-2">
        {toggleError && (
          // Announced: a switch that silently failed to persist would leave the
          // user believing a state the config doesn't hold.
          <InlineError alert>
            Couldn&apos;t save the change: {toggleError}
          </InlineError>
        )}

        {skill.requirements.length === 0 ? (
          <p className="text-[0.6875rem] text-muted-foreground">
            No extra software needed.
          </p>
        ) : (
          <>
            <h5 id={`skill-reqs-${skill.id}`} className={LABEL}>
              Requirements
            </h5>
            <ul
              aria-labelledby={`skill-reqs-${skill.id}`}
              className="flex flex-col gap-2"
            >
              {skill.requirements.map((req) => (
                <SkillRequirementRow
                  key={requirementKey(req.requirement)}
                  req={req}
                  download={download}
                  cancelling={cancelling}
                  downloadErrors={downloadErrors}
                  onStartDownload={onStartDownload}
                  onCancelDownload={onCancelDownload}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
