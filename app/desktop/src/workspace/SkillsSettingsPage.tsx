// The "Skills" settings page: every built-in skill the backend ships, with
// its requirement statuses and an enable switch. The catalogue's source of
// truth is the Rust `SkillRegistry` via `listSkills()` — this page never
// holds a frontend copy. The enable switch renders the state
// `setSkillEnabled` reports back from disk, never the optimistic value: a
// toggle that silently failed to persist would show a skill as off while the
// registry still activates it (or the reverse). Requirement downloads stream
// the same `PullEvent` channel as local-model pulls (one at a time, one
// cancel channel). Every failure lands inline next to the thing that failed —
// never a silent blank. Creating or importing skills is deferred, so the page
// says nothing about it.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FlaskConical,
  RefreshCw,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type {
  PullEvent,
  Requirement,
  RequirementStatus,
  SkillListing,
  SkillRequirement,
} from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { LABEL } from "./KeySetupPanel";
import { InlineError, LoadingRow } from "./ProviderCard";

const GIB = 1024 ** 3;
/** Whole-GB label for the free-disk-space requirement. */
const wholeGb = (bytes: number) => `${Math.round(bytes / GIB)} GB`;
/** One-decimal GB label for download progress sizes. */
const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/** Manifest icon names → Lucide. Unknown names fall back to the wand — the
 *  skill iconography the picker and chips already use. */
const SKILL_ICONS: Record<string, LucideIcon> = { flask: FlaskConical };
const skillIcon = (name: string): LucideIcon => SKILL_ICONS[name] ?? Wand2;

/** The catalogue load as an explicit state machine — until it resolves the
 *  page can neither list skills nor claim there are none (the LocalAiCard
 *  installed-scan discipline). */
type CatalogueLoad =
  | { status: "loading" }
  | { status: "ready"; skills: SkillListing[] }
  | { status: "error"; message: string };

/** The freshest streamed frame for the one in-flight requirement download. */
interface DownloadProgress {
  requirement: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
}

// State-updater factories, named at module level so the promise chains that
// use them stay within Sonar's callback-nesting depth (the LocalAiCard S2004
// precedent).

/** Record an inline error under `key` (a skill id or requirement name). */
const withKeyedError =
  (key: string, message: string) =>
  (prev: Record<string, string>): Record<string, string> => ({
    ...prev,
    [key]: message,
  });

/** Clear the inline error under `key`, if any. */
const withoutKey =
  (key: string) =>
  (prev: Record<string, string>): Record<string, string> => {
    const next = { ...prev };
    delete next[key];
    return next;
  };

/** Render the enabled state the backend reported as persisted — the write's
 *  echo, applied to the one skill it names. */
const withPersistedEnabled =
  (id: string, enabled: boolean) =>
  (prev: CatalogueLoad): CatalogueLoad =>
    prev.status === "ready"
      ? {
          status: "ready",
          skills: prev.skills.map((s) => (s.id === id ? { ...s, enabled } : s)),
        }
      : prev;

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

/** One requirement's human label. Binary and asset names render in mono —
 *  they're program/file names, and mono is the app's register for those. An
 *  asset (a downloadable data file, not an executable) carries a prose
 *  "Required file:" prefix so it never reads as a program the way a bare
 *  binary name does. */
function requirementLabel(r: Requirement): {
  /** Prose lead-in, rendered outside the mono register. */
  prefix?: string;
  text: string;
  mono: boolean;
} {
  switch (r.type) {
    case "binary":
      return { text: r.name, mono: true };
    case "asset":
      return { prefix: "Required file: ", text: r.name, mono: true };
    case "freeDiskSpace":
      return { text: `${wholeGb(r.minBytes)} free disk space`, mono: false };
    case "platform":
      return { text: `${r.os} / ${r.arch}`, mono: false };
  }
}

/** A stable per-requirement key (requirements have no id of their own). */
function requirementKey(r: Requirement): string {
  switch (r.type) {
    case "binary":
      return `bin:${r.name}`;
    case "asset":
      return `asset:${r.name}`;
    case "freeDiskSpace":
      return `disk:${r.minBytes}`;
    case "platform":
      return `plat:${r.os}:${r.arch}`;
  }
}

/** The status chip: installed / missing / couldn't check. "Missing" and
 *  "couldn't check" are different claims — an undetected requirement may well
 *  be present, so it never renders as missing. */
