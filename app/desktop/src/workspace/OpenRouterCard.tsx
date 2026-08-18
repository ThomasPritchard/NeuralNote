// The OpenRouter provider card: key status, activation, and the key form.
// Owns all of the key-form state; the page (AiSettingsPage) hands it the
// shared status and the one provider-switch channel.

import { useState } from "react";
import { Check, KeyRound } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { AiStatus } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { KeyChangeCaveat } from "./KeyChangeCaveat";
import { FIELD, LABEL } from "./KeySetupPanel";
import { InlineError, ProviderCard } from "./ProviderCard";
import { ReasoningSettings } from "./ReasoningSettings";

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
  // The last save landed in the keychain but could not be announced to the app's
  // other windows. A receipt of THAT save, not a standing claim about the world:
  // the frontend can't tell whether a second window exists or has since been
  // restarted, so it is dismissible and it is cleared the moment another save is
  // set up. Separate from `keyError` on purpose — the save worked, and reusing
  // the red channel would report the opposite failure to the one being fixed.
  const [keyChangeCaveat, setKeyChangeCaveat] = useState(false);
  const [orError, setOrError] = useState<string | null>(null);
  const [savingReasoning, setSavingReasoning] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [reasoningError, setReasoningError] = useState<string | null>(null);

  const hasKey = status?.openrouter.hasKey ?? false;
  const orActive = status?.activeProvider === "openRouter";
  // The persisted value is the checkbox's only source of truth: a toggle renders
  // the status its own write returned, so the control never shows an un-persisted
  // state, and a rejected write leaves it untouched.
  const reasoning = status?.openrouter.reasoning ?? false;
  // `reasoningControl` describes the *effective* provider's model, so while Local
  // is active it is the local model's control — which has nothing to say about
  // the OpenRouter model this card names. Rendering it here would pair one
  // model's verdict with another model's id, so the block appears only when
  // OpenRouter is the model actually being configured. That makes the
  // mislabelling structurally impossible rather than guarded against.
  const showsReasoning = hasKey && orActive && status !== null;

  const openKeyForm = () => {
    setKeyError(null);
    // The notice describes the save it came from; a new one is about to replace
    // that save, so keeping it would attach it to the wrong key.
    setKeyChangeCaveat(false);
    setModelValue(status?.openrouter.model ?? "");
    setKeyFormOpen(true);
  };

  const saveKey = async () => {
    const key = keyValue.trim();
    if (key === "" || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      const outcome = await api.saveApiKey(
        key,
        modelValue.trim() || (status?.openrouter.model ?? ""),
      );
      // Read before anything else can fail. The keychain write is committed by
      // now, so the caveat is true whatever the follow-up status read does — and
      // `refreshStatus` records its own failure rather than rejecting, so there
      // is no path here that should swallow it.
      setKeyChangeCaveat(!outcome.revisionPublished);
      await refreshStatus();
      setKeyFormOpen(false);
      setKeyValue("");
    } catch (e) {
      setKeyError(errorMessage(e));
    } finally {
      setSavingKey(false);
    }
  };

  /** Run one reasoning-preference write and render exactly what it persisted.
   *
   *  Never a follow-up `refreshStatus`: that swallows its own failure, so a
   *  read that failed after the write landed would leave the control showing
   *  "off" while the config says "on" — billing the user for tokens they never
   *  agreed to. Both writes share this for the same reason. */
  const writePreference = async (run: () => Promise<AiStatus>) => {
    if (savingReasoning) return;
    setSavingReasoning(true);
    setReasoningError(null);
    try {
      applyStatus(await run());
    } catch (e) {
      setReasoningError(errorMessage(e));
    } finally {
      setSavingReasoning(false);
    }
  };

  /** Re-ask the capability probe. The shell's effort-menu cache is not
   *  persisted, so a Settings pane opened inside the launch window reads
   *  `pending` and — since this page loads its status once, on mount — would
   *  stay there. The probe's response is the one status read that carries a
   *  resolved control on a cold launch, so this is what resolves it. */
  const recheckCapabilities = async () => {
    if (rechecking) return;
    setRechecking(true);
    setReasoningError(null);
    try {
      applyStatus(await api.refreshReasoningSupport());
    } catch (e) {
      setReasoningError(errorMessage(e));
    } finally {
      setRechecking(false);
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

      {/* Directly under the status line, because that is the claim it qualifies:
          "Key connected" is true of THIS window, and the notice says what is
          still true of any other. */}
      {keyChangeCaveat && (
        <KeyChangeCaveat onDismiss={() => setKeyChangeCaveat(false)} />
      )}

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

      {showsReasoning && (
        <ReasoningSettings
          control={status.reasoningControl}
          model={status.openrouter.model}
          reasoningOn={reasoning}
          effort={status.openrouter.reasoningEffort}
          saving={savingReasoning}
          rechecking={rechecking}
          error={reasoningError}
          onToggle={() => void writePreference(() => api.setReasoning(!reasoning))}
          onPickEffort={(effort) =>
            void writePreference(() => api.setReasoningEffort(effort))
          }
          onRecheck={() => void recheckCapabilities()}
        />
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
