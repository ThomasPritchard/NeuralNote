// ── Landing direction · "Product hero" ──────────────────────────────────────
// Product-led marketing page for NeuralNote. The hero is a stylised app-window
// mock of the real 3-pane workspace (vault · reader · cited chat), so the
// product itself carries the page. Editorial minimalism adapted to the project's
// dark-indigo / violet tokens: big confident type, generous whitespace, flat
// 1px-bordered cards, restrained accent, the violet glow reserved for the mock
// and the final CTA. Honest copy only — no fabricated proof.
//
// Themed by the [data-direction="neuralnote"] wrapper the route supplies, so this
// file uses semantic token classes only. No data-direction, no viewport height.

import {
  ArrowRight,
  Brain,
  Check,
  Clock,
  Database,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Hash,
  Layers,
  Newspaper,
  Quote,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  Type,
  Video,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  finalCta,
  hero,
  loop,
  nav,
  pillars,
  privacy,
  why,
  wordmark,
} from "./content";

const loopIcon: ComponentType<{ className?: string }>[] = [FilePlus2, Sparkles, Quote];
const pillarIcon: Record<string, ComponentType<{ className?: string }>> = {
  capture: Layers,
  recall: Quote,
  own: HardDrive,
};

export default function LandingProduct() {
  return (
    <div className="w-full bg-background text-foreground antialiased">
      <ScopedStyles />
      <TopNav />

      <main>
        <Hero />
        <Loop />
        <Pillars />
        <Why />
        <Privacy />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}

/* ─────────────────────────────────  Nav  ───────────────────────────────── */

function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_18px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.25)]">
        <Brain className="size-[17px]" aria-hidden />
      </span>
      <span className="nn-heading text-[15px] font-semibold tracking-tight">{wordmark}</span>
    </span>
  );
}

function TopNav() {
  const links = nav.filter((n) => n !== "Download");
  const anchors: Record<string, string> = {
    "How it works": "#how",
    "Cited recall": "#recall",
    "Own your data": "#own",
  };
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#top" aria-label={wordmark}>
          <Wordmark />
        </a>

        <ul className="hidden items-center gap-1 md:flex">
          {links.map((item) => (
            <li key={item}>
              <a
                href={anchors[item] ?? "#"}
                className="rounded-md px-3 py-2 text-[13.5px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                {item}
              </a>
            </li>
          ))}
        </ul>

        <a
          href="#download"
          className="group inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[13.5px] font-medium text-primary-foreground shadow-[0_10px_30px_-12px_var(--color-primary)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
        >
          <Download className="size-4" aria-hidden />
          Download
        </a>
      </nav>
    </header>
  );
}

/* ─────────────────────────────────  Hero  ──────────────────────────────── */

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden px-6 pt-20 pb-24 sm:pt-24">
      {/* ambient violet wash behind the headline — depth, not decoration */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[-10%] mx-auto h-[520px] max-w-4xl opacity-70"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 0%, var(--color-primary) 0%, transparent 70%)",
          filter: "blur(70px)",
          opacity: 0.18,
        }}
      />

      <div className="relative mx-auto max-w-3xl text-center">
        <span className="lp-rise nn-mono inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_1px_var(--color-primary)]" />
          {hero.eyebrow}
        </span>

        <h1
          className="lp-rise nn-heading mx-auto mt-6 max-w-[20ch] text-balance text-[clamp(2.4rem,6vw,4.25rem)] font-semibold leading-[1.04] tracking-[-0.03em]"
          style={{ animationDelay: "60ms" }}
        >
          {hero.headline}
        </h1>

        <p
          className="lp-rise mx-auto mt-6 max-w-[46ch] text-pretty text-[16px] leading-7 text-muted-foreground sm:text-[17px]"
          style={{ animationDelay: "120ms" }}
        >
          {hero.sub}
        </p>

        <div
          className="lp-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          style={{ animationDelay: "180ms" }}
        >
          <a
            href="#download"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-[15px] font-medium text-primary-foreground shadow-[0_16px_40px_-14px_var(--color-primary)] transition-all duration-200 hover:brightness-110 active:scale-[0.98] sm:w-auto"
          >
            <Download className="size-[18px]" aria-hidden />
            {hero.ctaPrimary}
          </a>
          <a
            href="#how"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card/40 px-6 py-3 text-[15px] font-medium text-foreground transition-colors duration-200 hover:bg-card sm:w-auto"
          >
            {hero.ctaSecondary}
            <ArrowRight className="size-[18px] text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
          </a>
        </div>

        <p
          className="lp-rise nn-mono mt-5 text-[12px] text-muted-foreground/80"
          style={{ animationDelay: "240ms" }}
        >
          {hero.note}
        </p>
      </div>

      {/* the product — the hero centrepiece */}
      <div className="lp-rise relative mx-auto mt-16 max-w-6xl" style={{ animationDelay: "300ms" }}>
        {/* soft violet glow seating the window on the page */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-8 -bottom-12 top-16"
          style={{
            background:
              "radial-gradient(55% 60% at 50% 50%, var(--color-primary) 0%, transparent 72%)",
            filter: "blur(90px)",
            opacity: 0.28,
          }}
        />
        <ProductWindow />
      </div>
    </section>
  );
}

