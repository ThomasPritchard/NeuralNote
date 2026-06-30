import type { ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Command,
  CornerDownLeft,
  FileText,
  Hash,
  Library,
  Newspaper,
  Plus,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import type { SourceType } from "../mock";
import { chatThread, openNote, recentCaptures, vault, vaultStats } from "../mock";

const typeIcon: Record<SourceType, typeof Video> = {
  youtube: Video,
  article: Newspaper,
  pdf: FileText,
  text: Type,
};

// ── Linear ── cool zinc command deck. Glassy top header + breadcrumb, a hero
// ⌘K command bar, the vault as a dense Linear-issues list, a precise reader,
// and a cited-chat right rail with a context chip row. A notch denser than Eden;
// hairline borders, tight tracking, single indigo accent, restraint over decoration.
export default function Linear() {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* ── Glassy top header ─────────────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/70 px-4 backdrop-blur-md">
        <nav className="flex min-w-0 items-center gap-1.5 text-[13px] tracking-tight">
          <span className="shrink-0 text-muted-foreground">Vault</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
          <span className="shrink-0 text-muted-foreground">Research</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
          <span className="truncate font-medium text-foreground">{openNote.title}</span>
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
            <span>Command</span>
            <span className="flex items-center gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            <span className="hidden md:inline">Synced</span>
          </div>
          <div className="nn-mono grid size-6 place-items-center rounded-full border border-border bg-secondary text-[10px] text-muted-foreground">
            TP
          </div>
        </div>
      </header>

      {/* ── Body · three precise columns ──────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ── Vault sidebar (Linear-issues list) ──────────────────────────── */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <button className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3 text-left transition-colors hover:bg-sidebar-accent/40">
            <span className="nn-mono grid size-6 shrink-0 place-items-center rounded-[6px] bg-primary text-[12px] font-semibold text-primary-foreground">
              N
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium tracking-tight text-foreground">
                NeuralNote
              </span>
              <span className="nn-mono text-[10px] text-muted-foreground">
                {vaultStats.sources} sources
              </span>
            </span>
            <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground/70" />
          </button>

          <div className="px-2.5 pt-2.5 pb-1.5">
            <button className="flex w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-[13px] tracking-tight text-foreground transition-colors hover:bg-secondary">
              <Plus className="size-3.5 text-muted-foreground" />
              <span>Capture anything</span>
              <Kbd className="ml-auto">C</Kbd>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {vault.map((folder) => (
              <section key={folder.name} className="mb-0.5">
                <div className="flex h-7 items-center gap-1 px-2 text-muted-foreground">
                  <ChevronDown className="size-3 opacity-50" />
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em]">
                    {folder.name}
                  </span>
                  <span className="nn-mono ml-auto text-[10px] text-muted-foreground/60">
                    {folder.notes.length}
                  </span>
                </div>
                {folder.notes.map((note) => {
                  const Icon = typeIcon[note.type];
                  const active = note.id === openNote.id;
                  return (
                    <button
                      key={note.id}
                      className={`group flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors ${
                        active
                          ? "bg-sidebar-accent text-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          active ? "bg-primary" : "border border-muted-foreground/40"
                        }`}
                      />
                      <Icon
                        className={`size-3.5 shrink-0 ${
                          active ? "text-primary" : "text-muted-foreground/70"
                        }`}
                      />
                      <span className="truncate text-[13px] tracking-tight">{note.title}</span>
                      <span className="nn-mono ml-auto shrink-0 text-[10px] text-muted-foreground/50">
                        {shortTime(note.captured)}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>

          <div className="border-t border-border px-2 py-2">
            <div className="flex h-6 items-center px-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80">
                Recently captured
              </span>
            </div>
            {recentCaptures.map((c) => {
              const Icon = typeIcon[c.type];
              const distilling = c.state === "distilling";
              return (
                <div
                  key={c.label}
                  className="flex h-7 items-center gap-2 px-2 text-muted-foreground"
                >
                  <Icon className="size-3 shrink-0 text-muted-foreground/60" />
                  <span className="nn-mono truncate text-[11px]">{c.label}</span>
                  <span
                    className={`ml-auto flex shrink-0 items-center gap-1 text-[10px] ${
                      distilling ? "text-primary" : "text-muted-foreground/50"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        distilling ? "animate-pulse bg-primary" : "bg-muted-foreground/40"
                      }`}
                    />
                    {c.state}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between border-t border-border px-3 text-muted-foreground">
            <span className="nn-mono text-[10px]">
              {vaultStats.notes} notes · {vaultStats.folders} folders
            </span>
            <span className="nn-mono text-[10px]">{vaultStats.embedded}</span>
          </div>
        </aside>

        {/* ── Reader ──────────────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Hero ⌘K command bar */}
          <div className="flex h-12 shrink-0 items-center border-b border-border">
            <div className="mx-auto w-full max-w-2xl px-8">
              <button className="group flex h-9 w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 text-left ring-1 ring-inset ring-primary/10 transition-colors hover:border-primary/40 hover:ring-primary/20">
                <Command className="size-4 shrink-0 text-primary" />
                <span className="text-[13px] text-muted-foreground">
                  Ask across your vault, or jump to anything…
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
            </div>
          </div>

          {/* Note */}
          <div className="flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-2xl px-8 py-8">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-1">
                  <Video className="size-3.5 text-primary" />
                  <span className="nn-mono text-[11px]">{openNote.sourceUrl}</span>
                  <ArrowUpRight className="size-3 text-muted-foreground/50" />
                </span>
                <span className="text-muted-foreground/30">·</span>
                <span className="nn-mono text-[11px]">{openNote.capturedAt}</span>
              </div>

              <h1 className="mt-4 text-[26px] font-semibold leading-[1.15] tracking-tight text-foreground">
                {openNote.title}
              </h1>

              <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
                {openNote.tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-secondary/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    <Hash className="size-2.5 text-muted-foreground/50" />
                    {t}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1 rounded-[5px] border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                  <Sparkles className="size-2.5" />
                  {openNote.distilModel}
                </span>
              </div>

              <p className="mt-6 text-[15px] leading-relaxed text-foreground/85">
                {openNote.summary}
              </p>

              <h2 className="mt-9 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Key claims
              </h2>
              <div className="mt-3 overflow-hidden rounded-lg border border-border">
                {openNote.keyClaims.map((claim, i) => (
                  <div
                    key={claim}
                    className={`flex gap-3 px-4 py-3 ${i > 0 ? "border-t border-border" : ""}`}
                  >
                    <span className="nn-mono shrink-0 pt-px text-[12px] text-primary">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[13.5px] leading-relaxed text-foreground/85">
                      {claim}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-9 flex items-end justify-between">
                <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Full source · retained transcript
                </h2>
                <span className="nn-mono text-[10px] text-muted-foreground/60">
                  {openNote.sourceChunks.length} chunks · embedded
                </span>
              </div>
              <div className="mt-3 overflow-hidden rounded-lg border border-border">
                {openNote.sourceChunks.map((chunk, i) => (
                  <div
                    key={chunk.id}
                    className={`flex gap-3.5 px-4 py-3 transition-colors hover:bg-card/60 ${
                      i > 0 ? "border-t border-border" : ""
                    }`}
                  >
                    <span className="nn-mono w-12 shrink-0 pt-px text-[11px] text-primary">
                      {chunk.locator}
                    </span>
                    <span className="text-[13px] leading-relaxed text-muted-foreground">
                      {chunk.text}
                    </span>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </main>

        {/* ── Cited chat rail ─────────────────────────────────────────────── */}
        <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-sidebar">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-primary" />
              <span className="text-[13px] font-medium tracking-tight text-foreground">
                Cited chat
              </span>
            </div>
            <Kbd>⌘J</Kbd>
          </div>

          {/* Context / scope chips */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2">
            <button className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 text-[11px] text-foreground transition-colors hover:bg-secondary">
              <Library className="size-3 text-primary" />
              Whole vault
              <ChevronDown className="size-3 text-muted-foreground/60" />
            </button>
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-secondary/25 px-2 text-[11px] text-muted-foreground">
              <span className="nn-mono">{vaultStats.sources}</span> sources
            </span>
            <span className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-secondary/25 px-2 text-[11px] text-muted-foreground">
              <span className="nn-mono">{vaultStats.folders}</span> folders
            </span>
          </div>

          {/* Thread */}
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
            {chatThread.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="flex flex-col items-end gap-1">
                  <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/60">
                    You
                  </span>
                  <div className="max-w-[88%] rounded-lg rounded-tr-[3px] border border-border bg-secondary/50 px-3 py-2 text-[13px] leading-relaxed text-foreground">
                    {turn.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-3">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="size-3 text-primary" />
                    <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/60">
                      NeuralNote
                    </span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-foreground/90">
                    {renderWithCitations(turn.text)}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {turn.citations?.map((c) => {
                      const Icon = typeIcon[c.noteType];
                      return (
                        <button
                          key={c.marker}
                          className="group flex items-start gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-primary/40"
                        >
                          <span className="nn-mono mt-px grid size-4 shrink-0 place-items-center rounded-[4px] bg-primary/15 text-[10px] text-primary">
                            {c.marker}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <Icon className="size-3 shrink-0 text-muted-foreground/70" />
                              <span className="truncate text-[12px] font-medium text-foreground">
                                {c.noteTitle}
                              </span>
                              <span className="nn-mono shrink-0 text-[10px] text-primary">
                                {c.locator}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                              {c.snippet}
                            </p>
                          </div>
                          <ArrowUpRight className="mt-px size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ),
            )}
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-border p-3">
            <div className="rounded-lg border border-border bg-card transition-colors focus-within:border-primary/40">
              <textarea
                rows={2}
                placeholder="Ask anything across your vault…"
                className="w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <div className="flex items-center justify-between border-t border-border px-2.5 py-1.5">
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <Library className="size-3" /> Whole vault
                </span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  Send
                  <span className="flex items-center gap-0.5">
                    <Kbd>⌘</Kbd>
                    <Kbd>
                      <CornerDownLeft className="size-2.5" />
                    </Kbd>
                  </span>
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// Small physical-key chip for keyboard hints / locators.
function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`nn-mono inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border bg-secondary px-1 text-[10px] leading-none text-muted-foreground ${className}`}
    >
      {children}
    </kbd>
  );
}

// Render inline [n] markers as crisp indigo citation chips.
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className="nn-mono mx-0.5 inline-flex h-[14px] min-w-[14px] -translate-y-px cursor-pointer items-center justify-center rounded-[3px] bg-primary/15 px-0.5 text-[9px] font-medium text-primary transition-colors hover:bg-primary/25"
      >
        {m[1]}
      </sup>
    );
  });
}

// "2h ago" → "2h", "yesterday" → "1d", etc. Keeps sidebar rows dense.
function shortTime(t: string): string {
  if (t === "yesterday") return "1d";
  return t.replace(" ago", "");
}
