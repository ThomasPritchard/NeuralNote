// The docked "Cited recall" pane — the real cited-chat UI. The provider-aware
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
} from "react";
import {
  AlertTriangle,
  Brain,
  Cpu,
  Database,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { useVault } from "../lib/store";
import type { AiStatus, ChatEvent } from "../lib/types";
import { BTN_PRIMARY } from "./buttonStyles";
import { ChatMessages } from "./ChatMessages";
import {
  emptyAssistant,
  reduceAssistant,
  toHistory,
  userMessage,
  type ChatMessage,
  type CitationView,
} from "./chatMessage";
import { DisconnectedPane, KeySetupPanel } from "./KeySetupPanel";
import { ProviderPicker } from "./ProviderPicker";
import { reasoningCapability } from "./reasoningSupport";

type View =
  | "loading"
  | "picker"
  | "setup"
  | "localSetup"
  | "disconnected"
  | "chat";

/** Header status pill: the connected model id while chatting, "Not connected"
 *  after a skip; hidden during the transient first-run states. */
function StatusPill({ view, model }: Readonly<{ view: View; model: string }>) {
  if (view === "chat") {
    return (
      <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
        <span className="size-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]" aria-hidden />
        <span className="nn-mono max-w-[9rem] truncate">{model.split("/").pop()}</span>
      </span>
    );
  }
  if (view === "disconnected") {
    return (
      <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
        <Database className="size-3" aria-hidden /> Not connected
      </span>
    );
  }
  return null;
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
  const reasoningReasonId = useId();

  // Latest transcript, read when building the next request's history without
  // rebuilding the send callback on every streamed delta.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Latest view, readable from the status effect below without re-running it
  // (and re-fetching) every time the user walks through the first-run states.
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Land on the view a provider-aware status implies. The `model` doubles as
   *  the status-pill label: the OpenRouter model id, or the local model tag. */
  const applyStatus = useCallback((next: AiStatus) => {
    setStatus(next);
    if (next.activeProvider === "openRouter") {
      setModel(next.openrouter.model);
      // hasKey false here would be a config hole — fall back to guided setup.
      setView(next.openrouter.hasKey ? "chat" : "setup");
    } else if (next.activeProvider === "local") {
      if (next.local.activeModelTag) {
        setModel(next.local.activeModelTag);
        setView("chat");
      } else {
        // "Local" chosen but nothing downloaded — an honest hand-off into
        // Settings, never a chat that would only error.
        setView("localSetup");
      }
    } else {
      setModel(next.openrouter.model);
      setView("picker");
    }
  }, []);

  // On mount (and whenever Settings closes), read the effective provider. A
  // failed check still lands on the first-run picker (never a raw error) but
  // is surfaced on the shared channel.
  useEffect(() => {
    let cancelled = false;
    api
      .aiStatus()
      .then((status) => {
        if (cancelled) return;
        // A later refresh that still reports "nothing configured" must not
        // stomp a manually-chosen first-run view (guided setup / skipped);
        // only the mount pass may land on the picker from scratch.
        if (status.activeProvider === null && viewRef.current !== "loading") return;
        applyStatus(status);
      })
      .catch((e) => {
        if (cancelled) return;
        reportError(errorMessage(e));
        if (viewRef.current === "loading") setView("picker");
      });
    return () => {
      cancelled = true;
    };
  }, [applyStatus, reportError, refreshSignal]);

  // The provider+model this status would chat against, or null in a first-run
  // state with nothing to probe. A string key, so the probe effect below
  // re-fires exactly when the effective provider or selected model changes —
  // and only then (`refreshReasoningSupport` is network I/O, never per-render).
  let probeTarget: string | null = null;
  if (status?.activeProvider === "openRouter" && status.openrouter.hasKey) {
    probeTarget = `openRouter:${status.openrouter.model}`;
  } else if (status?.activeProvider === "local" && status.local.activeModelTag) {
    probeTarget = `local:${status.local.activeModelTag}`;
  }

  // Probe the selected model for reasoning support on mount and on every
  // provider/model change. A failed probe fails OPEN: capability stays
  // "unknown", the toggle stays enabled, and the failure is surfaced on the
  // shared channel — exactly like the mount status-read failure above.
  useEffect(() => {
    if (probeTarget === null) return;
    let cancelled = false;
    api
      .refreshReasoningSupport()
      .then((fresh) => {
        if (!cancelled) applyStatus(fresh);
      })
      .catch((e) => {
        if (!cancelled) reportError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [probeTarget, applyStatus, reportError]);

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

  // Fold each streamed event into the in-flight (last) assistant turn.
  const applyEvent = useCallback((event: ChatEvent) => {
    setMessages((prev) => {
      const last = prev.at(-1);
      if (last?.role !== "assistant") return prev;
      return [...prev.slice(0, -1), reduceAssistant(last, event)];
    });
  }, []);

  const send = useCallback(() => {
    const prompt = input.trim();
    if (prompt === "" || busy) return;
    const history = toHistory(messagesRef.current);
    setInput("");
    setBusy(true);
    // Pin the live reasoning opt-in onto the turn at creation: the finished
    // turn is judged (the backstop notice) against the opt-in it actually ran
    // under, not a flag the user may have flipped mid-stream.
    setMessages((prev) => [
      ...prev,
      userMessage(prompt),
      emptyAssistant(effectiveReasoning),
    ]);
    // A transport-level rejection is surfaced as an inline error event, so a
    // failed run is never silent and the composer always re-enables.
    void api
      .chat(prompt, history, applyEvent)
      .catch((e) => applyEvent({ type: "error", message: errorMessage(e) }))
      .finally(() => setBusy(false));
  }, [input, busy, effectiveReasoning, applyEvent]);

  const handleSave = useCallback(
    async (key: string, chosenModel: string) => {
      setSaving(true);
      try {
        await api.saveApiKey(key, chosenModel);
        // Re-read the effective provider: a fresh key with no explicit choice
        // reads as "openRouter", which lands the pane in the chat view.
        applyStatus(await api.aiStatus());
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

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside className="relative flex w-[380px] shrink-0 flex-col border-l border-border bg-gradient-to-b from-primary/[0.07] via-sidebar to-sidebar">
      <header className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_18px_-5px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <span className="nn-heading text-sm font-semibold">Cited recall</span>
          <StatusPill view={view} model={model} />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Ask questions across everything in your vault. Every claim is
          citation-checked against its source.
        </p>
      </header>

      {view === "loading" && (
        <output className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground/70">
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
          <p className="text-[13px] font-medium text-foreground/90">
            Local AI needs a model
          </p>
          <p className="mx-auto max-w-[17rem] text-[12px] leading-relaxed text-muted-foreground">
            Local AI is selected, but no model is set up yet. Pick one to
            download in the AI settings.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(BTN_PRIMARY, "mt-1 px-3.5")}
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
                <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary shadow-[0_0_24px_-8px_var(--color-primary)] ring-1 ring-inset ring-primary/20">
                  <Sparkles className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[13px] font-medium text-foreground/90">
                    Ask anything across your vault
                  </p>
                  <p className="mx-auto max-w-[15rem] text-[12px] leading-relaxed text-muted-foreground">
                    Watch the answer get searched, read and citation-checked live.
                  </p>
                </div>
              </div>
            ) : (
              <ChatMessages messages={messages} onOpenCitation={openCitation} />
            )}
          </div>

          <div className="shrink-0 border-t border-border px-4 pb-3 pt-3">
            {reasoningError && (
              // The pane's error voice (mirrors the turn error box), announced:
              // a toggle that silently failed to persist would misbill the user.
              <p
                role="alert"
                className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] leading-snug text-destructive"
              >
                <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{reasoningError}</span>
              </p>
            )}
            <div className="flex items-end gap-2 rounded-xl bg-background/40 p-2 ring-1 ring-inset ring-border transition focus-within:bg-background/60 focus-within:ring-primary/40">
              <textarea
                rows={1}
                value={input}
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKeyDown}
                aria-label="Ask across your vault"
                placeholder="Ask across your vault…"
                className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={send}
                disabled={busy || input.trim() === ""}
                aria-label="Send"
                // The primary button in icon-only form: p-0 clears the text
                // padding; the type-scale classes are inert on an svg child.
                className={cn(BTN_PRIMARY, "grid size-9 shrink-0 place-items-center p-0")}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <Send className="size-4" aria-hidden />
                )}
              </button>
            </div>
            {/* The composer's meta strip: the reasoning opt-in on the left (a
                quiet chip — it changes what the next turn requests, so it lives
                at the point of send), the keyboard hint on the right. */}
            <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
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
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition-colors motion-reduce:transition-none",
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
              <p className="text-right text-[10px] leading-none text-muted-foreground/60">
                Enter to send · Shift+Enter for a new line
              </p>
            </div>
            {capability.reason && (
              // Not hover-only, not SR-only: the persistent "why" is a plain
              // visible line every user can perceive, and it doubles as the
              // chip's accessible description.
              <p
                id={reasoningReasonId}
                className="mt-1 px-1 text-[10px] leading-snug text-muted-foreground/70"
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
