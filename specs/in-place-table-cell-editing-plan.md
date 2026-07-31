# In-place table cell editing — implementation plan

Status: draft for maintainer approval, 30 July 2026. Worktree
`/Users/thomaspritchard/Documents/projects/NeuralNote-tables`, branch
`feat/table-in-place-editing`, HEAD `cd66833`. **No phase below authorises a commit, push,
pull request, merge, or release.**

Design contract: [`specs/in-place-table-cell-editing.md`](in-place-table-cell-editing.md)
(corrected 30 July 2026 — see its §12 changelog). Shipping bar:
[`docs/definition-of-done.md`](../docs/definition-of-done.md).

Every `path:line` in this document was opened at `cd66833`. Library citations are relative to
`app/desktop/node_modules/`; installed versions are `@codemirror/view` 6.43.6,
`@codemirror/state` 6.7.1, `@codemirror/commands` 6.10.4.

---

## 0. What this plan is, and what changed

It consolidates four parallel analyses and a reconciliation
(`scratchpad/pm-decomposition.md`) into an executable schedule, then adjusts that schedule for
three decisions Tom has since settled. Where this plan and the decomposition disagree, this
plan controls, and §9 says why.

**The three settled gates, recorded so nobody re-opens them:**

| gate | decision |
|---|---|
| **G1 — cross-cell selection** | **Refuse and say why.** A transaction whose changes touch a hidden delimiter is rejected whole; the document and every cursor survive; the reason is announced to assistive technology. |
| **G2 — wide tables** | **The table keeps scrolling inside itself.** Each table row is its own horizontal scroll container, with scroll positions synchronised. Note-level horizontal scrolling is rejected: it changes the scroll behaviour the instant the caret enters the table, which is the discontinuity this feature exists to remove. |
| **G3 — scope** | **Take the larger scope.** One canonical `CellPaintPlan` is shared by the measurement path and the paint path. Equivalent-but-separate logic is not acceptable. |

**What G2 costs, stated up front.** It is the single largest unproven element of the plan. It
is not a variation on the decomposition's §2 verdict; it replaces that verdict's mechanism.
A scroll container nested inside `contenteditable` is not a well-trodden path, and I found one
mechanism (§4, K1) that makes it fail by construction unless the design answers it explicitly.
**P0 spikes it before any production code, and if the spike fails the decision goes back to Tom
with evidence rather than being quietly reversed.**

---

## 1. Phases in dependency order

| # | Phase | Lane | Files owned exclusively | Depends on | Gate command | The assertion that fails if the phase is wrong |
|---|---|---|---|---|---|---|
| **P0** | Spike, contract freeze, doc corrections | `coder` (throwaway spike) + planner (docs) | throwaway `*.browser.test.tsx` under `app/desktop/src/workspace/` (deleted at phase end); `specs/in-place-table-cell-editing.md`; `specs/in-place-table-cell-editing-plan.md`; `docs/definition-of-done.md`; the CT-1 fixture module | — | `npm --prefix app/desktop run test:browser` (spike only) | Every kill check in §2 records a pass/fail observation with a number attached. A check that "looked fine" is a fail. |
| **P1** | Integrity — both confirmed defects + the G1 transaction filter | `coder` | new `sourceEditorTableDelimiterGuard.ts` (+`.test.ts`); `sourceEditorTableCommands.ts` (+test); the `EditorView.atomicRanges` registration line in `sourceEditorDecorations.ts`; `SourceNoteEditor.tsx` (extension array + announcement wiring only) | K1–K3 in §2 answered (pass **or** fail — P1 ships either way, see §7) | `npm --prefix app/desktop run test:run -- src/workspace/sourceEditorTableDelimiterGuard.test.ts src/workspace/sourceEditorTableCommands.test.ts src/workspace/sourceEditorTableIntegrity.test.ts src/workspace/SourceNoteEditor.test.tsx` then `npm --prefix app/desktop run test:browser` | Drag-select from `aa` to `bb` across a hidden cell boundary in `\| aa \| bb \|`, type one character: the document is byte-identical, both selection ranges survive, and one `aria-live` message was announced. Today this silently produces `\| aabb \|`. |
| **P2** | `CellPaintPlan` — the canonical projection (G3) | `coder` | new `sourceEditorCellPaintPlan.ts` (+test); `sourceEditorDecorationsPreview.ts`; `obsidianLivePreview.ts` (table-cell path only) | P1 (shares the `sourceEditorDecorations.ts` surface); CT-3 frozen | `npm --prefix app/desktop run test:run -- src/workspace/sourceEditorCellPaintPlan.test.ts src/workspace/sourceEditorDecorations.test.ts src/workspace/obsidianLivePreview.test.ts` | For a cell containing `**bold**`, a `` `code` `` span, a `[[wikilink]]` and a `#tag`, the plan's `visibleText` equals the concatenation of the text nodes the paint layer actually renders, character for character — and both layers derive that from the same function call, not from two lists of hidden node names. |
| **P3a** | Measurement + cache | `coder` | new `sourceEditorTextMetrics.ts` (+`.test.ts`, +`.browser.test.tsx`) | CT-3, CT-4 frozen; P2 | `npm --prefix app/desktop run test:browser` (this phase is unprovable in jsdom) | The detached probe reproduces the live rendered width of every fixture cell to within 1px, with a negative control (`font-family: monospace`) showing a non-zero delta in the same run. A 0.00px agreement with no failing control is a probe that silently didn't apply its styles. |
| **P3b** | Structure — render plan, per-cell marks, line decorations | `coder` | `sourceEditorDecorations.ts`; `sourceEditorDecorationsWidgets.ts`; `sourceEditorTableModel.ts` (+ their tests) | CT-1..CT-6 frozen; P2. **Parallel with P3a, P3c, P3d** | `npm --prefix app/desktop run test:run -- src/workspace/sourceEditorDecorations.test.ts src/workspace/sourceEditorTableModel.test.ts` then `npm --prefix app/desktop run test:browser` | On `\| a **b** c \| x \| y \|` every table line yields **exactly one** `.nn-lp-cell` element per column, each at its declared `grid-column`, and the block `TableWidget` still renders once for a table the caret is outside. |
| **P3c** | Visual — the box and the row scrollers | `ui-designer` | **`app/desktop/src/styles.css` only** | CT-1, CT-5, CT-7 frozen. Parallel with P3a/P3b/P3d | `npm --prefix app/desktop run test:browser` | Consecutive table rows join at 0.0px, every row's border box is an integer pixel height, the corner radii compose on a one-row table, the fills stay translucent enough that a selection reads through them, and **exactly one** horizontal scroll affordance is visible for a wide table — not one per row. |
| **P3d** | Row-scroll synchronisation (new — G2) | `coder` | new `sourceEditorTableScrollSync.ts` (+`.test.ts`, +`.browser.test.tsx`) | CT-7 frozen; K1–K5 passed. Parallel with P3a/P3b/P3c | `npm --prefix app/desktop run test:browser` | Set `scrollLeft` on any one row of a 6-row wide table, let one frame pass: every other row reports the same `scrollLeft`, the drawn caret's client rect still coincides with the caret's text position to within 1px, and no row's `scrollLeft` resets to 0 on the next keystroke. |
| **P4** | Integration + native go/no-go | `coder`, then **Tom by hand** | assertion tests only; no production file | P3a + P3b + P3c + P3d | full `npm --prefix app/desktop run test:run`, `test:browser`, `typecheck`, `typecheck:browser`, `lint`; then the WKWebView walkthrough in §8 | The runtime DOM matches the CT-1 golden fixture exactly — direct-child order, class names, `grid-column` values, edge hooks. And Tom's hand-run WKWebView checklist is *recorded with its actual results*, not asserted. |
| **P5** | Review + gates | `code-reviewer`, then `coder` | — | P4 | `npm --prefix app/desktop run test:run`, `test:browser`, `coverage`, `typecheck`, `typecheck:browser`, `lint`, `npm --prefix app/desktop run build`, `bash scripts/rust-quality-gate.sh`, `gitleaks git . --log-opts=--all --redact` | `rust-quality-gate.sh` prints **GREEN** and exits `0`. Exit `2` (INCOMPLETE) is not green (`docs/definition-of-done.md:44-51`). |

### Why the sequence is this shape

- **P0 before everything** because G2 is unproven and the design that depends on it is expensive.
  A grid hit-testing failure or a caret-detach failure kills the approach for roughly a day of
  spike work instead of after three parallel waves.
