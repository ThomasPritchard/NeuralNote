// The Local AI provider card: hardware readout, model recommendation, the
// curated catalogue with streamed pulls, and the installed-model list. Owns
// all of its data loading through the api.ts seam; the page (AiSettingsPage)
// hands it the shared status and the one provider-switch channel. Every
// failure lands inline next to the thing that failed — never a silent blank —
// with one deliberate exception: the Hugging Face transparency metadata is
// non-fatal by contract (types.ts HfModelMeta), so a failed lookup just omits
// that row's metadata line instead of erroring the card.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Cpu, Download, RefreshCw, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type {
  AiStatus,
  CandidateModel,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  PullEvent,
  Recommendation,
} from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ConfirmDialog } from "./ConfirmDialog";
import { LABEL } from "./KeySetupPanel";
import { ActiveBadge, InlineError, LoadingRow, ProviderCard } from "./ProviderCard";

const GIB = 1024 ** 3;
/** Whole-GB label for memory sizes (hardware readout, min-RAM). */
const wholeGb = (bytes: number) => `${Math.round(bytes / GIB)} GB`;
/** One-decimal GB label for download/disk sizes. */
const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

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

/** The installed-model scan as one explicit state machine. `checking` is a
 *  real state, distinct from "not installed": until the scan resolves (or
 *  after it fails) the catalogue can neither claim a model is Installed nor
 *  offer Download — treating "not yet known" as "not installed" is how an
 *  already-installed model got offered for a multi-gigabyte re-download. */
type InstalledScan =
  | { status: "checking" }
  | { status: "ready"; models: InstalledModel[] }
  | { status: "error"; message: string };

/** The freshest streamed pull frame for the one in-flight download. */
interface PullProgress {
  tag: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
}

// State-updater factories, named at module level so the promise chains that use
// them stay within Sonar's callback-nesting depth (S2004).

/** Merge one repo's HF transparency metadata into the map. */
const withHfMeta =
  (repo: string, meta: HfModelMeta) =>
  (prev: Record<string, HfModelMeta>): Record<string, HfModelMeta> => ({
    ...prev,
    [repo]: meta,
  });

/** Record `tag`'s pull failure, inline on the row that was downloading. */
const withPullError =
  (tag: string, message: string) =>
  (prev: Record<string, string>): Record<string, string> => ({
    ...prev,
    [tag]: message,
  });

interface LocalAiCardProps {
  status: AiStatus | null;
  /** True while either card's provider switch is in flight — one switch at a
   *  time, so both cards' activate buttons disable together. */
  switching: boolean;
  /** Make `tag` the active local model (the page's switch channel).
   *  Rejects with the api error so this card can surface it inline. */
  onActivate: (tag: string) => Promise<void>;
  /** Re-read the AI status after a change (the page owns the status). */
  refreshStatus: () => Promise<void>;
}

