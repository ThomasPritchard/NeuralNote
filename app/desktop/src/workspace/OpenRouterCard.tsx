// The OpenRouter provider card: key status, activation, and the key form.
// Owns all of the key-form state; the page (AiSettingsPage) hands it the
// shared status and the one provider-switch channel.

import { useId, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { AiStatus } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { FIELD, LABEL } from "./KeySetupPanel";
import { InlineError, ProviderCard } from "./ProviderCard";
import { reasoningCapability } from "./reasoningSupport";

interface OpenRouterCardProps {
  status: AiStatus | null;
  /** True while either card's provider switch is in flight — one switch at a
   *  time, so both cards' activate buttons disable together. */
  switching: boolean;
  /** Make OpenRouter the active provider (the page's switch channel).
   *  Rejects with the api error so this card can surface it inline. */
  onActivate: () => Promise<void>;
  /** Re-read the AI status after a change (the page owns the status). Never
   *  rejects — it records its own read failure — so callers cannot treat it as
   *  confirmation that a preceding write took effect. */
  refreshStatus: () => Promise<void>;
  /** Install a status the backend just handed back, without a second read. Used
   *  where a stale-looking control would misrepresent persisted state. */
  applyStatus: (status: AiStatus) => void;
}

export function OpenRouterCard({
  status,
  switching,
  onActivate,
  refreshStatus,
  applyStatus,
}: Readonly<OpenRouterCardProps>) {
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [orError, setOrError] = useState<string | null>(null);
  const [savingReasoning, setSavingReasoning] = useState(false);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const reasoningHintId = useId();

  const hasKey = status?.openrouter.hasKey ?? false;
  const orActive = status?.activeProvider === "openRouter";
  // The persisted value is the checkbox's only source of truth: a toggle renders
  // the status its own write returned, so the control never shows an un-persisted
  // state, and a rejected write leaves it untouched.
  const reasoning = status?.openrouter.reasoning ?? false;
  // The probed capability — shared with the chat pane's chip (one derivation,
  // one copy). Only a verified "unsupported" disables; "unknown" fails open.
  //
  // `reasoningSupported` describes the *effective* provider's model, so it may
  // be the local model's verdict. Only trust it here when OpenRouter is the
  // effective provider; otherwise fail open (`unknown`), or a local model's
  // "unsupported" would falsely disable — and mislabel — the OpenRouter toggle.
  const capability = reasoningCapability(
    orActive ? (status?.reasoningSupported ?? "unknown") : "unknown",
    status?.openrouter.model ?? "",
  );

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

  const toggleReasoning = async () => {
    if (savingReasoning) return;
    setSavingReasoning(true);
    setReasoningError(null);
    try {
      // Render what the write persisted, not a follow-up read. `refreshStatus`
      // swallows its own failure, so using it here would let a failed re-read
      // leave the box unticked while the config says reasoning is on — billing
      // the user for tokens they never agreed to.
      applyStatus(await api.setReasoning(!reasoning));
    } catch (e) {
      setReasoningError(errorMessage(e));
    } finally {
      setSavingReasoning(false);
    }
  };

  // ("activate", not a `use` prefix — a plain event handler, and the hook
  // naming convention would misread it as a React hook.)
  const activateOpenRouter = () => {
    setOrError(null);
    onActivate().catch((e) => setOrError(errorMessage(e)));
  };

  return (
    <ProviderCard
      icon={KeyRound}
      title="OpenRouter"
      description="Bring your own key — cited chat runs on a cloud model of your choice."
      active={orActive}
    >
      <p className="flex flex-wrap items-center gap-1.5 text-[0.75rem]">
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
            className={buttonVariants({ tone: "primary", size: "sm" })}
          >
            Use OpenRouter
          </button>
        )}
        <button type="button" onClick={openKeyForm} className={buttonVariants({ tone: "quiet", size: "sm" })}>
          {hasKey ? "Update key…" : "Connect a key…"}
        </button>
      </div>
      {orError && <InlineError>{orError}</InlineError>}

      {hasKey && (
        <div className="flex flex-col gap-1">
          <label
            title={capability.reason ?? undefined}
            className={cn(
              "flex w-fit items-center gap-2 text-[0.75rem] text-foreground/90",
              capability.disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            <input
              type="checkbox"
              checked={reasoning}
              onChange={() => void toggleReasoning()}
              disabled={savingReasoning || capability.disabled}
              aria-describedby={reasoningHintId}
              className="size-3.5 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span>Show model reasoning</span>
          </label>
          {/* The hint slot is already aria-associated, so when the probe
              verified the model can't reason it carries the "why" — visible
              and announced — instead of a billing note for a moot toggle. */}
          <p
            id={reasoningHintId}
            className="pl-5.5 text-[0.6875rem] leading-snug text-muted-foreground"
          >
            {capability.reason ?? "Reasoning tokens are billed by OpenRouter."}
          </p>
          {reasoningError && <InlineError>{reasoningError}</InlineError>}
        </div>
      )}

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
              className={buttonVariants({ tone: "primary", size: "sm" })}
            >
              {savingKey ? "Saving…" : "Save key"}
            </button>
            <button
              type="button"
              onClick={() => setKeyFormOpen(false)}
              className={buttonVariants({ tone: "quiet", size: "sm" })}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </ProviderCard>
  );
}