- **P1 before the rendering waves** for two independent reasons. It touches
  `sourceEditorTableCommands.ts` and the extension array in `sourceEditorDecorations.ts`, which
  P3b owns; and it is defect work on already-committed code that should be reviewable and
  shippable on its own (§7). Sequencing it first also means the rendering waves build on a base
  where the integrity boundary already exists rather than bolting one on afterwards.
- **P2 before P3a/P3b** because both consume `CellPaintPlan` and its signature. G3 is the
  decision that they consume *the same* projection; splitting them re-introduces the exact
  divergence that manifests as column jitter rather than as an error.
- **P3a/P3b/P3c/P3d in parallel** only once CT-1..CT-7 are committed artifacts. Disjoint file
  lists do not make waves safe — the contracts are where two agents editing different files still
  collide.

### Lane assignment, and the rule behind it

`coder` owns behaviour and logic in TypeScript. `ui-designer` owns `styles.css` exclusively and
nothing else in production.

A file being visually consequential does not make it presentational. `sourceEditorDecorations.ts`
and `sourceEditorDecorationsWidgets.ts` are CodeMirror `StateField` and `WidgetType` logic; their
output is visual, which is not the same thing. **P3d is the case where this matters most under
G2**: the row-scroll synchroniser is scroll-event wiring, `scrollLeft` propagation and a forced
layer re-measure — behaviour, `coder`, its own module. Only the scroll *chrome* (which element
scrolls, `overflow`, scrollbar suppression, the single affordance) is CSS, and that is
`ui-designer` inside `styles.css`.

If the stylesheet needs another class, attribute or custom property, `ui-designer` raises a
contract change against CT-1 rather than editing the producer.

> **Dispatch note.** The `ui-routing-guard.py` PreToolUse hook reads the whole brief and keys on
> nouns, including inside negations. A `coder` brief for P3b or P3d must name `ui-designer` as the
> owner of the presentational slice, or scope itself explicitly as "logic only / no markup or
> CSS". The P3c `ui-designer` brief must do the reverse. Put the affirmation in the brief; do not
> work around the gate.

---

## 2. P0 — the spike, kill checks cheapest first

**Rules.** The spike is throwaway. It is a `*.browser.test.tsx` file colocated in
`app/desktop/src/workspace/`, named unmistakably disposable
(`tableScrollerSpike.throwaway.browser.test.tsx`), importing nothing from a production table
module beyond the fixture text, and **deleted before P1 opens**. It reports numbers; it does not
render a verdict. The planner draws the conclusion.

The last spike on this branch was picked up by `npm run test:browser` while it existed
(`specs/in-place-table-cell-editing.md` §8) — so it must be deleted, not left "for reference".

Each check below is a pass/fail **observation**, not an impression. Ordered cheapest first, so
the likeliest kill is also the first thing run.

### K1 — Does the drawn caret stay with the text when a row scrolls? *(new; ~30 min)*

This is first because I believe it fails by default, and the mechanism is in the installed source.

