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
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Cpu, Database, Loader2, Send, Sparkles } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { useVault } from "../lib/store";
import type { AiStatus, ChatEvent } from "../lib/types";
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

/** Locked default from the plan; the backend echoes it via `aiStatus`. */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

type View =
  | "loading"
  | "picker"
  | "setup"
  | "localSetup"
  | "disconnected"
  | "chat";

/** Header status pill — mirrors ChatStub's "Indexing soon" chip per state. */
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
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [saving, setSaving] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

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
  const applyStatus = useCallback((status: AiStatus) => {
    if (status.activeProvider === "openRouter") {
      setModel(status.openrouter.model || DEFAULT_MODEL);
      // hasKey false here would be a config hole — fall back to guided setup.
      setView(status.openrouter.hasKey ? "chat" : "setup");
    } else if (status.activeProvider === "local") {
      if (status.local.activeModelTag) {
        setModel(status.local.activeModelTag);
        setView("chat");
      } else {
        // "Local" chosen but nothing downloaded — an honest hand-off into
        // Settings, never a chat that would only error.
        setView("localSetup");
      }
    } else {
      setModel(status.openrouter.model || DEFAULT_MODEL);
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
    setMessages((prev) => [...prev, userMessage(prompt), emptyAssistant()]);
    // A transport-level rejection is surfaced as an inline error event, so a
    // failed run is never silent and the composer always re-enables.
    void api
      .chat(prompt, history, applyEvent)
      .catch((e) => applyEvent({ type: "error", message: errorMessage(e) }))
      .finally(() => setBusy(false));
  }, [input, busy, applyEvent]);

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
          Ask questions across everything you&apos;ve captured. Every claim is
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
            className="mt-1 rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-[0_0_16px_-8px_var(--color-primary)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Open AI settings
          </button>
        </div>
      )}

      {view === "disconnected" && (
        <DisconnectedPane onConnect={() => setView("setup")} />
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
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_16px_-8px_var(--color-primary)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <Send className="size-4" aria-hidden />
                )}
              </button>
            </div>
            <p className="mt-1.5 pr-1 text-right text-[10px] leading-none text-muted-foreground/60">
              Enter to send · Shift+Enter for a new line
            </p>
          </div>
        </>
      )}
    </aside>
  );
}
