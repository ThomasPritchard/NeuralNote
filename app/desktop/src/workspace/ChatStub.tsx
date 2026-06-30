// The docked "Cited recall" pane, ported from the prototype as an honest,
// clearly-disabled stub. The visual shell exists so the locked layout is
// complete, but it fakes no AI output or citations — cited chat arrives next.

import { Database, Send, Sparkles } from "lucide-react";

export function ChatStub() {
  return (
    <aside className="relative flex w-[380px] shrink-0 flex-col border-l border-border bg-gradient-to-b from-primary/[0.07] via-sidebar to-sidebar">
      <header className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_18px_-5px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <span className="nn-heading text-sm font-semibold">Cited recall</span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
            <Database className="size-3 text-primary" aria-hidden /> Indexing soon
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Ask questions across everything you&apos;ve captured — every claim citation-checked.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-card text-primary ring-1 ring-inset ring-border">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <p className="text-[13px] font-medium text-foreground/90">Cited chat arrives in the next phase</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Once your vault is embedded, ask anything and get answers grounded in the exact source
          chunk or timestamp.
        </p>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-end gap-2 rounded-xl bg-background/40 p-2 ring-1 ring-inset ring-border opacity-60">
          <textarea
            rows={1}
            disabled
            aria-label="Ask across your vault (coming soon)"
            placeholder="Cited chat is coming soon…"
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 placeholder:text-muted-foreground/70 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            disabled
            aria-label="Send (coming soon)"
            className="grid size-9 shrink-0 cursor-not-allowed place-items-center rounded-lg bg-muted text-muted-foreground"
          >
            <Send className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}