`drawSelection()` is enabled (`SourceNoteEditor.tsx:151`). Its cursor and selection layers are
appended to `view.scrollDOM` (`@codemirror/view/dist/index.js:9403`) and positioned in scroller
coordinates from `view.coordsAtPos(...)` (`:9276-9287`). They are re-measured only on
`docChanged | selectionSet | viewportChanged | configChanged` (`:9557`, `:9585`) or
`update.geometryChanged` (`:9419`). A `scroll` event on an element does not bubble — it bubbles
only when the target is the Document ([CSSOM View](https://drafts.csswg.org/cssom-view/)) — so a
per-row scroller scrolling notifies CodeMirror of nothing at all. And the native caret cannot
cover for it: `hideNativeSelection` is `Prec.highest` and sets `caret-color: transparent
!important` on `.cm-line` and `.cm-content` (`@codemirror/view/dist/index.js:9589` onward), which
beats `styles.css:527-530`.

Two consequences follow, and the spike must observe both:

- **PASS/FAIL 1a.** Place the caret in the last column of a wide row. Set that row's `scrollLeft`
  to its maximum. Read `document.querySelector(".cm-cursor").getBoundingClientRect().left` and
  `view.coordsAtPos(head).left`. **Pass:** they agree within 1px without any code being added.
  **Fail (expected):** they diverge by the scroll offset.
- **PASS/FAIL 1b.** With the caret scrolled out of the row's visible band, read the drawn caret's
  rect against the row element's rect. **Pass:** the caret is not painted outside the row's border
  box. **Fail:** it paints over neighbouring content, because the layer sits in scroller space and
  is not clipped by the row's `overflow`.

If either fails, the remedy must be measured, not assumed. **The remedy this clause originally
prescribed — force `view.requestMeasure(...)` from the row's own `scroll` listener on every frame —
does not work, and the clause was wrong to call it "known".** See K1's measured result below for
what does. If the rescue restores 1a but not 1b, the design needs a clip on the layers, which is a
change to CodeMirror's own DOM and is an architecture escape hatch (§4, kill 13 — this clause
previously cited "§6, kill 10", which is neither the kill-criteria section nor that criterion).

**MEASURED — 30 July 2026, real headless Chromium. 1a fails, 1b fails, and only 1a is
recoverable.**

- **1a fails as predicted.** With the row scrolled to its maximum (381px), the drawn caret sat
  **+380.41px** from `view.coordsAtPos(head).left` — exactly the scroll offset.
- **The prescribed rescue recovers nothing.** `view.requestMeasure(...)` from the row's `scroll`
  listener left the drift at **380.41px** despite firing 61 read callbacks. The reason is
  structural: a `LayerView` re-queues its *own* `measureReq` only when `layer.update()` returns true
  or on `update.geometryChanged` (`@codemirror/view/dist/index.js:9417-9421`). An unrelated measure
  request never reaches it, however many times it fires.
- **What does work is a `selectionSet` transaction.** `view.dispatch({ selection:
  view.state.selection })` makes `cursorLayer.update()` return true (`:9551-9557`, whose return is
  `update.docChanged || update.selectionSet || confChange`), which re-queues the layer's own
  measure. That recovers the caret to **-0.59px** — the cursor marker's own `margin-left: -0.6px`,
  i.e. exact.
- **Its cost is not the problem.** Frame interval p50 8.3ms / p95 8.7ms / max 9.5ms against a
  baseline of 8.3 / 9.0 / 9.3 — indistinguishable at frame level. Handler time p50 0.3ms / p95
  0.6ms / max 0.9ms, at 1.02 calls per frame.
- **1b is not recovered by either rescue.** With the caret's character scrolled out of the row's
  band, the drawn caret painted **369.92px past the row's inline-end edge**, `insideRowBorderBox`
  false. The layers are appended to `scrollDOM` (`:9403`), siblings of `.cm-content`, so no
  `overflow` on a row can clip them. Zero neighbouring line boxes were overlapped — rows are
  full-width and stacked, so the overflow is purely inline — but it is still paint outside the box.

**Consequence: kill criterion 1 (§4) is met on its second half.** The caret's *position* is
recoverable at a measured-negligible cost; its *clipping* is not, and clipping the layers is kill
criterion 13. This is the G2 decision point, and it goes to Tom.

### K2 — Does a `.cm-line` survive as a scroll container across a keystroke? *(~30 min)*

The scroller must be the `.cm-line` element itself, not an inner wrapper. CodeMirror's DocView
reuses a line's own element across updates but rebuilds its children, so a wrapper created by a
widget loses `scrollLeft` on every decoration rebuild — i.e. on every keystroke.

- **PASS/FAIL 2.** With the table scrolled to `scrollLeft = 200`, type one character in a
  different note paragraph, then in a table cell. **Pass:** every row still reports
  `scrollLeft === 200`. **Fail:** any row resets to 0. A table that jumps to column one while you
  type has failed the feature's own premise more comprehensively than note-level scrolling ever
  did.

**MEASURED — PASS.** `scrollLeft` held at 200px across a keystroke in another paragraph, in another
row's cell, and in the scrolled row itself. All 7 row elements kept object identity across every
rebuild, and 0 exceptions were thrown.

### K3 — OQ-0: does `.cm-line` as a grid container preserve hit-testing? *(~1 h)*

Carried forward from the decomposition unchanged — it is the one genuinely open architecture
question and the grid design dies here if it fails.

Bare `EditorView`, three explicit pixel tracks, cells that are plain / bold / code / empty /
ragged.

- **PASS/FAIL 3a.** `coordsAtPos` → `posAtCoords` round-trips into the correct cell for a probe
  position in each cell. **Pass:** every probe returns a position inside the same slot's
  `[from, to]`. (A mid-surrogate probe snapping to a cluster boundary is a pass, not a fail.)
- **PASS/FAIL 3b.** The same round-trip after `scrollLeft` is non-zero on the row.
- **PASS/FAIL 3c.** A selection crossing two delimiters resolves to the expected document range.
- **PASS/FAIL 3d.** No `RangeError` is thrown during mount or update.

**MEASURED — PASS, but only in a repaired arm, and the probes alone would have missed it.**
Hit-testing passed in *both* arms: 12/12 round-trips into the correct slot, exact ranges, 0
`RangeError`s. Geometry did not. A naive `.cm-line`-as-grid gave row heights of **128.78px**
against a 19.59px line box — 6.4x too tall — because CodeMirror brackets every inline widget with
`<img class="cm-widgetBuffer">` (`@codemirror/view/dist/index.js:2338-2340`, `:2464-2469`), and in a
grid container those are unplaced items that auto-flow into implicit rows: 8 buffers per row, 9
stacked rows. Forcing `.cm-line > * { grid-row: 1 }` and parking the buffers in column 1 returned
all five rows to exactly **19.59px**.

**This is a hazard no analysis anticipated, and it is why CT-1 is a committed module rather than
prose.** A fixture that omits the buffers describes DOM that cannot exist, and the obvious probes
certify the broken arm as healthy. The buffers and their required placement are encoded at
`app/desktop/src/workspace/sourceEditorTableContractFixture.ts`.

### K4 — OQ-2: does the no-wrap treatment hold, and does per-row scrolling change the clamp? *(~30 min)*

The decomposition's 390.45px / 65.30px wrapped-cell figures survive in no retained artifact
(A1's prose only; nothing in `spike-evidence.txt`). This converts the claim into an assertion.

- **PASS/FAIL 4a.** ~~Every table line returns `getClientRects().length === 1` under `white-space:
  pre` at a 400px pane, while a control paragraph still returns more than one.~~ **This assertion
  is vacuous and must not be used.** `.cm-line` is `display: block`
  (`@codemirror/view/dist/index.js:6844-6847`), and `Element.getClientRects()` returns exactly one
  border-box rect for any block box, wrapped or not. Measured: 1 rect for table lines **and** 1 for
  wrapped control paragraphs — the check cannot fail, so it proves nothing.
  **The sound measure is height in line boxes.** At the default 19.59px line height: table lines
  19.59px / 1 box; control paragraphs 78.38px / 4 boxes and 58.78px / 3 boxes. Use that.
- **PASS/FAIL 4b.** **New under G2.** With rows as `width: 100%` scroll containers rather than
  `max-content` boxes, does `.cm-content`'s intrinsic width still grow? A3 measured that a
  `max-content` row pushed `.cm-content` to 1279.73px and stopped ordinary paragraphs wrapping.
  **Pass:** paragraphs still wrap at the pane width with no `.cm-content { max-width: 100% }`
  clamp present.

**MEASURED — 4b FAILS. The clamp stays, and §9 change 3 is withdrawn.**

| arm | `.cm-content` width | note-level h-scroll | rows overflowing inline | control paragraph |
|---|---|---|---|---|
| unclamped | **881.78px** | appears | **0 of 7** | stops wrapping |
| clamped | **400px** | none | **6 of 7** | wraps |

The root cause is not the row's `width`. `.cm-content` is a flex item of `.cm-scroller`, so its
`min-width: auto` resolves to min-content, and `overflow-x` on a *descendant* row does not zero
that floor. Unclamped, the content box simply grows to the widest row — at which point **no row is
narrower than its content, so no row can ever become a scroll container**, and G2's mechanism has
nothing to scroll. F5's hope that G2 dissolved a global regression surface is refuted: the clamp is
load-bearing *for* G2, not merely alongside it.

### K5 — Does one scroll affordance work, and is the closing border reachable? *(~45 min)*

A scrollbar under every row is unacceptable, and the box must still read as closed.

- **PASS/FAIL 5a.** Exactly one horizontal scroll affordance is visible for a wide table. ~~Measure
  by counting elements whose `clientHeight < scrollHeight` in the block direction~~, and by
  screenshot. **The predicate as written measures the wrong axis.** `clientHeight < scrollHeight`
  is block-axis overflow; a horizontal scroller overflows in the *inline* axis. Corrected to
  `clientWidth < scrollWidth`, the count is **7** (6 rows plus `cm-cursorLayer`); the clause's own
  predicate returned **2** — a different and wrong set, and one that would have been read as
  "nearly one affordance" rather than as a bug in the check.
- **PASS/FAIL 5b.** At each row's maximum `scrollLeft`, the last column's trailing padding and the
  row's inline-end border are both inside the visible band. (Grid items in a scroll container
  classically lose the container's trailing padding; this is the check for it.)
- **PASS/FAIL 5c.** Two candidate mechanisms are measured, not chosen from taste: (i) suppress
  per-row scrollbars (`scrollbar-width: none` plus the WebKit pseudo-element) and render one
  overlay affordance; (ii) let one designated row own the visible scrollbar and drive the rest.
  Record which one holds 5a and 5b together.

**MEASURED — 5b passes, 5c is UNDECIDED.**

- **5b passes in every row and every arm.** Trailing padding was honoured at maximum `scrollLeft`
  (gaps 8.22 / 8.05 / 8.05 / 7.84 / 8.45 / 8.45 px against `padding-inline-end: 8px`), and each
  row's inline-end border sat at x=398, inside the visible band.
- **5c cannot be settled by layout metrics.** The engine uses overlay scrollbars, so the two
  candidate mechanisms are indistinguishable in `clientWidth` / `scrollWidth` / `offsetWidth`, and
  the screenshot half of the check was not run. This stays open — it is §7 decision 2, and it is
  downstream of the G2 decision anyway.

### K6 — OQ-7: does horizontal `scrollIntoView` behave inside a per-row scroller? *(~30 min, same harness)*

~~`scrollRectIntoView` walks up from the target DOM and scrolls any ancestor whose `scrollWidth >
clientWidth` (`@codemirror/view/dist/index.js:540-560`), so it *will* scroll a row scroller. That
is good for reachability and bad for synchronisation: it scrolls exactly one row, outside the sync
path, with no notification.~~

**The premise is inverted, and the hazard is the opposite one.** The walk is real, but it does not
start at the target: at HEAD the call is `scrollRectIntoView(this.view.scrollDOM, ...)`
(`@codemirror/view/dist/index.js:3449`). It *starts* at `.cm-scroller`, an ancestor of every row,
and only ever walks further **up**. It can never descend into a `.cm-line`. So a row scroller is
not scrolled out of band — it is not scrolled at all.

- **PASS/FAIL 6a.** Tab from the last visible cell to an off-screen cell brings that cell into
  view.
- **PASS/FAIL 6b.** After 6a, every other row's `scrollLeft` matches within one frame.

**MEASURED — the default arm never reveals the cell; a deferred scroll handler does.**

- **Default arm:** the off-screen cell moved **0px** and was never revealed. Instead the *note*
  scrolled sideways 178px. The hazard is non-reveal, not one-row desync — the inverse of what this
  check was written to catch.
- **A `scrollHandler` that reads layout inline throws** `Reading the editor layout isn't allowed
  during an update`. This is the second hazard no analysis anticipated, and it constrains P3d's
  design directly.
- **Only a handler that defers its read to `view.requestMeasure` works.** With one: the target row
  moved 193px, the cell landed in the band, and 6 of 7 rows followed. The 7th is the short
  alignment row, whose `scrollWidth` equals its `clientWidth`, so it physically cannot scroll —
  that is correct behaviour, not a sync failure, and any P3d assertion must exempt it rather than
  demand 7 of 7.

### K7 — OQ-3 and OQ-4: precedence and the degenerate cells *(~45 min)*

- **PASS/FAIL 7a.** On `| a **b** c | x | y |` with the per-cell mark provider registered *below*
  `previewPlugin`: exactly one `.nn-lp-cell` element per column per line.
- **PASS/FAIL 7b.** With the cell-mark provider demoted, the block `TableWidget` still renders
  exactly once. (Block decorations may not come from a plugin —
  `@codemirror/view/dist/index.js:2743` — so this must be two `EditorView.decorations.from(field,
  …)` providers at different precedence over **one** `StateField`, never a demoted field.)
- **PASS/FAIL 7c.** `| x |  | z |` yields three grid items at columns 0/1/2, and the empty cell's
  zero-length widget honours its explicit `grid-column`.
- **PASS/FAIL 7d.** A ragged `| only |` puts its trailing chrome outside the content columns, not
  in column 2.

**MEASURED — PASS, with one gap that must not be read as covered.**

- **7a passes:** exactly one cell per column per line, at x = 6/206/426 under a `200px 220px 210px`
  template, no duplicated columns.
- **7b passes:** with the cell-mark provider demoted, the block `TableWidget` count is 1 and 0
  `RangeError`s are thrown.
- **7c passes for the case it ran, which is not the case that matters.** Three grid items landed at
  columns 1/2/3 — but the middle cell's source was **two spaces**, a non-empty range. The genuinely
  zero-length cell (`||`) is **unproven**, and it cannot be reached by widening this check, because
  it cannot use a `Decoration.mark` at all: a mark may not be empty. It is a different code path,
  and it is recorded as open question CT1-Q1 in the CT-1 fixture module.
- **7d passes:** a ragged row keeps its trailing chrome out of columns 2 and up.

### K8 — OQ-1: WKWebView vs Chromium measurement *(Tom, ~20 min)*

The browser lane is Chromium; the shipped app runs WebKit. **No agent can settle this**, and it
gates P3a's premise rather than P0's.

Dev build, a note carrying the CT-1 fixture table, a short snippet in the WKWebView console
measuring A1's seven strings via a detached probe against the sum of `Range.getClientRects()`.
**Pass:** every delta within 1px after the correct style epoch, with the monospace negative
control showing a non-zero delta in the same run.

### The G2 decision point

If K1, K2, K5 or K6 cannot be made to pass, **stop and route the decision back to Tom.** Do not
fall back silently. The brief for that escalation is: the observed numbers; what would be required
to rescue per-row scrollers (per-frame `requestMeasure`, and its measured cost); and the named
fallback — **note-level horizontal scroll, which Tom has already rejected once** — so he
re-decides with evidence rather than having it decided for him. The third option, which is not the
fallback and should be offered as its own choice, is to ship P1 alone and keep today's
two-appearance behaviour.

**This has now triggered. K1's 1b failed and K6's premise was inverted, so the decision is live and
it is Tom's.** The numbers are in K1 and K6 above; the correction to the rescue's cost is that the
rescue is not per-frame `requestMeasure` (which recovers nothing) but a per-frame `selectionSet`
transaction, whose measured cost is indistinguishable from baseline at frame level. What that
rescue does *not* buy is 1b: the drawn caret still paints 369.92px outside the row, and clipping
CodeMirror's own layers is kill criterion 13. **CT-7 is therefore not frozen — see §3.**

---

## 3. Frozen contracts

Each is a place where two agents editing different files would still collide. **CT-1, CT-2 and
CT-5 are frozen as of P0 and are read-only thereafter. CT-3 and CT-4 are frozen in shape and must
stay frozen before P3a and P3b begin. CT-6 is a statement only. CT-7 could not be frozen.**

Status at a glance:

| id | status |
|---|---|
| **CT-1** | **FROZEN** — committed module, `app/desktop/src/workspace/sourceEditorTableContractFixture.ts` |
| **CT-2** | **FROZEN** — restated below with the measured template |
| **CT-3** | **FROZEN in shape** — P2 implements it; signature unchanged |
| **CT-4** | **FROZEN in shape** — P3a implements it; signature unchanged |
| **CT-5** | **FROZEN** — restated below with what P0 did and did not measure |
| **CT-6** | **STATEMENT ONLY** — enforcement retimed from P1 to P2, and its premise needs re-verifying |
| **CT-7** | **NOT FROZEN** — recorded as a finding; blocked on Tom's G2 decision |

### CT-1 — golden DOM fixture — FROZEN

**The artifact is `app/desktop/src/workspace/sourceEditorTableContractFixture.ts`, pinned by
`sourceEditorTableContractFixture.test.ts`.** It is a committed module, not prose in this document,
because the thing it fixes is exact: direct-child order, class names, `grid-column` values and edge
hooks, for a header row, a collapsed alignment row, interior and last body rows, a one-row table,
empty cells, ragged filler cells, and formatted and widget-backed content.

Read the module's doc comment for the contract itself. Four things belong here:

1. **It is a TARGET, not a snapshot.** Nothing renders it today. A mismatch against the running app
   is work not yet done, not a regression.
2. **It encodes the `cm-widgetBuffer` elements and their required placement.** K3's measurement is
   why. A fixture that omits them describes DOM that cannot exist, and the naive arm it would have
   sanctioned measured 128.78px rows against a 19.59px line box while passing every hit-testing
   probe.
3. **Edge position is stamped, never inferred.** `nn-lp-table-row-first` / `-last` are explicit
   classes, because table rows are `.cm-line` siblings among unrelated paragraph lines and no CSS
   selector can find a table's edges. The one-row table in the fixture is the case where first and
   last land on two different lines.
4. **It records what it could not freeze.** Three open questions ship inside the module
   (`CONTRACT_OPEN_QUESTIONS`), so a later phase reads them at the same moment it reads the
   contract: the genuinely zero-length cell (CT1-Q1, see K7c), buffer elision between adjacent
   zero-length widgets (CT1-Q2), and the row's `overflow` ownership (CT1-Q3, which is CT-7).

**What it protects against:** `coder` produces the DOM and `ui-designer` styles it; they never share
a file and would otherwise collide on every selector.

### CT-2 — `TableRenderPlan` — FROZEN

Per-column track widths, row kind, per-cell track assignment, and the custom-property name **and
units**. TypeScript computes and stamps them.

- **The stamped property is `--nn-table-tracks`**, carrying a track list in `px`, written on every
  row line of a table — not only the first, because each row line is its own grid container.
- **The stylesheet's only permitted use of it is `grid-template-columns: var(--nn-table-tracks)`.**
  This reconciles the two halves of the original clause: what `ui-designer` must not do is author a
  *literal* template that fights the inline stamp; wiring the custom property through is the
  mechanism, and follows the existing house pattern (`--nn-cell-pad`,
  `sourceEditorDecorationsWidgets.ts:30`).
- **The measured template is `200px 220px 210px`, which put the three cells at x = 6/206/426**
  (K7a). The cells sit exactly at the track origins; the 6px is CodeMirror's own `.cm-line {
  padding: 0 2px 0 6px }` (`@codemirror/view/dist/index.js:6844-6847`). That is the evidence that
  **no per-cell padding contributes to alignment under the grid** — the tracks do all of it, and
  the monospace `--nn-cell-pad` mechanism does not carry over.
- **Adjusted for G2, unchanged:** a table-wide `--nn-table-width` is not required for the box to
  close. **Track widths are still required for column alignment.**

**What it protects against:** P3a, P3b and P3c all reason about column geometry from different
files.

### CT-3 — `CellPaintPlan` + its signature — FROZEN IN SHAPE

Unchanged from the statement this plan was approved with; P2 implements it. Visible text, hidden
ranges, widget labels, nested mark classes, header/body context. Consumed by **both** the decoration
adapter and the measurement probe. The signature excludes source offsets, so moving an identical
cell does not change its width. Cache key is `(styleEpoch, CellPaintPlan.signature)`, never
`(styleEpoch, rawText)`.

**What it protects against:** the G3 failure mode — two lists of "which characters are hidden" that
drift apart. The measured width then belongs to a different string than the user sees, and it shows
up as column jitter, not as an error.

### CT-4 — measurement API — FROZEN IN SHAPE

Unchanged from the statement this plan was approved with; P3a implements it.
`primeTextMetrics(from: Element)` / `metricsEpoch()` / `measuredWidth(plan)`, plus the epoch-bump
trigger list: `document.fonts` `loadingdone`, typeface preference, font scale, zoom, and defensively
on theme. `measuredWidth` returning `null` means "not primed yet" and is the normal first frame, not
an error.

**What it protects against:** P3a owns the probe, P3b consumes it; an unagreed "not primed" contract
turns a normal first frame into a reported failure.

### CT-5 — row metric budget — FROZEN

**The contract: a table row's border box is an integer number of pixels, and a table line never
carries a margin.** CodeMirror measures the *border* box
(`@codemirror/view/dist/index.js:3296`), so a margin is invisible to the height map and every
position below it drifts by that amount. `ui-designer` declares the height; any TypeScript that
reasons about height depends on it.

**What P0 measured.** The spike's bare `EditorView` had a default line box of **19.59px**, and the
repaired grid arm — `grid-row: 1` on all direct children, buffers parked in column 1 — held **every
one of its five rows at exactly that**. That is the useful finding: *the grid repair introduces no
fractional drift of its own*. Every row measured identically.

**What P0 did NOT measure, and must not be read as measuring.** 19.59px is a bare-harness number
with no application stylesheet loaded. The shipped editor sets `line-height: 1.8` on `.cm-scroller`
(#92, `styles.css:490-499`), so the app's line box is not 19.59px. The original clause's arithmetic
(`padding-block: 0.5rem` + `line-height: 1.5` = 40px plus borders) is likewise a *target*, not a
measurement, and it does not match the app's current line height either. **P3c chooses the padding
that lands the border box on an integer against the app's own line height, and measures it.** The
19.59px figure is evidence about the grid, not about the row.

**What it protects against:** fractional row heights stack into visible sub-pixel gaps between rows,
and the box stops looking like a box.

### CT-6 — the table-active boundary invariant — STATEMENT ONLY

**The statement stands, unchanged.** A single exported predicate — `activeTable(state, from, to)` —
consumed by both `sourceEditorDecorationsPreview.ts` (the `Table` arm at `:227-234`) and
`sourceEditorTableCommands.ts` (`activeTableAt`, `:52-56`). It must *not* be a change to the shared
`active()` helper at `sourceEditorDecorationsPreview.ts:38-42`, which every construct in the
collector uses; widening that globally would change emphasis-marker reveal across the whole editor.
`activeLink` at `:44-48` is the existing house pattern for exactly this scoped widening.

**Enforcement is retimed from P1 to P2, and it did NOT happen in P1.** Recorded plainly because a
contract everyone believes is enforced is worse than one everyone knows is not:

- CT-6's own rule is "same agent, same wave, never split". P1's exclusive file list (§1) does not
  include `sourceEditorDecorationsPreview.ts` — §1 assigns that file to P2. So P1 could only ever
  have enforced *half* of a contract whose entire value is that both halves move together.
  Enforcing half of it would have been worse than not starting.
- **P2's file list must therefore gain `sourceEditorTableCommands.ts` and its test**, so one wave
  changes both consumers in one commit. P2 already owns `sourceEditorDecorationsPreview.ts`.

**And its premise needs re-verifying before P2 acts on it.** The clause asserts "today the two files
disagree by construction". At HEAD they appear to **agree**, both exclusive of `to`:

- `active()` uses `range.head >= from && range.head < to`
  (`sourceEditorDecorationsPreview.ts:38-42`).
- `activeTableAt` returns null when `pos >= model.to` (`sourceEditorTableCommands.ts:52-56`).
- A comment at `sourceEditorTableCommands.ts:46-51` says so explicitly: "`active()` in the preview
  layer is exclusive of `to` … The commands must agree, or Enter writes a row to a table the user
  sees as rendered."

That is a deliberate alignment, not a divergence. The bug CT-6 describes — the caret at `table.to`
being swallowed into a read-only widget — may still be real, but if so it is a bug in *where both
files draw the boundary*, not in the two of them disagreeing. **P2 re-derives the failing case
first, and does not widen anything until it has a test that goes red at HEAD.** Note that a comment
asserting the two are aligned is itself a claim with no check behind it; the test is the deliverable.

### CT-7 — row-scroller contract — NOT FROZEN

**This is a recorded finding, not a contract. Do not write CT-7 and do not plan against one.**

CT-7 was frozen "contingent on K1–K6" (§3, as approved). That contingency failed:

- **K1's 1b failed and is not rescuable inside the design.** The drawn caret's *position* is
  recoverable — a per-frame `selectionSet` transaction brings a 380.41px drift back to -0.59px, at
  a frame cost indistinguishable from baseline (p50 8.3ms / p95 8.7ms / max 9.5ms against 8.3 / 9.0
  / 9.3). Its *clipping* is not: with the caret's character scrolled out of the row's band, the
  drawn caret painted **369.92px past the row's inline-end edge**. The layers are appended to
  `scrollDOM` (`@codemirror/view/dist/index.js:9403`), siblings of `.cm-content`, so no `overflow`
  on a row can clip them. Clipping or reparenting CodeMirror's own selection layers is kill
  criterion 13 (§4).
- **K6's premise was inverted.** `scrollRectIntoView` is called as
  `scrollRectIntoView(this.view.scrollDOM, ...)` (`:3449`), so it starts at `.cm-scroller` and only
  walks up. It cannot descend into a `.cm-line`. Measured: the off-screen cell moved **0px** and was
  never revealed; the note scrolled sideways 178px instead. The hazard is non-reveal, not one-row
  desync.
- **A rescue exists for K6 but constrains P3d.** A `scrollHandler` that reads layout inline throws
  `Reading the editor layout isn't allowed during an update`. Only one that defers its read to
  `view.requestMeasure` works: target row +193px, cell in band, 6 of 7 rows following. The 7th is
  the short alignment row, whose `scrollWidth` equals its `clientWidth`.
- **K5c is undecided.** The engine uses overlay scrollbars, so layout metrics cannot distinguish the
  two candidate single-affordance mechanisms, and the screenshot half was not run.

**What did hold, and is worth keeping if G2 survives:** K2 passed outright — `scrollLeft` held at
200px across every keystroke arm, all 7 row elements kept object identity across every rebuild, 0
exceptions. And K4b established that the `.cm-content { max-width: 100% }` clamp is *load-bearing
for G2*: unclamped, 0 of 7 rows overflow inline, so no row can become a scroll container at all.

### CT-7 — RESOLVED and FROZEN (31 July 2026)

Tom delegated this decision explicitly ("answer them proactively and autonomously and continue"),
so it was taken here rather than escalated. G2 stands. The resolution turns 1b from a tolerated
defect into an unreachable state, without touching CodeMirror's layers.

> **REVERSED 31 July 2026 — see the addendum at the end of this section. The clamp described
> below was implemented, measured in use, and withdrawn. Read the addendum before implementing
> anything here.**

**The rule: while the main caret is inside a table, that table's scroll offset is clamped to the
range that keeps the caret's own character inside the row's client band.**

The scroll-sync module (P3d) owns one offset per table. It already has to compute the caret's
coordinates for the K1 rescue, so the clamp costs one comparison on a value it holds anyway.

Why this and not the alternatives:

- *Clip or reparent the layers* — kill criterion 13, and the reason 1b was called unrescuable.
  Not on the table.
- *Hide the drawn caret while out of band* — legal (it styles the layer rather than clipping it),
  but it answers "your caret is somewhere you can't see" with "you now have no caret", which is
  worse than not letting it get there.
- *Tolerate the out-of-band paint* — rejected on evidence. The spike measured
  `neighbouringLinesOverlapped: 0`, but that is a property of the spike's fixture, not of the
  design: a longer neighbouring paragraph would be painted over. Reading a fixture-specific zero as
  a general guarantee is the same mistake this plan has already caught twice.

**What it costs, stated plainly:** with the caret in a table, you cannot scroll that table far
enough to lose sight of your own caret — the scroll stops there. Move the caret out of the table
and it scrolls freely. The alternative was a caret that silently paints over unrelated text.

**Assertions that must exist (P3d, browser lane):**
1. Caret in a table, scroll the table hard in both directions: `coordsAtPos(head)` stays within the
   row's client band on every frame, and the clamp is what stopped it (assert the offset hit the
   clamp, not merely that the caret is in band — a table too narrow to scroll satisfies the latter
   vacuously).
