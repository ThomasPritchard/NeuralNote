// The "Configure the AI" settings page: which provider serves cited chat.
// The page is the orchestrator — it owns the shared AI status and the one
// provider-switch channel, and mounts one card per provider (OpenRouterCard,
// LocalAiCard), each of which owns its own action state and data loads.
// Every failure lands inline next to the thing that failed — never a silent
// blank.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { AiStatus, ProviderKind } from "../lib/types";
import { LocalAiCard } from "./LocalAiCard";
import { OpenRouterCard } from "./OpenRouterCard";
import { InlineError } from "./ProviderCard";

/** Header chip mirroring ChatPane's StatusPill: the *effective* provider. */
function CurrentProviderChip({ status }: Readonly<{ status: AiStatus | null }>) {
  const base =
    "flex shrink-0 items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[0.6875rem] ring-1 ring-inset ring-border";
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
          className="size-1.5 rounded-full bg-healthy"
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
            className="size-1.5 rounded-full bg-healthy"
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

export function AiSettingsPage() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** One provider switch in flight at a time — shared so both cards' activate
   *  buttons disable together. */
  const [switching, setSwitching] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.aiStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(errorMessage(e));
    }
  }, []);

  // Initial status load on mount; guards `cancelled` so a late resolve can't
  // write into a closed settings dialog. (Each card loads its own data the
  // same way.)
  useEffect(() => {
    let cancelled = false;
    void api
      .aiStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatusError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The one switch channel: flips `switching` around the call and refreshes
   *  the status on success. Rejects with the api error so the calling card
   *  can surface it in its own inline slot. */
  const switchProvider = useCallback(
    async (provider: ProviderKind, tag?: string) => {
      setSwitching(true);
      try {
        // Keep the no-tag call unary — an explicit `undefined` tag is not the
        // same invoke payload as an absent one.
        await (tag === undefined
          ? api.setActiveProvider(provider)
          : api.setActiveProvider(provider, tag));
        await refreshStatus();
      } finally {
        setSwitching(false);
      }
    },
    [refreshStatus],
  );

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="nn-heading text-sm font-semibold text-foreground">
            Configure the AI
          </h3>
          <CurrentProviderChip status={status} />
        </div>
        <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
          Choose where cited chat runs. You can switch providers at any time.
        </p>
        {statusError && (
          <InlineError>Couldn&apos;t read the AI status: {statusError}</InlineError>
        )}
      </header>

      <OpenRouterCard
        status={status}
        switching={switching}
        onActivate={() => switchProvider("openRouter")}
        refreshStatus={refreshStatus}
        applyStatus={setStatus}
      />

      <LocalAiCard
        status={status}
        switching={switching}
        onActivate={(tag) => switchProvider("local", tag)}
        refreshStatus={refreshStatus}
      />
    </div>
  );
}
