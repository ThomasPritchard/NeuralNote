// The chat pane's provider/status concern: which AI provider is effective, the
// view that status implies (first-run picker, guided setup, local hand-off,
// skipped, or live chat), the reasoning opt-in + its probed capability, and the
// key-save flow. The webview never sees the API key — it asks `aiStatus` which
// provider is effective and mirrors the core's `effective_reasoning`. All state,
// refs, effects, and the pure status→destination helpers live here so the pane
// only presents what this hook resolves.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { AiStatus } from "../lib/types";
import { reasoningCapability, type ReasoningCapability } from "./reasoningSupport";

export type View =
  | "loading"
  | "picker"
  | "setup"
  | "localSetup"
  | "disconnected"
  | "chat";

interface ProviderDestination {
  model: string;
  view: Extract<View, "chat" | "setup" | "localSetup" | "picker">;
}

/** Map one backend status to the pane destination it authoritatively implies. */
function providerDestination(status: AiStatus): ProviderDestination {
  if (status.activeProvider === "openRouter") {
    return {
      model: status.openrouter.model,
      view: status.openrouter.hasKey ? "chat" : "setup",
    };
  }
  if (status.activeProvider === "local") {
    return {
      model: status.local.activeModelTag ?? "",
      view: status.local.activeModelTag ? "chat" : "localSetup",
    };
  }
  return { model: status.openrouter.model, view: "picker" };
}

/** The provider+model a status would chat against, or null in a first-run
 *  state with nothing to probe. A string key, so the probe effect re-fires
 *  exactly when the effective provider or selected model changes — and only
 *  then (`refreshReasoningSupport` is network I/O, never per-render). */
function reasoningProbeTarget(status: AiStatus | null): string | null {
  if (status?.activeProvider === "openRouter" && status.openrouter.hasKey) {
    return `openRouter:${status.openrouter.model}`;
  }
  if (status?.activeProvider === "local" && status.local.activeModelTag) {
    return `local:${status.local.activeModelTag}`;
  }
  return null;
}

/** A same-model status echo owns provider/config fields, but an `unknown`
 * capability must not erase a support verdict already returned by the probe. */
function mergeStatusRead(current: AiStatus | null, next: AiStatus): AiStatus {
  if (
    current !== null &&
    reasoningProbeTarget(current) === reasoningProbeTarget(next) &&
    next.reasoningSupported === "unknown"
  ) {
    return { ...next, reasoningSupported: current.reasoningSupported };
  }
  return next;
}

export interface ChatPaneProvider {
  view: View;
  setView: Dispatch<SetStateAction<View>>;
  model: string;
  status: AiStatus | null;
  saving: boolean;
  savingReasoning: boolean;
  reasoningError: string | null;
  capability: ReasoningCapability;
  reasoningOn: boolean;
  effectiveReasoning: boolean;
  reasoningReasonId: string;
  applyStatus: (next: AiStatus) => void;
  handleSave: (key: string, chosenModel: string) => Promise<void>;
  toggleReasoning: () => Promise<void>;
}

/** Own the provider-aware status, the view it implies, and the reasoning opt-in.
 *  A failed status read still lands on the first-run picker (never a raw error)
 *  but is surfaced on the pane's shared error channel. */