2. Caret outside the table: the same scroll runs to the full extent, proving the clamp is scoped.
3. `.cm-cursorLayer` never reports an inline overflow while the caret is inside a table.

**Decisions 2 and 3 of §7, taken at the same time:**

- **K5c / single affordance — mechanism ii, owner = the table's last row.** The engine uses overlay
  scrollbars (`scrollbarGutterPerRowPx` was `0` on every row in all three arms), so this costs zero
  layout either way and is purely a visual call. One bar beneath the last row reads as a table
  scrollbar; a bar under every row reads as damage.
- **No explicit keyboard scroll binding in v1.** The deferred `scrollHandler` already reveals the
  target cell on cell-to-cell navigation (K6 arm C: +193px, cell in band). A separate binding would
  be a second way to do the same thing. Revisit only if P4's native pass shows the handler missing
  cases.

P3c and P3d are unblocked. P3a and P3b were never blocked — they depend on CT-1..CT-5.

**One hazard this inherits from K6, to be carried into P3d:** the alignment row's `scrollWidth`
equals its `clientWidth`, so it cannot follow the others (it sat at 0 while six rows moved to
193px). Every row must be forced to the table's full width or the rows shear. That is CT-2's
`--nn-table-width`, and K6 is the evidence for why it is load-bearing rather than cosmetic.

