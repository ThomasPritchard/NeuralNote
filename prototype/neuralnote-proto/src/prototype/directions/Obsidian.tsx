import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock,
  FilePlus2,
  Files,
  FileText,
  FolderOpen,
  Hash,
  Link2,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Network,
  Newspaper,
  Quote,
  Search,
  Send,
  Settings,
  Sparkles,
  Type,
  Video,
  X,
} from "lucide-react";
import type { SourceType } from "../mock";
import {
  allNotes,
  chatThread,
  openNote,
  recentCaptures,
  vault,
  vaultStats,
} from "../mock";

const typeIcon: Record<SourceType, typeof Video> = {
  youtube: Video,
  article: Newspaper,
  pdf: FileText,
  text: Type,
};

const typeLabel: Record<SourceType, string> = {
  youtube: "YouTube",
  article: "Article",
  pdf: "PDF",
  text: "Note",
};

// Tabs open in the editor — the active note plus a couple of pinned siblings.
const openTabIds = [openNote.id, "scaling", "bitter"];

// Derived status-bar figures (computed from the open note, Obsidian-style).
const wordCount = `${openNote.summary} ${openNote.keyClaims.join(" ")} ${openNote.sourceChunks
  .map((c) => c.text)
  .join(" ")}`
  .trim()
  .split(/\s+/).length;

const backlinks = allNotes.filter(
  (n) => n.id !== openNote.id && n.tags.some((t) => openNote.tags.includes(t)),
).length;

