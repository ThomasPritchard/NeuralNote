import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  Download,
  FilePlus2,
  FolderOpen,
  Inbox,
  Lock,
  type LucideIcon,
  Quote,
  Sparkles,
} from "lucide-react";
import { BrandLockup } from "./BrandLockup";
import { finalCta, hero, loop, nav, pillars, privacy, why } from "./content";

/* ──────────────────────────────────────────────────────────────────────────
   LandingGradient — the "Gradient hero" direction.

   The boldest of the three landings: an animated, pure-CSS violet/indigo
   "aurora" hero (layered blurred radial blobs that drift + pulse), big
   expressive type, then the product payoff (a stylised cited-recall answer
   panel) further down. No 3D, no libraries — all motion is CSS keyframes.

   Rendered inside [data-direction="neuralnote"], so every colour is a token
   (bg-background / text-primary / bg-card / border-border …). Aurora colours
   are DERIVED from --primary via relative-oklch hue shifts, never hardcoded.
   ────────────────────────────────────────────────────────────────────────── */

// Decorative aurora blob — a soft radial fade derived from the brand violet.
// dl/dc override lightness/chroma for the glow; dh shifts hue (±) for the
// violet → indigo → magenta spread; a is alpha.
const blob = (dl: number, dc: number, dh: number, a: number) =>
  `radial-gradient(closest-side, oklch(from var(--primary) ${dl} ${dc} calc(h + ${dh}) / ${a}), transparent)`;

// Vivid violet→magenta sweep for the highlighted headline phrase.
const headlineSweep =
  "linear-gradient(102deg, oklch(from var(--primary) 0.84 0.13 calc(h - 26)), oklch(from var(--primary) 0.72 0.24 calc(h + 2)), oklch(from var(--primary) 0.78 0.2 calc(h + 34)))";

const sectionAnchors: Record<string, string> = {
  "How it works": "#how-it-works",
  "Cited recall": "#cited-recall",
  "Own your data": "#own-your-data",
};

export default function LandingGradient() {
  return (
    <div className="relative w-full overflow-x-hidden bg-background text-foreground">
      <Styles />

      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <TopNav />

      <main id="content">
        <Hero />
        <LoopSection />
        <PillarsSection />
        <WhySection />
        <PrivacySection />
        <FinalCtaSection />
      </main>

      <SiteFooter />
    </div>
  );
}

/* ──────────────────────────────── Aurora ──────────────────────────────────
   A clipped layer of large, blurred radial blobs that slowly drift + pulse.
   Used full-bleed behind the hero and (contained) inside the final CTA. */

function Aurora({ contained = false }: { contained?: boolean }) {
  return (
    <div className="lg-aurora pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/* violet core */}
      <span
        className="lg-blob lg-drift-a absolute left-[4%] top-[-16%] h-[48rem] w-[48rem] rounded-full blur-3xl motion-reduce:animate-none"
        style={{ background: blob(0.66, 0.23, 0, contained ? 0.52 : 0.68) }}
      />
      {/* indigo / blue, right side */}
      <span
        className="lg-blob lg-drift-b absolute right-[-10%] top-[-2%] h-[44rem] w-[44rem] rounded-full blur-3xl motion-reduce:animate-none"
        style={{ background: blob(0.6, 0.21, -32, contained ? 0.44 : 0.58) }}
      />
      {/* magenta wash, lower centre */}
      <span
        className="lg-blob lg-drift-c absolute bottom-[-24%] left-[26%] h-[48rem] w-[48rem] rounded-full blur-3xl motion-reduce:animate-none"
        style={{ background: blob(0.66, 0.24, 30, contained ? 0.36 : 0.5) }}
      />
      {/* bright pulsing highlight behind the headline */}
      <span
        className="lg-blob lg-pulse absolute left-1/2 top-[10%] h-[30rem] w-[30rem] -translate-x-1/2 rounded-full blur-3xl motion-reduce:animate-none"
        style={{ background: blob(0.8, 0.17, 8, contained ? 0.36 : 0.46) }}
      />
    </div>
  );
}

