// The "Configure the AI" settings page: which provider serves cited chat.
// Owns all of its data loading through the api.ts seam. Every failure lands
// inline next to the thing that failed — never a silent blank — with one
// deliberate exception: the Hugging Face transparency metadata is non-fatal by
// contract (types.ts HfModelMeta), so a failed lookup just omits that row's
// metadata line instead of erroring the page.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
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
import { ConfirmDialog } from "./ConfirmDialog";
import { FIELD, LABEL } from "./KeySetupPanel";

// ── Shared bits ───────────────────────────────────────────────────────────────

const BTN_PRIMARY =
  "rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-[0_0_16px_-8px_var(--color-primary)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none";
const BTN_QUIET =
  "rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground ring-1 ring-inset ring-border transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";

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

/** Inline failure notice — the page-level home for surfaced errors. */
function InlineError({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[12px] leading-snug text-destructive">
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** In-flight indicator (an <output> so it's announced, matching ChatPane). */
function LoadingRow({ label }: Readonly<{ label: string }>) {
  return (
    <output className="flex items-center gap-2 text-[12px] text-muted-foreground/70">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </output>
  );
}

function ActiveBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary ring-1 ring-inset ring-primary/30">
      <Check className="size-3" aria-hidden />
      Active
    </span>
  );
}

/** One provider section: icon tile, title/description header, then children. */
function ProviderCard({
  icon: Icon,
  title,
  description,
  active,
  children,
}: Readonly<{
  icon: LucideIcon;
  title: string;
  description: string;
  active: boolean;
  children: ReactNode;
}>) {
  return (
    <section className="rounded-xl bg-background/40 p-4 ring-1 ring-inset ring-border">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="nn-heading text-[13px] font-semibold text-foreground">
            {title}
          </h4>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
        {active && <ActiveBadge />}
      </header>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** Header chip mirroring ChatPane's StatusPill: the *effective* provider. */
function CurrentProviderChip({ status }: Readonly<{ status: AiStatus | null }>) {
  const base =
    "flex shrink-0 items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] ring-1 ring-inset ring-border";
  if (!status) {
    return (
      <output className={cn(base, "text-muted-foreground/70")}>
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        Checking…
      </output>
    );
  }
  if (status.activeProvider === "openRouter") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <span
          className="size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]"
          aria-hidden
        />
        {/* No space intended — the flex gap separates chip parts. */}
        {"OpenRouter"}
        <span className="nn-mono max-w-[10rem] truncate">
          {status.openrouter.model.split("/").pop()}
        </span>
      </span>
    );
  }
  if (status.activeProvider === "local") {
    if (status.local.activeModelTag) {
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <span
            className="size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]"
            aria-hidden
          />
          {/* No space intended — the flex gap separates chip parts. */}
          {"Local"}
          <span className="nn-mono max-w-[10rem] truncate">
            {status.local.activeModelTag}
          </span>
        </span>
      );
    }
    // A real misconfiguration — chat can't run — so it reads as a fault.
    return (
      <span className={cn(base, "text-destructive ring-destructive/40")}>
        <AlertTriangle className="size-3" aria-hidden />
        Local — no model selected
      </span>
    );
  }
  return <span className={cn(base, "text-muted-foreground")}>Not configured</span>;
}

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

// ── The page ──────────────────────────────────────────────────────────────────

