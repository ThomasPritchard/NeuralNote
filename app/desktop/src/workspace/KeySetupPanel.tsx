// The connection-state bodies of the chat pane: the guided OpenRouter key setup
// and the clearly-disabled "skipped" state. Never a raw error — a missing key is
// an invitation to connect, not a stack trace (spec §6, §8).

import { useState } from "react";
import { KeyRound, Sparkles } from "lucide-react";

// Exported so the settings page's key form (AiSettingsPage) shares the exact
// field idiom — two key UIs that can't drift apart.
export const FIELD =
  "w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/30";
export const LABEL = "text-[11px] font-medium text-muted-foreground";

/** Guided API-key setup, shown inside the pane when no key is stored. */
export function KeySetupPanel({
  model,
  saving,
  onSave,
  onSkip,
}: Readonly<{
  model: string;
  saving: boolean;
  onSave: (key: string, model: string) => void;
  onSkip: () => void;
}>) {
  const [key, setKey] = useState("");
  const [modelValue, setModelValue] = useState(model);
  const canSave = key.trim() !== "" && !saving;

  const submit = () => {
    if (canSave) onSave(key.trim(), modelValue.trim() || model);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-8">
      <div className="flex flex-col items-center gap-2.5 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary shadow-[0_0_24px_-8px_var(--color-primary)] ring-1 ring-inset ring-primary/20">
          <KeyRound className="size-5" aria-hidden />
        </span>
        <p className="text-[14px] font-medium text-foreground/90">Connect an AI key</p>
        <p className="mx-auto max-w-[17rem] text-[12px] leading-relaxed text-muted-foreground">
          Add an OpenRouter key to chat with your vault. Your key is stored in the
          OS keychain, so it never leaves this machine.
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>OpenRouter API key</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="OpenRouter API key"
            placeholder="sk-or-…"
            className={FIELD}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={`flex items-baseline justify-between ${LABEL}`}>
            {/* No whitespace intended between the two — justify-between spaces
                them; the expression container makes that explicit. */}
            {"Model"}
            <span className="text-[10px] font-normal text-muted-foreground/60">
              optional
            </span>
          </span>
          <input
            type="text"
            value={modelValue}
            onChange={(e) => setModelValue(e.target.value)}
            aria-label="Model"
            className={`nn-mono ${FIELD}`}
          />
          <span className="text-[10px] leading-snug text-muted-foreground/60">
            A capable default is already set for you.
          </span>
        </label>

        <button
          type="submit"
          disabled={!canSave}
          className="mt-1 grid place-items-center rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground shadow-[0_0_18px_-6px_var(--color-primary)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {saving ? "Saving…" : "Save & start chatting"}
        </button>
      </form>

      <button
        type="button"
        onClick={onSkip}
        className="mx-auto rounded text-[12px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        Skip for now
      </button>
    </div>
  );
}

/** The clearly-disabled state after "Skip" — an honest dead-end with the one
 *  action that revives the pane. */
export function DisconnectedPane({ onConnect }: Readonly<{ onConnect: () => void }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-inset ring-border">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <p className="text-[13px] font-medium text-foreground/90">Cited chat is off</p>
      <p className="mx-auto max-w-[17rem] text-[12px] leading-relaxed text-muted-foreground">
        Connect an OpenRouter key to ask questions across your vault and get
        answers grounded in the exact source.
      </p>
      <button
        type="button"
        onClick={onConnect}
        className="mt-1 rounded-lg bg-primary px-3.5 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-[0_0_16px_-8px_var(--color-primary)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Connect a key
      </button>
    </div>
  );
}
