// The Local AI card's curated catalogue: one row per allowlisted model with its
// size / RAM floor / licence, optional Hugging Face transparency metadata, the
// action slot (Download / Cancel / Checking / Installed), streamed pull progress,
// and any inline pull error. Purely presentational — the card owns the loads and
// the pull channel and hands them down; the allowlist is the source of truth for
// what may be installed (it protects cited chat's tool-calling).

import { type ReactNode } from "react";
import { Check, Download } from "lucide-react";
import { cn } from "../lib/cn";
import type { CandidateModel, HfModelMeta } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { gb, wholeGb } from "./localAiFormat";
import type { InstalledScan, PullProgress } from "./localAiTypes";
import { LABEL } from "./KeySetupPanel";
import { InlineError, LoadingRow } from "./ProviderCard";

const COMPACT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
/** "12 Jun 2026", or null when HF hands back an unparseable timestamp. */
const fmtDate = (iso: string): string | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : DATE.format(d);
};

/** A catalogue row's HF transparency fragments — "1.2M downloads", the
 *  licence, "updated 12 Jun 2026" — skipping whatever HF didn't provide.
 *  Absent metadata (lookup failed or still in flight) → no fragments. */
const hfMetaBits = (meta: HfModelMeta | undefined): string[] => {
  if (!meta) return [];
  const updated = meta.lastModified ? fmtDate(meta.lastModified) : null;
  return [
    meta.downloads == null ? null : `${COMPACT.format(meta.downloads)} downloads`,
    meta.license,
    updated ? `updated ${updated}` : null,
  ].filter((bit): bit is string => bit != null);
};

interface LocalAiCatalogueProps {
  candidates: CandidateModel[] | null;
  candidatesError: string | null;
  /** HF transparency metadata by hfRepo; a missing key means "lookup failed or
   *  still in flight" and the row simply renders without the metadata line. */
  hfMeta: Record<string, HfModelMeta>;
  recommendedTag: string | null;
  installedScan: InstalledScan;
  pull: PullProgress | null;
  pullErrors: Record<string, string>;
  cancelling: boolean;
  onStartPull: (tag: string) => void;
  onCancelPull: (tag: string) => void;
}

export function LocalAiCatalogue({
  candidates,
  candidatesError,
  hfMeta,
  recommendedTag,
  installedScan,
  pull,
  pullErrors,
  cancelling,
  onStartPull,
  onCancelPull,
}: Readonly<LocalAiCatalogueProps>) {
  // Only a RESOLVED scan may claim a model is installed; every other status
  // is handled explicitly by catalogueAction below.
  const installedTags = new Set(
    installedScan.status === "ready"
      ? installedScan.models.map((m) => m.tag)
      : [],
  );

  /** The action slot for one catalogue row — an explicit function of the
   *  in-flight pull and the installed scan, so "scan still running" can never
   *  silently read as "not installed, offer Download". */
  const catalogueAction = (c: CandidateModel): ReactNode => {
    if (pull?.tag === c.tag) {
      return (
        <button
          type="button"
          onClick={() => onCancelPull(c.tag)}
          disabled={cancelling}
          className={buttonVariants({ tone: "quiet", size: "sm" })}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      );
    }
    // Still determining what's installed: show that a check is running and
    // offer nothing — neither Download nor Installed is knowable yet.
    if (installedScan.status === "checking") {
      return <LoadingRow label="Checking…" />;
    }
    // Known installed → the Installed chip carries the state; no action.
    if (installedScan.status === "ready" && installedTags.has(c.tag)) {
      return null;
    }
    return (
      <button
        type="button"
        onClick={() => onStartPull(c.tag)}
        // One pull at a time (a single cancel channel) — and held while the
        // installed scan is in error: we can't verify the model isn't already
        // on disk, so the failure fails safe (the Installed section surfaces
        // it with a Retry).
        disabled={pull !== null || installedScan.status === "error"}
        className={cn(
          "flex items-center gap-1.5",
          c.tag === recommendedTag
            ? buttonVariants({ tone: "primary", size: "sm" })
            : buttonVariants({ tone: "quiet", size: "sm" }),
        )}
      >
        <Download className="size-3.5" aria-hidden />
        Download
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <h5 id="ai-model-catalogue" className={LABEL}>
        Model catalogue
      </h5>
      {!candidates && !candidatesError && (
        <LoadingRow label="Loading the model catalogue…" />
      )}
      {candidatesError && <InlineError>{candidatesError}</InlineError>}
      {candidates && (
        <ul aria-labelledby="ai-model-catalogue" className="flex flex-col gap-2">
          {candidates.map((c) => {
            const metaBits = hfMetaBits(hfMeta[c.hfRepo]);
            const pulling = pull?.tag === c.tag;
            const isInstalled =
              installedScan.status === "ready" && installedTags.has(c.tag);
            return (
              <li
                key={c.tag}
                className="flex flex-col gap-2 rounded-lg bg-background/50 p-3 ring-1 ring-inset ring-border"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="nn-mono text-[0.8125rem] font-medium text-foreground">
                    {c.tag}
                  </span>
                  {c.tag === recommendedTag && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[0.625rem] font-medium text-primary ring-1 ring-inset ring-primary/30">
                      Recommended
                    </span>
                  )}
                  {isInstalled && (
                    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
                      <Check className="size-2.5" aria-hidden />
                      Installed
                    </span>
                  )}
                  <span className="ml-auto">{catalogueAction(c)}</span>
                </div>
                <p className="text-[0.6875rem] text-muted-foreground">
                  {c.params} · {gb(c.downloadBytes)} download · needs{" "}
                  {wholeGb(c.minRamBytes)} RAM · {c.license}
                </p>
                {metaBits.length > 0 && (
                  <p className="text-[0.6875rem] text-muted-foreground/70">
                    {metaBits.join(" · ")}
                  </p>
                )}
                {pulling && pull && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground">
                      <span className="min-w-0 truncate">{pull.status}</span>
                      <span className="nn-mono shrink-0">
                        {pull.completed != null && pull.total != null
                          ? `${gb(pull.completed)} / ${gb(pull.total)}`
                          : ""}
                        {pull.percent == null
                          ? ""
                          : ` · ${Math.round(pull.percent)}%`}
                      </span>
                    </div>
                    <Progress
                      aria-label={`Downloading ${c.tag}`}
                      value={pull.percent ?? 0}
                    />
                  </div>
                )}
                {pullErrors[c.tag] && (
                  <InlineError>{pullErrors[c.tag]}</InlineError>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
