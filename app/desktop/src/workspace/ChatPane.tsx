// The docked Neural Assistant AI pane — the real cited-chat UI. The provider-aware
// states share one shell: the first-run picker (nothing configured), guided key
// setup, a "local provider chosen but no model yet" hand-off into Settings, a
// clearly-disabled "skipped" state, and the live chat view. The webview never
// sees the API key; it asks `aiStatus` which provider is effective and drives
// the streamed `ChatEvent` loop via `chat`. Orchestration stays in Rust — this
// pane only presents the stream and folds it with `reduceAssistant`.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  Brain,
  Cpu,
  Database,
  Loader2,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { useVault } from "../lib/store";
import type { AiStatus, ChatEvent, SkillListing } from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { StatusPill as NeuralStatusPill } from "@/components/neural/patterns";
import { ChatMessages } from "./ChatMessages";
import { ChatModelMenu } from "./ChatModelMenu";
import {
  emptyAssistant,
  markAssistantStopped,
  reduceAssistantForTurn,
  toHistory,
  userMessage,
  type ChatMessage,
  type CitationView,
} from "./chatMessage";
import { DisconnectedPane, KeySetupPanel } from "./KeySetupPanel";
import { ProviderPicker } from "./ProviderPicker";
import { reasoningCapability } from "./reasoningSupport";
import {
  filterSkillSuggestions,
  findSkillTrigger,
  removeSkillTrigger,
  type SkillPickerEntry,
  type SkillTrigger,
} from "./skillAutocomplete";
import {
  SkillChips,
  SkillSuggestions,
  SKILL_LISTBOX_ID,
  skillOptionId,
  type SkillPickerNotice,
} from "./SkillPicker";

type View =
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

/** The backend skill catalogue as an explicit state machine: until the load
 *  resolves the picker can neither offer skills nor claim there are none —
 *  "not yet known" must never silently read as "no skills" (the same union
 *  discipline as LocalAiCard's installed-model scan). */
type SkillsCatalogue =
  | { status: "loading" }
  | { status: "ready"; skills: SkillListing[] }
  | { status: "error"; message: string };

/** While the catalogue isn't usable yet, an active trigger still opens the
 *  popup — showing this quiet loading/error line instead of options, so typing
 *  `@` during the load never looks like "there are no skills". */
function skillPickerNotice(
  catalogue: SkillsCatalogue,
): SkillPickerNotice | null {
  if (catalogue.status === "loading") {
    return { kind: "loading", message: "Loading skills…" };
  }
  if (catalogue.status === "error") {
    return {
      kind: "error",
      message: `Couldn't load skills: ${catalogue.message}`,
    };
  }
  return null;
}

/** What the composer's `@` popup shows for one render. */
interface SkillPickerState {
  trigger: SkillTrigger | null;
  /** Identity of the current trigger — Escape/blur dismissals are keyed to it,
   *  so typing another character re-derives the key and may reopen the popup. */
  triggerKey: string | null;
  suggestions: SkillListing[];
  notice: SkillPickerNotice | null;
  open: boolean;
  active: number;
}

/** Derive the `@` picker's render state from the composer buffer, the caret,
 *  and the async catalogue. A pure function of its inputs, exactly like the
 *  trigger itself (the editor's `[[` autocomplete discipline). */
