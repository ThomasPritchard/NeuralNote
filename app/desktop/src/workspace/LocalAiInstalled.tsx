// The Local AI card's "Installed on this machine" section: the scan's checking /
// error (with Retry) / empty / list states, and per-row use-or-delete actions.
// Purely presentational — the card owns the scan and the action channels and
// hands them down; every failure still lands inline, never a silent blank.

import { RefreshCw, Trash2 } from "lucide-react";
import type { InstalledModel } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { gb } from "./localAiFormat";
import type { InstalledScan } from "./localAiTypes";
import { LABEL } from "./KeySetupPanel";
import { ActiveBadge, InlineError, LoadingRow } from "./ProviderCard";

interface LocalAiInstalledProps {
  installedScan: InstalledScan;
  localActive: boolean;
  activeModelTag: string | null;
  switching: boolean;
  localActionError: string | null;
  onRetry: () => void;
  onActivate: (tag: string) => void;
  onRequestDelete: (model: InstalledModel) => void;
}

export function LocalAiInstalled({
  installedScan,
  localActive,
  activeModelTag,
  switching,
  localActionError,
  onRetry,
  onActivate,
  onRequestDelete,
}: Readonly<LocalAiInstalledProps>) {
  return (
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
            onClick={() => onRetry()}
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
            const isActiveModel = localActive && activeModelTag === m.tag;
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
                    onClick={() => onActivate(m.tag)}
                    disabled={switching}
                    className={buttonVariants({ tone: "quiet", size: "sm" })}
                  >
                    Use this model
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Delete ${m.tag}`}
                  onClick={() => onRequestDelete(m)}
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
  );
}
