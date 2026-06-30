import { useEffect, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  FolderOpen,
  Inbox,
  type LucideIcon,
  Play,
  Quote,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import GalaxyHero from "./GalaxyHero";
import { finalCta, hero, loop, nav, pillars, privacy, why, wordmark } from "./content";

/* ─────────────────────────────────────────────────────────────────────────
   Galaxy hero — premium, "expensive agency" marketing page for NeuralNote.
   Ethereal-glass vibe on the indigo brand: live 3D galaxy as the star, layered
   violet glows, glass nav + cards (double-bezel), spring motion, scroll reveals.
   Bolder than the app, same token family. Single scroll, no data-direction here.
   ──────────────────────────────────────────────────────────────────────── */

const SPRING = "cubic-bezier(0.32,0.72,0,1)";

// Scroll-reveal: fade-up-deblur as elements enter view. A safety timer force-
// reveals everything (covers no-scroll static capture + prefers-reduced-motion).
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const revealAll = () => els.forEach((el) => el.setAttribute("data-shown", ""));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      revealAll();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.setAttribute("data-shown", "");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" },
    );
    els.forEach((el) => io.observe(el));
    const t = window.setTimeout(revealAll, 2600); // static-capture safety net
    return () => {
      io.disconnect();
      window.clearTimeout(t);
    };
  }, []);
}

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      data-reveal
      style={{ transitionDelay: `${delay}ms`, transitionTimingFunction: SPRING }}
      className={`translate-y-8 opacity-0 blur-[6px] transition-[transform,opacity,filter] duration-[900ms] will-change-transform data-[shown]:translate-y-0 data-[shown]:opacity-100 data-[shown]:blur-[0px] ${className}`}
    >
      {children}
    </div>
  );
}

