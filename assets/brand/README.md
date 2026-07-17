# NeuralNote brand assets

Production raster assets derived from the approved note-tab identity board.

## Core assets

- `neuralnote-mark-violet.png` — primary transparent mark, 1024 px
- `neuralnote-mark-black.png` — dark monochrome mark, 1024 px
- `neuralnote-mark-white.png` — light monochrome mark, 1024 px
- `neuralnote-lockup-dark-bg.png` — violet mark with light wordmark
- `neuralnote-lockup-light-bg.png` — violet mark with dark wordmark
- `neuralnote-lockup-white.png` — all-white transparent lockup
- `neuralnote-lockup-black.png` — all-dark transparent lockup
- `neuralnote-wordmark-light.png` / `neuralnote-wordmark-dark.png` — standalone wordmarks
- `neuralnote-app-icon.png` — 1024 px rounded app icon with transparent corners
- `icons/` — app icon exports from 16–1024 px
- `marks/` — transparent mark exports from 16–1024 px

`preview.png` is a visual proof sheet. `reference-brand-board.png` preserves the original approved identity construction and remains a historical source; use the generated brand pack for current messaging. `build_assets.py` reproducibly derives the pack from a transparent master mark.

## Positioning

NeuralNote is an AI-powered knowledge assistant built on files the user owns.

Use this messaging hierarchy:

1. Primary tagline: `More knowledge, less setup.`
2. Supporting line: `Built for instant use.`
3. Category: `Your AI-powered knowledge assistant.`
4. Explainer: `A complete knowledge workflow, built on files you own.`
5. Trust message: `Every answer stays connected to your notes and sources.`
6. Compatibility proof: `Works with your existing Markdown vault.`

Public brand copy should make the product's ready-made workflow clear without naming or attacking a competitor. Do not use `zero setup`, `cited AI`, or `cited recall` as primary marketing language. Citations and source links are evidence that the assistant can be trusted, not the product category.

Technical documentation may describe the exact Obsidian-compatible Markdown, YAML, and vault contracts when that detail helps a user or contributor.

## Palette

- Violet: `#A879EF`
- Dark surface: `#29282B`
- Ink: `#201E22`
- Cream: `#F2EBDD`
- Soft white: `#EFEDF2`

Use the cream background for light-mode brand applications. Keep the mark's diagonal fold as negative space so it adopts the surface behind it.

## Typography

NeuralNote uses **Geist Variable** as a single-family system. It matches the approved wordmark's quiet, compact neo-grotesque character without turning the product into a decorative type exercise.

- Wordmark: Geist Medium, weight `500`, line height `1`, tracking from `-0.03em` to `-0.02em`.
- Display headings: Geist Medium, weight `500`, optical sizing enabled, line height from `0.98` to `1.05`, tracking no tighter than `-0.035em`.
- Body copy: Geist Regular, weight `400`, line height from `1.55` to `1.7`, with default tracking.
- Navigation and controls: Geist Medium, weight `500`. Use semibold only when hierarchy cannot be carried by size and colour.
- Avoid heavy `700+` weights, wide geometric tracking, and a second sans-serif family. The brand should feel calm and precise rather than loud.

On responsive web surfaces, render the symbol as an image but keep `NeuralNote` as live text. This preserves sharp type, accessibility, and layout flexibility. Use the baked PNG lockups only where live text is impossible.
