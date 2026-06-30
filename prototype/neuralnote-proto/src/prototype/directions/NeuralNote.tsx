import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FilePlus2,
  Files,
  FileText,
  Folder,
  FolderOpen,
  Hash,
  Link2,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Network,
  Newspaper,
  Plus,
  Quote,
  ScanLine,
  Search,
  Send,
  Settings,
  Sparkles,
  Type,
  Video,
  X,
} from "lucide-react";
import { useState } from "react";
import type { SourceType, VaultNote, VaultTreeFolder } from "../mock";
import {
  allNotes,
  chatThread,
  openNote,
  recentCaptures,
  vaultStats,
  vaultTree,
} from "../mock";
import { setGalaxy } from "../galaxy/nav";

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

// Far-left ribbon actions (Obsidian's workspace switcher).
const ribbonItems = [
  { icon: Search, label: "Search", active: false },
  { icon: Files, label: "Files", active: true },
  { icon: FilePlus2, label: "Capture", active: false },
  { icon: Network, label: "Graph view", active: false },
];

// Tabs open in the editor — the active note plus a couple of pinned siblings.
const openTabIds = [openNote.id, "scaling", "bitter"];

// Relevance scores powering the retrieval visualisation (Deepflow's hero viz).
const relevanceByMarker: Record<number, number> = { 1: 0.96, 2: 0.91, 3: 0.84 };

// Premium easing — physical, weighted motion on the interactive surfaces.
const ease = "ease-[cubic-bezier(0.32,0.72,0,1)]";

// Derived status-bar figures (computed from the open note, Obsidian-style).
const wordCount = `${openNote.summary} ${openNote.keyClaims.join(" ")} ${openNote.sourceChunks
  .map((c) => c.text)
  .join(" ")}`
  .trim()
  .split(/\s+/).length;

const backlinks = allNotes.filter(
  (n) => n.id !== openNote.id && n.tags.some((t) => openNote.tags.includes(t)),
).length;

// ── NeuralNote (chosen) ── Deepflow's indigo skin on Obsidian's dense, low-chrome
// workspace. Icon ribbon · vault tree · tabbed reader (frontmatter properties +
// distilled summary + key claims + retained full source) · docked cited-chat with
// the retrieval visualisation (sources-retrieved banner + MATCH% relevance bars).
// No stats band — the reader and chat inherit that reclaimed room.
export default function NeuralNote() {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* ── Workspace (ribbon · tree · reader · chat) ───────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <Ribbon />
        <FileTree />
        <Reader />
        <ChatPane />
      </div>

      <StatusBar />
    </div>
  );
}

/* ──────────────────────────────  Icon ribbon  ──────────────────────────── */

function Ribbon() {
  return (
    <nav
      aria-label="Workspace"
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-3"
    >
      {/* gradient brand mark with the Deepflow violet glow */}
      <div className="mb-3 grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_22px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
        <Brain className="size-[18px]" aria-hidden />
      </div>
      {ribbonItems.map(({ icon: Icon, label, active }) => (
        <button
          key={label}
          aria-label={label}
          onClick={label === "Graph view" ? () => setGalaxy(true) : undefined}
          className={`relative grid size-9 place-items-center rounded-lg transition-colors duration-300 ${ease} ${
            active
              ? "bg-sidebar-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          }`}
        >
          {active && (
            <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" aria-hidden />
          )}
          <Icon className="size-[18px]" aria-hidden />
        </button>
      ))}
      <button
        aria-label="Settings"
        className={`mt-auto grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors duration-300 hover:bg-sidebar-accent/60 hover:text-foreground ${ease}`}
      >
        <Settings className="size-[18px]" aria-hidden />
      </button>
    </nav>
  );
}

/* ───────────────────────────────  File tree  ───────────────────────────── */

function allFolderPaths(folders: VaultTreeFolder[], prefix = ""): string[] {
  return folders.flatMap((f) => {
    const p = prefix ? `${prefix}/${f.name}` : f.name;
    return [p, ...allFolderPaths(f.folders ?? [], p)];
  });
}

function countNotes(f: VaultTreeFolder): number {
  return (f.notes?.length ?? 0) + (f.folders?.reduce((s, sf) => s + countNotes(sf), 0) ?? 0);
}

