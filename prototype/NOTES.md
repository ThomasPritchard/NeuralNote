# Prototype verdict — NeuralNote app workspace

**Question this prototype answers:** What should the NeuralNote app workspace look and feel like?
Six directions, same vault data, switchable live (`?variant=` + `←/→`).

## Status: 6/6 built & verified
- All six render correctly at 1440×900 (see `neuralnote-proto/shots/*.png` + `contact-sheet.png`).
- `npx tsc -b` clean (exit 0). Agents stayed in their own files; shared files + memory dir untouched.
- Every direction preserves the moat: cited chat with inline `[n]` → citation cards carrying real
  locators (`04:12` / `07:48` / `p.3`), and the retained full-source transcript is visible.

## Verification scope (deliberate)
This is throwaway prototype code (prototype skill: no tests/abstractions). Verification = visual
(6 screenshots reviewed by eye) + typecheck + scope/diff check. A full pr-review pass was NOT run:
not warranted for disposable variant components, and the high-stakes hook signal (auth/money/data)
is a false positive here — no such surface exists.

## Decision: Deepflow skin + Obsidian-native UX (Tom, chosen)
Winner = a synthesis, built as variant #7 `?variant=neuralnote`:
- **Skin from Deepflow (#4):** dark indigo palette, violet accent, the chat retrieval viz (MATCH % bars).
- **UX/bones from Obsidian-native (#2):** icon ribbon, dense file tree, tab bar, docked chat pane, status bar.
- **Cut:** the top metrics/stats band (vanity chrome) — give the note + cited chat the reclaimed room.
Originals #1–6 kept for reference for now.

**Built & verified** (`?variant=neuralnote`, default): tsc -b clean; screenshot confirms indigo skin +
Obsidian bones, stats band gone, reader + chat roomy, retrieval viz (MATCH% bars) visible at rest.
Ribbon already carries a "Graph view" entry — front door for the 3D neural galaxy.

Then: build the **3D Three.js neural-galaxy** graph prototype in the chosen skin (see PLAN.md backlog).
Note: a glowing 3D node cloud reads best on a DARK backdrop → favours Eden / Linear / Deepflow over
the two light directions (Collective / Vercel).

## CHOSEN — final design directions (Tom, locked)
The two surfaces Tom has committed to for NeuralNote:

1. **App workspace** = `?variant=neuralnote` — Deepflow indigo skin + Obsidian-native UX, stats band cut,
   VSCode-style nested file tree, "Graph view" → the 3D neural galaxy (`?galaxy=1`). (Detail above.)
2. **Landing page** = `?landing=gradient` — gradient/aurora hero (option 3) as the base, with three
   sections swapped in from the galaxy direction (option 1): Pillars ("Three things it gets right." +
   THE MOAT 96/91/84% viz), Why ("LEAVE NOTHING BEHIND" check-circles), Final CTA ("START TODAY" +
   radial glow). Hero / loop / privacy / nav kept from gradient. Honest copy only (no fake proof).

Both verified (tsc -b clean + full-page screenshots reviewed). These are the directions to carry into
the real build.

## Cleanup (after decision)
Fold the two chosen surfaces toward the real app; the losing app directions (#1–6 minus neuralnote),
the two unused landings (`?landing=galaxy`, `?landing=product`), and both switchers can be deleted once
the prototype has served its purpose. Until then, keep them for reference.
