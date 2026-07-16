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
//
// This module owns the catalogue/toggle/download state and orchestration; the
// presentational pieces live in siblings: one skill renders as `<SkillCard>`,
// and each of its requirements as a `<SkillRequirementRow>`.

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { PullEvent, SkillListing } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { InlineError, LoadingRow } from "./ProviderCard";
import { SkillCard } from "./SkillCard";
import type { DownloadProgress } from "./SkillRequirementRow";

/** The catalogue load as an explicit state machine — until it resolves the
 *  page can neither list skills nor claim there are none (the LocalAiCard
 *  installed-scan discipline). */
type CatalogueLoad =
  | { status: "loading" }
  | { status: "ready"; skills: SkillListing[] }
  | { status: "error"; message: string };

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

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h3 className="nn-heading text-sm font-semibold text-foreground">
          Skills
        </h3>
        <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
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
        load.skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            toggling={togglingId === skill.id}
            toggleError={toggleErrors[skill.id]}
            onToggle={() => void toggleSkill(skill)}
            download={download}
            cancelling={cancelling}
            downloadErrors={downloadErrors}
            onStartDownload={startDownload}
            onCancelDownload={cancelDownload}
          />
        ))}
    </div>
  );
}
