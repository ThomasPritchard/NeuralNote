# NeuralNote — design directions

Six aesthetic directions for the **app workspace** (not the marketing site — that's a queued
fast-follow). Each is a runnable theme in the prototype, switchable live via the floating bar or
`?variant=<id>`. This doc is the source of truth for tokens; `src/prototype/themes.css` is the
codified version.

> Inputs: Obsidian (structure), eden.so + Collective OS + Deepflow + AI-tools refs (look), and two
> picks from styles.refero.design — **Linear** ("midnight command deck") and **Vercel**
> ("prismatic monolith on graph paper").

## What every direction must show (so they're comparable)

The same NeuralNote workspace, rendered six ways. Non-negotiable elements — these encode the
product thesis (own your vault, throw anything in, **cited recall**):

1. **Vault sidebar** — app mark, a capture entry ("throw anything in"), search, the folder→note
   tree (`vault`).
2. **Reader** — the open note (`openNote`): title, source-type + url, tags, AI-distilled summary,
   key claims, **and access to the retained full source** (transcript chunks with locators). Full
   source is the moat — it must be visible, not hidden.
3. **Cited chat** — the hero. The `chatThread`: a question and an answer with inline `[n]` markers
   that map to **citation cards** (note title + locator like `04:12` / `p.3` + snippet). A wrong
   citation is worse than no answer, so citations must read as first-class, jump-to-able.
4. **Capture affordance** — the "paste a link / drop a PDF / brain-dump" entry + recent captures.

What each direction is free to change: layout (2- vs 3-pane, where chat lives — rail / dock /
overlay), density, type scale, chrome, motion. **Differ structurally, not just by colour.**

## Shared implementation contract

- One file per direction: `src/prototype/directions/<Name>.tsx`, `export default`, no props,
  imports data from `../mock`.
- Root element fills the themed wrapper: `<div className="flex h-full w-full bg-background text-foreground">`.
  Do **not** set `data-direction` — the route applies it.
- Style via shadcn **semantic** Tailwind classes (`bg-background`, `bg-card`, `bg-sidebar`,
  `text-primary`, `text-muted-foreground`, `border-border`, `ring-border`, `rounded-lg`…). They
  resolve against the active direction's tokens automatically.
- Fonts: default body inherits `--font-sans`; use `.nn-heading` for display and `.nn-mono` for
  monospace (locators, ids, metadata).
- Icons: `lucide-react`. **No brand icons exist** (trademark) — use `Video` for youtube sources.
- Primitives available: `@/components/ui/{button,card,input,badge,separator,scroll-area,avatar,tabs,tooltip,textarea}`.

---

## The six directions

### 1 · Eden — `eden` (built, reference)
**Soul:** warm-dark, soft sage, calm & spacious. Premium and quiet — focus-first.
**Palette:** bg `oklch(0.18 .008 155)` near-black w/ green tint · primary sage `oklch(0.83 .07 150)`
· muted-fg `oklch(0.66 .015 150)`. Radius `0.85rem`. Font Inter.
**Structure:** roomy 3-pane (sidebar · reader · chat rail). Lots of whitespace, rounded-2xl cards,
pill capture button. Chat is a focused right rail.

### 2 · Obsidian-native — `obsidian`
**Soul:** dense, functional, low-chrome — the "refugee feels at home" bet. Faithful to Obsidian's
information density, cleaned up.
**Palette:** neutral grey bg `oklch(0.21 0 0)` · purple primary `oklch(0.62 .18 292)` · borders
visible `oklch(1 0 0 / 10%)`. Radius tight `0.35rem`. Font Inter + JetBrains Mono.
**Structure:** classic Obsidian — far-left thin **icon ribbon**, then a **file tree** with
disclosure triangles, a **tab bar** atop the reader, and a **status bar** along the bottom
(word count, backlinks, sync dot). Chat docked as a right "plugin" pane. Compact spacing, small
text, more rows visible. This one should look *busy and capable*, not airy.

### 3 · Collective OS — `collective`
**Soul:** warm cream paper, heavy editorial display type. Distinctive, magazine-like — the
contrarian "second brain as a publication" take.
**Palette:** cream bg `oklch(0.96 .014 88)` · near-black primary `oklch(0.2 .005 60)` (black pill
nav/buttons) · muted-fg warm grey. Radius large `1.1rem`. Heading **Archivo** (800–900), body Inter.
**Structure:** light, editorial. A **black pill top-nav** (à la Collective OS). Oversized Archivo
note title. Generous measure on the body. Consider chat as a **bottom command dock** that reads
like an editor's note rather than a chat app, or a distinct warm-paper right column. Big type
contrast; let it feel printed.

### 4 · Deepflow — `deepflow`
**Soul:** dark indigo dashboard, data-viz chrome. Leans "AI SaaS tool" — show the machinery.
**Palette:** very dark indigo bg `oklch(0.16 .02 282)` · vivid violet primary `oklch(0.62 .21 288)`
· cards `oklch(0.2 .025 282)`. Radius `0.7rem`. Font Inter + JetBrains Mono for figures.
**Structure:** dashboard. A **top metrics row** of stat cards (notes, sources, tokens embedded,
citations served). The chat panel visualises **retrieval** — show which chunks were pulled with
little relevance bars / a "3 sources retrieved" header. More chrome, gradient accent on primary,
chart-like flourishes. Feels like an analytics product that happens to hold your brain.

### 5 · Linear — `linear`
**Soul:** cool zinc command deck, crisp single accent, refined density. The benchmark
productivity-tool feel — precise, keyboard-first, expensive-quiet.
**Palette:** zinc-black bg `oklch(0.155 .004 270)` · indigo primary `oklch(0.6 .16 277)` (Linear
#5e6ad2) · hairline borders `oklch(1 0 0 / 7%)`. Radius `0.5rem`. Font Inter, tight tracking, small.
**Structure:** a **⌘K command bar** as the hero affordance. Glassy top header with breadcrumb +
keyboard hints (`⌘K`, `↵`). Vault as a tight, Linear-issues-style list (status dots, dense rows).
Chat as a refined right rail with a "context" chip row showing what's in scope. Everything a notch
denser and more precise than Eden; restraint over decoration.

### 6 · Vercel — `vercel`
**Soul:** monochrome on graph paper, sharp & geometric. High-contrast, engineered, the outlier.
**Palette:** near-white bg `oklch(0.985 0 0)` · pure-black primary/foreground `oklch(0.13 0 0)` ·
graph-paper grid via `--grid` `oklch(0.13 0 0 / 6%)`. Radius sharp `0.25rem`. Font **Geist** +
**Geist Mono**.
**Structure:** **graph-paper grid background** behind content (use `--grid`, e.g. a CSS
`linear-gradient` grid). Crisp **1px black dividers**, geometric panels, no soft shadows.
**Uppercase Geist Mono micro-labels** on sections and metadata. High contrast black-on-white.
Black primary buttons with square-ish corners. Make it feel like documentation / a design system —
monolithic and exact. (Only light direction alongside Collective — provides relief from the four
dark ones.)

---

## How to view

```bash
cd prototype/neuralnote-proto && npm run dev   # → http://localhost:5173
```
Flip directions with the bottom bar or `?variant=<id>`; `←/→` cycle. Screenshot all six with
`node scripts/shoot.mjs` (writes `shots/<id>.png`).