> **Superseded 31 July 2026.** `--nn-table-width` proved unnecessary. Every content row's trailing
> chrome is stamped at the table's last column and the alignment row's rule spans the full track
> list, so all rows already reach the final track — measured identical 638px scroll widths,
> alignment row included, with each row proven to accept a scroll offset and the extent asserted
> above 100px so an all-stuck-at-zero table cannot satisfy it vacuously. K6's shear came from the
> spike's own harness using a plain-text alignment row, not from the contract shape. Recorded
> because "the spike measured it" was the reason this clause existed, and the spike was measuring
> something else.

### CT-7 addendum — the clamp is withdrawn (31 July 2026)

**The clamp above is reversed. Table scrolling is free; the drawn caret is suppressed instead.**

I took the clamp decision. It was wrong, and P3d's implementation is what proved it: with the
caret in the first cell of a 1200px table in a 400px pane, the table will not scroll past ~21px,
leaving roughly 780px of the user's own table unreachable until they move the caret or click away.
That reads as a frozen table, not as a protected caret. The arithmetic was always going to say
this — if column one must stay inside a 400px band, there is nowhere to scroll to — and I did not
do it before ratifying the rule.

**Replacement rule:** the scroll offset is unconstrained. When the main caret is inside a drawn
table and its character is outside that row's visible band, `sourceEditorTableScrollSync` toggles
the class `nn-table-caret-offscreen` on `view.dom`, and the stylesheet hides the cursor layer under
it. The caret returns the moment its character does.

