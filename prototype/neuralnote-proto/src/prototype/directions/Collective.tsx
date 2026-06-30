import {
  ArrowUpRight,
  Brain,
  Clock,
  FileText,
  Newspaper,
  Plus,
  Search,
  Send,
  Sparkles,
  Type,
  Video,
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
import { Button } from "@/components/ui/button";

const typeIcon: Record<SourceType, typeof Video> = {
  youtube: Video,
  article: Newspaper,
  pdf: FileText,
  text: Type,
};

const typeLabel: Record<SourceType, string> = {
  youtube: "Video",
  article: "Article",
  pdf: "PDF",
  text: "Text",
};

const NAV = ["Vault", "Reader", "Graph", "Chat"];

// Folder this note belongs to — used as the magazine "department" kicker.
const department =
  vault.find((f) => f.notes.some((n) => n.id === openNote.id))?.name ?? "Vault";

const pad = (n: number) => String(n).padStart(2, "0");

// ── Collective OS ── warm cream paper, heavy Archivo editorial display, black
// pill nav. A "second brain as a publication": numbered table of contents,
// feature-article reader, and a full-width "cited recall" command dock.
export default function Collective() {
  const userTurn = chatThread.find((t) => t.role === "user");
  const answer = chatThread.find((t) => t.role === "assistant");

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* ── Floating black pill nav ─────────────────────────────────────── */}
      <header className="shrink-0 px-4 pt-4 pb-1.5">
        <nav className="flex h-16 items-center gap-3 rounded-full bg-primary pr-3 pl-5 text-primary-foreground">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-full bg-primary-foreground text-primary">
              <Brain className="size-[18px]" />
            </span>
            <span className="nn-heading text-lg leading-none font-extrabold tracking-tight">
              NeuralNote
              <sup className="ml-0.5 align-super text-[9px] font-normal opacity-50">®</sup>
            </span>
          </div>

          <div className="ml-7 hidden items-center gap-1 lg:flex">
            {NAV.map((item) => {
              const active = item === "Reader";
              return (
                <span
                  key={item}
                  className={
                    active
                      ? "rounded-full bg-primary-foreground px-4 py-1.5 text-sm font-medium text-primary"
                      : "rounded-full px-4 py-1.5 text-sm font-medium text-primary-foreground/55 transition hover:text-primary-foreground"
                  }
                >
                  {item}
                </span>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <label className="flex w-64 items-center gap-2 rounded-full bg-primary-foreground/10 px-4 py-2 text-sm text-primary-foreground/60">
              <Search className="size-4 shrink-0" />
              <input
                placeholder="Ask or search the vault…"
                className="w-full bg-transparent placeholder:text-primary-foreground/45 focus:outline-none"
              />
            </label>
            <Button className="h-10 gap-1.5 rounded-full bg-primary-foreground px-4 text-primary hover:bg-primary-foreground/90">
              <Plus className="size-4" /> Capture
            </Button>
          </div>
        </nav>
      </header>

      {/* ── Editorial body: contents + reader ───────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* Table of contents */}
        <aside className="flex w-[330px] shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {/* Capture affordance */}
            <p className="nn-mono mb-2 text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
              Throw anything in
            </p>
            <button className="flex w-full flex-col items-start gap-0.5 rounded-2xl border border-dashed border-foreground/25 bg-card px-4 py-3 text-left transition hover:border-foreground/50">
              <span className="text-sm font-semibold text-foreground">
                Paste, drop or brain-dump
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                a link · a PDF · a thought — the AI files it for you
              </span>
            </button>

            <div className="mt-2.5 flex flex-col gap-0.5">
              {recentCaptures.map((c) => {
                const Icon = typeIcon[c.type];
                const distilling = c.state === "distilling";
                return (
                  <div
                    key={c.label}
                    className="flex items-center gap-2.5 rounded-xl px-2 py-1.5"
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-xs text-foreground/80">
                      {c.label}
                    </span>
                    <span
                      className={
                        distilling
                          ? "nn-mono rounded-full bg-primary px-2 py-0.5 text-[9px] tracking-wider text-primary-foreground uppercase"
                          : "nn-mono text-[9px] tracking-wider text-muted-foreground uppercase"
                      }
                    >
                      {c.state}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Contents — numbered like a magazine index */}
            <div className="mt-7 flex items-baseline justify-between">
              <p className="nn-heading text-sm font-extrabold tracking-[0.14em] uppercase">
                Contents
              </p>
              <span className="nn-mono text-[10px] tracking-wider text-muted-foreground">
                {vaultStats.notes} notes
              </span>
            </div>

            <div className="mt-4 flex flex-col gap-5">
              {vault.map((folder) => (
                <section key={folder.name}>
                  <div className="mb-1.5 flex items-center gap-2.5">
                    <span className="nn-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                      {folder.name}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                    <span className="nn-mono text-[10px] text-muted-foreground">
                      {pad(folder.notes.length)}
                    </span>
                  </div>
                  <ol>
                    {folder.notes.map((note) => {
                      const Icon = typeIcon[note.type];
                      const active = note.id === openNote.id;
                      const idx = allNotes.findIndex((n) => n.id === note.id) + 1;
                      return (
                        <li key={note.id}>
                          <button
                            className={`grid w-full grid-cols-[auto_1fr] items-start gap-3 rounded-xl px-2.5 py-2 text-left transition ${
                              active
                                ? "bg-card ring-1 ring-border"
                                : "hover:bg-sidebar-accent/60"
                            }`}
                          >
                            <span
                              className={
                                active
                                  ? "nn-mono grid size-5 translate-y-0.5 place-items-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground"
                                  : "nn-mono translate-y-0.5 text-[11px] text-muted-foreground"
                              }
                            >
                              {pad(idx)}
                            </span>
                            <span className="flex flex-col gap-1">
                              <span
                                className={`text-[13px] leading-snug ${
                                  active
                                    ? "font-semibold text-foreground"
                                    : "text-foreground/80"
                                }`}
                              >
                                {note.title}
                              </span>
                              <span className="nn-mono flex items-center gap-1.5 text-[10px] tracking-wider text-muted-foreground uppercase">
                                <Icon className="size-3" /> {typeLabel[note.type]}
                                <span className="opacity-40">·</span> {note.captured}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </div>

          <dl className="grid shrink-0 grid-cols-3 border-t border-border">
            {[
              ["Sources", String(vaultStats.sources)],
              ["Folders", String(vaultStats.folders)],
              ["Embedded", vaultStats.embedded],
            ].map(([label, value], i) => (
              <div
                key={label}
                className={`px-4 py-3.5 ${i > 0 ? "border-l border-border" : ""}`}
              >
                <dt className="nn-mono text-[9px] tracking-[0.16em] text-muted-foreground uppercase">
                  {label}
                </dt>
                <dd className="nn-heading mt-0.5 text-[15px] leading-none font-bold">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </aside>

        {/* Reader — the feature article */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-[760px] px-12 py-10">
            <div className="nn-mono flex items-center gap-2 text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
              <span className="text-foreground">{department}</span>
              <span className="opacity-40">/</span>
              <span>Distilled note</span>
            </div>

            <h1 className="nn-heading mt-5 text-[clamp(2.5rem,5vw,4rem)] leading-[0.92] font-black tracking-[-0.02em]">
              {openNote.title}
            </h1>

            <div className="nn-mono mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3 text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              <span className="flex items-center gap-1.5 text-foreground">
                <Video className="size-3.5" /> {typeLabel[openNote.type]}
              </span>
              <span className="normal-case">{openNote.sourceUrl}</span>
              <span className="flex items-center gap-1.5">
                <Clock className="size-3" /> {openNote.capturedAt}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Sparkles className="size-3" /> {openNote.distilModel}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {openNote.tags.map((t) => (
                <span
                  key={t}
                  className="nn-mono rounded-full border border-border px-3 py-1 text-[11px] tracking-wide text-muted-foreground"
                >
                  #{t}
                </span>
              ))}
            </div>

            <p className="mt-8 text-[19px] leading-[1.72] text-foreground/90">
              <span className="nn-heading float-left mt-1.5 mr-3 text-[4.4rem] leading-[0.66] font-black text-foreground">
                {openNote.summary.charAt(0)}
              </span>
              {openNote.summary.slice(1)}
            </p>

            {/* Key claims */}
            <section className="mt-12">
              <Kicker index="01" label="Key claims" />
              <ol className="mt-2">
                {openNote.keyClaims.map((claim, i) => (
                  <li
                    key={claim}
                    className="grid grid-cols-[auto_1fr] items-start gap-6 border-t border-border py-6 last:border-b"
                  >
                    <span className="nn-heading text-4xl leading-none font-black text-foreground/15 tabular-nums">
                      {pad(i + 1)}
                    </span>
                    <p className="text-[17px] leading-relaxed text-foreground/90">
                      {claim}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            {/* Full source — the moat, retained verbatim */}
            <section className="mt-12 pb-4">
              <Kicker index="02" label="Full source — retained transcript" />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                The complete source is kept and chunked with locators, so every
                answer can cite back to the exact moment.
              </p>
              <div className="mt-4 flex flex-col">
                {openNote.sourceChunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    className="grid grid-cols-[78px_1fr] items-start gap-6 border-t border-border py-5"
                  >
                    <span className="nn-mono pt-0.5 text-sm font-medium text-foreground">
                      {chunk.locator}
                    </span>
                    <p className="text-[15px] leading-relaxed text-muted-foreground">
                      {chunk.text}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </article>
        </main>
      </div>

      {/* ── Cited-recall command dock ───────────────────────────────────── */}
      <section className="shrink-0 border-t border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-8 py-3">
          <Sparkles className="size-4" />
          <span className="nn-heading text-sm font-extrabold tracking-[0.14em] uppercase">
            Cited recall
          </span>
          <span className="nn-mono hidden text-[10px] tracking-[0.16em] text-muted-foreground uppercase md:inline">
            Answers from across your whole vault — every claim traced to source
          </span>
          <div className="ml-auto flex w-[360px] items-center gap-2 rounded-full border border-border bg-background py-2 pr-2 pl-4">
            <input
              placeholder="Ask your archive anything…"
              className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/70 focus:outline-none"
            />
            <Button
              size="icon"
              className="size-7 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/85"
            >
              <Send className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,520px)_1fr] gap-10 px-8 py-5">
          <div>
            <p className="nn-mono mb-1.5 text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Question
            </p>
            <p className="text-sm leading-snug font-semibold text-foreground">
              {userTurn?.text}
            </p>
            <p className="nn-mono mt-4 mb-1.5 text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Answer
            </p>
            <p className="text-[14px] leading-relaxed text-foreground/90">
              {renderWithCitations(answer?.text ?? "")}
            </p>
          </div>

          <div>
            <p className="nn-mono mb-2.5 text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Sources · {answer?.citations?.length ?? 0} cited
            </p>
            <div className="grid grid-cols-3 gap-3">
              {answer?.citations?.map((c) => {
                const Icon = typeIcon[c.noteType];
                return (
                  <button
                    key={c.marker}
                    className="group flex flex-col gap-2 rounded-2xl border border-border bg-background p-3.5 text-left transition hover:border-foreground/40 hover:bg-card"
                  >
                    <div className="flex items-center gap-2">
                      <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                        {c.marker}
                      </span>
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="nn-mono ml-auto text-[11px] font-medium text-foreground">
                        {c.locator}
                      </span>
                    </div>
                    <span className="line-clamp-2 text-xs leading-snug font-semibold text-foreground">
                      {c.noteTitle}
                    </span>
                    <span className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                      “{c.snippet}”
                    </span>
                    <span className="nn-mono mt-auto flex items-center gap-1 pt-1 text-[10px] tracking-wider text-muted-foreground/70 uppercase transition group-hover:text-foreground">
                      Jump to source{" "}
                      <ArrowUpRight className="size-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// Editorial department header: mono index + heavy Archivo label + hairline.
function Kicker({ index, label }: { index: string; label: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="nn-mono text-[11px] text-muted-foreground">{index}</span>
      <span className="nn-heading text-sm font-extrabold tracking-[0.14em] uppercase">
        {label}
      </span>
    </div>
  );
}

// Inline [n] markers → small black citation pills (consistent with the dock).
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className="nn-mono mx-0.5 inline-grid size-[15px] -translate-y-0.5 cursor-pointer place-items-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground"
      >
        {m[1]}
      </sup>
    );
  });
}
