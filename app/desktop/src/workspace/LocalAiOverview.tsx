// The Local AI card's read-only probe display: the compact hardware readout that
// drives the recommendation, and the recommendation verdict itself. Each probe
// owns its own loading and inline-error slot so one failure never blanks the
// others. Purely presentational — the card loads the data and hands it down.

import { Check } from "lucide-react";
import type { HardwareSpec, Recommendation } from "../lib/types";
import { gb, wholeGb } from "./localAiFormat";
import { InlineError, LoadingRow } from "./ProviderCard";

interface LocalAiOverviewProps {
  hardware: HardwareSpec | null;
  hardwareError: string | null;
  recommendation: Recommendation | null;
  recommendationError: string | null;
}

export function LocalAiOverview({
  hardware,
  hardwareError,
  recommendation,
  recommendationError,
}: Readonly<LocalAiOverviewProps>) {
  return (
    <>
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
    </>
  );
}