This is what an editor already does when your cursor scrolls off screen: nothing is drawn. It only
needed arranging here because CodeMirror would otherwise draw it somewhere wrong. It is legal where
clipping is not — the cursor layer already hides itself on blur, so hiding is an established state
rather than a new mechanism, and nothing reaches into or reparents CodeMirror's layers.

I rejected this option when I ratified the clamp, on the reasoning that "no caret" is worse than a
hidden one. That was the wrong comparison. The real comparison is a suppressed caret against a
table you cannot scroll, and free scrolling wins.

`nn-table-caret-offscreen` is the frozen name across the two lanes: the module toggles it, the
stylesheet consumes it.

---

## 4. Kill criteria

Concrete observations, each tied to a point in the schedule. Any one means abandon the drawn-box
approach and keep today's two-appearance behaviour rather than push through. **P1 is exempt from
every one of them** — see §7.

1. **P0 / K1 — the caret detaches. MET, on its second half.** A row's internal scroll leaves the
   drawn caret or the drawn selection behind and it cannot be recovered to within 1px, *or* the
   drawn caret paints outside the row's border box. **Measured: position is recoverable
   (380.41px → -0.59px), clipping is not (369.92px outside the row).** The recovery is not the
   `requestMeasure` this criterion named — that recovered nothing — but a `selectionSet`
   transaction; see K1. *Kill G2's mechanism, route to Tom.*
2. **P0 / K2 — scroll position does not survive a keystroke.** Any row's `scrollLeft` resets to 0
   on a decoration rebuild. *Kill G2's mechanism, route to Tom.*
3. **P0 / K3 — grid hit-testing.** `coordsAtPos` or `posAtCoords` resolves into the wrong cell with
   `.cm-line` as a grid, a cross-cell selection breaks, or CodeMirror throws. *Kill the whole
   design, before anything is built.*
4. **P0 / K4 — no-wrap. NOT MET; the criterion as written could never have been met.** ~~A table
   line still returns more than one client rect under `white-space: pre`.~~ `.cm-line` is
   `display: block`, so it returns exactly one client rect whether it wraps or not — this criterion
   was unfalsifiable. **Restated: a table line occupies more than one line box under
   `white-space: pre` at the pane width.** Measured: table lines 19.59px / 1 box against control
   paragraphs at 78.38px / 4 boxes and 58.78px / 3 boxes. The no-wrap treatment holds.
5. **P0 / K5 — the affordance.** Neither candidate mechanism gives exactly one scroll affordance
   with the closing border reachable. *Route to Tom; a scrollbar per row is a stated
   unacceptable.*
6. **P3a / K8 — platform measurement.** The detached probe differs from live rendering by more than
   1px in WKWebView across plain / bold / code / CJK / ZWJ-emoji / tabular-number content after the
   correct style epoch. Pixel widths would be wrong on the only platform that ships.
7. **P2 — the projection cannot be unified.** The measurement path and the paint path cannot share
   one `CellPaintPlan` — for instance `obsidianLivePreview`'s widget replacement cannot be projected
   without duplicating its logic. Equivalent-but-separate logic is not acceptable: it manifests as
   column jitter, not as an error.
8. **P3a — performance.** Real browser p95 from dispatch through layout to next paint exceeds 50ms
   for 20 single-character edits on a 200-row table **after** memoisation. Note that the existing
   `sourceEditorPerformance.test.ts:45-66` budget is pure-state with no DOM and proves nothing here
   — and it is `it.skipIf(UNDER_COVERAGE_INSTRUMENTATION)` (`:16-18`), so it does not run in the
   coverage lane at all. This needs its own browser-lane budget.
9. **P3 — geometry.** Column-boundary spread stays above ~1.5px across rows, the closing border is
   unreachable, ordinary paragraphs stop wrapping, or rich / empty / ragged cells split into
   multiple grid items.
10. **P1, any time — integrity.** Any generic edit, paste, cut, drag or multi-selection change can
    still remove a hidden delimiter. If the transaction filter cannot close this, the feature cannot
    ship at all: it breaks Tom's non-negotiable byte constraint.
11. **Any phase — byte fidelity.** A no-op open, a caret walk, a font load, a zoom, a style refresh
    or a composition lifecycle changes a single byte of source. Immediate stop.
12. **P4 — native.** WKWebView drops, duplicates or reorders IME, dictation or dead-key input in a
    table cell compared with an ordinary paragraph; or the caret lands in the wrong cell on click or
    vertical motion, including after horizontal scroll. Not recoverable by more engineering.
13. **Architecture escape hatch.** Solving any failure requires a nested `EditorView`, editable
    widget DOM, DOM-to-source reconciliation, a clip or reparent applied to CodeMirror's own
    selection layers, or rewriting the document to achieve a visual effect. The last is Tom's
    explicit prohibition; the others mean the design has left the one-document / one-`contenteditable`
    model that makes the rest of it safe.
14. **Process.** Two consecutive phases fail the browser lane for structural rather than test-bug
    reasons — the decomposition itself is suspect. Stop and re-derive.

**If the native verification in P4 is simply unavailable, the release is blocked.** An unrun gate
is not a passed gate.

---

## 5. Verification — the gates, and two things a green suite does not cover