export function useChatPaneProvider({
  reportError,
  refreshSignal,
}: {
  reportError: (message: string) => void;
  /** Bumped by the workspace when Settings closes, so a provider configured
   *  there is re-read without remounting the pane. */
  refreshSignal: number;
}): ChatPaneProvider {
  const [view, setView] = useState<View>("loading");
  // Empty until `aiStatus` echoes the effective model — the Rust core owns the
  // locked default, so the frontend never duplicates the model id. Nothing
  // shows it before then: the pill renders only in chat/disconnected, and the
  // one path into setup that skips `applyStatus` (a failed status check) leaves
  // the prefill blank — the core normalizes an empty model back to its default.
  const [model, setModel] = useState("");
  // The last status the backend echoed — the reasoning chip's only source of
  // truth (opt-in + probed capability), so the control never renders a state
  // the config doesn't hold.
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingReasoning, setSavingReasoning] = useState(false);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const reasoningReasonId = useId();

  // Latest view, readable from the status effect below without re-running it
  // (and re-fetching) every time the user walks through the first-run states.
  const viewRef = useRef(view);
  viewRef.current = view;
  const statusRef = useRef(status);
  statusRef.current = status;
  const statusGenerationRef = useRef(0);
  const probeTargetGenerationRef = useRef(0);

  const commitStatus = useCallback((next: AiStatus) => {
    const destination = providerDestination(next);
    if (
      reasoningProbeTarget(statusRef.current) !== reasoningProbeTarget(next)
    ) {
      // Provider/model identity owns probe validity. Advancing only for a target
      // change lets a same-model config mutation and its in-flight probe merge
      // their disjoint fields, while still rejecting changed-target and ABA
      // responses even before React has run the old effect's cleanup.
      probeTargetGenerationRef.current += 1;
    }
    statusRef.current = next;
    setStatus(next);
    setModel(destination.model);
    setView(destination.view);
  }, []);

  /** Land on the view a provider-aware status implies. The `model` doubles as
   *  the status-pill label: the OpenRouter model id, or the local model tag.
   *  Mutation echoes are authoritative, so applying one invalidates every
   *  older status read that may still be crossing the IPC boundary. */
  const applyStatus = useCallback((next: AiStatus) => {
    statusGenerationRef.current += 1;
    commitStatus(mergeStatusRead(statusRef.current, next));
  }, [commitStatus]);

  // On mount (and whenever Settings closes), read the effective provider. A
  // failed check still lands on the first-run picker (never a raw error) but
  // is surfaced on the shared channel.
  useEffect(() => {
    let cancelled = false;
    const generation = statusGenerationRef.current + 1;
    statusGenerationRef.current = generation;
    api
      .aiStatus()
      .then((nextStatus) => {
        if (cancelled || statusGenerationRef.current !== generation) return;
        // A later refresh that still reports "nothing configured" must not
        // stomp a manually-chosen first-run view (guided setup / skipped);
        // only the mount pass may land on the picker from scratch.
        if (nextStatus.activeProvider === null && viewRef.current !== "loading") return;
        commitStatus(mergeStatusRead(statusRef.current, nextStatus));
      })
      .catch((e) => {
        if (cancelled || statusGenerationRef.current !== generation) return;
        reportError(errorMessage(e));
        if (viewRef.current === "loading") setView("picker");
      });
    return () => {
      cancelled = true;
    };
  }, [commitStatus, reportError, refreshSignal]);

  // The provider+model this status would chat against — the string key that
  // makes the probe effect below re-fire exactly when the effective provider
  // or selected model changes, and only then (see `reasoningProbeTarget`).
  const probeTarget = reasoningProbeTarget(status);

  // Probe the selected model for reasoning support on mount and on every
  // provider/model change. A failed probe fails OPEN: capability stays
  // "unknown", the toggle stays enabled, and the failure is surfaced on the
  // shared channel — exactly like the mount status-read failure above.
  useEffect(() => {
    if (probeTarget === null) return;
    let cancelled = false;
    const targetGeneration = probeTargetGenerationRef.current;
    const target = probeTarget;
    api
      .refreshReasoningSupport()
      .then((fresh) => {
        const current = statusRef.current;
        if (
          cancelled ||
          probeTargetGenerationRef.current !== targetGeneration ||
          reasoningProbeTarget(current) !== target ||
          reasoningProbeTarget(fresh) !== target ||
          current === null
        ) return;
        // The probe owns capability only. Preserve any same-target provider or
        // reasoning state refreshed while its network request was in flight.
        commitStatus({ ...current, reasoningSupported: fresh.reasoningSupported });
      })
      .catch((e) => {
        if (
          !cancelled &&
          probeTargetGenerationRef.current === targetGeneration &&
          reasoningProbeTarget(statusRef.current) === target
        ) {
          reportError(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [probeTarget, commitStatus, reportError]);

  // The persisted opt-in + the probed capability — both straight from the
  // status echo (see `reasoningSupport.ts` for the fail-open rule).
  const reasoningOn = status?.openrouter.reasoning ?? false;
  const capability = reasoningCapability(
    status?.reasoningSupported ?? "unknown",
    model,
  );
  // What the backend will *actually* request — the frontend mirror of the core's
  // `effective_reasoning` (opt-in AND not a known-unsupported model). The backstop
  // notice pins THIS, not the raw opt-in: on an unsupported model the app sends no
  // reasoning by design, so "the model returned none" would blame it for our own
  // (correct) choice — and the toggle is disabled, so the user can't clear it.
  const effectiveReasoning = reasoningOn && !capability.disabled;

  const toggleReasoning = useCallback(async () => {
    // The unsupported state uses aria-disabled and stays FOCUSABLE (a native
    // disabled control can't be reached to hear why it is off), so the DOM
    // does not block activation — this guard is what makes the click a no-op.
    if (savingReasoning || capability.disabled) return;
    setSavingReasoning(true);
    setReasoningError(null);
    try {
      // Render what the write persisted, never a follow-up read — the same
      // rationale as OpenRouterCard.tsx: a read that failed after the write
      // landed would show "off" while the config says "on", silently billing
      // the user for reasoning tokens they never agreed to.
      applyStatus(await api.setReasoning(!reasoningOn));
    } catch (e) {
      // A toggle that silently doesn't persist would bill the user for
      // reasoning they didn't consent to — or withhold what they asked for.
      setReasoningError(errorMessage(e));
    } finally {
      setSavingReasoning(false);
    }
  }, [savingReasoning, capability.disabled, reasoningOn, applyStatus]);

  const handleSave = useCallback(
    async (key: string, chosenModel: string) => {
      setSaving(true);
      try {
        await api.saveApiKey(key, chosenModel);
        // Re-read the effective provider: a fresh key with no explicit choice
        // reads as "openRouter", which lands the pane in the chat view.
        const generation = statusGenerationRef.current + 1;
        statusGenerationRef.current = generation;
        try {
          const next = await api.aiStatus();
          if (statusGenerationRef.current === generation) applyStatus(next);
        } catch (error) {
          if (statusGenerationRef.current === generation) throw error;
        }
      } catch (e) {
        reportError(errorMessage(e));
      } finally {
        setSaving(false);
      }
    },
    [applyStatus, reportError],
  );

  return {
    view,
    setView,
    model,
    status,
    saving,
    savingReasoning,
    reasoningError,
    capability,
    reasoningOn,
    effectiveReasoning,
    reasoningReasonId,
    applyStatus,
    handleSave,
    toggleReasoning,
  };
}