function Eyebrow({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <span className="nn-mono inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3.5 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.22em] text-primary backdrop-blur-md">
      {Icon ? (
        <Icon className="size-3" aria-hidden />
      ) : (
        <span
          className="size-1.5 rounded-full bg-primary shadow-[0_0_10px_2px_var(--color-primary)]"
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

// Island button with nested "button-in-button" trailing icon + spring physics.
function PrimaryCta({
  children,
  href = "#download",
  icon: Icon = ArrowUpRight,
  className = "",
}: {
  children: ReactNode;
  href?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <a
      href={href}
      style={{ transitionTimingFunction: SPRING }}
      className={`group inline-flex items-center gap-3 rounded-full bg-primary py-2 pl-6 pr-2 text-sm font-medium text-primary-foreground shadow-[0_14px_44px_-14px_var(--color-primary)] ring-1 ring-white/20 transition-[transform,box-shadow,background-color] duration-500 hover:shadow-[0_20px_56px_-12px_var(--color-primary)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${className}`}
    >
      <span className="py-1">{children}</span>
      <span
        style={{ transitionTimingFunction: SPRING }}
        className="grid size-9 place-items-center rounded-full bg-white/15 transition-transform duration-500 group-hover:-translate-y-px group-hover:translate-x-0.5 group-hover:scale-105"
      >
        <Icon className="size-4" aria-hidden />
      </span>
    </a>
  );
}

function GhostCta({
  children,
  href = "#how",
  icon: Icon = Play,
}: {
  children: ReactNode;
  href?: string;
  icon?: LucideIcon;
}) {
  return (
    <a
      href={href}
      style={{ transitionTimingFunction: SPRING }}
      className="group inline-flex items-center gap-2.5 rounded-full border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-medium text-foreground/90 backdrop-blur-md transition-[transform,background-color,border-color] duration-500 hover:border-white/20 hover:bg-white/[0.08] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <span
        style={{ transitionTimingFunction: SPRING }}
        className="grid size-5 place-items-center rounded-full bg-primary/20 text-primary transition-transform duration-500 group-hover:scale-110"
      >
        <Icon className="size-2.5 fill-current" aria-hidden />
      </span>
      {children}
    </a>
  );
}

// Soft violet light-source. Decorative, GPU-cheap (transform/opacity only).
function Glow({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute -z-0 rounded-full bg-primary/20 blur-[120px] ${className}`}
    />
  );
}

const loopIcons: LucideIcon[] = [Inbox, Sparkles, Quote];

export default function LandingGalaxy() {
  useReveal();

  return (
    <div className="relative w-full overflow-x-clip bg-background text-foreground antialiased [--sp:var(--color-primary)]">
      <a
        href="#main"
        className="sr-only z-[70] focus:not-sr-only focus:fixed focus:left-1/2 focus:top-4 focus:-translate-x-1/2 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* fine film grain over the whole document for a physical, costly feel */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[40] opacity-[0.035] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* ── Floating glass nav ─────────────────────────────────────────────── */}
      <header className="fixed left-1/2 top-5 z-50 w-[min(60rem,calc(100%-2rem))] -translate-x-1/2">
        <nav
          aria-label="Primary"
          className="flex items-center justify-between gap-4 rounded-full border border-white/10 bg-background/55 py-2 pl-3 pr-2 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.04] backdrop-blur-2xl"
        >
          <a href="#main" className="flex items-center gap-2.5 pl-1.5">
            <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_18px_-4px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.25)]">
              <Sparkles className="size-3.5" aria-hidden />
            </span>
            <span className="nn-heading text-[15px] font-semibold tracking-tight">{wordmark}</span>
          </a>

          <div className="hidden items-center gap-1 md:flex">
            {[
              { label: nav[0], href: "#how" },
              { label: nav[1], href: "#recall" },
              { label: nav[2], href: "#own" },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                style={{ transitionTimingFunction: SPRING }}
                className="rounded-full px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors duration-300 hover:bg-white/[0.06] hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </div>

          <PrimaryCta href="#download" icon={Download} className="shrink-0">
            <span className="hidden sm:inline">Download</span>
            <span className="sm:hidden">Get app</span>
          </PrimaryCta>
        </nav>
      </header>

      <main id="main">
        {/* ── Hero — the galaxy is the star ──────────────────────────────── */}
        <section className="relative flex min-h-[110svh] flex-col items-center justify-end overflow-hidden px-6 pb-[11vh] pt-40">
          {/* galaxy occupies the upper field so the headline gets its own stage */}
          <GalaxyHero className="absolute inset-x-0 top-0 h-[70%]" />

          {/* nebula ambiance — additive soft light enriching the field */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[6%] h-[26rem] w-[44rem] -translate-x-1/2 rounded-full bg-primary/25 opacity-70 blur-[130px] [mix-blend-mode:screen]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute left-[18%] top-[2%] h-72 w-72 rounded-full bg-[rgba(244,170,255,0.18)] blur-[120px] [mix-blend-mode:screen]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute right-[14%] top-[20%] h-72 w-72 rounded-full bg-primary/20 blur-[120px] [mix-blend-mode:screen]"
          />

          {/* scrims: nav legibility (top) + a clean dark stage for the copy (lower) */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-background to-transparent"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,transparent_36%,var(--background)_72%,var(--background)_100%)]"
          />

          <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
            <Reveal>
              <Eyebrow>{hero.eyebrow}</Eyebrow>
            </Reveal>

            <Reveal delay={90} className="mt-7">
              <h1 className="nn-heading text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.025em] text-foreground [text-shadow:0_2px_60px_rgba(123,92,255,0.45)] sm:text-6xl lg:text-[4.7rem]">
                {hero.headline}
              </h1>
            </Reveal>

            <Reveal delay={180} className="mt-6 max-w-2xl">
              <p className="text-base leading-relaxed text-foreground/75 sm:text-lg">{hero.sub}</p>
            </Reveal>

            <Reveal delay={260} className="mt-10">
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <PrimaryCta href="#download">{hero.ctaPrimary}</PrimaryCta>
                <GhostCta href="#how">{hero.ctaSecondary}</GhostCta>
              </div>
            </Reveal>

            <Reveal delay={340} className="mt-7">
              <p className="nn-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
                {hero.note}
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── The loop: capture → distil → cite ──────────────────────────── */}
        <section id="how" className="relative scroll-mt-28 px-6 py-28 sm:py-36">
          <Glow className="left-1/2 top-0 h-72 w-[40rem] -translate-x-1/2 opacity-60" />
          <div className="relative mx-auto max-w-6xl">
            <div className="mx-auto max-w-2xl text-center">
              <Reveal>
                <Eyebrow>How it works</Eyebrow>
              </Reveal>
              <Reveal delay={80} className="mt-6">
                <h2 className="nn-heading text-3xl font-semibold tracking-[-0.02em] sm:text-4xl lg:text-5xl">
                  One loop, from anything to answers.
                </h2>
              </Reveal>
              <Reveal delay={150} className="mt-5">
                <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
                  No filing, no plugins to wire up. Throw a source in and the work you'd never do by
                  hand is already done.
                </p>
              </Reveal>
            </div>

            <ol className="relative mt-20 grid gap-12 md:grid-cols-3 md:gap-7">
              {/* connector threading the three steps on desktop */}
              <span
                aria-hidden
                className="pointer-events-none absolute left-[16%] right-[16%] top-7 hidden h-px bg-gradient-to-r from-primary/10 via-primary/60 to-primary/10 shadow-[0_0_12px_0_var(--color-primary)] md:block"
              />
              {loop.map((s, i) => {
                const Icon = loopIcons[i];
                const isPayoff = i === loop.length - 1;
                return (
                  <Reveal key={s.step} delay={i * 120}>
                    <li className="flex flex-col items-center text-center">
                      <div
                        className={`relative z-10 mb-6 grid size-14 place-items-center rounded-2xl border ring-1 ${
                          isPayoff
                            ? "border-primary/40 bg-gradient-to-br from-primary to-primary/65 text-primary-foreground shadow-[0_0_34px_-6px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.25)] ring-white/10"
                            : "border-white/10 bg-card/70 text-primary shadow-[0_10px_30px_-16px_rgba(0,0,0,0.8),inset_0_1px_0_0_rgb(255_255_255/0.06)] ring-white/[0.04] backdrop-blur-xl"
                        }`}
                      >
                        <Icon className="size-6" aria-hidden />
                        <span className="nn-mono absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-background text-[9px] font-semibold text-primary ring-1 ring-primary/30">
                          {s.step}
                        </span>
                      </div>
                      <h3 className="nn-heading text-lg font-semibold tracking-tight">{s.title}</h3>
                      <p className="mt-2.5 max-w-[18rem] text-sm leading-relaxed text-muted-foreground">
                        {s.body}
                      </p>
                    </li>
                  </Reveal>
                );
              })}
            </ol>
          </div>
        </section>

        {/* ── Pillars — cited recall is the centrepiece ──────────────────── */}
        <section id="recall" className="relative scroll-mt-28 px-6 py-28 sm:py-36">
          <Glow className="right-0 top-1/4 h-80 w-80 opacity-50" />
          <div className="relative mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <Reveal>
                <Eyebrow>Why it's different</Eyebrow>
              </Reveal>
              <Reveal delay={80} className="mt-6">
                <h2 className="nn-heading text-3xl font-semibold tracking-[-0.02em] sm:text-4xl lg:text-5xl">
                  Three things it gets right.
                </h2>
              </Reveal>
            </div>

            <div className="mt-14 grid gap-5 lg:grid-cols-3 lg:grid-rows-2">
              <RecallCard />
              {pillars
                .filter((p) => !p.highlight)
                .map((p, i) => (
                  <Reveal key={p.key} delay={120 + i * 120} className="lg:col-span-1">
                    <PillarCard
                      icon={p.key === "own" ? FolderOpen : Inbox}
                      title={p.title}
                      body={p.body}
                    />
                  </Reveal>
                ))}
            </div>
          </div>
        </section>

        {/* ── Why it beats Obsidian — editorial split ────────────────────── */}
        <section id="own" className="relative scroll-mt-28 px-6 py-28 sm:py-36">
          <Glow className="left-0 top-1/3 h-72 w-72 opacity-40" />
          <div className="relative mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
            <div>
              <Reveal>
                <Eyebrow>Leave nothing behind</Eyebrow>
              </Reveal>
              <Reveal delay={80} className="mt-6">
                <h2 className="nn-heading text-3xl font-semibold leading-[1.08] tracking-[-0.02em] sm:text-4xl lg:text-[2.9rem]">
                  {why.title}
                </h2>
              </Reveal>
            </div>

            <ul className="flex flex-col">
              {why.points.map((point, i) => (
                <Reveal key={point} delay={i * 110}>
                  <li className="flex items-start gap-5 border-t border-white/10 py-6 first:border-t-0 first:pt-0">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
                      <Check className="size-3.5" aria-hidden />
                    </span>
                    <p className="text-base leading-relaxed text-foreground/85 sm:text-lg">{point}</p>
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Honest privacy — a trust signal, not fine print ────────────── */}
        <section className="relative px-6 pb-28 sm:pb-36">
          <div className="relative mx-auto max-w-5xl">
            <Reveal>
              <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] p-2 ring-1 ring-white/[0.04]">
                <div className="relative overflow-hidden rounded-[1.6rem] bg-card/55 px-8 py-10 backdrop-blur-xl sm:px-12 sm:py-14">
                  <Glow className="-right-10 -top-10 h-56 w-56 opacity-50" />
                  <div className="relative flex flex-col gap-7 lg:flex-row lg:items-start lg:gap-12">
                    <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow-[0_0_34px_-6px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.25)]">
                      <ShieldCheck className="size-7" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <Eyebrow icon={ShieldCheck}>Honest privacy</Eyebrow>
                      <h2 className="nn-heading mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">
                        {privacy.title}
                      </h2>
                      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                        {privacy.body}
                      </p>
                      <div className="mt-7 flex flex-wrap gap-2.5">
                        {["Files stay on disk", "You pick the providers", "Fully-local AI later"].map(
                          (chip) => (
                            <span
                              key={chip}
                              className="nn-mono rounded-full border border-white/10 bg-background/40 px-3 py-1.5 text-[11px] text-foreground/75"
                            >
                              {chip}
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── Final CTA ──────────────────────────────────────────────────── */}
        <section id="download" className="relative scroll-mt-28 overflow-hidden px-6 py-32 sm:py-40">
          <Glow className="left-1/2 top-1/2 h-[34rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 opacity-70" />
          <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
            <Reveal>
              <Eyebrow icon={Sparkles}>Start today</Eyebrow>
            </Reveal>
            <Reveal delay={90} className="mt-7">
              <h2 className="nn-heading text-4xl font-semibold leading-[1.05] tracking-[-0.025em] text-foreground [text-shadow:0_2px_60px_rgba(123,92,255,0.45)] sm:text-5xl lg:text-6xl">
                {finalCta.title}
              </h2>
            </Reveal>
            <Reveal delay={170} className="mt-6 max-w-xl">
              <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">{finalCta.sub}</p>
            </Reveal>
            <Reveal delay={250} className="mt-10">
              <PrimaryCta href="#download" icon={Download}>
                {finalCta.cta}
              </PrimaryCta>
            </Reveal>
            <Reveal delay={320} className="mt-6">
              <p className="nn-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
                {finalCta.note}
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="relative border-t border-white/10 px-6 py-12">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
            <a href="#main" className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[0_0_18px_-4px_var(--color-primary)]">
                <Sparkles className="size-3.5" aria-hidden />
              </span>
              <span className="nn-heading text-[15px] font-semibold tracking-tight">{wordmark}</span>
            </a>
            <p className="nn-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
              macOS · Windows · Linux — free, local-first, BYO key
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}

/* ── Cited-recall centrepiece: the moat, made visible ─────────────────────── */

function RecallCard() {
  const recall = pillars.find((p) => p.highlight)!;
  return (
    <Reveal className="lg:col-span-2 lg:row-span-2">
      <article className="group relative h-full overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] p-2 ring-1 ring-white/[0.04]">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[1.6rem] bg-gradient-to-b from-primary/[0.10] via-card/60 to-card/60 p-7 backdrop-blur-xl sm:p-9">
          <Glow className="-left-8 -top-12 h-60 w-60 opacity-60" />
          <div className="relative flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow-[0_0_30px_-6px_var(--color-primary),inset_0_1px_0_0_rgb(255_255_255/0.25)]">
              <Quote className="size-5" aria-hidden />
            </span>
            <span className="nn-mono rounded-full border border-primary/25 bg-primary/12 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-primary">
              The moat
            </span>
          </div>

          <h3 className="nn-heading relative mt-6 max-w-md text-2xl font-semibold leading-snug tracking-tight sm:text-[1.7rem]">
            {recall.title}
          </h3>
          <p className="relative mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            {recall.body}
          </p>

          {/* illustrative retrieval visualisation — echoes the app's cited chat */}
          <div
            aria-hidden
            className="relative mt-auto rounded-[1.4rem] border border-white/10 bg-black/25 p-2 ring-1 ring-white/[0.04]"
          >
            <div className="rounded-[1.05rem] border border-white/[0.06] bg-card/70 p-4 backdrop-blur-md sm:p-5">
              <p className="text-sm leading-relaxed text-foreground/85">
                Grounded in the exact source it came from
                <sup className="nn-mono mx-1 inline-grid size-4 -translate-y-px place-items-center rounded bg-primary/20 text-[10px] font-medium text-primary ring-1 ring-inset ring-primary/30">
                  1
                </sup>
                — verified before you ever see it.
              </p>
              <div className="mt-5 flex flex-col gap-2.5">
                {[
                  { n: 1, src: "transcript", loc: "12:04", score: 96 },
                  { n: 2, src: "article", loc: "¶ 7", score: 91 },
                  { n: 3, src: "pdf", loc: "p. 4", score: 84 },
                ].map((c) => (
                  <div
                    key={c.n}
                    className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-background/40 px-3 py-2"
                  >
                    <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-medium text-primary">
                      {c.n}
                    </span>
                    <span className="nn-mono w-20 shrink-0 truncate text-[11px] text-muted-foreground">
                      {c.src}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/12">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary"
                        style={{ width: `${c.score}%` }}
                      />
                    </div>
                    <span className="nn-mono w-8 shrink-0 text-right text-[10px] text-primary">
                      {c.score}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </article>
    </Reveal>
  );
}

/* ── Supporting pillar card ───────────────────────────────────────────────── */

function PillarCard({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <article
      style={{ transitionTimingFunction: SPRING }}
      className="group h-full rounded-[1.6rem] border border-white/10 bg-white/[0.025] p-2 ring-1 ring-white/[0.03] transition-transform duration-500 hover:-translate-y-1"
    >
      <div className="flex h-full flex-col rounded-[1.25rem] bg-card/55 p-6 backdrop-blur-xl">
        <span className="grid size-11 place-items-center rounded-xl border border-white/10 bg-background/50 text-primary shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06)]">
          <Icon className="size-5" aria-hidden />
        </span>
        <h3 className="nn-heading mt-5 text-lg font-semibold tracking-tight">{title}</h3>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </article>
  );
}