### The gates

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run typecheck:browser
npm --prefix app/desktop run test:run       # jsdom + mockIPC journeys
npm --prefix app/desktop run test:browser   # real Chromium, vitest.browser.config.ts
npm --prefix app/desktop run coverage
npm --prefix app/desktop run build
bash scripts/rust-quality-gate.sh
gitleaks git . --log-opts=--all --redact
```

**The definition-of-done document did not mention the browser lane**, although
`npm --prefix app/desktop run test:browser` has existed at `app/desktop/package.json:20` since
before this branch, with three suites already in it (`sourceEditorTable.browser.test.tsx`,
`editorTypography.browser.test.tsx`, `TitleBar.browser.test.tsx`). Every phase in this plan
concerning pixel geometry — P3a, P3b, P3c, P3d — is provable **only** in that lane. A gate nobody
is required to run is not a gate, so **this plan amends `docs/definition-of-done.md` rather than
merely noting the gap.** That amendment is P0 work and lands with the spec corrections.

### Chromium is not WebKit

The browser lane runs headless Chromium via Playwright (`vitest.browser.config.ts`); the shipped
app runs macOS WKWebView. Measurement parity between them is a genuine open question, not an
assumption — it is K8, and it is Tom's to run. **A green `test:browser` is evidence about
Chromium and nothing else.** Do not let the plan's own gate table be read as platform coverage.

### No agent can drive the native GUI

Input-method composition, macOS dictation and dead keys cannot be settled by any agent. jsdom has
no IME; headless Chromium has no IME; Tauri's WKWebView cannot be driven headless. The engineering
deliverable is the freeze gated on `compositionStarted` (§9, change 5); **the verification is
Tom's, by hand.** It appears in P4 as his checklist, and a green suite is never read as coverage
of it.

Tom's P4 checklist, in a real WKWebView build:

- Japanese and Chinese IME composition inside a cell, including a composition that spans a column
  re-measurement, kana→kanji, with the Japanese input source.
- macOS dictation into a cell.
- Dead keys (option-e-e) inside a cell.
- Caret placement by click and by vertical motion, **including after a row has been horizontally
  scrolled** (this is the G2-specific case and it is new).
- Horizontal scroll by trackpad across a wide table: do the rows stay in sync under a real
  momentum-scroll gesture, not just a scripted `scrollLeft` assignment?
- VoiceOver over a table, recording honestly what it announces.
- Keyboard-only: reach a table, edit a cell, and leave the editor entirely using Tab and arrows.
- Copy a selection starting in a cell and ending two paragraphs below; paste into a plain text
  editor; confirm it is source Markdown with pipes.
- LF, CRLF, CR and mixed-ending fixtures compared byte-for-byte after a cell edit and after a
  no-op open/close.
- The G1 refusal: drag-select across a hidden boundary, type — confirm VoiceOver announces the
  refusal rather than the edit silently vanishing.

---

## 6. What ships independently

**P1 ships as its own reviewable unit, ahead of and independent of the rendering work.**

The two confirmed defects are integrity work on already-committed code:

- **D1 — `tableAtomicRanges` is dead code.** `sourceEditorDecorations.ts:201` exports it;
  `grep -rn "EditorView.atomicRanges" app/desktop/src/` returns nothing, and the extension array
  at `:348-355` has no entry. Its doc comment at `:195-200` claims it "covers pointer selection
  and any motion path that does consult the facet" — a guarantee asserted with nothing that goes
  red if it is untrue. **Wire it, don't delete it:** the premise that justified leaving it dead has
  moved, because the hidden span is now the whole `" | "` gap
  (`sourceEditorTableModel.ts:276-347`), so the strict-interior tests
  (`@codemirror/commands/dist/index.js:1196`, `if (from < pos && to > pos)`) are now satisfiable
  where a bare pipe never could be. Two fixes are required on wiring: it must cover **all visible
  tables**, not just the one at `state.selection.main.head` (`:202`), and it must honour the same
  oversized-table bail as the visual path (`:178-183`).
- **D2 — `guardTableDelimiter` returns null for any non-empty selection.**
  `sourceEditorTableCommands.ts:195`, verbatim `if (!range.empty) return null;`.

**D2 is a live defect at HEAD, not a prospective one.** `alignmentRanges`
(`sourceEditorDecorations.ts:165-193`) already hides the `" | "` gaps on the current branch, so
the gesture that corrupts a table — drag-select across a cell boundary, type — is available today.
`| aa | bb |` becomes `| aabb |`: the row loses a column while the delimiter row still declares
two, so Obsidian renders it ragged, and nothing warns. That is a direct breach of the byte
constraint.

`atomicRanges` **cannot** fix it. For a non-empty range `deleteBy` does
`from = skipAtomic(from, false); to = skipAtomic(to, true)`
(`@codemirror/commands/dist/index.js:1173-1180`) — atomic ranges *expand* a deletion outward, they
never refuse it. Wiring D1 makes this path no better.

The fix, per G1, is a central `transactionFilter`, all-or-nothing: derive protected delimiter
ranges from `tr.startState`, inspect every component of the `ChangeSet` including all multicursor
edits, and reject the whole transaction if any part lands inside a protected delimiter —
preserving the document and every selection, with an `aria-live` message attached as an effect
(`EditorView.announce`), never a React call from inside a filter. Two exceptions are required or
ordinary editing breaks: an annotated structural table command, and a change that removes or
replaces an affected table **entirely**, so Select All and cutting a whole table still work.

One constraint shapes the design and must be stated as an invariant with a test, not held
quietly: `filter: false` at `@codemirror/commands/dist/index.js:536` means history's undo/redo
dispatch **bypasses transaction filters**. The filter is safe only because nothing unsafe ever
entered history in the first place.

**Why it ships first and alone:** it repairs a live corruption path; it is reviewable without any
of the rendering design; it is the one part of this plan that survives every kill criterion,
including a total G2 failure. If the spike kills the drawn box, P1 still merges.

---

## 7. Open decisions routed to Tom

Nothing below is a design preference an agent can settle.

1. **If K1/K2/K5/K6 fail — does G2 change? LIVE as of 30 July 2026, and it blocks CT-7, P3c and
   P3d.** The numbers are in §2 (K1, K4b, K5, K6) and §3 CT-7. Two corrections to how this
   escalation was framed:
   - The rescue is **not** per-frame `requestMeasure`. That recovers nothing (380.41px drift
     unchanged after 61 read callbacks). The rescue that works is a per-frame `selectionSet`
     transaction, and its measured cost is indistinguishable from baseline at frame level.
   - **The rescue does not close K1's 1b.** Even rescued, the drawn caret paints 369.92px outside
     the scrolled row, and clipping CodeMirror's own layers is kill criterion 13. So "rescue and
     pay the cost" is not a complete option — it buys the caret's position, not its clipping.

   The three options to put to Tom, restated: **(a)** accept the rescue *and* the unclipped caret
   overhang as a known visual defect; **(b)** take note-level horizontal scroll (already rejected
   once, now with evidence); **(c)** ship P1 alone and keep today's two-appearance behaviour. P3a
   and P3b are not blocked by this and can proceed on the frozen CT-1..CT-5 either way.
2. **The single-affordance mechanism (K5c). UNDECIDED, and not settleable by measurement.** The
   engine uses overlay scrollbars, so the two candidates are indistinguishable in layout metrics
   and the screenshot half was not run. It reverts to a taste call about how the scroll affordance
   reads, with `ui-designer` proposing rather than deciding — but it is downstream of decision 1
   and is moot unless G2 survives.
3. **Screen-reader table semantics.** The one-appearance decision (`spec §4`) means no real
   `<table>` / `<th scope="col">` DOM in any state. Accepted knowingly and filed as tracked
   accessibility debt — but under G2 a horizontally scrolling region also needs a keyboard route,
   which is new and not yet specified.

---

## 8. Findings from my own verification

Nine claims failed the reconciliation's independent check and none of them are reintroduced above.
These are the additional ones I found, checking the reconciliation itself at `cd66833`.

| # | claim | source | finding |
|---|---|---|---|
| F1 | "`--nn-cell-pad` is set at `sourceEditorDecorationsWidgets.ts:32`" was corrected to ":34 — off by two" | `pm-decomposition.md` §8 claim table | **The correction is wrong.** At `cd66833` the `setProperty` call is at `sourceEditorDecorationsWidgets.ts:32`, exactly as A1 said. Immaterial to the design, but it sits in the one table people read as ground truth. |
| F2 | CT-6: "widen both to `<= to`" | `pm-decomposition.md` §4, C4 | **Right intent, wrong mechanism.** `active()` at `sourceEditorDecorationsPreview.ts:38-42` is the *shared* helper for every construct the collector emits — headings, emphasis, links, task markers. Widening it would change emphasis-marker reveal across the whole editor. The correct scoping is a table-specific predicate; `activeLink` at `:44-48` is the existing house pattern. CT-6 is restated accordingly. |
| F3 | W1 owns "new `sourceEditorTableIntegrity.ts` (+test)" | `pm-decomposition.md` §5 wave table | **The name is already taken.** `app/desktop/src/workspace/sourceEditorTableIntegrity.test.ts` exists at HEAD (150 lines) and tests `sourceEditorTableCommands`, not a module of that name. A wave briefed to "add" it would collide with a real fixture-driven sweep. Renamed to `sourceEditorTableDelimiterGuard.ts` in P1. |
| F4 | The drawn caret and selection under G2 | not raised by any analysis | **New, and it reorders the spike.** `drawSelection()`'s layers live in `.cm-scroller` (`@codemirror/view/dist/index.js:9403`), are positioned from `coordsAtPos` (`:9276-9287`), re-measure only on doc/selection/viewport/geometry change (`:9419`, `:9557`, `:9585`), and element `scroll` events do not bubble. A per-row scroller therefore notifies CodeMirror of nothing, and `hideNativeSelection` (`:9589`+, `Prec.highest`) has already made the native caret transparent. This is K1, and it is cheaper to observe than the hit-testing question. |
| F5 | `.cm-content { max-width: 100% }` "is mandatory and it is a global regression surface" | `pm-decomposition.md` §2, point 2 | ~~**Possibly dissolved by G2.**~~ **REFUTED by K4b, 30 July 2026.** The hope was that `width: 100%` rows would not propagate into `.cm-content`'s intrinsic contribution. They do not need to: `.cm-content` is a flex item whose `min-width: auto` resolves to min-content regardless, and a descendant's `overflow-x` does not zero that floor. Unclamped, `.cm-content` measured 881.78px with **0 of 7 rows overflowing inline** — the clamp is what *creates* the row overflow G2 depends on. See §9, change 3, withdrawn. |
| F6 | The perf budget test | `pm-decomposition.md` §7, kill 5 | Correct that it proves nothing about pixels, and worth adding: `sourceEditorPerformance.test.ts:16-18` makes both budgets `it.skipIf(UNDER_COVERAGE_INSTRUMENTATION)`, so neither runs under `npm run coverage`. A budget that silently doesn't run in one lane is worth knowing about before it is cited as coverage. |
| F7 | The spec's §1 file:line references | `specs/in-place-table-cell-editing.md:16-50` | **Stale at HEAD, describing a pre-phase-1/2 state.** `TableWidget` is at `sourceEditorDecorationsWidgets.ts:103`, not `:97`; `TablePadWidget` no longer exists (it is `TableChromeWidget`); `displayWidth` is now `monospaceWidth` at `sourceEditorTableModel.ts:99`, not `:62`; the `Table` `return false` is at `sourceEditorDecorationsPreview.ts:234`, not `:233`. Corrected inside the clauses this plan rewrites; the rest is flagged rather than swept, because §1 is a historical framing section and rewriting it wholesale would lose the record. |

Everything else in the reconciliation that I re-checked held: the `composing` / `compositionStarted`
semantics (`@codemirror/view/dist/index.js:7840`, `:7847`), the two `RangeError` throws (`:2743`,
`:2745`), `EditorView.lineWrapping` as a `contentAttributes` class (`:8958`) with
`break-spaces` at `:6835-6841`, `guessWrapping` reading the facet (`:6230-6231`), the 10000-char
`ensureLineGaps` margin (`:6481-6483`), the mark-precedence doc comment (`:242-248`), `filter:
false` in history's dispatch (`@codemirror/commands/dist/index.js:536`), `skipAtomic` expanding
deletions (`:1173-1180`), the `#92` line-height fix (`styles.css:490-499`, commit `ec1e509`), the
read-only widget's own `overflow-x: auto` (`styles.css:613-621`), `.nn-lp-tag`'s `font-weight: 600`
(`styles.css:726-732`), `obsidianLivePreview.ts:179` / `:252` / `:294`, and the DoD's silence on
the browser lane.

