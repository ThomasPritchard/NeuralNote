import {
  Brain,
  ChevronRight,
  Clock,
  FileText,
  Folder,
  Hash,
  Newspaper,
  Plus,
  Quote,
  Search,
  Send,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import type { SourceType } from "../mock";
import { chatThread, openNote, recentCaptures, vault, vaultStats } from "../mock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const typeIcon: Record<SourceType, typeof Video> = {
  youtube: Video,
  article: Newspaper,
  pdf: FileText,
  text: Type,
};

// ── Eden ── warm-dark, soft sage, spacious & calm. 3 panes, lots of air,
// cited chat as a focused right rail. Reference implementation for the set.
export default function Eden() {
  return (
    <div className="flex h-full w-full bg-background text-foreground">
      {/* ── Vault sidebar ─────────────────────────────────────────────── */}
      <aside className="flex w-72 flex-col gap-6 bg-sidebar px-5 py-6 text-sidebar-foreground">
        <div className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Brain className="size-4" />
          </div>
          <span className="nn-heading text-[15px] font-semibold tracking-tight">NeuralNote</span>
        </div>

        <Button className="h-11 justify-start gap-2 rounded-2xl bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="size-4" /> Capture anything
        </Button>

        <label className="flex items-center gap-2 rounded-2xl bg-background/40 px-3.5 py-2.5 text-sm text-muted-foreground ring-1 ring-border">
          <Search className="size-4" />
          <input
            placeholder="Ask or search…"
            className="w-full bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
          />
        </label>

        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto">
          {vault.map((folder) => (
            <div key={folder.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                <Folder className="size-3" /> {folder.name}
              </div>
              {folder.notes.map((note) => {
                const Icon = typeIcon[note.type];
                const active = note.id === openNote.id;
                return (
                  <button
                    key={note.id}
                    className={`flex items-start gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition ${
                      active
                        ? "bg-sidebar-accent text-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                    }`}
                  >
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-primary/80" />
                    <span className="line-clamp-2 leading-snug">{note.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex items-center justify-between rounded-2xl bg-background/30 px-4 py-3 text-xs text-muted-foreground">
          <span>{vaultStats.notes} notes</span>
          <span>{vaultStats.embedded} embedded</span>
        </div>
      </aside>

      {/* ── Reader ────────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col overflow-y-auto px-12 py-10">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Video className="size-3.5 text-primary" />
            <span>{openNote.sourceUrl}</span>
            <span className="opacity-40">·</span>
            <Clock className="size-3" />
            <span>{openNote.capturedAt}</span>
          </div>

          <h1 className="nn-heading mt-4 text-4xl font-semibold leading-tight tracking-tight">
            {openNote.title}
          </h1>

          <div className="mt-4 flex flex-wrap gap-2">
            {openNote.tags.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="gap-1 rounded-full border-border px-3 py-1 text-xs font-normal text-muted-foreground"
              >
                <Hash className="size-3" /> {t}
              </Badge>
            ))}
          </div>

          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs text-primary">
            <Sparkles className="size-3" /> Distilled by {openNote.distilModel}
          </div>

          <p className="mt-8 text-[17px] leading-relaxed text-foreground/90">{openNote.summary}</p>

          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Key claims
          </h2>
          <ul className="mt-4 flex flex-col gap-3">
            {openNote.keyClaims.map((claim, i) => (
              <li key={i} className="flex gap-3 rounded-2xl bg-card px-5 py-4 ring-1 ring-border">
                <span className="nn-mono mt-0.5 text-sm text-primary">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[15px] leading-relaxed text-foreground/90">{claim}</span>
              </li>
            ))}
          </ul>

          <div className="mt-12 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Quote className="size-4 text-primary" /> Full source · retained transcript
          </div>
          <div className="mt-4 flex flex-col gap-px overflow-hidden rounded-2xl ring-1 ring-border">
            {openNote.sourceChunks.map((chunk) => (
              <div key={chunk.id} className="flex gap-4 bg-card px-5 py-4">
                <span className="nn-mono shrink-0 text-xs text-primary">{chunk.locator}</span>
                <span className="text-sm leading-relaxed text-muted-foreground">{chunk.text}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* ── Cited chat rail (the hero) ────────────────────────────────── */}
      <aside className="flex w-[400px] flex-col border-l border-border bg-card/40">
        <div className="flex items-center gap-2 px-6 py-5">
          <Sparkles className="size-4 text-primary" />
          <span className="nn-heading text-sm font-semibold">Ask your brain</span>
        </div>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-4">
          {chatThread.map((turn, i) =>
            turn.role === "user" ? (
              <div key={i} className="self-end rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                {turn.text}
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-4">
                <p className="text-[15px] leading-relaxed text-foreground/90">
                  {renderWithCitations(turn.text)}
                </p>
                <div className="flex flex-col gap-2">
                  {turn.citations?.map((c) => {
                    const Icon = typeIcon[c.noteType];
                    return (
                      <div
                        key={c.marker}
                        className="group flex gap-3 rounded-xl bg-background/50 p-3 ring-1 ring-border transition hover:ring-primary/50"
                      >
                        <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] text-primary">
                          {c.marker}
                        </span>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5 text-xs font-medium">
                            <Icon className="size-3 text-primary" />
                            {c.noteTitle}
                            <span className="nn-mono text-muted-foreground">· {c.locator}</span>
                          </div>
                          <p className="text-xs leading-relaxed text-muted-foreground">“{c.snippet}”</p>
                        </div>
                        <ChevronRight className="ml-auto size-4 self-center text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                      </div>
                    );
                  })}
                </div>
              </div>
            ),
          )}
        </div>

        <div className="px-6 pb-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {recentCaptures.map((c) => (
              <span key={c.label} className="truncate rounded-full bg-background/50 px-2 py-1 ring-1 ring-border">
                {c.label}
              </span>
            ))}
          </div>
        </div>

        <div className="border-t border-border p-4">
          <div className="flex items-end gap-2 rounded-2xl bg-background/60 p-2 ring-1 ring-border">
            <textarea
              rows={1}
              placeholder="Ask across everything you've captured…"
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-2 text-sm placeholder:text-muted-foreground/70 focus:outline-none"
            />
            <Button size="icon" className="size-9 shrink-0 rounded-xl bg-primary text-primary-foreground">
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

// Render inline [n] markers as little sage citation chips.
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className="nn-mono mx-0.5 inline-grid size-4 -translate-y-0.5 cursor-pointer place-items-center rounded bg-primary/15 text-[10px] text-primary"
      >
        {m[1]}
      </sup>
    );
  });
}
