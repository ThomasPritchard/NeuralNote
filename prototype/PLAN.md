# NeuralNote — Design Prototype Plan

> Throwaway design exploration. Answers: **"What should the NeuralNote app workspace look and feel like?"**
> Artifact = one route, N variants, switchable via `?variant=` + floating bottom bar (prototype skill, UI branch, sub-shape B).

## Decisions (from interview)
- **Surface:** App workspace first (3-pane: vault tree · note/source reader · cited chat). Landing page = queued fast-follow.
- **Stack:** Vite + React + TS + Tailwind + shadcn/ui (copy-in components = "bake the lib in" approach).
- **Directions (6):**
  1. Dark + sage-green (Eden)
  2. Obsidian-native dark (dense, functional)
  3. Warm cream + bold type (Collective OS)
  4. Purple dashboard (Deepflow)
  5. TBD — from styles.refero.design
  6. TBD — from styles.refero.design
- Each direction gets its own structural personality, not just a reskin (prototype skill: variants must differ structurally).

## Phases
- [x] R1. Research refero.design → picked 5=Linear ("midnight command deck"), 6=Vercel ("graph paper")
- [x] R2. Look at refs — eden.so (dark sage) extracted; bridgemind.ai 403'd (vibe-coding tool, covered by Obsidian/Linear)
- [x] R3. Context7 — confirmed Tailwind v4 (`@tailwindcss/vite` + `@import`, no config) + shadcn new-york. Locked: Vite 8.1, React 19.2, Tailwind 4.3.2
- [x] B1. Scaffolded; mock.ts; themes.css (6 token blocks); PrototypeSwitcher; PrototypeRoute (?variant=, ←/→)
- [x] B2. design.md written (tokens + structural brief per direction)
- [x] B3. 6 directions built (Eden reference + 5 delegated to parallel ui-designer agents). All distinct.
- [x] V1. All 6 verified in browser (shots/*.png) + contact-sheet.png assembled
- [x] V2. Verification done: tsc -b clean; agents stayed in-lane; memory dir untouched; citations intact in all 6. Verdict scaffold in NOTES.md. (No heavy pr-review — throwaway code; high-stakes hook was a false positive.)
- [ ] NEXT. Tom picks a direction → build 3D Three.js neural-galaxy in that skin (backlog below)

## Verification harness
`cd neuralnote-proto && node scripts/shoot.mjs [ids…]` → `shots/<id>.png`. Dev server: `npm run dev` (:5173).
Eden reference shot confirmed: 3-pane, sage palette, cited chat with [1][2][3] → source cards w/ locators.

## Backlog / next prototype — 3D "neural galaxy" graph (Tom, mid-session)
Past Obsidian's flat 2D graph: a **Three.js 3D neural map**. Notes = nodes/neurons in 3D space,
edges = **AI-inferred semantic links** (spec already does semantic auto-linking → shows connections
the user never drew). Interactive: orbit (click-drag rotate), zoom in/out "like a galaxy", click a
node to focus, search to filter/fly-to. Skinned in **one chosen design direction** (its palette
applied to node/edge/glow colours + chrome).
- **Sequencing (Tom's framing):** finish the 6 → Tom picks a direction → THEN build this in that skin.
  Separate throwaway prototype route, NOT a 7th theme variant.
- **Tech (confirmed vs Context7):** `react-force-graph-3d` (Vasturiano; Three.js + d3-force-3d).
  API: `<ForceGraph3D graphData={{nodes,links}} nodeAutoColorBy backgroundColor onNodeClick>`,
  camera focus via `fgRef.current.cameraPosition({x,y,z}, lookAt, ms)`, `controlType` orbit/trackball/fly.
  Add `three` + `three-spritetext` (labels) + an UnrealBloom pass for the galaxy glow. Skin =
  chosen `neuralnote` palette (indigo bg, violet/sage nodes). `react-three-fiber` is the fallback
  if bespoke control is needed. Separate throwaway route, gated on Tom approving the chosen direction.
- **Data:** expand mock into a node+edge graph (~30–60 nodes, semantic-similarity edges, clusters
  per folder/topic) so the galaxy reads as a real second brain.

## Landing-page round (IN PROGRESS) — marketing surface, "app first" fast-follow
Interview answers: **3 directions to compare** · each anchored by a **different hero** (galaxy /
product screenshot / abstract gradient) · **bolder** take on the chosen indigo brand · **honest copy
only** (no fake testimonials/logos/user-counts).
- Surface: `?landing=<galaxy|product|gradient>` in PrototypeRoute (precedence: landing > galaxy >
  variant), wrapped in `data-direction="neuralnote"`, scrollable. `LandingSwitcher` cycles the 3 + exit.
- Shared honest copy: `src/prototype/landing/content.ts` (hero/problem/loop/pillars/why/privacy/finalCta).
  Cited recall flagged `highlight:true` = the moat centrepiece on every page.
- `GalaxyHero.tsx` = reusable auto-rotating galaxy bg (extracted `makeNodeObject` → `galaxy/orb.ts`,
  shared with NeuralGalaxy). pointer-events-none, fills parent.
- Build: 3 parallel ui-designer agents, one file each (LandingGalaxy/Product/Gradient.tsx), distinct
  taste skills (high-end-visual-design / minimalist-ui / gpt-taste) for genuine variation.
- shoot.mjs extended: `landing-<id>` → full-page shot (galaxy waits 4.5s for WebGL).
- [x] 3 landings built + reviewed. Tom's verdict: **base = gradient (aurora hero)**, with 3 sections
  swapped in from galaxy — Pillars ("Three things it gets right." + THE MOAT 96/91/84% viz), Why
  ("LEAVE NOTHING BEHIND" check-circles), Final CTA ("START TODAY" + radial glow). Hero/loop/privacy/
  nav kept from gradient. Combined lives at `?landing=gradient` (LandingGradient.tsx). tsc 0 + shot verified.
  Galaxy reveal logic stripped on merge; orphaned code pruned (noUnusedLocals). `?shot=1` hides dev chrome.
- [ ] Optional polish offered: unify loop kicker to pill eyebrow (plain-text vs pill rhythm). Awaiting Tom.

## Workspace tweak backlog (Tom's running list)
- [x] **File tree → VSCode-style.** DONE. Recursive nested tree in `neuralnote` FileTree: twisties,
  indent guides, 3-level nesting (Research › Papers › Foundational › active note), folder/file icons,
  per-folder counts, selection ring, collapse/expand state. Added `vaultTree` to mock additively
  (flat `vault` untouched → other 5 directions unaffected). tsc clean, render verified.

## Galaxy build — DONE (verify interactions live)
Built `?galaxy=1` (ribbon Graph view → galaxy; back button returns). react-force-graph-3d + three +
UnrealBloom (strength 0.7 / radius 0.45 / threshold 0.35 after taming a blowout), zoomToFit on
engine-stop. 5 colour-coded clusters, 9 glowing cross-cluster bridges, hover tooltip, click → camera
focus + detail panel, search → fly-to. tsc clean; render verified via screenshot. NOT auto-verified:
orbit/zoom/click/search interactions (need live drive) + bloom feel on real GPU (shot used swiftshader).

## Galaxy build — definition of done
- Separate throwaway surface (`?galaxy=1`), reached from the chosen workspace's ribbon "Graph view".
- 3D force graph: notes = nodes, AI-inferred semantic links = edges; ~50 nodes clustered by topic.
- Skinned in `neuralnote` (indigo bg, violet/accent nodes, bloom glow → "galaxy").
- Interactive: orbit-drag, scroll-zoom, click node → camera focus + detail panel, search → fly-to/filter.
- Tech: react-force-graph-3d + three + three-spritetext (+ UnrealBloom if clean). Verify via screenshot
  (note: headless WebGL via swiftshader; if capture is unreliable, rely on live dev server).

## Contract for direction components (so parallel builds don't diverge)
- Each direction = `src/prototype/directions/Direction<Name>.tsx`, default-exports a component taking `{ data }` (shared mock vault).
- Free to own its full layout (no shared `<Layout>` — prototype skill). May share dumb primitives + mock data only.
- Self-contained styling via Tailwind classes / CSS vars scoped to the variant root.