---

## 9. What changed versus the reconciliation, and why

1. **A spike phase now precedes everything, and its first check is new.** The reconciliation's W0
   held OQ-0 as the first kill check. G2 adds four questions that are cheaper to answer and likelier
   to fail (K1, K2, K5, K6), so OQ-0 moves to third.
2. **The wrapping verdict's *consequence* is replaced.** Table lines still opt out of wrapping.
   `.cm-content { max-width: 100% }` and note-level horizontal scrolling are replaced by per-row
   scroll containers plus synchronisation. The premise survives; the mechanism does not.
3. **The clamp may come out of the plan entirely.** See F5. K4b decides it.
   > **WITHDRAWN, 30 July 2026, by K4b's measurement.** The clamp stays. Unclamped, `.cm-content`
   > grows to 881.78px, note-level horizontal scroll appears, a control paragraph stops wrapping,
   > and **0 of 7 rows overflow inline** — so no row can become a scroll container and G2 has
   > nothing to scroll. Clamped: `.cm-content` at 400px, no note-level scroll, 6 of 7 rows
   > overflowing correctly. The cause is not the row's `width`: `.cm-content` is a flex item of
   > `.cm-scroller`, its `min-width: auto` resolves to min-content, and `overflow-x` on a
   > descendant row does not zero that floor. The clamp is load-bearing *for* G2, not merely
   > alongside it. **No phase may remove it.**
4. **A new phase, P3d, and a new contract, CT-7.** Row-scroll synchronisation is behaviour, not
   presentation, so it is a `coder` module rather than more stylesheet. Without CT-7, P3c and P3d
   would both believe they own the scrolling.
5. **The `CellPaintPlan` wave is in, not conditional.** G3 settles it. The plan states the failure
   mode as column jitter rather than an error, because that is what makes "equivalent but separate"
   tempting and wrong.
6. **CT-6 is restated** (F2), **W1's new module is renamed** (F3), and the wave table's phase names
   change from W-numbers to P-numbers to avoid two documents using the same labels for different
   scopes.
7. **The definition-of-done gap is fixed, not noted.** P0 amends the document.
8. **P1's independence is made explicit and argued** (§6), including the point the reconciliation
   left implicit: D2 is a defect on the branch *today*, so P1 survives every kill criterion.

---

## 10. Changelog

- **30 July 2026** — created. Consolidates `analysis-1-measurement.md`,
  `analysis-2-structure.md`, `analysis-3-visual.md`, `analysis-4-interaction.md` and
  `pm-decomposition.md`, adjusted for gates G1, G2 and G3.
- **30 July 2026 — P0's measurements landed.** All seven agent-runnable kill checks ran in real
  headless Chromium; the throwaway spike is deleted. Each check in §2 now carries its numbers, and
  the contracts in §3 are restated as frozen artifacts rather than table rows. What the measurement
  changed:

  | clause | was | is |
  |---|---|---|
  | §2 K1 | "the remedy is known": per-frame `view.requestMeasure` | It recovers **nothing** (380.41px unchanged, 61 read callbacks). A `selectionSet` transaction recovers to -0.59px. 1b is not recoverable at all: 369.92px painted outside the row. |
  | §2 K3 | grid hit-testing was the whole question | Hit-testing passed in **both** arms. Geometry did not: `cm-widgetBuffer` elements auto-flow into implicit grid rows, 128.78px against a 19.59px line box. A hazard no analysis anticipated. |
  | §2 K4a | `getClientRects().length === 1` | Vacuous — `.cm-line` is `display: block`, so it always returns 1. Restated as height in line boxes. |
  | §2 K4b, §9 change 3, §8 F5 | the clamp may come out of the plan | **Withdrawn.** The clamp is load-bearing *for* G2: unclamped, 0 of 7 rows overflow inline, so no row can become a scroll container. |
  | §2 K5a | count `clientHeight < scrollHeight` | Wrong axis. `clientWidth < scrollWidth` counts 7, not the clause's 2. |
  | §2 K5c | two candidates, settled by measurement | **Undecided.** Overlay scrollbars make them indistinguishable in layout metrics. |
  | §2 K6 | `scrollRectIntoView` walks up from the target and will scroll a row | **Inverted.** It is called on `.cm-scroller` (`:3449`) and only walks up, so it never reveals the cell at all — the note scrolls 178px sideways instead. A `scrollHandler` also cannot read layout inline. |
  | §2 K7c | the empty-cell case is covered | The middle cell's source was two spaces. The genuinely zero-length case (`||`) is **unproven** and cannot use a `Decoration.mark` at all. |
  | §3 CT-1 | "a committed HTML snapshot" described in prose | A committed module: `app/desktop/src/workspace/sourceEditorTableContractFixture.ts`, pinned by its test. |
  | §3 CT-6 | "P0 statement, P1 enforcement" | Statement only. Enforcement retimed to **P2**, because P1's file list excludes `sourceEditorDecorationsPreview.ts`. Its premise ("the two files disagree by construction") is refuted at HEAD and must be re-derived. |
  | §3 CT-7 | frozen, contingent on K1–K6 | **Not frozen.** The contingency failed. Recorded as a finding; blocked on Tom (§7 decision 1). |