/* ───────────────────────────  Product-window mock  ─────────────────────── */

function ProductWindow() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-[0_40px_120px_-30px_rgb(0_0_0/0.65)] ring-1 ring-white/5">
      {/* title bar — faux macOS chrome */}
      <div className="flex h-11 items-center gap-3 border-b border-border bg-sidebar px-4">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-[#ff5f57]/85" />
          <span className="size-3 rounded-full bg-[#febc2e]/85" />
          <span className="size-3 rounded-full bg-[#28c840]/85" />
        </div>
        <div className="mx-auto flex items-center gap-2 rounded-md border border-border bg-background/50 px-3 py-1 text-[12px] text-muted-foreground">
          <Search className="size-3" aria-hidden />
          NeuralNote vault
          <kbd className="nn-mono ml-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </div>
        <Sparkles className="size-4 text-primary/80" aria-hidden />
      </div>

      {/* 3-pane workspace */}
      <div className="grid grid-cols-[180px_1fr] md:grid-cols-[200px_1fr_330px]">
        <VaultPane />
        <ReaderPane />
        <ChatPane />
      </div>
    </div>
  );
}

function VaultPane() {
  return (
    <aside className="hidden flex-col border-r border-border bg-sidebar p-3 md:flex">
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="text-[12px] font-semibold text-sidebar-foreground">Vault</span>
        <FilePlus2 className="size-3.5 text-muted-foreground" aria-hidden />
      </div>

      <TreeFolder name="Research" open>
        <TreeItem icon={Video} label="Attention Is All You Need" active />
        <TreeItem icon={FileText} label="Scaling Laws for Neural LMs" />
        <TreeItem icon={Newspaper} label="The Bitter Lesson" />
      </TreeFolder>
      <TreeFolder name="Reading">
        <TreeItem icon={Newspaper} label="Building a Second Brain" />
      </TreeFolder>
      <TreeFolder name="Ideas">
        <TreeItem icon={Type} label="Why citation fidelity is the moat" />
      </TreeFolder>

      <div className="mt-auto flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground">
        <ScanLine className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="nn-mono truncate">arxiv.org/abs/2001…</span>
        <span className="ml-auto shrink-0 text-primary">distilling</span>
      </div>
    </aside>
  );
}

function TreeFolder({
  name,
  open = false,
  children,
}: {
  name: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-sidebar-foreground">
        <Icon className={`size-3.5 ${open ? "text-primary/80" : "text-muted-foreground"}`} aria-hidden />
        {name}
      </div>
      {open && <div className="ml-2 border-l border-border/70 pl-1.5">{children}</div>}
    </div>
  );
}