export function LocalAiCard({
  status,
  switching,
  onActivate,
  refreshStatus,
}: Readonly<LocalAiCardProps>) {
  // Each load owns its own error slot so one failed probe never blanks the rest.
  const [hardware, setHardware] = useState<HardwareSpec | null>(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateModel[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  /** HF transparency metadata by hfRepo; a missing key means "lookup failed or
   *  still in flight" and the row simply renders without the metadata line. */
  const [hfMeta, setHfMeta] = useState<Record<string, HfModelMeta>>({});
  /** checking → ready | error; the render switches on the status, so an
   *  unresolved scan can never be read as an empty (all-downloadable) list. */
  const [installedScan, setInstalledScan] = useState<InstalledScan>({
    status: "checking",
  });

  // Card actions. One pull at a time — mirrors the single cancel_pull.
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [pullErrors, setPullErrors] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [localActionError, setLocalActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InstalledModel | null>(null);

  const refreshInstalled = useCallback(async () => {
    // A retry from the error state re-enters `checking` (visible progress);
    // a background refresh after a pull or delete keeps the last good list
    // on screen instead of blanking it.
    setInstalledScan((prev) =>
      prev.status === "error" ? { status: "checking" } : prev,
    );
    try {
      setInstalledScan({ status: "ready", models: await api.listLocalModels() });
    } catch (e) {
      // The sidecar failing to start lands here — surfaced, with a retry.
      setInstalledScan({ status: "error", message: errorMessage(e) });
    }
  }, []);

  // One parallel load per concern on mount; each guards `cancelled` so a
  // late resolve can't write into a closed settings dialog.
  useEffect(() => {
    let cancelled = false;
    const guard =
      <T,>(set: (value: T) => void) =>
      (value: T) => {
        if (!cancelled) set(value);
      };

    void api
      .detectHardware()
      .then(guard(setHardware))
      .catch(guard((e: unknown) => setHardwareError(errorMessage(e))));
    void api
      .recommendLocalModel()
      .then(guard(setRecommendation))
      .catch(guard((e: unknown) => setRecommendationError(errorMessage(e))));
    void api
      .localCandidates()
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
        for (const c of list) {
          void api
            .hfModelMetadata(c.hfRepo)
            .then(guard((meta: HfModelMeta) => setHfMeta(withHfMeta(c.hfRepo, meta))))
            .catch(() => {
              // Non-fatal by contract: HF being unreachable means "no metadata",
              // never a blocked or erroring catalogue (types.ts HfModelMeta).
            });
        }
      })
      .catch(guard((e: unknown) => setCandidatesError(errorMessage(e))));
    void api
      .listLocalModels()
      .then(
        guard((models: InstalledModel[]) =>
          setInstalledScan({ status: "ready", models }),
        ),
      )
      .catch(
        guard((e: unknown) =>
          setInstalledScan({ status: "error", message: errorMessage(e) }),
        ),
      );

    return () => {
      cancelled = true;
    };
  }, []);

  const startPull = (tag: string) => {
    setPullErrors((prev) => {
      const next = { ...prev };
      delete next[tag];
      return next;
    });
    setCancelling(false);
    setPull({ tag, status: "starting…", completed: null, total: null, percent: null });
    const onEvent = (ev: PullEvent) => {
      if (ev.type === "progress") {
        setPull({
          tag,
          status: ev.status,
          completed: ev.completed,
          total: ev.total,
          percent: ev.percent,
        });
      } else if (ev.type === "error") {
        // The one terminal failure frame (including cancellation) — inline, on
        // the row that was downloading.
        setPullErrors(withPullError(tag, ev.message));
      } else {
        // Terminal success: the fresh model immediately becomes the provider.
        void onActivate(tag)
          .catch((e) => setPullErrors(withPullError(tag, errorMessage(e))));
        void refreshInstalled();
      }
    };
    void api
      .pullLocalModel(tag, onEvent)
      // A transport-level rejection (e.g. the sidecar died mid-pull) takes the
      // same inline lane as a streamed terminal error — never silent.
      .catch((e) => setPullErrors(withPullError(tag, errorMessage(e))))
      .finally(() => setPull(null));
  };

  const cancelPull = (tag: string) => {
    setCancelling(true);
    void api
      .cancelPull()
      .catch((e) => setPullErrors(withPullError(tag, errorMessage(e))));
  };

  // ("activate", not a `use` prefix — a plain event handler, and the hook
  // naming convention would misread it as a React hook.)
  const activateLocalModel = (tag: string) => {
    setLocalActionError(null);
    onActivate(tag).catch((e) => setLocalActionError(errorMessage(e)));
  };

  const confirmDelete = () => {
    const model = pendingDelete;
    if (!model) return;
    setPendingDelete(null);
    setLocalActionError(null);
    void api
      .deleteLocalModel(model.tag)
      .then(() => {
        void refreshInstalled();
        void refreshStatus(); // the deleted model may have been the active one
      })
      .catch((e) => setLocalActionError(errorMessage(e)));
  };

  const localActive = status?.activeProvider === "local";
  const recommendedTag =
    recommendation?.status === "supported" ? recommendation.modelTag : null;
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
          onClick={() => cancelPull(c.tag)}
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
        onClick={() => startPull(c.tag)}
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
    <>
      <ProviderCard
        icon={Cpu}
        title="Local AI"
        description="A model that runs entirely on this machine — private, no key needed."
        active={localActive}
      >
        {/* Hardware readout driving the recommendation. */}
        {hardware && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-background/50 px-3 py-2 text-[0.6875rem] text-muted-foreground ring-1 ring-inset ring-border">
            <span className="font-medium text-foreground/80">This machine</span>
            <span className="nn-mono">{wholeGb(hardware.totalRamBytes)} RAM</span>
            <span aria-hidden>·</span>
            <span className="nn-mono">{hardware.cpuBrand}</span>
            <span aria-hidden>·</span>
            <span className="nn-mono">{hardware.cpuCores} cores</span>
            {hardware.gpuLabel && (
              <>
                <span aria-hidden>·</span>
                <span className="nn-mono">{hardware.gpuLabel}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="nn-mono">
              {hardware.arch} / {hardware.os}
            </span>
          </p>
        )}
        {!hardware && !hardwareError && <LoadingRow label="Reading this machine's specs…" />}
        {hardwareError && <InlineError>{hardwareError}</InlineError>}

        {/* Recommendation verdict. The unsupported reason renders verbatim —
            the backend copy is the user-facing contract. */}
        {!recommendation && !recommendationError && (
          <LoadingRow label="Checking what this machine can run…" />
        )}
        {recommendationError && <InlineError>{recommendationError}</InlineError>}
        {recommendation?.status === "unsupported" && (
          <InlineError>{recommendation.reason}</InlineError>
        )}
        {recommendation?.status === "supported" && (
          <div className="rounded-lg bg-primary/[0.07] px-3 py-2.5 ring-1 ring-inset ring-primary/25">
            <p className="flex flex-wrap items-center gap-1.5 text-[0.75rem] font-medium text-foreground/90">
              <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
              Recommended for this machine:
              <span className="nn-mono text-primary">{recommendation.modelTag}</span>
              <span className="font-normal text-muted-foreground">
                ({recommendation.params})
              </span>
            </p>
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">
              {recommendation.why} Uses about {gb(recommendation.estRamBytes)} of
              memory while running.
            </p>
          </div>
        )}

        {/* Curated catalogue — the allowlist is the source of truth for what
            may be installed (it protects cited chat's tool-calling). */}
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

        {/* Installed models: use or delete. */}
        <div className="flex flex-col gap-2">
          <h5 id="ai-installed-models" className={LABEL}>
            Installed on this machine
          </h5>
          {installedScan.status === "checking" && (
            <LoadingRow label="Starting the local runtime…" />
          )}
          {installedScan.status === "error" && (
            <div className="flex flex-col items-start gap-2">
              <InlineError>{installedScan.message}</InlineError>
              <button
                type="button"
                onClick={() => void refreshInstalled()}
                className={buttonVariants({ tone: "quiet", size: "sm" })}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </button>
            </div>
          )}
          {installedScan.status === "ready" && installedScan.models.length === 0 && (
            <p className="text-[0.75rem] text-muted-foreground">
              No local models installed yet.
            </p>
          )}
          {installedScan.status === "ready" && installedScan.models.length > 0 && (
            <ul aria-labelledby="ai-installed-models" className="flex flex-col gap-2">
              {installedScan.models.map((m) => {
                const isActiveModel =
                  localActive && status?.local.activeModelTag === m.tag;
                const diskBits = [
                  `${gb(m.sizeBytes)} on disk`,
                  m.parameterSize,
                  m.quantization,
                ].filter((bit): bit is string => bit != null);
                return (
                  <li
                    key={m.tag}
                    className="flex items-center gap-3 rounded-lg bg-background/50 px-3 py-2.5 ring-1 ring-inset ring-border"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="nn-mono truncate text-[0.8125rem] text-foreground">
                        {m.tag}
                      </p>
                      <p className="text-[0.6875rem] text-muted-foreground">
                        {diskBits.join(" · ")}
                      </p>
                    </div>
                    {isActiveModel ? (
                      <ActiveBadge />
                    ) : (
                      <button
                        type="button"
                        onClick={() => activateLocalModel(m.tag)}
                        disabled={switching}
                        className={buttonVariants({ tone: "quiet", size: "sm" })}
                      >
                        Use this model
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Delete ${m.tag}`}
                      onClick={() => setPendingDelete(m)}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {localActionError && <InlineError>{localActionError}</InlineError>}
        </div>
      </ProviderCard>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.tag}?`}
          message={`This removes the model from this machine and frees ${gb(pendingDelete.sizeBytes)} of disk. You can download it again any time.`}
          confirmLabel="Delete"
          tone="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