export function AiSettingsPage() {
  // Each load owns its own error slot so one failed probe never blanks the rest.
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareSpec | null>(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateModel[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  /** HF transparency metadata by hfRepo; a missing key means "lookup failed or
   *  still in flight" and the row simply renders without the metadata line. */
  const [hfMeta, setHfMeta] = useState<Record<string, HfModelMeta>>({});
  const [installed, setInstalled] = useState<InstalledModel[] | null>(null);
  const [installedError, setInstalledError] = useState<string | null>(null);

  // OpenRouter card actions.
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [orError, setOrError] = useState<string | null>(null);

  // Local card actions. One pull at a time — mirrors the single cancel_pull.
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [pullErrors, setPullErrors] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [localActionError, setLocalActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InstalledModel | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.aiStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(errorMessage(e));
    }
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await api.listLocalModels());
      setInstalledError(null);
    } catch (e) {
      // The sidecar failing to start lands here — surfaced, with a retry.
      setInstalledError(errorMessage(e));
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

    void api.aiStatus().then(guard(setStatus)).catch(guard((e: unknown) => setStatusError(errorMessage(e))));
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
      .then(guard(setInstalled))
      .catch(guard((e: unknown) => setInstalledError(errorMessage(e))));

    return () => {
      cancelled = true;
    };
  }, []);

  // ── OpenRouter actions ──────────────────────────────────────────────────────

  const openKeyForm = () => {
    setKeyError(null);
    setModelValue(status?.openrouter.model ?? "");
    setKeyFormOpen(true);
  };

  const saveKey = async () => {
    const key = keyValue.trim();
    if (key === "" || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await api.saveApiKey(key, modelValue.trim() || (status?.openrouter.model ?? ""));
      await refreshStatus();
      setKeyFormOpen(false);
      setKeyValue("");
    } catch (e) {
      setKeyError(errorMessage(e));
    } finally {
      setSavingKey(false);
    }
  };

  // ("activate", not a `use` prefix — these are plain event handlers, and the
  // hook naming convention would misread them as React hooks.)
  const activateOpenRouter = () => {
    setSwitching(true);
    setOrError(null);
    void api
      .setActiveProvider("openRouter")
      .then(refreshStatus)
      .catch((e) => setOrError(errorMessage(e)))
      .finally(() => setSwitching(false));
  };

  // ── Local actions ───────────────────────────────────────────────────────────

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
        void api
          .setActiveProvider("local", tag)
          .then(refreshStatus)
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

  const activateLocalModel = (tag: string) => {
    setSwitching(true);
    setLocalActionError(null);
    void api
      .setActiveProvider("local", tag)
      .then(refreshStatus)
      .catch((e) => setLocalActionError(errorMessage(e)))
      .finally(() => setSwitching(false));
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

  // ── Render ──────────────────────────────────────────────────────────────────

  const hasKey = status?.openrouter.hasKey ?? false;
  const orActive = status?.activeProvider === "openRouter";
  const localActive = status?.activeProvider === "local";
  const recommendedTag =
    recommendation?.status === "supported" ? recommendation.modelTag : null;
  const installedTags = new Set((installed ?? []).map((m) => m.tag));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="nn-heading text-sm font-semibold text-foreground">
            Configure the AI
          </h3>
          <CurrentProviderChip status={status} />
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Choose where cited chat runs. You can switch providers at any time.
        </p>
        {statusError && (
          <InlineError>Couldn&apos;t read the AI status: {statusError}</InlineError>
        )}
      </header>

      {/* ── OpenRouter ──────────────────────────────────────────────────────── */}
      <ProviderCard
        icon={KeyRound}
        title="OpenRouter"
        description="Bring your own key — cited chat runs on a cloud model of your choice."
        active={orActive}
      >
        <p className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {hasKey ? (
            <>
              <Check className="size-3.5 text-primary" aria-hidden />
              <span className="text-foreground/90">Key connected</span>
              <span className="nn-mono text-muted-foreground">
                {status?.openrouter.model}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              No key connected yet. Your key is stored in the OS keychain and
              never leaves this machine.
            </span>
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {!orActive && (
            <button
              type="button"
              onClick={activateOpenRouter}
              disabled={!hasKey || switching}
              className={BTN_PRIMARY}
            >
              Use OpenRouter
            </button>
          )}
          <button type="button" onClick={openKeyForm} className={BTN_QUIET}>
            {hasKey ? "Update key…" : "Connect a key…"}
          </button>
        </div>
        {orError && <InlineError>{orError}</InlineError>}

        {keyFormOpen && (
          <form
            className="flex flex-col gap-3 rounded-lg bg-background/50 p-3 ring-1 ring-inset ring-border"
            onSubmit={(e) => {
              e.preventDefault();
              void saveKey();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>OpenRouter API key</span>
              <input
                type="password"
                autoComplete="off"
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                aria-label="OpenRouter API key"
                placeholder="sk-or-…"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Model</span>
              <input
                type="text"
                value={modelValue}
                onChange={(e) => setModelValue(e.target.value)}
                aria-label="Model"
                className={`nn-mono ${FIELD}`}
              />
            </label>
            {keyError && <InlineError>{keyError}</InlineError>}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={keyValue.trim() === "" || savingKey}
                className={BTN_PRIMARY}
              >
                {savingKey ? "Saving…" : "Save key"}
              </button>
              <button
                type="button"
                onClick={() => setKeyFormOpen(false)}
                className={BTN_QUIET}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </ProviderCard>

      {/* ── Local AI ────────────────────────────────────────────────────────── */}
      <ProviderCard
        icon={Cpu}
        title="Local AI"
        description="A model that runs entirely on this machine — private, no key needed."
        active={localActive}
      >
        {/* Hardware readout driving the recommendation. */}
        {hardware && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-background/50 px-3 py-2 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
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
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-foreground/90">
              <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
              Recommended for this machine:
              <span className="nn-mono text-primary">{recommendation.modelTag}</span>
              <span className="font-normal text-muted-foreground">
                ({recommendation.params})
              </span>
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
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
                const meta = hfMeta[c.hfRepo];
                const metaBits = meta
                  ? [
                      meta.downloads == null
                        ? null
                        : `${COMPACT.format(meta.downloads)} downloads`,
                      meta.license,
                      meta.lastModified
                        ? (() => {
                            const d = fmtDate(meta.lastModified);
                            return d ? `updated ${d}` : null;
                          })()
                        : null,
                    ].filter((bit): bit is string => bit != null)
                  : [];
                const pulling = pull?.tag === c.tag;
                const isInstalled = installedTags.has(c.tag);
                return (
                  <li
                    key={c.tag}
                    className="flex flex-col gap-2 rounded-lg bg-background/50 p-3 ring-1 ring-inset ring-border"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="nn-mono text-[13px] font-medium text-foreground">
                        {c.tag}
                      </span>
                      {c.tag === recommendedTag && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary ring-1 ring-inset ring-primary/30">
                          Recommended
                        </span>
                      )}
                      {isInstalled && (
                        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          <Check className="size-2.5" aria-hidden />
                          Installed
                        </span>
                      )}
                      <span className="ml-auto">
                        {pulling ? (
                          <button
                            type="button"
                            onClick={() => cancelPull(c.tag)}
                            disabled={cancelling}
                            className={BTN_QUIET}
                          >
                            {cancelling ? "Cancelling…" : "Cancel"}
                          </button>
                        ) : (
                          !isInstalled && (
                            <button
                              type="button"
                              onClick={() => startPull(c.tag)}
                              // One pull at a time (a single cancel channel).
                              disabled={pull !== null}
                              className={cn(
                                "flex items-center gap-1.5",
                                c.tag === recommendedTag ? BTN_PRIMARY : BTN_QUIET,
                              )}
                            >
                              <Download className="size-3.5" aria-hidden />
                              Download
                            </button>
                          )
                        )}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {c.params} · {gb(c.downloadBytes)} download · needs{" "}
                      {wholeGb(c.minRamBytes)} RAM · {c.license}
                    </p>
                    {metaBits.length > 0 && (
                      <p className="text-[11px] text-muted-foreground/70">
                        {metaBits.join(" · ")}
                      </p>
                    )}
                    {pulling && pull && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
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
                        {/* Native progressbar; the vendor pseudo-elements
                            reproduce the token look (muted track, primary fill
                            with the violet glow). Percent-less frames render as
                            0% — value never goes undefined, so no engine falls
                            into its own indeterminate animation. */}
                        <progress
                          aria-label={`Downloading ${c.tag}`}
                          max={100}
                          value={pull.percent ?? 0}
                          className={cn(
                            "h-1.5 w-full appearance-none overflow-hidden rounded-full border-none bg-muted",
                            "[&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted",
                            "[&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:shadow-[0_0_8px_var(--color-primary)] [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300",
                            "[&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-moz-progress-bar]:shadow-[0_0_8px_var(--color-primary)]",
                          )}
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
          {installed === null && !installedError && (
            <LoadingRow label="Starting the local runtime…" />
          )}
          {installedError && (
            <div className="flex flex-col items-start gap-2">
              <InlineError>{installedError}</InlineError>
              <button
                type="button"
                onClick={() => void refreshInstalled()}
                className={cn("flex items-center gap-1.5", BTN_QUIET)}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </button>
            </div>
          )}
          {installed?.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              No local models installed yet.
            </p>
          )}
          {installed && installed.length > 0 && (
            <ul aria-labelledby="ai-installed-models" className="flex flex-col gap-2">
              {installed.map((m) => {
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
                      <p className="nn-mono truncate text-[13px] text-foreground">
                        {m.tag}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
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
                        className={BTN_QUIET}
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
    </div>
  );
}
