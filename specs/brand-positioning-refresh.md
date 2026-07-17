# NeuralNote brand positioning refresh

> Status: approved and implemented
> Scope: brand guidelines PDF, roadmap artwork, and the three landing-page prototypes

## Purpose

NeuralNote is an AI-powered knowledge assistant for people who want a useful system immediately without giving up open, portable files.

The public message should make the product feel simpler than assembling a knowledge workflow from plugins, templates, and detailed configuration. That comparison stays implicit. Public brand surfaces do not name a competitor or frame NeuralNote as an attack on another product.

## Messaging hierarchy

Use these lines consistently and in this order:

1. Primary tagline: `More knowledge, less setup.`
2. Supporting line: `Built for instant use.`
3. Category: `Your AI-powered knowledge assistant.`
4. Explainer: `A complete knowledge workflow, built on files you own.`
5. Product description: `Open your Markdown vault and start. NeuralNote helps you capture, organise, search and understand your knowledge without assembling the workflow yourself.`
6. Trust message: `Every answer stays connected to your notes and sources.`
7. Compatibility proof: `Works with your existing Markdown vault.`

The primary tagline is the most prominent line on campaign, landing, and roadmap surfaces. The supporting line should appear close enough to explain what "less setup" means, but it must not compete with the tagline.

## Product framing

NeuralNote is an AI assistant, not a citation product. Source links and verified references make the assistant trustworthy, but they are supporting evidence rather than the category name.

Prefer:

- AI-powered knowledge assistant
- answers connected to your notes and sources
- intelligent organisation
- ready-made workflow
- Markdown files you own
- useful from the moment you open a vault

Avoid in primary marketing copy:

- cited AI
- cited recall
- zero setup
- competitor names or direct comparison headings
- plugin-bashing language
- claims that every feature works without provider or account configuration

Detailed product sections may still explain citations, source verification, local storage, provider choice, and current platform limits.

## Tone

The voice is calm, useful, and direct. It should sound confident without picking a fight.

The contrast comes from outcomes:

- the workflow is already assembled
- sensible defaults make the product useful quickly
- the files remain open and portable
- the assistant helps the user understand what they have saved

Do not turn these into a forced list of slogans. Use the smallest set needed for each surface.

## Visual direction

The approved mark, lockups, palette, and typography stay unchanged. The new position is a messaging refresh, not a logo redesign.

Brand materials should express simplicity through:

- larger headline space
- fewer competing labels
- one clear violet action or signal
- short explanatory copy
- product imagery that shows a ready-to-use assistant rather than a configuration screen

The existing charcoal, cream, violet, Geist, Inter, and JetBrains Mono system remains authoritative.

## Brand pack changes

Update `assets/brand/README.md` with the messaging hierarchy, usage rules, and public comparison policy.

Update `assets/brand/build_brand_pack.py` so the generated PDF:

- uses `More knowledge, less setup.` on the cover
- uses `Built for instant use.` as the supporting promise
- describes NeuralNote as an AI-powered knowledge assistant
- replaces the old `Your notes. Your AI. Your choice.` promise
- replaces `The assembly is the product.` with simpler, customer-facing language
- retains the existing identity, colour, typography, application, asset-library, and product-family pages
- keeps source connection and verification as trust details

The output path remains `output/pdf/neuralnote-brand-pack.pdf`.

## Roadmap changes

Update the standalone roadmap at `output/brand/neuralnote-roadmap.png`.

The roadmap must:

- lead with `More knowledge, less setup.`
- include `Built for instant use.` in supporting copy
- keep NeuralNote Desktop as the foundation
- keep API Server, Cloud App, and CLI marked as planned
- keep Neural Voice separate as `Exploration / To be confirmed`
- avoid dates and release promises
- keep all product names and statuses exact

## Landing-page prototype changes

Apply the new message to all three landing directions:

- `?landing=galaxy`
- `?landing=product`
- `?landing=gradient`

Shared copy belongs in `prototype/neuralnote-proto/src/prototype/landing/content.ts` when every direction uses it. Direction-specific components should contain only the wording required by their distinct layout.

### Hero

Every landing hero should show:

- eyebrow: `Built for instant use.`
- headline: `More knowledge, less setup.`
- category or supporting copy: `Your AI-powered knowledge assistant.`
- explainer based on the approved product description
- primary action: `Download for desktop`
- secondary action: `See how it works`

The exact line breaks may differ by direction, but the words must not change.

### Product story

Rename the workflow and benefit sections so the AI assistant is the product and source connection is proof:

- `Capture anything`
- `Your assistant organises it`
- `Ask what you know`

The final step should explain that answers remain connected to notes and sources. It should not use `cited AI` or make `cited recall` the headline.

Replace direct comparison sections with a customer-centred section such as `Useful from the first vault`. Explain the ready-made workflow, owned Markdown files, and connected answers without naming a competitor.

### Final call to action

Use:

- title: `More knowledge, less setup.`
- supporting line: `Open your Markdown vault and start.`
- action: `Download for desktop`

The footer may state `AI-powered`, `Markdown-compatible`, `local-first`, and `bring your own key`. It must not name a competitor.

## Files in scope

- `assets/brand/README.md`
- `assets/brand/build_brand_pack.py`
- `specs/brand-positioning-refresh.md`
- `prototype/neuralnote-proto/src/prototype/landing/content.ts`
- `prototype/neuralnote-proto/src/prototype/landing/LandingGalaxy.tsx`
- `prototype/neuralnote-proto/src/prototype/landing/LandingProduct.tsx`
- `prototype/neuralnote-proto/src/prototype/landing/LandingGradient.tsx`
- `prototype/neuralnote-proto/scripts/brand-smoke.mjs`
- generated PDF, roadmap, prototype screenshots, and PDF render intermediates

No desktop application behaviour, Rust contract, generated binding, or production UI component is in scope.

## Verification

Use a red-green copy check in `brand-smoke.mjs` before changing the landing components. The test should fail against the old copy and pass after the refresh.

The final checks are:

```bash
npm --prefix prototype/neuralnote-proto run lint
npm --prefix prototype/neuralnote-proto run build
npm --prefix prototype/neuralnote-proto run test:brand
python3 -m py_compile assets/brand/build_brand_pack.py
python3 assets/brand/build_brand_pack.py
pdfinfo output/pdf/neuralnote-brand-pack.pdf
pdftoppm -png output/pdf/neuralnote-brand-pack.pdf tmp/pdfs/neuralnote-brand-pack
```

The landing test must cover galaxy, product, and gradient at mobile, tablet, and desktop widths. It must verify the approved tagline, confirm the old promise and direct competitor headings are absent, and retain the existing no-overflow and brand-mark checks.

Render every PDF page and inspect the latest contact sheet. Inspect the standalone roadmap at full resolution. Reject clipped text, overlaps, stale copy, unreadable labels, or inconsistent product status.

## Acceptance criteria

- All public brand surfaces use `More knowledge, less setup.` as the primary tagline.
- `Built for instant use.` appears as supporting copy.
- NeuralNote is described as an AI-powered knowledge assistant.
- Source links and citations are explained as trust evidence, not the product category.
- Public landing copy does not name a competitor or use a direct comparison heading.
- Visible copy does not claim literal zero setup.
- The existing logo, palette, typography, and product-roadmap structure remain intact.
- All three landing directions pass their responsive brand checks and have current screenshots.
- The PDF and roadmap pass structural and visual verification.
