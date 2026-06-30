import {
  ArrowUpRight,
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  FileText,
  Folder,
  Hash,
  Home,
  Layers,
  Library,
  Loader2,
  MessageSquare,
  Newspaper,
  Plus,
  Quote,
  ScanLine,
  Search,
  Send,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import type { SourceType } from "../mock";
import { chatThread, openNote, recentCaptures, vault, vaultStats } from "../mock";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

// ── Deepflow ── dark indigo dashboard, data-viz chrome. Nav sidebar +
// full-width metrics band + "source detail" reader + retrieval-viz chat rail.
// More figures, more chrome than Eden — an analytics product that holds a brain.
export default function Deepflow() {
  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <NavSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <MetricsBand />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ReaderColumn />
          <ChatRail />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────  Nav sidebar  ───────────────────────────── */

const navItems = [
  { icon: Home, label: "Home" },
  { icon: Library, label: "Library", active: true },
  { icon: MessageSquare, label: "Chat" },
  { icon: BarChart3, label: "Insights" },
];

function NavSidebar() {
  return (
    <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow-[0_0_20px_-4px_var(--color-primary)]">
          <Brain className="size-4" />
        </div>
        <div className="flex flex-col leading-none">
          <span className="nn-heading text-[15px] font-semibold tracking-tight text-foreground">
            NeuralNote
          </span>
          <span className="nn-mono mt-0.5 text-[10px] text-muted-foreground">v1 · vault</span>
        </div>
      </div>

      {/* capture entry */}
      <div className="px-4">
        <Button className="h-10 w-full justify-start gap-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 text-primary-foreground shadow-[0_8px_24px_-12px_var(--color-primary)] hover:opacity-95">
          <Plus className="size-4" /> Capture anything
        </Button>
      </div>

      {/* search */}
      <div className="px-4 pt-3">
        <label className="flex items-center gap-2 rounded-lg bg-background/50 px-3 py-2 text-sm text-muted-foreground ring-1 ring-border focus-within:ring-primary/50">
          <Search className="size-3.5" />
          <input
            placeholder="Search vault…"
            className="w-full bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <kbd className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
        </label>
      </div>

      {/* primary nav */}
      <nav className="mt-4 flex flex-col gap-0.5 px-3">
        {navItems.map((item) => (
          <button
            key={item.label}
            aria-current={item.active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
              item.active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
            }`}
          >
            <item.icon className="size-4" />
            {item.label}
            {item.active && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
          </button>
        ))}
      </nav>

      {/* vault tree */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
          Vault
        </div>
        {vault.map((folder) => (
          <div key={folder.name} className="mb-2 flex flex-col">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-muted-foreground">
              <Folder className="size-3" /> {folder.name}
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
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition ${
                    active
                      ? "bg-primary/12 text-foreground ring-1 ring-primary/25"
                      : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
                  }`}
                >
                  <Icon className={`size-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground/70"}`} />
                  <span className="truncate">{note.title}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* ingest queue (recent captures + status) */}
      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-1.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
          <ScanLine className="size-3" /> Ingest queue
        </div>
        <div className="flex flex-col gap-1.5">
          {recentCaptures.map((c) => {
            const Icon = typeIcon[c.type];
            const distilling = c.state === "distilling";
            return (
              <div
                key={c.label}
                className="flex items-center gap-2 rounded-md bg-background/40 px-2 py-1.5 ring-1 ring-border"
              >
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="nn-mono truncate text-[11px] text-muted-foreground">{c.label}</span>
                <span
                  className={`ml-auto flex shrink-0 items-center gap-1 text-[10px] ${
                    distilling ? "text-primary" : "text-muted-foreground/80"
                  }`}
                >
                  {distilling ? (
                    <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <CheckCircle2 className="size-3" />
                  )}
                  {distilling ? "distilling" : "distilled"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/* ────────────────────────────────  Top bar  ───────────────────────────── */

function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-6">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <span>Library</span>
        <ChevronRight className="size-3.5 opacity-50" />
        <span>Research</span>
        <ChevronRight className="size-3.5 opacity-50" />
        <span className="max-w-[260px] truncate text-foreground">{openNote.title}</span>
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] text-primary ring-1 ring-primary/20">
          <LiveDot /> Index synced
        </span>
        <span className="nn-mono hidden items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground lg:inline-flex">
          <Cpu className="size-3" /> {openNote.distilModel}
        </span>
        <Avatar className="size-7 ring-1 ring-border">
          <AvatarFallback className="bg-primary/15 text-[11px] text-primary">TP</AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}

function LiveDot() {
  return (
    <span className="relative flex size-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
    </span>
  );
}

/* ──────────────────────────────  Metrics band  ─────────────────────────── */

const notesTrend = [4, 6, 5, 8, 7, 9, 8, 11, 10, 13];
const sourcesTrend = [120, 126, 131, 129, 140, 150, 156, 162, 165, 168];
const tokensTrend = [0.55, 0.62, 0.68, 0.74, 0.82, 0.9, 1.0, 1.08, 1.15, 1.2];
const citationsTrend = [140, 180, 210, 240, 230, 280, 320, 360, 390, 432];

function MetricsBand() {
  return (
    <section
      aria-label="Vault metrics"
      className="grid shrink-0 grid-cols-2 gap-3 border-b border-border px-6 py-4 lg:grid-cols-4"
    >
      <StatCard
        icon={FileText}
        label="Notes"
        value={String(vaultStats.notes)}
        delta="+8"
        sub="this week"
        spark={<SparkBars data={notesTrend} />}
      />
      <StatCard
        icon={Database}
        label="Sources retained"
        value={String(vaultStats.sources)}
        delta="+11"
        sub="this week"
        spark={<SparkLine data={sourcesTrend} fill />}
      />
      <StatCard
        icon={Cpu}
        label="Tokens embedded"
        value={vaultStats.embedded.split(" ")[0]}
        unit="tokens"
        delta="+0.34M"
        sub="this week"
        spark={<SparkLine data={tokensTrend} fill />}
      />
      <StatCard
        icon={Quote}
        label="Citations served"
        value="2,847"
        delta="+214"
        sub="this week"
        spark={<SparkBars data={citationsTrend} />}
      />
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  delta,
  sub,
  spark,
}: {
  icon: typeof FileText;
  label: string;
  value: string;
  unit?: string;
  delta: string;
  sub: string;
  spark: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl bg-card p-3.5 ring-1 ring-border transition hover:ring-primary/30">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className="nn-mono text-[26px] font-semibold leading-none tracking-tight text-foreground">
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[11px]">
        <ArrowUpRight className="size-3 text-primary" />
        <span className="nn-mono text-primary">{delta}</span>
        <span className="text-muted-foreground/70">{sub}</span>
      </div>
      <div className="mt-3">{spark}</div>
    </div>
  );
}

function SparkBars({ data }: { data: number[] }) {
  const max = Math.max(...data);
  return (
    <div className="flex h-8 items-end gap-[2px]" aria-hidden>
      {data.map((v, i) => {
        const last = i === data.length - 1;
        return (
          <span
            key={i}
            className={`w-full rounded-[1px] ${last ? "bg-primary" : "bg-primary/30"}`}
            style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

function SparkLine({ data, fill = false }: { data: number[]; fill?: boolean }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map(
    (v, i) => [(i / (data.length - 1)) * 100, 27 - ((v - min) / span) * 24] as const,
  );
  const line = pts.map((p) => `${p[0]},${p[1]}`).join(" ");
  const area = `0,30 ${line} 100,30`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full text-primary" aria-hidden>
      <defs>
        <linearGradient id="nn-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <polygon points={area} fill="url(#nn-spark-fill)" />}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="1.8" fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ──────────────────────────  Reader (source detail)  ───────────────────── */

function ReaderColumn() {
  const SourceIcon = typeIcon[openNote.type];
  return (
    <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
      <article className="overflow-hidden rounded-2xl bg-card ring-1 ring-border">
        {/* card toolbar */}
        <div className="flex items-center gap-2 border-b border-border bg-background/30 px-5 py-2.5">
          <span className="flex items-center gap-1.5 rounded-md bg-primary/12 px-2 py-1 text-[11px] font-medium text-primary ring-1 ring-primary/20">
            <SourceIcon className="size-3" /> {typeLabel[openNote.type]}
          </span>
          <span className="nn-mono truncate text-[11px] text-muted-foreground">{openNote.sourceUrl}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="size-3" /> {openNote.capturedAt}
          </span>
        </div>

        <div className="px-6 py-6">
          <h1 className="nn-heading text-[26px] font-semibold leading-tight tracking-tight">
            {openNote.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {openNote.tags.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="gap-1 rounded-full border-border bg-background/40 px-2.5 py-0.5 text-[11px] font-normal text-muted-foreground"
              >
                <Hash className="size-2.5" /> {t}
              </Badge>
            ))}
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] text-primary ring-1 ring-primary/20">
              <Sparkles className="size-3" /> Distilled · {openNote.distilModel}
            </span>
          </div>

          {/* distilled summary */}
          <div className="mt-6 rounded-xl bg-background/30 p-5 ring-1 ring-border">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Sparkles className="size-3 text-primary" /> AI summary
            </div>
            <p className="text-[15px] leading-relaxed text-foreground/90">{openNote.summary}</p>
          </div>

          {/* key claims */}
          <div className="mt-6 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Layers className="size-3 text-primary" /> Key claims
            <span className="nn-mono ml-1 text-muted-foreground/60">{openNote.keyClaims.length}</span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {openNote.keyClaims.map((claim, i) => (
              <li
                key={claim}
                className="flex gap-3 rounded-xl bg-background/30 px-4 py-3 ring-1 ring-border transition hover:ring-primary/30"
              >
                <span className="nn-mono mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-primary/12 text-[11px] text-primary">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[14px] leading-relaxed text-foreground/90">{claim}</span>
              </li>
            ))}
          </ul>

          {/* retained full source — the moat */}
          <div className="mt-7 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <Quote className="size-3 text-primary" /> Retained full source
            <span className="nn-mono ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {openNote.sourceChunks.length} chunks · indexed
            </span>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-border">
            {openNote.sourceChunks.map((chunk, i) => (
              <div
                key={chunk.id}
                className={`flex gap-4 bg-background/30 px-4 py-3.5 transition hover:bg-background/50 ${
                  i > 0 ? "border-t border-border" : ""
                }`}
              >
                <span className="nn-mono mt-px flex h-5 shrink-0 items-center rounded bg-primary/12 px-2 text-[11px] text-primary">
                  {chunk.locator}
                </span>
                <span className="text-[13px] leading-relaxed text-muted-foreground">{chunk.text}</span>
              </div>
            ))}
          </div>
        </div>
      </article>
    </main>
  );
}

/* ─────────────────────  Cited chat rail (the hero)  ────────────────────── */

// Relevance scores for the retrieval visualisation (highest-ranked first).
const relevanceByMarker: Record<number, number> = { 1: 0.96, 2: 0.91, 3: 0.84 };

function ChatRail() {
  const assistant = chatThread.find((t) => t.role === "assistant");
  const citationCount = assistant?.citations?.length ?? 0;

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-border bg-gradient-to-b from-primary/[0.06] to-background">
      {/* header */}
      <div className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-primary-foreground">
            <Sparkles className="size-3.5" />
          </span>
          <span className="nn-heading text-sm font-semibold">Cited recall</span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-background/50 px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-border">
            <Database className="size-3 text-primary" /> {vaultStats.sources} sources
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Grounded in retrieved chunks · every claim citation-checked before shown.
        </p>
      </div>

      {/* conversation */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {chatThread.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[13px] leading-relaxed text-primary-foreground shadow-[0_8px_24px_-14px_var(--color-primary)]">
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col gap-3">
              {/* retrieval status banner */}
              <div className="flex items-center gap-2 rounded-lg bg-background/40 px-3 py-2 ring-1 ring-border">
                <ScanLine className="size-3.5 text-primary" />
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
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  <Quote className="size-3 text-primary" /> Sources · ranked by relevance
                </div>
                {turn.citations?.map((c) => {
                  const Icon = typeIcon[c.noteType];
                  const score = relevanceByMarker[c.marker] ?? 0.8;
                  return (
                    <button
                      key={c.marker}
                      className="group flex flex-col gap-1.5 rounded-xl bg-card/70 p-2.5 text-left ring-1 ring-border transition hover:bg-card hover:ring-primary/45"
                    >
                      <div className="flex items-center gap-2">
                        <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] text-primary">
                          {c.marker}
                        </span>
                        <Icon className="size-3 shrink-0 text-primary" />
                        <span className="truncate text-[12px] font-medium text-foreground">
                          {c.noteTitle}
                        </span>
                        <span className="nn-mono ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {c.locator}
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
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
          <span className="rounded-full bg-background/50 px-2 py-0.5 ring-1 ring-border">Scope: all folders</span>
          <span className="nn-mono rounded-full bg-background/50 px-2 py-0.5 ring-1 ring-border">
            {vaultStats.notes} notes
          </span>
        </div>
        <div className="flex items-end gap-2 rounded-xl bg-background/60 p-2 ring-1 ring-border focus-within:ring-primary/50">
          <textarea
            rows={1}
            placeholder="Ask across everything you've captured…"
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <Button
            size="icon"
            className="size-9 shrink-0 rounded-lg bg-gradient-to-br from-primary to-primary/80 text-primary-foreground hover:opacity-95"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}

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
        className="nn-mono mx-0.5 inline-grid size-4 -translate-y-px cursor-pointer place-items-center rounded bg-primary/20 text-[10px] font-medium text-primary ring-1 ring-primary/30 transition hover:bg-primary/30"
      >
        {m[1]}
      </sup>
    );
  });
}