// Faint, edge-faded grid for texture under the hero text.
function GridTexture() {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden
      style={{
        backgroundImage:
          "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
        backgroundSize: "62px 62px",
        maskImage: "radial-gradient(ellipse 80% 70% at 50% 38%, #000 10%, transparent 72%)",
        WebkitMaskImage: "radial-gradient(ellipse 80% 70% at 50% 38%, #000 10%, transparent 72%)",
        opacity: 0.7,
      }}
    />
  );
}

/* ─────────────────────────────── Top nav ──────────────────────────────────
   Floating glass pill — wordmark · links · Download CTA. */

function TopNav() {
  return (
    <header className="fixed inset-x-0 top-3 z-50 px-4 sm:top-5">
      <nav
        aria-label="Primary"
        className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 rounded-full border border-border bg-background/55 px-3 py-2.5 pl-4 shadow-[0_18px_50px_-24px_oklch(from_var(--primary)_l_c_h_/_0.55)] backdrop-blur-xl"
      >
        <a href="#content" aria-label="NeuralNote">
          <BrandLockup size="md" />
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {nav
            .filter((item) => item !== "Download")
            .map((item) => (
              <a
                key={item}
                href={sectionAnchors[item] ?? "#content"}
                className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                {item}
              </a>
            ))}
        </div>

        <a
          href="#download"
          className="group inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-[0_10px_30px_-12px_var(--color-primary)] transition hover:opacity-95 active:scale-[0.98]"
        >
          <Download className="size-4" aria-hidden />
          Download
        </a>
      </nav>
    </header>
  );
}

/* ──────────────────────────────── Hero ────────────────────────────────────
   Cinematic centre: aurora behind, big headline (2–3 lines), two CTAs. */

function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-6 pb-28 pt-36 sm:pt-44 md:pb-40 md:pt-52">
      <Aurora />
      <GridTexture />
      {/* bottom fade so the aurora melts into the next chapter */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-background"
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col items-center text-center">
        <p className="lg-rise nn-mono inline-flex items-center gap-2 rounded-full border border-border bg-background/50 px-3.5 py-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          {hero.eyebrow}
        </p>

        <h1
          className="lg-rise nn-heading mt-7 max-w-5xl text-balance font-semibold leading-[0.95] tracking-tight"
          style={{ animationDelay: "80ms", fontSize: "clamp(2.75rem, 6.5vw, 5.25rem)" }}
        >
          The second brain that{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: headlineSweep, WebkitBackgroundClip: "text", backgroundClip: "text" }}
          >
            actually read
          </span>{" "}
          your sources.
        </h1>

        <p
          className="lg-rise mt-7 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg"
          style={{ animationDelay: "160ms" }}
        >
          {hero.sub}
        </p>

        <div
          className="lg-rise mt-10 flex flex-col items-center gap-3 sm:flex-row"
          style={{ animationDelay: "240ms" }}
        >
          <a
            href="#download"
            className="group inline-flex items-center justify-center gap-2 rounded-full bg-primary px-7 py-3.5 text-[15px] font-semibold text-primary-foreground shadow-[0_22px_60px_-18px_var(--color-primary)] transition hover:-translate-y-0.5 hover:opacity-95 active:translate-y-0"
          >
            <Download className="size-[18px]" aria-hidden />
            {hero.ctaPrimary}
          </a>
          <a
            href="#how-it-works"
            className="group inline-flex items-center justify-center gap-2 rounded-full border border-border bg-background/40 px-7 py-3.5 text-[15px] font-semibold text-foreground backdrop-blur transition hover:border-primary/50 hover:bg-accent/40"
          >
            {hero.ctaSecondary}
            <ArrowDown className="size-[18px] text-primary transition-transform group-hover:translate-y-0.5" aria-hidden />
          </a>
        </div>

        <p className="lg-rise nn-mono mt-7 text-[12px] text-muted-foreground/80" style={{ animationDelay: "320ms" }}>
          {hero.note}
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────────── The loop ───────────────────────────────────
   capture → distil → cite, three connected steps. */

const loopIcons = [FilePlus2, Sparkles, Quote];