function deriveSkillPicker(args: {
  input: string;
  caret: number;
  dismissedKey: string | null;
  pickerIndex: number;
  catalogue: SkillsCatalogue;
  activeSkills: readonly SkillPickerEntry[];
}): SkillPickerState {
  const { input, caret, dismissedKey, pickerIndex, catalogue, activeSkills } =
    args;
  const trigger = findSkillTrigger(input, caret);
  const triggerKey =
    trigger === null ? null : `${trigger.start}:${trigger.query}`;
  // Only enabled skills are offerable — activation authority stays with the
  // Rust `SkillRegistry`, and offering a disabled skill would set up a
  // guaranteed "could not be activated" notice.
  const offerableSkills =
    catalogue.status === "ready"
      ? catalogue.skills.filter((s) => s.enabled)
      : [];
  const suggestions =
    trigger !== null && triggerKey !== dismissedKey
      ? filterSkillSuggestions(
          offerableSkills,
          trigger.query,
          activeSkills.map((s) => s.id),
        )
      : [];
  const notice = skillPickerNotice(catalogue);
  const open =
    suggestions.length > 0 ||
    (trigger !== null && triggerKey !== dismissedKey && notice !== null);
  return {
    trigger,
    triggerKey,
    suggestions,
    notice,
    open,
    active:
      suggestions.length > 0 ? Math.min(pickerIndex, suggestions.length - 1) : 0,
  };
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

/** Header connection pill. The active model now belongs at the point of send
 *  in the composer, leaving only the disconnected state in the header. */
function ChatStatusPill({ view }: Readonly<{ view: View }>) {
  if (view === "disconnected") {
    return (
      <NeuralStatusPill status="neutral" className="ml-auto shrink-0 gap-1.5 px-2.5 py-1 text-[0.6875rem]">
        <Database className="size-3" aria-hidden /> Not connected
      </NeuralStatusPill>
    );
  }
  return null;
}

function ComposerActionButton({
  buttonRef,
  busy,
  stopping,
  inputEmpty,
  onSend,
  onCancel,
}: Readonly<{
  buttonRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  stopping: boolean;
  inputEmpty: boolean;
  onSend: () => void;
  onCancel: () => void;
}>) {
  const label = busy ? (stopping ? "Stopping" : "Stop response") : "Send";
  const disabled = busy ? stopping : inputEmpty;
  let icon = <Send className="size-4" aria-hidden />;
  if (busy) {
    icon = stopping ? (
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
    ) : (
      <Square className="size-3.5 fill-current" aria-hidden />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={busy ? onCancel : onSend}
      disabled={disabled}
      aria-label={label}
      className={cn(buttonVariants({ tone: "chat", size: "icon" }), "size-9")}
    >
      {icon}
    </button>
  );
}

export function ChatPane({
  openNoteAt,
  onOpenSettings,
  refreshSignal = 0,
}: Readonly<{
  openNoteAt: (absPath: string) => void;
  /** Opens the settings modal on the AI section (local setup lives there). */
  onOpenSettings: () => void;
  /** Bumped by the workspace when Settings closes, so a provider configured
   *  there (e.g. a first local model) is reflected without remounting — and
   *  without wiping an in-progress transcript. */
  refreshSignal?: number;
}>) {
  const { vault, reportError } = useVault();
  const vaultPath = vault?.path;

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stoppingTurnId, setStoppingTurnId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const activeTurnIdRef = useRef<string | null>(null);
  const reasoningReasonId = useId();

  // ── Skills: the chip row + the composer's `@` picker ────────────────────────
  // Chips persist across sends on purpose: an activated skill is a mode the
  // user switched on (and history-carried follow-ups — a late elicitation
  // answer — should re-activate it), not a one-message attachment.
  const [activeSkills, setActiveSkills] = useState<SkillPickerEntry[]>([]);
  // The backend catalogue the picker offers (Settings › Skills is the other
  // consumer). Loaded on mount and re-read whenever Settings closes — the one
  // place a skill's enabled state can change out from under the picker.
  const [skillsCatalogue, setSkillsCatalogue] = useState<SkillsCatalogue>({
    status: "loading",
  });
  // Ref mirror (the messagesRef idiom below): the catalogue effect's failure
  // handler needs to know whether a last-good catalogue exists, without the
  // effect re-running on every catalogue change.
  const skillsCatalogueRef = useRef(skillsCatalogue);
  skillsCatalogueRef.current = skillsCatalogue;
  // Run ids by assistant-message index, resolved as each run settles — the
  // report card's Undo handle. Client-side only; never part of the transcript.
  const [runIds, setRunIds] = useState<Record<number, string>>({});
  // The caret mirrors the textarea's selectionStart (the trigger is a pure
  // function of value + caret, exactly like the editor's `[[` autocomplete).
  const [caret, setCaret] = useState(0);
  const [pickerIndex, setPickerIndex] = useState(0);
  // Escape/blur dismiss the popup for the CURRENT trigger text only — typing
  // another character re-derives the key and the popup may reopen.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerActionRef = useRef<HTMLButtonElement>(null);
  const composerRunOwnsFocusRef = useRef(false);
  const previousBusyRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy === previousBusyRef.current) return;

    if (busy && composerRunOwnsFocusRef.current) {
      composerActionRef.current?.focus();
    } else if (!busy && composerRunOwnsFocusRef.current) {
      composerRunOwnsFocusRef.current = false;
      composerRef.current?.focus();
    }

    previousBusyRef.current = busy;
  }, [busy]);

  // Load the picker's catalogue. `refreshSignal` bumps when Settings closes,
  // so a skill toggled there is reflected without remounting the pane. A
  // failed REFRESH keeps the last good catalogue on screen (stale beats
  // blank) but still surfaces the failure on the pane's shared error channel
  // — exactly like a failed `aiStatus` read; only a load with nothing to fall
  // back on lands on the quiet in-picker error line instead, surfaced where
  // the data is consumed. Either way, never silent.
  useEffect(() => {
    let cancelled = false;
    api
      .listSkills()
      .then((skills) => {
        if (!cancelled) setSkillsCatalogue({ status: "ready", skills });
      })
      .catch((e) => {
        if (cancelled) return;
        if (skillsCatalogueRef.current.status === "ready") {
          reportError(errorMessage(e));
        } else {
          setSkillsCatalogue({ status: "error", message: errorMessage(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal, reportError]);

  // The popup's render state is a pure derivation of buffer + caret + the
  // async catalogue — see `deriveSkillPicker` for the offerability and
  // loading/error-notice rules.
  const {
    trigger,
    triggerKey,
    suggestions,
    notice: pickerNotice,
    open: pickerOpen,
    active: pickerActive,
  } = deriveSkillPicker({
    input,
    caret,
    dismissedKey,
    pickerIndex,
    catalogue: skillsCatalogue,
    activeSkills,
  });

  // A changed trigger is a new search: highlight from the top again.
  useEffect(() => {
    setPickerIndex(0);
  }, [triggerKey]);

  // Restore the caret after a pick edits the buffer mid-text (a controlled
  // textarea moves the caret to the end on programmatic value changes).
  useEffect(() => {
    if (pendingCaretRef.current === null) return;
    composerRef.current?.setSelectionRange(
      pendingCaretRef.current,
      pendingCaretRef.current,
    );
    pendingCaretRef.current = null;
  }, [input]);

  // Latest transcript, read when building the next request's history without
  // rebuilding the send callback on every streamed delta.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
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
      .then((status) => {
        if (cancelled || statusGenerationRef.current !== generation) return;
        // A later refresh that still reports "nothing configured" must not
        // stomp a manually-chosen first-run view (guided setup / skipped);
        // only the mount pass may land on the picker from scratch.
        if (status.activeProvider === null && viewRef.current !== "loading") return;
        commitStatus(mergeStatusRead(statusRef.current, status));
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

  /** Run one chat turn. Shared by the composer and by a dormant elicitation's
   *  late answer (which is an ordinary turn by design — spec §3.4). */
  const sendPrompt = useCallback(
    (prompt: string) => {
      if (prompt === "" || busy) return;
      const turnId = crypto.randomUUID();
      const history = toHistory(messagesRef.current);
      // Where the assistant turn is about to land — the run id resolved below
      // is keyed to it so the report card's Undo targets the right run.
      const assistantIndex = messagesRef.current.length + 1;
      activeTurnIdRef.current = turnId;
      setBusy(true);
      setStopError(null);
      setLiveAnnouncement("");
      // Pin the live reasoning opt-in onto the turn at creation: the finished
      // turn is judged (the backstop notice) against the opt-in it actually ran
      // under, not a flag the user may have flipped mid-stream.
      setMessages((prev) => [
        ...prev,
        userMessage(prompt),
        emptyAssistant(effectiveReasoning, turnId),
      ]);
      const applyTurnEvent = (event: ChatEvent) => {
        setMessages((prev) => reduceAssistantForTurn(prev, turnId, event));
      };
      // A transport-level rejection is surfaced as an inline error event, so a
      // failed run is never silent and the composer always re-enables.
      void api
        .chat(turnId, prompt, history, applyTurnEvent, activeSkills.map((s) => s.id))
        .then((runId) => {
          // The caller UUID is the sole run identity. A mismatched native echo
          // never receives an Undo handle.
          if (runId === turnId) {
            setRunIds((prev) => ({ ...prev, [assistantIndex]: runId }));
          }
        })
        .catch((e) => applyTurnEvent({ type: "error", message: errorMessage(e) }))
        .finally(() => {
          if (activeTurnIdRef.current === turnId) {
            activeTurnIdRef.current = null;
            setBusy(false);
          }
          setStoppingTurnId((current) => (current === turnId ? null : current));
        });
    },
    [busy, effectiveReasoning, activeSkills],
  );

  const send = useCallback(() => {
    const prompt = input.trim();
    if (prompt === "" || busy) return;
    composerRunOwnsFocusRef.current = true;
    setInput("");
    sendPrompt(prompt);
  }, [input, busy, sendPrompt]);

  const cancelRun = useCallback(async () => {
    const turnId = activeTurnIdRef.current;
    if (!busy || turnId === null || stoppingTurnId === turnId) return;
    setStoppingTurnId(turnId);
    setStopError(null);
    try {
      const outcome = await api.cancelChatRun(turnId);
      if (activeTurnIdRef.current !== turnId) return;
      if (outcome.turnId !== turnId) {
        setStopError("Couldn't stop the response");
        setStoppingTurnId(null);
        return;
      }
      if (outcome.status === "cancelled") {
        // TODO(done-cancel-announcement): announce stopped only when
        // markAssistantStopped actually transitions this turn; Done must keep
        // its completed announcement if native guard cleanup is still pending.
        setMessages((prev) => markAssistantStopped(prev, turnId));
        setLiveAnnouncement("Response stopped.");
      } else {
        setStoppingTurnId(null);
      }
    } catch {
      if (activeTurnIdRef.current === turnId) {
        setStopError("Couldn't stop the response");
        setStoppingTurnId(null);
      }
    }
  }, [busy, stoppingTurnId]);

  /** Swap the typed `@query` for a chip; the picker and the chips both feed
   *  the same `activeSkills` field on the next send. */
  const pickSkill = useCallback(
    (skill: SkillPickerEntry) => {
      if (trigger === null) return;
      const removed = removeSkillTrigger(input, trigger.start, caret);
      setActiveSkills((prev) => [...prev, skill]);
      setInput(removed.value);
      setCaret(removed.caret);
      pendingCaretRef.current = removed.caret;
      // A mouse pick must not strand focus: typing continues in the composer.
      composerRef.current?.focus();
    },
    [trigger, input, caret],
  );

  const removeSkill = useCallback((id: string) => {
    setActiveSkills((prev) => prev.filter((s) => s.id !== id));
  }, []);

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

  const openCitation = useCallback(
    (citation: CitationView) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${citation.relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  const openWrittenNote = useCallback(
    (relPath: string) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  const syncCaret = (e: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  /** The keys the open `@` popup claims; true means the event was consumed.
   *  With no options yet (the quiet loading/error line), only Escape is
   *  claimed: arrows keep moving the caret and Enter falls through to an
   *  ordinary send. */
  const handlePickerKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const len = suggestions.length;
    if (len > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerIndex((pickerActive + 1) % len);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerIndex((pickerActive - 1 + len) % len);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSkill(suggestions[pickerActive]);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissedKey(triggerKey);
      return true;
    }
    return false;
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the `@` popup is open it owns the nav keys — Enter picks a skill,
    // it never sends mid-pick.
    if (pickerOpen && handlePickerKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside className="nn-chat-pane relative flex shrink-0 flex-col border-l border-border bg-sidebar">
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {liveAnnouncement}
      </p>
      <header className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg border border-primary/25 bg-primary/12 text-primary">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <span className="nn-heading shrink-0 text-sm font-semibold">
            Neural Assistant AI
          </span>
          <ChatStatusPill view={view} />
        </div>
        <p className="mt-2 text-[0.6875rem] leading-snug text-muted-foreground">
          Ask questions across everything in your vault. Every claim is
          citation-checked against its source.
        </p>
      </header>

      {view === "loading" && (
        <output className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[0.75rem] text-muted-foreground/70">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Checking connection…
        </output>
      )}

      {view === "picker" && (
        <ProviderPicker
          onPickOpenRouter={() => setView("setup")}
          onPickLocal={onOpenSettings}
          onSkip={() => setView("disconnected")}
        />
      )}

      {view === "setup" && (
        <KeySetupPanel
          model={model}
          saving={saving}
          onSave={handleSave}
          onSkip={() => setView("disconnected")}
        />
      )}

      {view === "localSetup" && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-inset ring-border">
            <Cpu className="size-5" aria-hidden />
          </span>
          <p className="text-[0.8125rem] font-medium text-foreground/90">
            Local AI needs a model
          </p>
          <p className="mx-auto max-w-[17rem] text-[0.75rem] leading-relaxed text-muted-foreground">
            Local AI is selected, but no model is set up yet. Pick one to
            download in the AI settings.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(buttonVariants({ tone: "primary", size: "sm" }), "mt-1 px-3.5")}
          >
            Open AI settings
          </button>
        </div>
      )}

      {view === "disconnected" && (
        // Back to the provider PICKER, not the OpenRouter form — both shipped
        // providers (key or Local AI) must stay reachable after a skip. The
        // refresh guard above never lands here on its own ("picker" only
        // applies from a loading mount), so this can't loop.
        <DisconnectedPane onConnect={() => setView("picker")} />
      )}

      {view === "chat" && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                  <Sparkles className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.8125rem] font-medium text-foreground/90">
                    Ask anything across your vault
                  </p>
                  <p className="mx-auto max-w-[15rem] text-[0.75rem] leading-relaxed text-muted-foreground">
                    Watch the answer get searched, read and citation-checked live.
                  </p>
                </div>
              </div>
            ) : (
              <ChatMessages
                messages={messages}
                onOpenCitation={openCitation}
                onOpenNote={openWrittenNote}
                onSendFollowUp={sendPrompt}
                busy={busy}
                runIds={runIds}
              />
            )}
          </div>

          <div className="shrink-0 border-t border-border px-4 pb-3 pt-3">
            {stopError && (
              <p
                role="alert"
                className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
              >
                <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                {stopError}
              </p>
            )}
            {reasoningError && (
              // The pane's error voice (mirrors the turn error box), announced:
              // a toggle that silently failed to persist would misbill the user.
              <p
                role="alert"
                className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[0.6875rem] leading-snug text-destructive"
              >
                <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{reasoningError}</span>
              </p>
            )}
            <SkillChips skills={activeSkills} onRemove={removeSkill} />
            <div className="relative">
              {pickerOpen && (
                <SkillSuggestions
                  suggestions={suggestions}
                  notice={suggestions.length === 0 ? pickerNotice : null}
                  active={pickerActive}
                  onPick={pickSkill}
                  onHover={setPickerIndex}
                />
              )}
              <div className="flex items-end gap-2 rounded-xl bg-background/40 p-2 ring-1 ring-inset ring-border transition focus-within:bg-background/60 focus-within:ring-2 focus-within:ring-ring">
              <textarea
                ref={composerRef}
                rows={1}
                value={input}
                disabled={busy}
                onChange={(e) => {
                  setInput(e.target.value);
                  syncCaret(e);
                }}
                onKeyDown={onComposerKeyDown}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onBlur={() => setDismissedKey(triggerKey)}
                // Coming back to the composer is a fresh session for the
                // popup: a blur-dismissal must not outlive it (the key alone
                // can collide with an identically retyped trigger).
                onFocus={() => setDismissedKey(null)}
                aria-label="Ask across your vault"
                aria-autocomplete="list"
                // The listbox exists only when there are options — a popup
                // showing the quiet loading/error line is not a listbox, so
                // the combobox wiring stays off until options render.
                aria-controls={suggestions.length > 0 ? SKILL_LISTBOX_ID : undefined}
                aria-activedescendant={
                  suggestions.length > 0 ? skillOptionId(pickerActive) : undefined
                }
                placeholder="Ask across your vault…"
                className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.8125rem] leading-5 placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <ComposerActionButton
                buttonRef={composerActionRef}
                busy={busy}
                stopping={
                  activeTurnIdRef.current !== null &&
                  stoppingTurnId === activeTurnIdRef.current
                }
                inputEmpty={input.trim() === ""}
                onSend={send}
                onCancel={() => void cancelRun()}
              />
              </div>
            </div>
            {/* The composer's meta strip: the reasoning opt-in on the left (a
                quiet chip — it changes what the next turn requests, so it lives
                at the point of send), the keyboard hint on the right. */}
            <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-1">
                {status && (
                  <ChatModelMenu
                    status={status}
                    busy={busy}
                    onStatusChange={applyStatus}
                    onOpenSettings={onOpenSettings}
                  />
                )}
                <button
                type="button"
                onClick={() => void toggleReasoning()}
                // Two different inert states, split on purpose. A write in
                // flight is transient — native disabled is fine. "unsupported"
                // is EXPLANATORY: aria-disabled keeps the chip focusable so a
                // keyboard/SR user can reach it and get the why (the visible
                // line below, wired via aria-describedby); the click guard
                // lives in toggleReasoning.
                disabled={savingReasoning}
                aria-disabled={capability.disabled || undefined}
                aria-pressed={reasoningOn}
                aria-label="Show model reasoning"
                aria-describedby={capability.reason ? reasoningReasonId : undefined}
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ring-1 ring-inset transition-colors motion-reduce:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  reasoningOn
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "text-muted-foreground ring-border",
                  savingReasoning || capability.disabled
                    ? "cursor-not-allowed opacity-50"
                    : !reasoningOn && "hover:bg-muted hover:text-foreground",
                )}
                >
                  <Brain className="size-3 shrink-0" aria-hidden />
                  Reasoning
                </button>
              </div>
              <p className="nn-compact-label text-right text-[0.625rem] leading-none text-muted-foreground/60">
                Enter to send · Shift+Enter for a new line
              </p>
            </div>
            {capability.reason && (
              // Not hover-only, not SR-only: the persistent "why" is a plain
              // visible line every user can perceive, and it doubles as the
              // chip's accessible description.
              <p
                id={reasoningReasonId}
                className="mt-1 px-1 text-[0.625rem] leading-snug text-muted-foreground/70"
              >
                {capability.reason}
              </p>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