// ── Obsidian-native ── dense, low-chrome, file-tree workspace. Icon ribbon +
// vault tree + tabbed reader (frontmatter properties, callouts, retained
// source) + docked "Cited Chat" plugin pane + status bar. The refugee bet.
export default function Obsidian() {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* ── Workspace (ribbon · tree · editor · plugin pane) ───────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* ── Icon ribbon ─────────────────────────────────────────────────── */}
        <nav
          aria-label="Workspace"
          className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-2.5"
        >
          <div className="mb-2 grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <span className="nn-mono text-[13px] font-bold">N</span>
          </div>
          {[
            { icon: Search, label: "Search", active: false },
            { icon: Files, label: "Files", active: true },
            { icon: FilePlus2, label: "Capture", active: false },
            { icon: Network, label: "Graph view", active: false },
          ].map(({ icon: Icon, label, active }) => (
            <button
              key={label}
              aria-label={label}
              className={`grid size-9 place-items-center rounded-md transition ${
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
              }`}
            >
              <Icon className="size-[18px]" aria-hidden />
            </button>
          ))}
          <button
            aria-label="Settings"
            className="mt-auto grid size-9 place-items-center rounded-md text-muted-foreground transition hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <Settings className="size-[18px]" aria-hidden />
          </button>
        </nav>

        {/* ── File tree ───────────────────────────────────────────────────── */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
          <header className="flex items-center justify-between px-3 pb-1.5 pt-3">
            <button className="flex items-center gap-1 text-[13px] font-semibold text-sidebar-foreground transition hover:text-foreground">
              NeuralNote vault
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </button>
            <FilePlus2
              className="size-4 text-muted-foreground transition hover:text-foreground"
              aria-hidden
            />
          </header>

          <div className="px-3 pb-2">
            <label className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[13px] text-muted-foreground focus-within:border-primary/60">
              <Search className="size-3.5 shrink-0" aria-hidden />
              <input
                aria-label="Search vault"
                placeholder="Search or ask…"
                className="w-full bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </label>
          </div>

          {/* Folder → note tree */}
          <div className="flex-1 overflow-y-auto px-1.5 pb-2">
            {vault.map((folder) => (
              <div key={folder.name} className="mb-0.5">
                <div className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-sidebar-foreground">
                  <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{folder.name}</span>
                </div>
                <ul className="ml-2 border-l border-border/70 pl-1.5">
                  {folder.notes.map((note) => {
                    const Icon = typeIcon[note.type];
                    const active = note.id === openNote.id;
                    return (
                      <li key={note.id}>
                        <button
                          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-[13px] transition ${
                            active
                              ? "bg-sidebar-accent text-foreground"
                              : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                          }`}
                        >
                          <Icon
                            className={`size-3.5 shrink-0 ${active ? "text-primary" : "opacity-70"}`}
                            aria-hidden
                          />
                          <span className="truncate">{note.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          {/* Capture pipeline — "throw anything in" + recent captures */}
          <div className="shrink-0 border-t border-border px-2.5 py-2.5">
            <button className="mb-2 flex w-full items-center gap-2 rounded-md bg-primary px-2.5 py-1.5 text-[13px] font-medium text-primary-foreground transition hover:opacity-90">
              <FilePlus2 className="size-3.5" aria-hidden />
              Capture anything
            </button>
            <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              Recent captures
            </div>
            <ul className="flex flex-col gap-0.5">
              {recentCaptures.map((c) => {
                const Icon = typeIcon[c.type];
                const distilling = c.state === "distilling";
                return (
                  <li
                    key={c.label}
                    className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground"
                  >
                    <Icon className="size-3 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{c.label}</span>
                    {distilling ? (
                      <LoaderCircle
                        className="ml-auto size-3 shrink-0 animate-spin text-primary"
                        aria-label="distilling"
                      />
                    ) : (
                      <Check
                        className="ml-auto size-3 shrink-0 text-primary/80"
                        aria-label="distilled"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/* ── Editor / reader ─────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {/* Tab bar */}
          <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-sidebar">
            {openTabIds.map((id) => {
              const note = allNotes.find((n) => n.id === id);
              if (!note) return null;
              const Icon = typeIcon[note.type];
              const active = id === openNote.id;
              return (
                <div
                  key={id}
                  className={`group flex max-w-52 items-center gap-1.5 border-r border-t-2 border-border px-3 text-[13px] ${
                    active
                      ? "border-t-primary bg-background text-foreground"
                      : "border-t-transparent text-muted-foreground hover:bg-background/40"
                  }`}
                >
                  <Icon
                    className={`size-3.5 shrink-0 ${active ? "text-primary" : "opacity-70"}`}
                    aria-hidden
                  />
                  <span className="truncate">{note.title}</span>
                  <X
                    className="size-3.5 shrink-0 opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                    aria-hidden
                  />
                </div>
              );
            })}
          </div>

          {/* Note toolbar — breadcrumb + view controls */}
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-5 text-[12px] text-muted-foreground">
            <div className="nn-mono flex items-center gap-1.5 truncate">
              <span>Research</span>
              <span className="opacity-40">/</span>
              <span className="truncate text-foreground/80">{openNote.title}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="nn-mono">{openNote.sourceChunks.length} blocks</span>
              <MoreHorizontal className="size-4 transition hover:text-foreground" aria-hidden />
            </div>
          </div>

          {/* Document */}
          <article className="flex-1 overflow-y-auto px-5 py-7">
            <div className="mx-auto w-full max-w-2xl">
              <h1 className="nn-heading text-[26px] font-bold leading-tight tracking-tight">
                {openNote.title}
              </h1>

              {/* Frontmatter properties — Obsidian's metadata table */}
              <dl className="mt-4 flex flex-col divide-y divide-border/70 rounded-md border border-border bg-card/40">
                <Property icon={Video} label="type">
                  <span className="text-foreground/90">{typeLabel[openNote.type]}</span>
                </Property>
                <Property icon={Link2} label="source">
                  <span className="nn-mono truncate text-foreground/80">{openNote.sourceUrl}</span>
                </Property>
                <Property icon={Clock} label="captured">
                  <span className="nn-mono text-foreground/80">{openNote.capturedAt}</span>
                </Property>
                <Property icon={Sparkles} label="distilled">
                  <span className="nn-mono text-primary">{openNote.distilModel}</span>
                </Property>
                <Property icon={Hash} label="tags">
                  <div className="flex flex-wrap gap-1">
                    {openNote.tags.map((t) => (
                      <span
                        key={t}
                        className="nn-mono rounded-sm bg-primary/12 px-1.5 py-0.5 text-[12px] text-primary transition hover:bg-primary/20"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                </Property>
              </dl>

              {/* Distilled summary */}
              <p className="mt-6 text-[15px] leading-7 text-foreground/90">{openNote.summary}</p>

              {/* Key claims — accent callout */}
              <section className="mt-6 overflow-hidden rounded-md border border-primary/30 border-l-2 border-l-primary bg-accent/40">
                <header className="flex items-center gap-2 px-3.5 py-2 text-[13px] font-semibold text-accent-foreground">
                  <ListChecks className="size-4 text-primary" aria-hidden />
                  Key claims
                </header>
                <ol className="flex flex-col gap-2.5 px-3.5 pb-3.5 pt-1">
                  {openNote.keyClaims.map((claim, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span className="nn-mono mt-px shrink-0 text-[12px] font-medium text-primary">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="text-[14px] leading-6 text-foreground/85">{claim}</span>
                    </li>
                  ))}
                </ol>
              </section>

              {/* Retained full source — the moat */}
              <section className="mt-6 overflow-hidden rounded-md border border-border bg-card/40">
                <header className="flex items-center justify-between border-b border-border px-3.5 py-2 text-[13px] font-semibold text-foreground/90">
                  <span className="flex items-center gap-2">
                    <Quote className="size-4 text-muted-foreground" aria-hidden />
                    Retained source · transcript
                  </span>
                  <span className="nn-mono text-[11px] font-normal text-muted-foreground">
                    full text kept
                  </span>
                </header>
                <ul className="flex flex-col divide-y divide-border/60">
                  {openNote.sourceChunks.map((chunk) => (
                    <li key={chunk.id} className="flex gap-3 px-3.5 py-3">
                      <span className="nn-mono mt-px shrink-0 rounded-sm bg-primary/12 px-1.5 py-0.5 text-[11px] text-primary">
                        {chunk.locator}
                      </span>
                      <span className="text-[13px] leading-6 text-muted-foreground">
                        {chunk.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </article>
        </main>

        {/* ── Cited chat — docked plugin pane ─────────────────────────────── */}
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-sidebar">
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3.5 text-[13px] font-semibold text-sidebar-foreground">
            <MessageSquareText className="size-4 text-primary" aria-hidden />
            <span>Cited Chat</span>
            <span className="nn-mono ml-1 text-[11px] font-normal text-muted-foreground">
              {vaultStats.notes} notes in scope
            </span>
            <MoreHorizontal
              className="ml-auto size-4 text-muted-foreground transition hover:text-foreground"
              aria-hidden
            />
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-4">
            {chatThread.map((turn, i) =>
              turn.role === "user" ? (
                <div
                  key={i}
                  className="max-w-[88%] self-end rounded-md rounded-br-sm bg-accent px-3 py-2 text-[13px] leading-5 text-accent-foreground"
                >
                  {turn.text}
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Sparkles className="size-3 text-primary" aria-hidden />
                    Answer
                    <span className="nn-mono opacity-70">· {openNote.distilModel}</span>
                  </div>
                  <p className="text-[13px] leading-6 text-foreground/90">
                    {renderWithCitations(turn.text)}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <div className="nn-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {turn.citations?.length ?? 0} sources cited
                    </div>
                    {turn.citations?.map((c) => {
                      const Icon = typeIcon[c.noteType];
                      return (
                        <button
                          key={c.marker}
                          className="group flex gap-2.5 rounded-md border border-border bg-background/50 p-2.5 text-left transition hover:border-primary/50 hover:bg-background"
                        >
                          <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-sm bg-primary/15 text-[11px] font-medium text-primary">
                            {c.marker}
                          </span>
                          <div className="flex min-w-0 flex-col gap-1">
                            <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground/90">
                              <Icon className="size-3 shrink-0 text-primary" aria-hidden />
                              <span className="truncate">{c.noteTitle}</span>
                              <span className="nn-mono shrink-0 text-muted-foreground">
                                {c.locator}
                              </span>
                            </div>
                            <p className="text-[11px] italic leading-5 text-muted-foreground">
                              “{c.snippet}”
                            </p>
                          </div>
                          <ArrowUpRight
                            className="ml-auto size-3.5 shrink-0 self-center text-muted-foreground opacity-0 transition group-hover:opacity-100"
                            aria-hidden
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ),
            )}
          </div>

          <div className="shrink-0 border-t border-border p-2.5">
            <div className="flex items-end gap-2 rounded-md border border-border bg-background/60 p-1.5 focus-within:border-primary/60">
              <textarea
                rows={1}
                aria-label="Ask across your vault"
                placeholder="Ask across your vault — answers cite sources…"
                className="max-h-28 flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] leading-5 placeholder:text-muted-foreground/70 focus:outline-none"
              />
              <button
                aria-label="Send"
                className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition hover:opacity-90"
              >
                <Send className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────── */}
      <footer className="nn-mono flex h-6 shrink-0 items-center justify-between border-t border-border bg-sidebar px-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>{wordCount} words</span>
          <span className="opacity-40">·</span>
          <span>{backlinks} backlinks</span>
          <span className="opacity-40">·</span>
          <span>{openNote.sourceChunks.length} blocks</span>
        </div>
        <div className="flex items-center gap-3">
          <span>{vaultStats.notes} notes</span>
          <span className="opacity-40">·</span>
          <span>{vaultStats.sources} sources</span>
          <span className="opacity-40">·</span>
          <span>{vaultStats.embedded} embedded</span>
          <span className="opacity-40">·</span>
          <span className="flex items-center gap-1.5 text-foreground/70">
            <span className="size-2 rounded-full bg-primary" aria-hidden />
            Synced
          </span>
        </div>
      </footer>
    </div>
  );
}

// One frontmatter property row (key column + value column).
function Property({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Video;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2">
      <dt className="nn-mono flex w-24 shrink-0 items-center gap-1.5 pt-px text-[12px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px]">{children}</dd>
    </div>
  );
}

// Render inline [n] markers as jump-to-able purple citation chips.
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className="nn-mono mx-0.5 inline-grid size-[15px] -translate-y-0.5 cursor-pointer place-items-center rounded-sm bg-primary/20 text-[10px] font-medium text-primary transition hover:bg-primary/35"
      >
        {m[1]}
      </sup>
    );
  });
}