function StatusChip({ status }: Readonly<{ status: RequirementStatus }>) {
  if (status.status === "installed") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Check className="size-2.5" aria-hidden />
        Installed
      </span>
    );
  }
  if (status.status === "undetected") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <AlertTriangle className="size-2.5" aria-hidden />
        Couldn&apos;t check
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive ring-1 ring-inset ring-destructive/30">
      <AlertTriangle className="size-2.5" aria-hidden />
      Missing
    </span>
  );
}

/** The backend's reasons, as plain visible text — readable by everyone,
 *  screen readers included; never a tooltip. */
function ReasonList({ reasons }: Readonly<{ reasons: readonly string[] }>) {
  if (reasons.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {reasons.map((reason, i) => (
        <li
          key={`${reason}-${i}`}
          className="text-[11px] leading-snug text-muted-foreground"
        >
          {reason}
        </li>
      ))}
    </ul>
  );
}

function statusReasons(status: RequirementStatus): string[] {
  switch (status.status) {
    case "installed":
      return [];
    case "unmet":
    case "undetected":
      return [...status.reasons];
    case "unmetAndUndetected":
      return [...status.unmet, ...status.undetected];
  }
}

export function SkillsSettingsPage() {
  const [load, setLoad] = useState<CatalogueLoad>({ status: "loading" });
  /** The one skill whose enable write is in flight (its switch disables). */
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleErrors, setToggleErrors] = useState<Record<string, string>>({});
  // One requirement download at a time — mirrors the single cancel channel.
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(async () => {
    // A retry from the error state re-enters loading (visible progress); the
    // post-download refresh replaces ready in place.
    setLoad((prev) => (prev.status === "error" ? { status: "loading" } : prev));
    try {
      setLoad({ status: "ready", skills: await api.listSkills() });
    } catch (e) {
      setLoad({ status: "error", message: errorMessage(e) });
    }
  }, []);

  // Initial load; guards `cancelled` so a late resolve can't write into a
  // closed settings dialog (the AiSettingsPage discipline).
  useEffect(() => {
    let cancelled = false;
    void api
      .listSkills()
      .then((skills) => {
        if (!cancelled) setLoad({ status: "ready", skills });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSkill = async (skill: SkillListing) => {
    setTogglingId(skill.id);
    setToggleErrors(withoutKey(skill.id));
    try {
      // Render what the write persisted, never the flipped value — the same
      // rationale as the reasoning toggle: if persistence failed, showing the
      // switch flipped would lie about what the registry will do.
      const persisted = await api.setSkillEnabled(skill.id, !skill.enabled);
      setLoad(withPersistedEnabled(skill.id, persisted));
    } catch (e) {
      setToggleErrors(withKeyedError(skill.id, errorMessage(e)));
    } finally {
      // Guarded clear: only the toggle that owns the slot may empty it, so a
      // slow write for skill A settling late can't re-enable skill B's switch
      // while B's own write is still in flight.
      setTogglingId((prev) => (prev === skill.id ? null : prev));
    }
  };

  const startDownload = (requirement: string) => {
    setDownloadErrors(withoutKey(requirement));
    setCancelling(false);
    setDownload({
      requirement,
      status: "starting…",
      completed: null,
      total: null,
      percent: null,
    });
    const onEvent = (ev: PullEvent) => {
      if (ev.type === "progress") {
        setDownload({
          requirement,
          status: ev.status,
          completed: ev.completed,
          total: ev.total,
          percent: ev.percent,
        });
      } else if (ev.type === "error") {
        // The one terminal failure frame (including cancellation) — inline,
        // on the requirement that was downloading.
        setDownloadErrors(withKeyedError(requirement, ev.message));
      } else {
        // Terminal success: re-read the catalogue so the backend re-evaluates
        // every requirement status — the page never marks one installed itself.
        void refresh();
      }
    };
    void api
      .downloadRequirement(requirement, onEvent)
      // A transport-level rejection takes the same inline lane as a streamed
      // terminal error — never silent.
      .catch((e) => setDownloadErrors(withKeyedError(requirement, errorMessage(e))))
      .finally(() => setDownload(null));
  };

  const cancelDownload = (requirement: string) => {
    setCancelling(true);
    void api
      .cancelRequirementDownload()
      .catch((e) => setDownloadErrors(withKeyedError(requirement, errorMessage(e))));
  };

  /** The action slot for one requirement row: Cancel while it downloads,
   *  Download for a missing binary, nothing otherwise (disk space and
   *  platform aren't downloadable). Assets are downloadable in principle,
   *  but the whole download pipeline is binary-specific today — the Rust
   *  command resolves names against the compiled-in BINARY allowlist and
   *  installs into bin/ with executable permissions, which is the wrong
   *  treatment for a data file — so an asset row offers no Download yet. */
  // TODO(asset-download-ui): offer Download for non-installed assets once the
  // backend grows a kind-agnostic (or asset-specific) download path.
  const requirementAction = (req: SkillRequirement): ReactNode => {
    if (req.requirement.type !== "binary") return null;
    const name = req.requirement.name;
    if (download?.requirement === name) {
      return (
        <button
          type="button"
          onClick={() => cancelDownload(name)}
          disabled={cancelling}
          className={buttonVariants({ tone: "quiet", size: "sm" })}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      );
    }
    if (req.status.status === "installed") return null;
    return (
      <button
        type="button"
        onClick={() => startDownload(name)}
        // One download at a time (a single cancel channel).
        disabled={download !== null}
        className={buttonVariants({ tone: "quiet", size: "sm" })}
      >
        <Download className="size-3.5" aria-hidden />
        Download
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h3 className="nn-heading text-sm font-semibold text-foreground">
          Skills
        </h3>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Built-in workflows the AI can run in chat. Add one to a message by
          typing @ in the composer; switch one off to keep it out of the picker.
        </p>
      </header>

      {load.status === "loading" && <LoadingRow label="Loading skills…" />}

      {load.status === "error" && (
        <div className="flex flex-col items-start gap-2">
          <InlineError>Couldn&apos;t load skills: {load.message}</InlineError>
          <button
            type="button"
            onClick={() => void refresh()}
            className={buttonVariants({ tone: "quiet", size: "sm" })}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Retry
          </button>
        </div>
      )}

      {load.status === "ready" &&
        load.skills.map((skill) => {
          const Icon = skillIcon(skill.icon);
          return (
            <section
              key={skill.id}
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
                  <h4 className="nn-heading text-[13px] font-semibold text-foreground">
                    {skill.name}
                  </h4>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {skill.description}
                  </p>
                </div>
                <EnableSwitch
                  checked={skill.enabled}
                  disabled={togglingId === skill.id}
                  label={`Enable ${skill.name}`}
                  onToggle={() => void toggleSkill(skill)}
                />
              </header>

              <div className="mt-4 flex flex-col gap-2">
                {toggleErrors[skill.id] && (
                  // Announced: a switch that silently failed to persist would
                  // leave the user believing a state the config doesn't hold.
                  <InlineError alert>
                    Couldn&apos;t save the change: {toggleErrors[skill.id]}
                  </InlineError>
                )}

                {skill.requirements.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
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
                      {skill.requirements.map((req) => {
                        const label = requirementLabel(req.requirement);
                        const key = requirementKey(req.requirement);
                        const name =
                          req.requirement.type === "binary"
                            ? req.requirement.name
                            : null;
                        const downloading =
                          name !== null && download?.requirement === name;
                        return (
                          <li
                            key={key}
                            className="flex flex-col gap-1.5 rounded-lg bg-background/50 px-3 py-2 ring-1 ring-inset ring-border"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[12px] font-medium text-foreground">
                                {label.prefix}
                                <span className={cn(label.mono && "nn-mono")}>
                                  {label.text}
                                </span>
                              </span>
                              <StatusChip status={req.status} />
                              <span className="ml-auto">
                                {requirementAction(req)}
                              </span>
                            </div>
                            <ReasonList reasons={statusReasons(req.status)} />
                            {downloading && download && (
                              <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                  <span className="min-w-0 truncate">
                                    {download.status}
                                  </span>
                                  <span className="nn-mono shrink-0">
                                    {download.completed != null &&
                                    download.total != null
                                      ? `${gb(download.completed)} / ${gb(download.total)}`
                                      : ""}
                                    {download.percent == null
                                      ? ""
                                      : ` · ${Math.round(download.percent)}%`}
                                  </span>
                                </div>
                                <Progress
                                  aria-label={`Downloading ${name}`}
                                  value={download.percent ?? 0}
                                />
                              </div>
                            )}
                            {name !== null && downloadErrors[name] && (
                              <InlineError alert>{downloadErrors[name]}</InlineError>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            </section>
          );
        })}
    </div>
  );
}