function TreeItem({
  icon: Icon,
  label,
  active = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-[12px] ${
        active
          ? "bg-primary/12 text-foreground ring-1 ring-inset ring-primary/25"
          : "text-muted-foreground"
      }`}
    >
      <Icon className={`size-3 shrink-0 ${active ? "text-primary" : "opacity-70"}`} aria-hidden />
      <span className="truncate">{label}</span>
    </div>
  );
}

function ReaderPane() {
  return (
    <section className="flex flex-col bg-background px-5 py-5 md:px-7 md:py-6">
      <div className="nn-mono mb-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Research <span className="opacity-40">/</span>
        <span className="text-foreground/80">Attention Is All You Need</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Chip icon={Video}>YouTube</Chip>
        <Chip icon={Sparkles}>Distilled</Chip>
      </div>

      <h3 className="nn-heading mt-4 text-[20px] font-semibold leading-tight tracking-tight md:text-[22px]">
        Attention Is All You Need
      </h3>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {["ml", "transformers", "architecture"].map((t) => (
          <span
            key={t}
            className="nn-mono inline-flex items-center rounded-sm bg-primary/12 px-1.5 py-0.5 text-[11px] text-primary ring-1 ring-inset ring-primary/15"
          >
            <Hash className="mr-0.5 size-2.5" aria-hidden />
            {t}
          </span>
        ))}
      </div>

      <p className="mt-4 max-w-[52ch] text-[13.5px] leading-6 text-muted-foreground">
        The Transformer drops recurrence entirely, relying only on self-attention to draw global
        dependencies — so training parallelises across the whole sequence.
      </p>

      <div className="mt-5 overflow-hidden rounded-lg border border-primary/25 border-l-2 border-l-primary bg-accent/30">
        <div className="flex items-center gap-2 px-3.5 py-2 text-[12px] font-semibold text-accent-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          Key claims
          <span className="nn-mono ml-1 text-[11px] font-normal text-muted-foreground">3</span>
        </div>
        <p className="border-t border-border/60 px-3.5 py-2.5 text-[12.5px] leading-5 text-foreground/80">
          Self-attention connects all positions with O(1) sequential operations, vs O(n) for
          recurrent layers.
        </p>
      </div>

      <div className="nn-mono mt-auto flex items-center gap-3 pt-5 text-[10.5px] text-muted-foreground/70">
        <span className="flex items-center gap-1.5">
          <Clock className="size-3" aria-hidden /> 29 Jun 2026
        </span>
        <span className="opacity-40">·</span>
        <span>3 chunks · indexed</span>
      </div>
    </section>
  );
}

function ChatPane() {
  return (
    <aside className="hidden flex-col border-l border-border bg-gradient-to-b from-primary/[0.08] via-sidebar to-sidebar p-4 md:flex">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_14px_-3px_var(--color-primary)]">
          <Sparkles className="size-3.5" aria-hidden />
        </span>
        <span className="nn-heading text-[13px] font-semibold">Cited recall</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground">
          <Database className="size-3 text-primary" aria-hidden />
          168 sources
        </span>
      </div>

      {/* user question */}
      <div className="mt-4 flex justify-end">
        <p className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[12px] leading-snug text-primary-foreground">
          Why did transformers replace RNNs?
        </p>
      </div>

      {/* retrieval banner */}
      <div className="mt-3 flex items-center gap-2 rounded-md bg-background/40 px-2.5 py-1.5 ring-1 ring-inset ring-border">
        <ScanLine className="size-3 text-primary" aria-hidden />
        <span className="text-[10.5px] font-medium text-foreground">2 sources retrieved</span>
        <span className="nn-mono ml-auto text-[10px] text-muted-foreground">scanned 168</span>
      </div>

      {/* answer with inline markers */}
      <p className="mt-3 text-[12px] leading-[1.5] text-foreground/90">
        Self-attention relates every position in a single step, so training no longer walks the
        sequence one token at a time
        <Marker n={1} />, and that same all-to-all attention captures long-range dependencies
        directly
        <Marker n={2} />.
      </p>

      {/* one citation card */}
      <div className="mt-3 rounded-lg bg-card/70 p-2.5 ring-1 ring-inset ring-border">
        <div className="flex items-center gap-2">
          <span className="nn-mono grid size-4 place-items-center rounded bg-primary/15 text-[10px] font-medium text-primary">
            1
          </span>
          <Video className="size-3 shrink-0 text-primary" aria-hidden />
          <span className="truncate text-[11.5px] font-medium text-foreground">
            Attention Is All You Need
          </span>
          <span className="nn-mono ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            04:12
          </span>
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">
          “recurrent models … inherently preclude parallelisation within a training example”
        </p>
        <MatchBar pct={96} />
      </div>

      <div className="mt-auto flex items-center gap-2 rounded-lg bg-background/60 p-1.5 pl-3 ring-1 ring-inset ring-border">
        <span className="text-[11px] text-muted-foreground/70">Ask across everything…</span>
        <span className="ml-auto grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <ArrowRight className="size-3.5" aria-hidden />
        </span>
      </div>
    </aside>
  );
}

function Marker({ n }: { n: number }) {
  return (
    <sup className="nn-mono mx-0.5 inline-grid size-3.5 -translate-y-px place-items-center rounded bg-primary/20 text-[9px] font-medium text-primary ring-1 ring-inset ring-primary/30">
      {n}
    </sup>
  );
}

function MatchBar({ pct }: { pct: number }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="nn-mono text-[8.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        match
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-primary/12">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="nn-mono text-[10px] text-primary">{pct}%</span>
    </div>
  );
}

function Chip({ icon: Icon, children }: { icon: ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-inset ring-primary/20">
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

/* ──────────────────────────  Section scaffolding  ──────────────────────── */

function SectionHeading({
  eyebrow,
  title,
  className = "",
}: {
  eyebrow: string;
  title: string;
  className?: string;
}) {
  return (
    <div className={`max-w-2xl ${className}`}>
      <span className="nn-mono text-[11px] font-medium uppercase tracking-[0.16em] text-primary">
        {eyebrow}
      </span>
      <h2 className="nn-heading mt-3 text-balance text-[clamp(1.6rem,3.2vw,2.4rem)] font-semibold leading-tight tracking-[-0.02em]">
        {title}
      </h2>
    </div>
  );
}

/* ─────────────────────────────  The loop  ──────────────────────────────── */

function Loop() {
  return (
    <section id="how" className="border-t border-border/60 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <SectionHeading eyebrow="How it works" title="One loop, from anything to a cited answer." />

        <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
          {loop.map((step, i) => {
            const Icon = loopIcon[i] ?? FilePlus2;
            return (
              <li key={step.step} className="bg-card p-7">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="nn-mono text-[13px] text-muted-foreground/70">{step.step}</span>
                </div>
                <h3 className="nn-heading mt-5 text-[18px] font-semibold tracking-tight">
                  {step.title}
                </h3>
                <p className="mt-2 text-[14px] leading-6 text-muted-foreground">{step.body}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ──────────────────────────────  Pillars  ──────────────────────────────── */

function Pillars() {
  const highlight = pillars.find((p) => p.highlight);
  const rest = pillars.filter((p) => !p.highlight);

  return (
    <section id="recall" className="relative overflow-hidden border-t border-border/60 px-6 py-24">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-24 h-[360px] w-[680px] -translate-x-1/2"
        style={{
          background: "radial-gradient(50% 50% at 50% 0%, var(--color-primary) 0%, transparent 70%)",
          filter: "blur(80px)",
          opacity: 0.1,
        }}
      />
      <div className="relative mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="What you get"
          title="Three things, done for you — one of them nobody else nails."
        />

        <div className="mt-12 grid gap-5 lg:grid-cols-5">
          {/* the moat — centrepiece */}
          {highlight && (
            <article className="relative overflow-hidden rounded-xl border border-primary/30 bg-card p-8 lg:col-span-3 lg:p-9">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 size-56"
                style={{
                  background:
                    "radial-gradient(circle, var(--color-primary) 0%, transparent 70%)",
                  filter: "blur(50px)",
                  opacity: 0.22,
                }}
              />
              <div className="relative">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary ring-1 ring-inset ring-primary/25">
                  <Quote className="size-3" aria-hidden />
                  The moat
                </span>
                <h3 className="nn-heading mt-5 text-[22px] font-semibold leading-tight tracking-tight">
                  {highlight.title}
                </h3>
                <p className="mt-3 max-w-[48ch] text-[14.5px] leading-7 text-muted-foreground">
                  {highlight.body}
                </p>

                <CitedAnswerMini />
              </div>
            </article>
          )}

          {/* supporting pillars */}
          <div className="grid gap-5 lg:col-span-2">
            {rest.map((p) => {
              const Icon = pillarIcon[p.key] ?? Layers;
              return (
                <article
                  key={p.key}
                  className="rounded-xl border border-border bg-card p-7 transition-colors duration-200 hover:border-border/40"
                >
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="nn-heading mt-5 text-[17px] font-semibold tracking-tight">
                    {p.title}
                  </h3>
                  <p className="mt-2 text-[13.5px] leading-6 text-muted-foreground">{p.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// Small cited-answer visual proving the moat inside the highlight pillar.
function CitedAnswerMini() {
  return (
    <div className="mt-7 rounded-lg border border-border bg-background/60 p-4">
      <div className="mb-3 flex items-center gap-2 rounded-md bg-card/60 px-2.5 py-1.5 ring-1 ring-inset ring-border">
        <ScanLine className="size-3.5 text-primary" aria-hidden />
        <span className="text-[11px] font-medium text-foreground">3 sources retrieved</span>
        <span className="nn-mono ml-auto text-[10px] text-muted-foreground">verified before shown</span>
      </div>
      <p className="text-[13px] leading-6 text-foreground/90">
        Once training parallelises, you can pour in far more compute — and loss keeps falling as a
        power law
        <Marker n={3} />.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-md bg-card/70 px-2.5 py-2 ring-1 ring-inset ring-border">
        <span className="nn-mono grid size-4 place-items-center rounded bg-primary/15 text-[10px] font-medium text-primary">
          3
        </span>
        <FileText className="size-3 shrink-0 text-primary" aria-hidden />
        <span className="truncate text-[11.5px] font-medium text-foreground">
          Scaling Laws for Neural LMs
        </span>
        <span className="nn-mono ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          p.3
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────  Why it beats Obsidian  ─────────────────────── */

function Why() {
  return (
    <section id="own" className="border-t border-border/60 px-6 py-24">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <SectionHeading eyebrow="Versus Obsidian" title={why.title} className="lg:max-w-none" />

        <ul className="flex flex-col divide-y divide-border/70">
          {why.points.map((point) => (
            <li key={point} className="flex items-start gap-4 py-5 first:pt-0 last:pb-0">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
                <Check className="size-3.5" aria-hidden />
              </span>
              <p className="text-[15px] leading-7 text-foreground/85">{point}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ────────────────────────────  Honest privacy  ─────────────────────────── */

function Privacy() {
  return (
    <section className="relative overflow-hidden border-t border-border/60 px-6 py-24">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[560px] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: "radial-gradient(50% 50% at 50% 50%, var(--color-primary) 0%, transparent 72%)",
          filter: "blur(80px)",
          opacity: 0.08,
        }}
      />
      <div className="relative mx-auto max-w-4xl">
        <div className="rounded-xl border border-border bg-card p-8 md:p-10">
          <div className="flex flex-col gap-7 md:flex-row md:items-start md:gap-8">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/20">
              <ShieldCheck className="size-6" aria-hidden />
            </span>
            <div>
              <h2 className="nn-heading text-[22px] font-semibold tracking-tight md:text-[26px]">
                {privacy.title}
              </h2>
              <p className="mt-3 max-w-[62ch] text-[15px] leading-7 text-muted-foreground">
                {privacy.body}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────────  Final CTA  ────────────────────────────── */

function FinalCta() {
  return (
    <section id="download" className="relative overflow-hidden border-t border-border/60 px-6 py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-[420px] max-w-3xl -translate-y-1/2"
        style={{
          background:
            "radial-gradient(50% 60% at 50% 50%, var(--color-primary) 0%, transparent 72%)",
          filter: "blur(90px)",
          opacity: 0.2,
        }}
      />
      <div className="relative mx-auto max-w-2xl text-center">
        <h2 className="nn-heading text-balance text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.06] tracking-[-0.03em]">
          {finalCta.title}
        </h2>
        <p className="mx-auto mt-5 max-w-[42ch] text-[16px] leading-7 text-muted-foreground sm:text-[17px]">
          {finalCta.sub}
        </p>
        <div className="mt-9 flex justify-center">
          <a
            href="#download"
            className="group inline-flex items-center justify-center gap-2 rounded-md bg-primary px-7 py-3.5 text-[15px] font-medium text-primary-foreground shadow-[0_18px_44px_-14px_var(--color-primary)] transition-all duration-200 hover:brightness-110 active:scale-[0.98]"
          >
            <Download className="size-[18px]" aria-hidden />
            {finalCta.cta}
          </a>
        </div>
        <p className="nn-mono mt-5 text-[12px] text-muted-foreground/80">{finalCta.note}</p>
      </div>
    </section>
  );
}

/* ────────────────────────────────  Footer  ─────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-border/60 px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
        <Wordmark />
        <p className="nn-mono text-[12px] text-muted-foreground/70">
          Local-first · Obsidian-compatible · bring your own key
        </p>
      </div>
    </footer>
  );
}

/* ────────────────────────────────  Motion  ─────────────────────────────── */
// Screenshot-safe entrance: time-based load animation with fill-mode both, short
// delays, disabled under reduced-motion. No IntersectionObserver — below-fold
// content must never be left at opacity:0 in a full-page capture.
function ScopedStyles() {
  return (
    <style>{`
      @keyframes lp-rise {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: none; }
      }
      .lp-rise { animation: lp-rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both; }
      @media (prefers-reduced-motion: reduce) {
        .lp-rise { animation: none; }
      }
    `}</style>
  );
}