function TreeNote({ note }: { note: VaultNote }) {
  const Icon = typeIcon[note.type];
  const active = note.id === openNote.id;
  return (
    <button
      className={`flex w-full items-center gap-1.5 rounded-md py-[5px] pl-1.5 pr-2 text-left text-[13px] transition ${ease} ${
        active
          ? "bg-primary/12 text-foreground ring-1 ring-inset ring-primary/25"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
      }`}
    >
      <Icon className={`size-3.5 shrink-0 ${active ? "text-primary" : "opacity-70"}`} aria-hidden />
      <span className="truncate">{note.title}</span>
    </button>
  );
}

function TreeFolder({
  folder,
  path,
  open,
  toggle,
}: {
  folder: VaultTreeFolder;
  path: string;
  open: Set<string>;
  toggle: (p: string) => void;
}) {
  const isOpen = open.has(path);
  return (
    <div>
      <button
        onClick={() => toggle(path)}
        className={`flex w-full items-center gap-1 rounded-md px-1 py-1 text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/40 ${ease}`}
      >
        <ChevronRight
          className={`size-3 shrink-0 opacity-60 transition-transform duration-200 ${ease} ${isOpen ? "rotate-90" : ""}`}
          aria-hidden
        />
        {isOpen ? (
          <FolderOpen className="size-3.5 shrink-0 text-primary/80" aria-hidden />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="truncate">{folder.name}</span>
        <span className="nn-mono ml-auto pr-1 text-[10px] text-muted-foreground/60">{countNotes(folder)}</span>
      </button>
      {isOpen && (
        <div className="ml-[7px] border-l border-border/60 pl-2">
          {folder.folders?.map((sf) => (
            <TreeFolder key={sf.name} folder={sf} path={`${path}/${sf.name}`} open={open} toggle={toggle} />
          ))}
          {folder.notes?.map((n) => (
            <TreeNote key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileTree() {
  const [open, setOpen] = useState<Set<string>>(() => new Set(allFolderPaths(vaultTree)));
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <header className="flex items-center justify-between px-3 pb-1.5 pt-3">
        <button className={`flex items-center gap-1 text-[13px] font-semibold text-sidebar-foreground transition-colors hover:text-foreground ${ease}`}>
          NeuralNote vault
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </button>
        <FilePlus2 className="size-4 text-muted-foreground transition-colors hover:text-foreground" aria-hidden />
      </header>

      {/* search / ask */}
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[13px] text-muted-foreground transition focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            aria-label="Search vault"
            placeholder="Search or ask…"
            className="w-full bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <kbd className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
        </label>
      </div>

      {/* folder → note tree (VSCode-style, nested with indent guides) */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {vaultTree.map((folder) => (
          <TreeFolder key={folder.name} folder={folder} path={folder.name} open={open} toggle={toggle} />
        ))}
      </div>

      {/* capture pipeline — "throw anything in" + live ingest states */}
      <div className="shrink-0 border-t border-border px-2.5 py-2.5">
        <button
          className={`mb-2.5 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 px-2.5 py-2 text-[13px] font-medium text-primary-foreground shadow-[0_8px_24px_-12px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.18)] transition hover:opacity-95 active:scale-[0.99] ${ease}`}
        >
          <Plus className="size-4" aria-hidden />
          Capture anything
        </button>
        <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
          <ScanLine className="size-3" aria-hidden /> Recent captures
        </div>
        <ul className="flex flex-col gap-1">
          {recentCaptures.map((c) => {
            const Icon = typeIcon[c.type];
            const distilling = c.state === "distilling";
            return (
              <li
                key={c.label}
                className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-1.5"
              >
                <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="nn-mono truncate text-[11px] text-muted-foreground">{c.label}</span>
                <span
                  className={`ml-auto flex shrink-0 items-center gap-1 text-[10px] ${
                    distilling ? "text-primary" : "text-muted-foreground/80"
                  }`}
                >
                  {distilling ? (
                    <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3" aria-hidden />
                  )}
                  {distilling ? "distilling" : "distilled"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

/* ─────────────────────────────  Reader / editor  ───────────────────────── */

function Reader() {
  const SourceIcon = typeIcon[openNote.type];
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {/* tab bar */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-sidebar">
        {openTabIds.map((id) => {
          const note = allNotes.find((n) => n.id === id);
          if (!note) return null;
          const Icon = typeIcon[note.type];
          const active = id === openNote.id;
          return (
            <div
              key={id}
              className={`group flex max-w-52 items-center gap-1.5 border-r border-t-2 border-border px-3 text-[13px] transition-colors ${ease} ${
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

      {/* note toolbar — breadcrumb + view controls */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-5 text-[12px] text-muted-foreground">
        <div className="nn-mono flex items-center gap-1.5 truncate">
          <span>Research</span>
          <span className="opacity-40">/</span>
          <span className="truncate text-foreground/80">{openNote.title}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="nn-mono hidden items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground lg:inline-flex">
            <Cpu className="size-3 text-primary" aria-hidden /> {openNote.distilModel}
          </span>
          <span className="nn-mono">{openNote.sourceChunks.length} blocks</span>
          <MoreHorizontal className="size-4 transition-colors hover:text-foreground" aria-hidden />
        </div>
      </div>

      {/* document — given full vertical room (no stats band above it) */}
      <article className="relative flex-1 overflow-y-auto px-6 py-9">
        {/* faint violet wash bleeding from the top, Deepflow signature */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-primary/[0.05] to-transparent"
          aria-hidden
        />
        <div className="relative mx-auto w-full max-w-[42rem]">
          {/* eyebrow + title */}
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-inset ring-primary/20">
              <SourceIcon className="size-3" aria-hidden /> {typeLabel[openNote.type]}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] text-primary ring-1 ring-inset ring-primary/20">
              <Sparkles className="size-3" aria-hidden /> Distilled
            </span>
          </div>

          <h1 className="nn-heading mt-4 text-[28px] font-semibold leading-tight tracking-tight">
            {openNote.title}
          </h1>

          {/* frontmatter properties — Obsidian's metadata table */}
          <dl className="mt-5 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-card/50">
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
              <div className="flex flex-wrap gap-1.5">
                {openNote.tags.map((t) => (
                  <span
                    key={t}
                    className={`nn-mono rounded-sm bg-primary/12 px-1.5 py-0.5 text-[12px] text-primary ring-1 ring-inset ring-primary/15 transition hover:bg-primary/20 ${ease}`}
                  >
                    #{t}
                  </span>
                ))}
              </div>
            </Property>
          </dl>

          {/* distilled summary */}
          <p className="mt-7 text-[15px] leading-7 text-foreground/90">{openNote.summary}</p>

          {/* key claims — accent callout */}
          <section className="mt-7 overflow-hidden rounded-lg border border-primary/30 border-l-2 border-l-primary bg-accent/40">
            <header className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-semibold text-accent-foreground">
              <ListChecks className="size-4 text-primary" aria-hidden />
              Key claims
              <span className="nn-mono ml-1 text-[11px] font-normal text-muted-foreground">
                {openNote.keyClaims.length}
              </span>
            </header>
            <ol className="flex flex-col gap-3 px-4 pb-4 pt-1">
              {openNote.keyClaims.map((claim, i) => (
                <li key={claim} className="flex gap-3">
                  <span className="nn-mono mt-px grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-medium text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[14px] leading-6 text-foreground/85">{claim}</span>
                </li>
              ))}
            </ol>
          </section>

          {/* retained full source — the moat, given room */}
          <section className="mt-7 overflow-hidden rounded-lg border border-border bg-card/50">
            <header className="flex items-center justify-between border-b border-border px-4 py-2.5 text-[13px] font-semibold text-foreground/90">
              <span className="flex items-center gap-2">
                <Quote className="size-4 text-primary" aria-hidden />
                Retained source · transcript
              </span>
              <span className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                {openNote.sourceChunks.length} chunks · indexed
              </span>
            </header>
            <ul className="flex flex-col divide-y divide-border/60">
              {openNote.sourceChunks.map((chunk) => (
                <li
                  key={chunk.id}
                  className={`flex gap-3.5 px-4 py-3.5 transition-colors hover:bg-background/40 ${ease}`}
                >
                  <span className="nn-mono mt-px flex h-5 shrink-0 items-center rounded bg-primary/12 px-2 text-[11px] text-primary ring-1 ring-inset ring-primary/15">
                    {chunk.locator}
                  </span>
                  <span className="text-[13px] leading-6 text-muted-foreground">{chunk.text}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </article>
    </main>
  );
}

/* ─────────────────  Cited-chat pane (docked, the hero)  ─────────────────── */

function ChatPane() {
  const assistant = chatThread.find((t) => t.role === "assistant");
  const citationCount = assistant?.citations?.length ?? 0;

  return (
    <aside className="relative flex w-[420px] shrink-0 flex-col border-l border-border bg-gradient-to-b from-primary/[0.07] via-sidebar to-sidebar">
      {/* header */}
      <header className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_18px_-5px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.2)]">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <span className="nn-heading text-sm font-semibold">Cited recall</span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-inset ring-border">
            <Database className="size-3 text-primary" aria-hidden /> {vaultStats.sources} sources
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Grounded in retrieved chunks · every claim citation-checked.
        </p>
      </header>

      {/* conversation */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {chatThread.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[86%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[13px] leading-relaxed text-primary-foreground shadow-[0_8px_24px_-14px_var(--color-primary)]">
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-3">
              {/* retrieval status banner — the moat made visible */}
              <div className="flex items-center gap-2 rounded-lg bg-background/40 px-3 py-2 ring-1 ring-inset ring-border">
                <ScanLine className="size-3.5 text-primary" aria-hidden />
                <span className="text-[11px] font-medium text-foreground">
                  {citationCount} sources retrieved
                </span>
                <span className="nn-mono ml-auto text-[10px] text-muted-foreground">
                  scanned {vaultStats.sources}
                </span>
              </div>

              {/* answer */}
              <p className="text-[13px] leading-[1.5] text-foreground/90">
                {renderWithCitations(turn.text)}
              </p>

              {/* citation cards with relevance bars */}
              <div className="flex flex-col gap-2">
                <div className="nn-mono flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  <Quote className="size-3 text-primary" aria-hidden /> Sources · ranked by relevance
                </div>
                {turn.citations?.map((c) => {
                  const Icon = typeIcon[c.noteType];
                  const score = relevanceByMarker[c.marker] ?? 0.8;
                  return (
                    <button
                      key={c.marker}
                      className={`group flex flex-col gap-1.5 rounded-xl bg-card/70 p-2.5 text-left ring-1 ring-inset ring-border transition hover:bg-card hover:ring-primary/45 ${ease}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-medium text-primary">
                          {c.marker}
                        </span>
                        <Icon className="size-3 shrink-0 text-primary" aria-hidden />
                        <span className="truncate text-[12px] font-medium text-foreground">
                          {c.noteTitle}
                        </span>
                        <span className="nn-mono ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {c.locator}
                        </span>
                        <ChevronRight
                          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
                          aria-label="jump to source"
                        />
                      </div>
                      <p className="text-[11px] leading-snug text-muted-foreground">“{c.snippet}”</p>
                      <RelevanceBar score={score} />
                    </button>
                  );
                })}
              </div>
            </div>
          ),
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded-full bg-background/50 px-2 py-0.5 ring-1 ring-inset ring-border">
            Scope: all folders
          </span>
          <span className="nn-mono rounded-full bg-background/50 px-2 py-0.5 ring-1 ring-inset ring-border">
            {vaultStats.notes} notes
          </span>
        </div>
        <div className="flex items-end gap-2 rounded-xl bg-background/60 p-2 ring-1 ring-inset ring-border transition focus-within:ring-primary/50">
          <textarea
            rows={1}
            aria-label="Ask across your vault"
            placeholder="Ask across everything you've captured…"
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <button
            aria-label="Send"
            className={`grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-[inset_0_1px_0_0_rgb(255_255_255/0.18)] transition hover:opacity-95 active:scale-95 ${ease}`}
          >
            <Send className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ───────────────────────────────  Status bar  ──────────────────────────── */

function StatusBar() {
  return (
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
          <LiveDot /> Index synced
        </span>
      </div>
    </footer>
  );
}

function LiveDot() {
  return (
    <span className="relative flex size-1.5" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
    </span>
  );
}

/* ────────────────────────────────  helpers  ────────────────────────────── */

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
    <div className="flex items-start gap-3 px-4 py-2.5">
      <dt className="nn-mono flex w-24 shrink-0 items-center gap-1.5 pt-px text-[12px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px]">{children}</dd>
    </div>
  );
}

// Retrieval relevance bar — Deepflow's MATCH% viz.
function RelevanceBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        match
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-primary/12">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary"
          style={{ width: `${Math.round(score * 100)}%` }}
        />
      </div>
      <span className="nn-mono text-[10px] text-primary">{Math.round(score * 100)}%</span>
    </div>
  );
}

// Inline [n] markers → small violet mono chips that map to the citation cards.
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className={`nn-mono mx-0.5 inline-grid size-4 -translate-y-px cursor-pointer place-items-center rounded bg-primary/20 text-[10px] font-medium text-primary ring-1 ring-inset ring-primary/30 transition hover:bg-primary/30 ${ease}`}
      >
        {m[1]}
      </sup>
    );
  });
}
