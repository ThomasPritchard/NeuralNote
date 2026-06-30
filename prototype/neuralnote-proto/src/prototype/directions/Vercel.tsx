import {
  ArrowRight,
  Brain,
  CornerDownLeft,
  FileText,
  Hash,
  Newspaper,
  Search,
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

// Graph-paper substrate behind the reader (the moat, on a blueprint).
// Two tiers like real graph paper: fine 24px cells over heavier 96px majors.
const gridMinor = "var(--grid)";
const gridMajor = "oklch(0.13 0 0 / 13%)";
const gridPaper = {
  backgroundImage: [
    `linear-gradient(${gridMajor} 1px, transparent 1px)`,
    `linear-gradient(90deg, ${gridMajor} 1px, transparent 1px)`,
    `linear-gradient(${gridMinor} 1px, transparent 1px)`,
    `linear-gradient(90deg, ${gridMinor} 1px, transparent 1px)`,
  ].join(","),
  backgroundSize: "96px 96px, 96px 96px, 24px 24px, 24px 24px",
} as const;

// ── Vercel ── monochrome on graph paper, sharp & geometric, high-contrast.
// A top command bar over three engineered panels divided by crisp 1px black
// rules. Mono micro-labels everywhere; documentation / design-system feel.
export default function Vercel() {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* ── Command bar ──────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-stretch border-b border-foreground">
        <div className="flex items-center gap-2.5 border-r border-foreground px-5">
          <div className="grid size-7 place-items-center rounded-none bg-primary text-primary-foreground">
            <Brain className="size-4" />
          </div>
          <span className="nn-heading text-[15px] font-semibold tracking-tight">NeuralNote</span>
          <sup className="nn-mono text-[10px] leading-none text-muted-foreground">™</sup>
        </div>

        {/* Capture — the "throw anything in" affordance, front and centre. */}
        <div className="flex flex-1 items-center gap-3 border-r border-foreground px-5">
          <span className="nn-mono text-[10px] tracking-[0.2em] text-muted-foreground">
            [ + ] CAPTURE
          </span>
          <input
            readOnly
            placeholder="PASTE URL · DROP PDF · BRAIN-DUMP"
            className="nn-mono w-full flex-1 bg-transparent text-xs uppercase tracking-[0.18em] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <button className="nn-mono flex items-center gap-1.5 rounded-none bg-primary px-3.5 py-1.5 text-[11px] font-medium tracking-[0.15em] text-primary-foreground transition-colors hover:bg-primary/85">
            CAPTURE <ArrowRight className="size-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 nn-mono text-[10px] tracking-[0.18em] text-muted-foreground">
          <span className="size-1.5 bg-primary" />
          <span className="text-foreground">READY</span>
          <span className="text-foreground/30">·</span>
          <span>V1 · BYO-KEY</span>
        </div>
      </header>

      {/* ── Body: three engineered panels ───────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* Vault index ─────────────────────────────────────────────────── */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-foreground bg-sidebar text-sidebar-foreground">
          <label className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              readOnly
              placeholder="SEARCH VAULT…"
              className="nn-mono w-full bg-transparent text-[11px] uppercase tracking-[0.15em] placeholder:text-muted-foreground/70 focus:outline-none"
            />
          </label>

          <PanelLabel value="VAULT INDEX" meta={`${vaultStats.folders} DIRS`} />

          <nav className="min-h-0 flex-1 overflow-y-auto">
            {vault.map((folder) => (
              <section key={folder.name}>
                <div className="flex items-center justify-between border-b border-border bg-secondary/60 px-4 py-1.5">
                  <span className="nn-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground">
                    § {folder.name.toUpperCase()}
                  </span>
                  <span className="nn-mono text-[10px] text-muted-foreground/70">
                    {String(folder.notes.length).padStart(2, "0")}
                  </span>
                </div>
                {folder.notes.map((note) => {
                  const Icon = typeIcon[note.type];
                  const active = note.id === openNote.id;
                  return (
                    <button
                      key={note.id}
                      className={`flex w-full items-start gap-2.5 border-b border-border px-4 py-2.5 text-left transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-foreground hover:bg-accent"
                      }`}
                    >
                      <Icon className={`mt-0.5 size-3.5 shrink-0 ${active ? "" : "text-muted-foreground"}`} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="line-clamp-2 text-[13px] leading-snug">{note.title}</span>
                        <span
                          className={`nn-mono text-[9px] tracking-[0.12em] ${
                            active ? "text-primary-foreground/60" : "text-muted-foreground"
                          }`}
                        >
                          {note.type.toUpperCase()} · {note.captured.toUpperCase()}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </nav>

          {/* Capture queue ─ the recent captures, with mono pipeline state. */}
          <PanelLabel value="CAPTURE QUEUE" meta={`${recentCaptures.length} ITEMS`} />
          <div className="shrink-0">
            {recentCaptures.map((c) => {
              const Icon = typeIcon[c.type];
              const distilled = c.state === "distilled";
              return (
                <div
                  key={c.label}
                  className="flex items-center gap-2.5 border-b border-border px-4 py-2"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="nn-mono flex-1 truncate text-[10px] tracking-[0.04em] text-foreground/80">
                    {c.label}
                  </span>
                  <span
                    className={`nn-mono shrink-0 border px-1.5 py-0.5 text-[8px] tracking-[0.12em] ${
                      distilled
                        ? "border-foreground text-foreground"
                        : "border-dashed border-muted-foreground text-muted-foreground"
                    }`}
                  >
                    {distilled ? "DISTILLED" : "DISTILLING…"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Telemetry footer ─ vault stats as engineered cells. */}
          <div className="grid shrink-0 grid-cols-2 gap-px border-t border-foreground bg-foreground">
            {[
              ["NOTES", vaultStats.notes],
              ["SOURCES", vaultStats.sources],
              ["FOLDERS", vaultStats.folders],
              ["EMBEDDED", vaultStats.embedded],
            ].map(([label, value]) => (
              <div key={label} className="bg-sidebar px-4 py-2.5">
                <div className="nn-mono text-[9px] tracking-[0.18em] text-muted-foreground">
                  {label}
                </div>
                <div className="nn-mono mt-0.5 text-[13px] font-medium text-foreground">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Reader ─ on graph paper ──────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-foreground bg-card px-8 py-2.5">
            <span className="nn-mono text-[10px] tracking-[0.18em] text-muted-foreground">
              VAULT / RESEARCH / ATTENTION
            </span>
            <span className="nn-mono text-[10px] tracking-[0.18em] text-muted-foreground">
              DOC · 001 — REV 2.6
            </span>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto" style={gridPaper}>
            {/* Corner crosshairs anchoring content to the grid. */}
            <span className="nn-mono pointer-events-none absolute left-5 top-5 select-none text-base text-foreground/25">
              +
            </span>
            <span className="nn-mono pointer-events-none absolute right-5 top-5 select-none text-base text-foreground/25">
              +
            </span>

            <article className="px-8 py-9">
              {/* Source ─────────────────────────────────────────────────── */}
              <div className="nn-mono mb-3 text-[10px] tracking-[0.22em] text-muted-foreground">
                SOURCE
              </div>
              <div className="inline-flex items-center gap-2.5 rounded-none border border-foreground bg-card px-3 py-1.5">
                <Video className="size-3.5" />
                <span className="nn-mono text-[11px] tracking-[0.1em]">
                  {openNote.type.toUpperCase()}
                </span>
                <span className="text-foreground/25">|</span>
                <span className="nn-mono text-[11px] text-muted-foreground">{openNote.sourceUrl}</span>
                <span className="text-foreground/25">|</span>
                <span className="nn-mono text-[11px] text-muted-foreground">{openNote.capturedAt}</span>
              </div>

              <h1 className="nn-heading mt-6 max-w-[20ch] text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.02em]">
                {openNote.title}
              </h1>

              {/* Tags ───────────────────────────────────────────────────── */}
              <div className="mt-5 flex items-center gap-3">
                <span className="nn-mono text-[10px] tracking-[0.22em] text-muted-foreground">
                  TAGS
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {openNote.tags.map((t) => (
                    <span
                      key={t}
                      className="nn-mono inline-flex items-center gap-1 rounded-none border border-foreground px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]"
                    >
                      <Hash className="size-2.5" />
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              {/* Distilled ──────────────────────────────────────────────── */}
              <Rule label="DISTILLED" meta={`MODEL · ${openNote.distilModel.toUpperCase()}`} />
              <p className="max-w-[64ch] text-[15px] leading-relaxed text-foreground/90">
                {openNote.summary}
              </p>

              {/* Key claims ─ numbered, black index cells. ──────────────── */}
              <Rule label="KEY CLAIMS" meta={`${openNote.keyClaims.length} EXTRACTED`} />
              <div className="grid gap-px border border-foreground bg-foreground">
                {openNote.keyClaims.map((claim, i) => (
                  <div key={claim} className="grid grid-cols-[3.25rem_1fr] bg-card">
                    <div className="nn-mono grid place-items-center bg-primary text-[13px] font-medium text-primary-foreground">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <p className="px-4 py-3.5 text-[14px] leading-relaxed text-foreground/90">
                      {claim}
                    </p>
                  </div>
                ))}
              </div>

              {/* Full source ─ retained transcript, the moat, visible. ──── */}
              <Rule
                label="FULL SOURCE"
                meta={`RETAINED · ${String(openNote.sourceChunks.length).padStart(2, "0")} CHUNKS`}
              />
              <div className="grid gap-px border border-foreground bg-foreground">
                {openNote.sourceChunks.map((chunk) => (
                  <div key={chunk.id} className="grid grid-cols-[4.25rem_1fr] bg-card">
                    <div className="nn-mono flex items-start justify-center bg-secondary px-2 py-3.5 text-[11px] tracking-[0.05em] text-foreground">
                      {chunk.locator}
                    </div>
                    <p className="px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground">
                      {chunk.text}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </main>

        {/* Cited chat ───────────────────────────────────────────────────── */}
        <aside className="flex w-[400px] shrink-0 flex-col border-l border-foreground bg-card">
          <div className="flex shrink-0 items-center justify-between border-b border-foreground px-5 py-3">
            <span className="nn-mono text-[11px] font-medium tracking-[0.2em]">CITED RECALL</span>
            <span className="nn-mono text-[10px] tracking-[0.15em] text-muted-foreground">
              THREAD · 01
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {chatThread.map((turn, i) =>
              turn.role === "user" ? (
                <div key={i} className="rounded-none border border-foreground bg-secondary">
                  <div className="nn-mono border-b border-foreground px-3 py-1.5 text-[10px] tracking-[0.2em] text-muted-foreground">
                    {">"} QUERY
                  </div>
                  <p className="px-3 py-2.5 text-[14px] leading-relaxed">{turn.text}</p>
                </div>
              ) : (
                <div key={i} className="rounded-none border border-foreground bg-card">
                  <div className="flex items-center justify-between border-b border-foreground px-3 py-1.5">
                    <span className="nn-mono text-[10px] tracking-[0.2em] text-muted-foreground">
                      RESPONSE
                    </span>
                    <span className="nn-mono text-[10px] tracking-[0.15em] text-muted-foreground">
                      {String(turn.citations?.length ?? 0).padStart(2, "0")} REFS
                    </span>
                  </div>
                  <p className="px-3 py-3 text-[14px] leading-relaxed text-foreground/90">
                    {renderWithCitations(turn.text)}
                  </p>

                  <div className="border-t border-border bg-secondary/40 px-3 py-3">
                    <div className="nn-mono mb-2 text-[9px] tracking-[0.22em] text-muted-foreground">
                      CITATIONS
                    </div>
                    <div className="flex flex-col gap-2">
                      {turn.citations?.map((c) => {
                        const Icon = typeIcon[c.noteType];
                        return (
                          <div
                            key={c.marker}
                            className="group rounded-none border border-foreground bg-card transition-colors hover:bg-accent"
                          >
                            <div className="flex items-center justify-between border-b border-border px-2.5 py-1">
                              <span className="nn-mono text-[9px] font-medium tracking-[0.15em]">
                                [REF {c.marker}]
                              </span>
                              <span className="nn-mono text-[9px] tracking-[0.1em] text-muted-foreground">
                                {c.locator}
                              </span>
                            </div>
                            <div className="px-2.5 py-2">
                              <div className="flex items-center gap-1.5">
                                <Icon className="size-3 shrink-0 text-muted-foreground" />
                                <span className="truncate text-[12px] font-medium">
                                  {c.noteTitle}
                                </span>
                              </div>
                              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                                “{c.snippet}”
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>

          <div className="shrink-0 border-t border-foreground p-3">
            <div className="flex items-stretch border border-foreground">
              <span className="nn-mono grid place-items-center border-r border-foreground px-3 text-[10px] tracking-[0.1em] text-muted-foreground">
                ASK
              </span>
              <input
                readOnly
                placeholder="QUERY ACROSS YOUR ENTIRE VAULT…"
                className="nn-mono min-w-0 flex-1 bg-card px-3 py-2.5 text-[11px] uppercase tracking-[0.12em] placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <button className="grid place-items-center bg-primary px-3.5 text-primary-foreground transition-colors hover:bg-primary/85">
                <CornerDownLeft className="size-4" />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// Mono section-label bar used between sidebar regions.
function PanelLabel({ value, meta }: { value: string; meta?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-foreground bg-card px-4 py-2">
      <span className="nn-mono text-[10px] font-medium tracking-[0.22em] text-foreground">
        {value}
      </span>
      {meta && (
        <span className="nn-mono text-[9px] tracking-[0.15em] text-muted-foreground">{meta}</span>
      )}
    </div>
  );
}

// A Swiss horizontal-rule section header: mono label, full-width black rule.
function Rule({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="mt-11 mb-4 flex items-center gap-3">
      <span className="nn-mono text-[10px] font-medium uppercase tracking-[0.22em] text-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-foreground/70" />
      {meta && (
        <span className="nn-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
          {meta}
        </span>
      )}
    </div>
  );
}

// Inline [n] markers → sharp bordered mono citation chips.
function renderWithCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <sup
        key={i}
        className="nn-mono mx-0.5 inline-flex -translate-y-0.5 cursor-pointer items-center justify-center rounded-none border border-foreground bg-card px-1 text-[9px] leading-none text-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
      >
        {m[1]}
      </sup>
    );
  });
}
