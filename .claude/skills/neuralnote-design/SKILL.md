---
name: neuralnote-design
description: >-
  NeuralNote's design system — the locked dark-indigo/violet "neuralnote" theme,
  its tokens, type, and component conventions. Use this whenever you build,
  style, review, or refine ANY UI in this repo (a component, pane, panel, modal,
  screen, composer, or any Tailwind/markup work), even when the user doesn't say
  "design system". It is the PROJECT design layer that pairs with a taste skill +
  frontend-design, and it names the exact tokens to use so you never introduce an
  off-palette colour or drift from the established look.
---

# NeuralNote Design System

One locked theme: **"neuralnote"** — a dark indigo ground with a **violet
accent** ("Deepflow skin on Obsidian bones"). Dark only; there is no light theme.
Calm, dense, content-first — an Obsidian-grade workspace, not a marketing page.

**Source of truth:** `app/desktop/src/styles.css`. Read it before styling — the
tokens below are the map, that file is the territory. If they disagree, the file
wins and this skill is stale.

## The one rule

**Use only the theme tokens. Introduce no new colours, no raw hex, no ad-hoc
oklch.** Every colour in the UI must resolve to a token below. This is what keeps
the app coherent and the violet accent meaningful — an off-palette colour reads
as a bug. When a design needs a shade that isn't a token, that's a signal to
reach for an existing token (e.g. `muted`, `accent`) or to discuss adding one to
`styles.css`, not to inline it.

## Tokens → Tailwind utilities

`styles.css` maps CSS custom properties to Tailwind v4 utilities via
`@theme inline`. Reach for the utility, which reads the token:

| Role | Token | Utility |
|---|---|---|
| Page ground | `--background` (oklch 0.16, indigo) | `bg-background` |
| Body text | `--foreground` (0.93) | `text-foreground` |
| Raised surface | `--card` / `--popover` | `bg-card` / `bg-popover` |
| **Accent / action** | `--primary` (oklch 0.62 0.21 288, violet) | `bg-primary` / `text-primary` |
| Quiet fill | `--secondary` / `--muted` | `bg-secondary` / `bg-muted` |
| Secondary text | `--muted-foreground` | `text-muted-foreground` |
| Highlight | `--accent` | `bg-accent` / `text-accent-foreground` |
| Error / destructive | `--destructive` (red) | `text-destructive` / `bg-destructive` |
| Hairlines | `--border` (low white-opacity) | `border-border` |
| Inputs | `--input` / `--ring` | `bg-input` / `ring-ring` |
| Left rail | `--sidebar-*` set | `bg-sidebar`, `text-sidebar-foreground`, … |

Radius comes from `--radius` (0.5rem) via `rounded-sm|md|lg|xl|2xl`.

## Type

- **Inter Variable** — UI + body. `--font-sans` (default), or `.nn-heading` for
  headings.
- **JetBrains Mono Variable** — code, paths, line-ranges, IDs. `.nn-mono`
  (ligatures off) or `--font-mono`. Reach for mono to make file paths and
  `Note.md:12–28` citations scannable.

## Baseline behaviours (already global — don't re-implement)

- `@layer base { * { border-color: var(--border) } }` — every element's default
  border colour is the theme hairline, so `border`/`border-t` need no colour.
- Thin, theme-tinted scrollbars are set globally.
- `body` is already `bg-background` / `text-foreground` / antialiased Inter.

## Component conventions

Match the established idiom before inventing one — read the neighbour:

- Reading/rendering markdown → `Markdown.tsx`. Reader shell → `Reader.tsx`.
- Search results → `SearchPanel.tsx`. Left rail / toolbar → `Ribbon.tsx`.
- The AI chat surface → `ChatPane.tsx`, `ChatMessages.tsx`, `KeySetupPanel.tsx`
  (the "harness feel": search/read/verify step rows, source chips, coverage).
- All in `app/desktop/src/workspace/`.
- Merge classes with the `cn` util: `import { cn } from "../lib/cn"` (`src/lib/cn.ts`).
- The right-hand tool pane idiom is `<aside className="… w-[380px] shrink-0">`.

## How this fits the routing

This is the **project design layer**. The global UI workflow layers three owners:
**this skill** sets tokens/voice → **one taste skill** sets the aesthetic
(`minimalist-ui` fits the calm dense workspace) → **frontend-design** owns the
build process + restraint. **Execution belongs to the `ui-designer` agent — never
a bare `coder` for presentational `.tsx`/CSS** (the global deploying-subagents
hard routing rule; split mixed logic+UI). Brief that agent with this skill.
