// The Local AI provider card: hardware readout, model recommendation, the
// curated catalogue with streamed pulls, and the installed-model list. Owns
// all of its data loading through the api.ts seam; the page (AiSettingsPage)
// hands it the shared status and the one provider-switch channel. Every
// failure lands inline next to the thing that failed — never a silent blank —
// with one deliberate exception: the Hugging Face transparency metadata is
// non-fatal by contract (types.ts HfModelMeta), so a failed lookup just omits
// that row's metadata line instead of erroring the card.
//
// This file is the composing top-level view: it owns the loads, the pull
// channel, and the actions, and hands the rendering to three presentational
// siblings — LocalAiOverview (machine + recommendation), LocalAiCatalogue, and
// LocalAiInstalled.

import { useCallback, useEffect, useState } from "react";
import { Cpu, Info } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type {
  AiStatus,
  CandidateModel,
  HardwareSpec,
  HfModelMeta,
  InstalledModel,
  PullEvent,
  Recommendation,
} from "../lib/types";
import { gb } from "./localAiFormat";
import type { InstalledScan, PullProgress } from "./localAiTypes";
import { ConfirmDialog } from "./ConfirmDialog";
import { LocalAiCatalogue } from "./LocalAiCatalogue";
import { LocalAiInstalled } from "./LocalAiInstalled";
import { LocalAiOverview } from "./LocalAiOverview";
import { ProviderCard } from "./ProviderCard";

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

  return (
    <>
      <ProviderCard
        icon={Cpu}
        title="Local AI"
        description="A model that runs entirely on this machine — private, no key needed."
        active={localActive}
      >
        {/* Honest expectation-setting, not an error: local runs private and
            local, but cited recall is the product's core promise, and on this
            tier the citation markers land only intermittently — so we point at
            the API-key path for the most reliable citations. Muted/informational
            register (never the destructive InlineError styling). */}
        <p className="flex items-start gap-1.5 rounded-lg bg-background/50 px-3 py-2 text-[0.6875rem] leading-snug text-muted-foreground ring-1 ring-inset ring-border">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            Local models run entirely on this machine — private, with no internet
            needed. For the most reliable source citations, connect an API key
            (OpenRouter); citation accuracy is best-effort with a local model.
          </span>
        </p>

        <LocalAiOverview
          hardware={hardware}
          hardwareError={hardwareError}
          recommendation={recommendation}
          recommendationError={recommendationError}
        />

        <LocalAiCatalogue
          candidates={candidates}
          candidatesError={candidatesError}
          hfMeta={hfMeta}
          recommendedTag={recommendedTag}
          installedScan={installedScan}
          pull={pull}
          pullErrors={pullErrors}
          cancelling={cancelling}
          onStartPull={startPull}
          onCancelPull={cancelPull}
        />

        <LocalAiInstalled
          installedScan={installedScan}
          localActive={localActive}
          activeModelTag={status?.local.activeModelTag ?? null}
          switching={switching}
          localActionError={localActionError}
          onRetry={() => void refreshInstalled()}
          onActivate={activateLocalModel}
          onRequestDelete={setPendingDelete}
        />
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