function LoopSection() {
  return (
    <section id="how-it-works" className="relative px-6 py-24 md:py-32">
      <div className="mx-auto w-full max-w-6xl">
        <SectionHeading
          kicker="One opinionated loop"
          title="Throw it in. Get back a queryable brain."
          intro="No filing system to build, no plugins to wire. Three steps run on everything you capture."
        />

        <ol className="mt-14 flex flex-col gap-4 md:flex-row md:items-stretch md:gap-3">
          {loop.map((step, i) => {
            const Icon = loopIcons[i];
            return (
              <li key={step.step} className="contents">
                <div className="group relative flex-1 overflow-hidden rounded-3xl border border-border bg-card/70 p-7 transition-colors hover:border-primary/45">
                  <div
                    className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-2xl"
                    aria-hidden
                    style={{ background: blob(0.62, 0.2, i * 26 - 26, 0.3) }}
                  />
                  <div className="relative flex items-center justify-between">
                    <span className="grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/25 transition group-hover:scale-105">
                      <Icon className="size-6" aria-hidden />
                    </span>
                    <span className="nn-mono text-4xl font-semibold text-primary/25">{step.step}</span>
                  </div>
                  <h3 className="nn-heading mt-6 text-xl font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">{step.body}</p>
                </div>

                {i < loop.length - 1 && (
                  <div className="hidden shrink-0 items-center justify-center md:flex" aria-hidden>
                    <ArrowRight className="size-5 text-primary/45" />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ─────────────────────────────── Pillars ──────────────────────────────────
   Gapless bento (ported from the Galaxy direction). Cited-recall — the moat —
   is the large centrepiece and carries the "grounded in the exact source"
   mini-viz; the two table-stakes pillars fill the right column. Rendered in
   the Gradient token idiom (blob glows, border tokens) so it reads as one page. */

function PillarsSection() {
  const recall = pillars.find((p) => p.highlight)!;
  const rest = pillars.filter((p) => !p.highlight);

  return (
    <section id="cited-recall" className="relative px-6 py-24 md:py-32">
      {/* faint ambient glow behind the bento */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[34rem] w-[60rem] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        aria-hidden
        style={{ background: blob(0.6, 0.18, 6, 0.16) }}
      />
      <div className="mx-auto w-full max-w-6xl">
        <div className="max-w-2xl">
          <Eyebrow>Why it's different</Eyebrow>
          <h2 className="nn-heading mt-5 text-balance text-3xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
            Three things it gets right.
          </h2>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-3 lg:grid-rows-2">
          {/* centrepiece — the moat */}
          <article className="group relative flex flex-col overflow-hidden rounded-[1.6rem] border border-primary/35 bg-card/80 p-7 sm:p-9 lg:col-span-2 lg:row-span-2">
            <div
              className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full blur-3xl"
              aria-hidden
              style={{ background: blob(0.66, 0.22, 12, 0.32) }}
            />
            <div className="relative flex items-center gap-2.5">
              <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.2)]">
                <Quote className="size-5" aria-hidden />
              </span>
              <span className="nn-mono rounded-full bg-primary/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary ring-1 ring-inset ring-primary/25">
                The moat
              </span>
            </div>

            <h3 className="nn-heading relative mt-6 max-w-md text-2xl font-semibold leading-snug tracking-tight">
              {recall.title}
            </h3>
            <p className="relative mt-4 max-w-md text-[14.5px] leading-relaxed text-muted-foreground">{recall.body}</p>

            <GroundedSourceViz />
          </article>

          {/* the two table-stakes pillars fill the remaining column */}
          {rest.map((p) => {
            const Icon = p.key === "own" ? FolderOpen : Inbox;
            return (
              <article
                key={p.key}
                className="group relative flex flex-col overflow-hidden rounded-[1.6rem] border border-border bg-card/70 p-7 transition-colors hover:border-primary/40"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/20 transition group-hover:scale-105">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="nn-heading mt-5 text-lg font-semibold tracking-tight">{p.title}</h3>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted-foreground">{p.body}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// Illustrative retrieval visualisation — echoes the app's cited chat. Decorative
// (percentages are placeholder UI, not real data), so the whole block is hidden
// from assistive tech; the moat copy above carries the real message.
const vizSources = [
  { n: 1, src: "transcript", score: 96 },
  { n: 2, src: "article", score: 91 },
  { n: 3, src: "pdf", score: 84 },
];

function GroundedSourceViz() {
  return (
    <div
      className="relative mt-auto flex flex-col gap-5 rounded-2xl border border-border bg-background/55 p-4 backdrop-blur sm:p-5"
      aria-hidden
    >
      <p className="text-[13px] leading-relaxed text-foreground/90">
        Grounded in the exact source it came from
        <sup className="nn-mono mx-1 inline-grid size-4 -translate-y-px place-items-center rounded bg-primary/20 text-[10px] font-medium text-primary ring-1 ring-inset ring-primary/30">
          1
        </sup>
        — verified before you ever see it.
      </p>

      <div className="flex flex-col gap-2.5">
        {vizSources.map((c) => (
          <div
            key={c.n}
            className="flex items-center gap-3 rounded-xl bg-card/70 px-3 py-2 ring-1 ring-inset ring-border"
          >
            <span className="nn-mono grid size-5 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-medium text-primary">
              {c.n}
            </span>
            <span className="nn-mono w-20 shrink-0 truncate text-[11px] text-muted-foreground">{c.src}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/15">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary"
                style={{ width: `${c.score}%` }}
              />
            </div>
            <span className="nn-mono w-9 shrink-0 text-right text-[10px] text-primary">{c.score}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────── Why it beats Obsidian ────────────────────────────
   Editorial split (ported from the Galaxy direction): big heading left, the
   three honest points stacked right, each with a circular check. */

function WhySection() {
  return (
    <section id="own-your-data" className="relative px-6 py-24 md:py-32">
      <div
        className="pointer-events-none absolute left-[8%] top-1/3 -z-10 h-72 w-72 rounded-full blur-3xl"
        aria-hidden
        style={{ background: blob(0.6, 0.18, -10, 0.16) }}
      />
      <div className="mx-auto grid w-full max-w-6xl gap-12 md:grid-cols-[0.9fr_1.1fr] md:gap-20">
        <div>
          <Eyebrow>Leave nothing behind</Eyebrow>
          <h2 className="nn-heading mt-5 text-balance text-3xl font-semibold leading-[1.08] tracking-tight sm:text-4xl lg:text-[2.9rem]">
            {why.title}
          </h2>
        </div>

        <ul className="flex flex-col">
          {why.points.map((point) => (
            <li
              key={point}
              className="group flex items-start gap-5 border-t border-border py-6 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary/12 text-primary ring-1 ring-inset ring-primary/25 transition group-hover:scale-105">
                <Check className="size-4" aria-hidden />
              </span>
              <p className="text-pretty text-[16px] leading-relaxed text-foreground/90 sm:text-lg">{point}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ───────────────────────────── Honest privacy ─────────────────────────────
   Trust signal, stated up front — not fine print. */

function PrivacySection() {
  return (
    <section className="relative px-6 py-12 md:py-16">
      <div className="mx-auto w-full max-w-4xl">
        <article className="relative overflow-hidden rounded-[1.6rem] border border-border bg-card/60 p-8 md:p-10">
          <div
            className="pointer-events-none absolute -left-12 -top-12 h-48 w-48 rounded-full blur-3xl"
            aria-hidden
            style={{ background: blob(0.62, 0.18, -10, 0.22) }}
          />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-primary/30 bg-primary/12 text-primary">
              <Lock className="size-6" aria-hidden />
            </span>
            <div>
              <h2 className="nn-heading text-2xl font-semibold tracking-tight">{privacy.title}</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{privacy.body}</p>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

/* ─────────────────────────────── Final CTA ────────────────────────────────
   Centred closer (ported from the Galaxy direction): a "Start today" pill, the
   big headline, the sub, the Download button and the note, on a soft centred
   radial glow — no bordered panel. */

function FinalCtaSection() {
  return (
    <section id="download" className="relative scroll-mt-24 overflow-hidden px-6 py-28 md:py-40">
      {/* soft centred radial glow — bookends the hero aurora, layered for depth.
          Plain z-auto (not -z-10) so it paints above the page background, with
          the content lifted above it via z-10 — same layering as the hero. */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[42rem] w-[54rem] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        aria-hidden
        style={{ background: blob(0.62, 0.21, -6, 0.42) }}
      />
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[26rem] w-[32rem] max-w-[88vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        aria-hidden
        style={{ background: blob(0.82, 0.16, 14, 0.4) }}
      />
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
        <Eyebrow icon={Sparkles}>Start today</Eyebrow>

        <h2
          className="nn-heading mt-7 text-balance font-semibold leading-[1] tracking-tight"
          style={{ fontSize: "clamp(2.25rem, 5.5vw, 4rem)" }}
        >
          {finalCta.title}
        </h2>
        <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
          {finalCta.sub}
        </p>

        <a
          href="#download"
          className="group mt-10 inline-flex items-center justify-center gap-2 rounded-full bg-primary px-8 py-4 text-base font-semibold text-primary-foreground shadow-[0_26px_70px_-18px_var(--color-primary)] transition hover:-translate-y-0.5 hover:opacity-95 active:translate-y-0"
        >
          <Download className="size-5" aria-hidden />
          {finalCta.cta}
        </a>
        <p className="nn-mono mt-6 text-[12px] text-muted-foreground/80">{finalCta.note}</p>
      </div>
    </section>
  );
}

/* ──────────────────────────────── Footer ──────────────────────────────────── */

function SiteFooter() {
  return (
    <footer className="border-t border-border px-6 py-12">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <BrandLockup size="md" />
          <div>
            <p className="nn-mono text-[11px] text-muted-foreground">Free · local-first · bring your own key</p>
          </div>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {nav
            .filter((item) => item !== "Download")
            .map((item) => (
              <a
                key={item}
                href={sectionAnchors[item] ?? "#content"}
                className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {item}
              </a>
            ))}
          <a
            href="#download"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-primary transition-colors hover:opacity-80"
          >
            Download
            <ArrowRight className="size-3.5" aria-hidden />
          </a>
        </nav>
      </div>
    </footer>
  );
}

/* ─────────────────────────── Shared section bits ──────────────────────────── */

// Pill eyebrow — matches the hero's eyebrow pill exactly so the swapped Galaxy
// sections read as part of the same page.
function Eyebrow({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <span className="nn-mono inline-flex items-center gap-2 rounded-full border border-border bg-background/50 px-3.5 py-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur">
      {Icon ? (
        <Icon className="size-3.5 text-primary" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      )}
      {children}
    </span>
  );
}

function SectionHeading({ kicker, title, intro }: { kicker: string; title: string; intro: string }) {
  return (
    <div className="max-w-2xl">
      <p className="nn-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{kicker}</p>
      <h2 className="nn-heading mt-4 text-balance text-3xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
        {title}
      </h2>
      <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">{intro}</p>
    </div>
  );
}

/* ─────────────────────────────── Keyframes ────────────────────────────────
   Ambient aurora drift/pulse + on-load fade-up. No scroll-triggered reveals
   (the screenshot harness doesn't scroll). All motion off under reduced-motion. */

function Styles() {
  return (
    <style>{`
      @keyframes lg-drift-a { 0%,100% { transform: translate3d(0,0,0) scale(1); } 50% { transform: translate3d(6%,-4%,0) scale(1.12); } }
      @keyframes lg-drift-b { 0%,100% { transform: translate3d(0,0,0) scale(1.05); } 50% { transform: translate3d(-7%,5%,0) scale(0.94); } }
      @keyframes lg-drift-c { 0%,100% { transform: translate3d(0,0,0) scale(1); } 50% { transform: translate3d(4%,7%,0) scale(1.1); } }
      @keyframes lg-pulse   { 0%,100% { opacity: 0.4; transform: translate(-50%,0) scale(1); } 50% { opacity: 0.72; transform: translate(-50%,0) scale(1.14); } }
      @keyframes lg-rise    { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }

      .lg-drift-a { animation: lg-drift-a 22s ease-in-out infinite; }
      .lg-drift-b { animation: lg-drift-b 26s ease-in-out infinite; }
      .lg-drift-c { animation: lg-drift-c 30s ease-in-out infinite; }
      .lg-pulse   { animation: lg-pulse 9s ease-in-out infinite; }
      .lg-rise    { animation: lg-rise 0.7s cubic-bezier(0.22,1,0.36,1) both; }

      @media (prefers-reduced-motion: reduce) {
        .lg-drift-a, .lg-drift-b, .lg-drift-c, .lg-pulse, .lg-rise { animation: none !important; }
      }
    `}</style>
  );
}
