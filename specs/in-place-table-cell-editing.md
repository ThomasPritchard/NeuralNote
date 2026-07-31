# In-place Markdown table cell editing

Status: draft for maintainer review, 30 July 2026; **corrected 30 July 2026**
against evidence gathered since it was written — see the changelog in section 12,
which names what corrected each clause. Nothing here is approved and no phase
below authorises a commit, push, pull request, merge, or release.

This document extends `specs/source-native-live-preview-editor.md` and its
implementation plan. Where the two disagree, the amendment in section 7 is the
only proposed change; everything else in the parent spec continues to control.

**The executable schedule lives in
[`specs/in-place-table-cell-editing-plan.md`](in-place-table-cell-editing-plan.md).**
This document is the design contract; that one is the phase order, the frozen
contracts, the spike's kill checks and the lane assignments. Section 9 below is
the original phase sketch and is superseded by it.

**Related:** `specs/source-native-live-preview-editor.md` (the parent contract),
`specs/source-native-live-preview-editor-implementation-plan.md` (delivery
rules), GitHub issue #86 (CJK/emoji column widths — closed by phase 1 below),
GitHub issue #92 (editor line-height — already closed, see section 8).

---

## 1. What ships today, and why it is not enough

On `feat/table-in-place-editing` a Markdown table has two appearances:

- **Caret elsewhere.** The whole table is a read-only block widget — a real
  `<table>` with `<th scope="col">` headers, built by `TableWidget` in
  `app/desktop/src/workspace/sourceEditorDecorationsWidgets.ts:97`. It is
  produced by `Decoration.replace({ block: true })`.
- **Caret inside.** The widget is dropped and the raw Markdown is revealed, in
  monospace, visually column-aligned by zero-length `TablePadWidget` insertions
  that repeat literal space characters
  (`app/desktop/src/workspace/sourceEditorDecorations.ts:132`). The document
  bytes never change. `Shift-Alt-f` is the only path that writes alignment to
  disk.

This is Obsidian's pre-1.5 live-preview behaviour and it is defensible. The
maintainer's objection is that editing still means looking at pipes. The ask is
that the *rendered* table stays visible and editable: type directly into
bordered cells, never see a `|`.

Three properties of today's implementation are worth keeping in view because
they constrain everything below:

1. Table decorations come from a `StateField`, not a `ViewPlugin`. This is not
   stylistic — `@codemirror/view` throws `"Block decorations may not be
   specified via plugins"` (`node_modules/@codemirror/view/dist/index.js:2743`)
   and `"Decorations that replace line breaks may not be specified via
   plugins"` (`:2745`). Any decoration that hides a line break must stay in the
   `StateField`.
2. The preview collector stops descending at a `Table` node
   (`sourceEditorDecorationsPreview.ts:233`, `return false`), so no inline
   Markdown is currently decorated inside a cell.
3. Column widths are grapheme counts (`displayWidth`,
   `sourceEditorTableModel.ts:62`). That is issue #86: CJK and emoji occupy two
   monospace columns and are counted as one.

---

## 2. The candidate designs

Four approaches were considered. Each is judged on five axes: how it preserves
byte-exactness, what happens to IME, what happens to a selection that leaves
the table, what it costs, and how far it reaches into the existing code.

### Option A — a nested `EditorView` per cell

Mount a second `EditorView` inside the rendered table widget's cell when that
cell is clicked. Every keystroke is immediately dispatched as a `changes`
transaction against the parent document; the cell is "a view, not a state".

**Verified feasibility.** This is a real pattern and CodeMirror upstream has
accommodated it in three places, all confirmed against the installed 6.43.6
source:

- the outer view does **not** steal the DOM selection from a nested editable —
  `updateSelection` early-returns on `!(activeElt && dom.contains(activeElt))`
  (`@codemirror/view/dist/index.js:3029`);
- mutations inside widget DOM are read and then discarded
  (`:7457`, `if (!tile || tile.isWidget()) return null`);
- the copy handler carries an explicit nested-editor guard and comment (`:5183`).

So it can be built. The question is what it costs.

**Byte-exactness.** Every nested edit must be translated from inner-document
coordinates to outer-document coordinates before it reaches `applySourceChanges`
in `sourceText.ts:62`. That translation is new, hand-written, and sits directly
on the line-ending separator map. A one-character offset error is a silently
corrupted file.

**IME.** `WidgetType.ignoreEvent` defaults to `true`
(`@codemirror/view/dist/index.js:161`), and `eventBelongsToEditor` (`:4856`)
uses it to drop *every* event inside widget DOM — keyboard, `beforeinput`,
composition, clipboard. The outer view is therefore blind to a composition
inside a cell, which is what makes the nesting safe. But it also means the
nested view owns composition entirely, while the outer document is changing
underneath it on every keystroke, which re-runs the table `StateField`, which
can rebuild the widget. A widget rebuild mid-composition destroys the composing
DOM node and aborts the composition. Preventing that needs a stable widget
identity plus `updateDOM`, and the failure mode when it is wrong is dropped or
duplicated CJK characters — silent, and invisible to every jsdom test we have.

**Selection leaving the table.** This is where the option fails structurally,
not incidentally. A nested `EditorView` owns a separate `EditorState` with a
separate document. A single selection range cannot span two documents. A
selection that starts in a cell and ends in the paragraph below is either
impossible, or it is a raw DOM selection that neither view models — so copy,
cut, and delete over it are undefined. There is no amount of care that fixes
this; it is what "two documents" means.

**Blast radius.** Large. New nested-view lifecycle, coordinate translation,
history bridging, focus management, and — because `ignoreEvent` blinds the outer
view — re-implementation of clipboard, undo, and keyboard handling inside each
cell. Live preview inside cells (`**bold**`) would also have to be rebuilt in
the nested view.

### Option B — `contenteditable` cells with a change-mapping layer

Make the widget's cells `contenteditable="true"` (the CodeMirror author's
documented answer to "how do I put an editable thing in a widget" is exactly
this: widgets are forced `contenteditable=false`, but you may introduce
`contenteditable=true` children —
<https://discuss.codemirror.net/t/focusing-inputs-within-widgets/5178>),
intercept
`beforeinput`, `preventDefault()`, and dispatch the equivalent change to the
outer document.

**This is broken for IME by specification, not by implementation.** The
`beforeinput` event with `inputType: "insertCompositionText"` is explicitly
**not cancelable** in Input Events Level 2 (<https://w3c.github.io/input-events/>,
"all beforeinput events apart from those emitted within an IME composition
process are cancelable"). IMEs take control of the editing region and cancelling
would make them malfunction. So `preventDefault()` cannot work during
composition. The only way out is to let the composition run in the
DOM and reconcile the resulting text back into the document after
`compositionend` — and a reconcile layer that diffs rendered DOM against source
Markdown *is* the second editable state machine the parent plan forbids, by any
reading.

Everything else about option A applies here too, minus CodeMirror's
battle-tested handling of the parts it does get right.

### Option C — an overlay / "cell popover" editor

Position an absolutely-placed single-cell editor over the rendered cell.

Strictly worse than A for this product: it inherits every one of A's integrity
problems, adds position-tracking churn on scroll and resize, and makes a
multi-cell selection not merely hard but conceptually absent — there is no
surface for it to live on. Its only advantage, that the rendered `<table>` DOM
stays intact for screen readers, is also A's advantage. Dismissed.

### Option D — hidden delimiters over live source (recommended)

Stop replacing the table with a widget when the caret is inside it. Instead
keep the source lines as the editable content — they already are — and decorate
them until they read as a table:

1. **Hide the pipes.** Each `|` on a header or body row is its own
   `TableDelimiter` node of length 1
   (`@lezer/markdown/dist/index.js:2064`). Cover each with
   `Decoration.replace({})` and register the same ranges in
   `EditorView.atomicRanges` so horizontal caret motion skips them. Replacement
   alone does not keep the caret out — the `.d.ts` says so explicitly
   (`@codemirror/view/dist/index.d.ts:1352`).
2. **Align the columns in pixels.** Keep the existing zero-length
   `TablePadWidget` insertions, which are already proven by a browser-tier test,
   but give them a measured pixel width instead of a run of literal spaces.
   Bytes still never change, and the monospace assumption disappears.
3. **Draw the cell chrome.** Give each row line a `Decoration.line` class and an
   inline custom property carrying the measured column track template; draw the
   vertical rules as an absolutely-positioned `::before` on each chrome span
   against a `position: relative` row line. (This spec originally specified a
   background gradient on the line element; that is superseded — see section 5,
   "Vertical rules".)
4. **Render the delimiter row as the header rule.** Replace the `| --- | --- |`
   line's content with a thin rule, revealing its source only when the caret is
   explicitly placed inside it.
5. **Let the cells render Markdown.** Remove the `return false` at
   `sourceEditorDecorationsPreview.ts:233` so the collector descends into
   `TableCell` and emits the ordinary inline decorations.

**Byte-exactness.** Nothing is added that can change the document. Pads are
zero-length insertions; hidden pipes are replacements; chrome is CSS. The
document the user edits is the document on disk, with no translation layer
anywhere. This is the same argument the existing alignment machinery already
won.

**IME, undo, selection, clipboard.** All four are inherited from CodeMirror
unchanged, because there is exactly one document, one selection, one history,
and one `contenteditable`. A selection from a cell to the paragraph below is an
ordinary range. Copy serialises from `state.doc` (`index.js:5158`), so it yields
source Markdown by construction. There is nothing to get right here, which is
the whole point.

**Where it is weak.** Two places, both honest:

- **Layout.** `EditorView.lineWrapping` is enabled
  (`SourceNoteEditor.tsx:150`), so a row wider than the editor wraps, and a
  wrapped row's continuation starts at the left margin with its columns no
  longer aligned. This is the main open risk and phase 5 owns it.
- **Screen-reader semantics.** The read-only widget produces a real `<table>`
  with `<th scope="col">`; styled source lines produce sibling `<div>`s that
  ARIA cannot legitimately be told are a table (`role="row"` without an owning
  `role="table"` ancestor is invalid). Cell text is read linearly instead. Note
  that this is *not* a regression against what ships today, which has exactly
  the same profile while the caret is in the table — but it is a regression
  against the rendered widget, and it is the one thing options A–C do better.

**Blast radius.** Contained: `sourceEditorDecorations.ts`,
`sourceEditorDecorationsPreview.ts`, `sourceEditorDecorationsWidgets.ts`,
`sourceEditorTableModel.ts`, `styles.css`. No new module owns state. The
`TableWidget` block-replace path can eventually be deleted, which removes the
DOM-`cellIndex`-to-model-column mapping that has already produced one CRITICAL
bug.

### Comparison

| | A: nested view | B: contenteditable | C: overlay | **D: hidden delimiters** |
|---|---|---|---|---|
| Byte-exactness | new translation layer on the separator map | same, plus DOM reconcile | same as A | **nothing new can write** |
| IME | silent-corruption risk on widget rebuild | **broken by spec** | as A | **inherited, unchanged** |
| Undo | bridged across two histories | as A | as A | **one stack, free** |
| Selection out of table | **structurally impossible** | impossible | impossible | **ordinary range** |
| Copy yields source | must be re-implemented | must be re-implemented | must be re-implemented | **free (`state.doc`)** |
| Markdown in cells | rebuild live preview inside the cell | as A | as A | **free (syntax tree)** |
| Screen-reader table semantics | **real `<table>`** | **real `<table>`** | **real `<table>`** | linear text |
| Wide rows | table scrolls in its own box | as A | as A | table scrolls in its own box, one scroll container per row — **spiked first, and it did not survive intact; back with Tom (§5, §10 kill 8)** |
| Blast radius | large | large | large | **contained** |

---

## 3. Recommendation

**Build option D.** Do not build A, B, or C, and do not fall back to them if D
runs into trouble — if D fails, revert to the behaviour that ships today.

The reasoning is one sentence: **D's risks are layout risks, A's and B's are
text-integrity risks.** A misaligned column is visible the instant it happens,
costs nothing but CSS to fix, and cannot lose a byte. A dropped character during
Japanese input, or an off-by-one in a coordinate translation feeding the
line-ending separator map, is silent, arrives in the user's vault, and is
exactly the failure this project's first rule exists to prevent: the data format
is sacred, and byte-exactness is enforced by machinery
(`sourceText.ts`) that options A and B would have to be threaded through by hand.

Two secondary reasons matter almost as much:

- D *removes* code. The rendered-widget path, its DOM-`cellIndex`-to-model
  coordinate mapping, and the two-appearances rule all go away. A and B add a
  nested-view lifecycle on top of everything that exists now.
- D gets live Markdown inside cells for free, because `TableCell` nodes already
  contain parsed inline content (`@lezer/markdown/dist/index.js:2054`). Under A
  or B, `**bold**` inside a cell is a second implementation of live preview.

### On the stated hypothesis

The hypothesis was that a per-cell editable view holding *no state of its own*
is a second view rather than a second state machine, and so satisfies the
parent plan's constraint. It does not hold, for a flat reason: **a CodeMirror
`EditorView` cannot exist without an `EditorState`.** `EditorViewConfig.state`
is optional precisely because the view creates one when you omit it
(`@codemirror/view/dist/index.d.ts:691-696`), and `view.state` is a
non-nullable getter (`:742`). The view owns its own document, its own selection,
its own facets, and unless deliberately suppressed its own history. "A nested
`EditorView` that holds no state" is not a buildable object. The smallest nested unit that really
holds no state is a bare `contenteditable`, which is option B, and option B is
defeated by a specification fact rather than an engineering one.

That said, the conclusion the hypothesis was reaching for is still true: the
constraint at `implementation-plan.md:14-15` is not what stands between us and
in-place table editing. Option D never approaches it. See section 7.

---

## 4. Decisions (settled 30 July 2026)

All three original open questions were answered by Tom on 30 July 2026, and three
further gates were settled later the same day after four parallel analyses.
Recorded here so implementation reads the decision, not the debate.

| Question | Decision |
| --- | --- |
| Keep the read-only widget for inactive tables? | **No — one appearance.** Styled source rows always. The `cellIndex` mapping is deleted. |
| Marker-visibility amendment | **Approved.** Applied to `source-native-live-preview-editor.md` (new rule 2, renumbered 3-6, plus the clause at the rendered-constructs list). |
| Typing `\|` in a cell | **Auto-escape to `\\\|`.** Verified: `\| x \\\| y \| z \|` parses as one `TableCell` containing an `Escape` node. |

### The three later gates

**Gate 1 — a selection spanning a hidden cell boundary: REFUSE AND SAY WHY.**
When a selection crosses a hidden delimiter and the user types, pastes or cuts,
the whole transaction is rejected. The document is preserved, every cursor is
preserved, and the reason is announced to assistive technology via
`EditorView.announce` attached as an effect — never a React call from inside a
transaction filter.

The alternative — allow it and merge the cells with visible feedback — was
rejected: silent column loss is the worse failure, and refusal is the only option
that keeps the bytes valid GFM. This is the design in section 5, "Selection
spanning a hidden cell boundary". Two exceptions are required or ordinary editing
breaks: an annotated structural table command, and a change that removes or
replaces an affected table entirely, so Select All and cutting a whole table
still work.

**Gate 2 — wide tables: THE TABLE KEEPS SCROLLING INSIDE ITSELF.** Each table row
becomes its own horizontal scroll container, and their scroll positions are kept
in sync. Note-level horizontal scrolling is rejected. Tom's reason is the
feature's own premise: the scroll behaviour would visibly change the instant the
caret entered the table, which is precisely the discontinuity this slice exists
to remove. This overturns the earlier wide-row clause — see section 5, "A cell
whose content makes the row longer than the viewport", and section 8.

> **Status, 30 July 2026: back with Tom.** The gate's *decision* stands; its
> *mechanism* did not survive P0. The drawn caret paints 369.92px outside a
> scrolled row and nothing inside the design can clip it, and `scrollIntoView`
> never reveals an off-screen cell. Nothing falls back silently — the numbers
> and the three options are in `specs/in-place-table-cell-editing-plan.md` §3
> CT-7 and §7 decision 1. Until Tom re-decides, CT-7 is not frozen and the
> row-scroller phases do not begin.

This is the largest unproven element of the design. It is spiked before any
production code, and **if the spike fails the decision returns to Tom with the
measurements rather than being silently reversed.** The named fallback, so it is
re-decided rather than assumed, is note-level horizontal scroll.

**Gate 3 — scope: TAKE THE LARGER SCOPE.** One canonical `CellPaintPlan` — the
projection of what a cell actually renders as — is shared by both the measurement
path and the painting path. Equivalent-but-separate logic is explicitly not
acceptable.

The reason is that measurement cannot use raw cell source text. `tableSegmentWidths`
(`sourceEditorTableModel.ts:356-366`) measures `state.sliceDoc(slot.from, slot.to)`,
and for a cell containing `**bold**` that string carries four asterisks the paint
layer hides (overmeasurement) while the visible text is painted heavier by a mark
decoration (undermeasurement). Two errors, opposite signs, content-dependent, with
no correction factor. There are three independent decoration sources over the same
characters — the table `StateField`, `previewPlugin`, and `obsidianLivePreview`
(`obsidianLivePreview.ts:294`, which emits its own wikilink replace at `:252` and an
`nn-lp-tag` mark at `:179` that `styles.css:726-732` renders at `font-weight: 600`).
A measurement layer that owned its own list of hidden marker types would drift from
the paint layer, and the measured width would then belong to a different string than
the user sees. **That failure mode is column jitter, not an error**, which is what
makes duplicating the logic tempting and wrong.

Tom's binding constraint on the whole slice, in his words: *"as long as it's
still markdown under the hood and is compatible with Obsidian vaults."* Reading
a note must leave it byte-identical; every write must produce ordinary GFM that
Obsidian reads the same way.

**Accepted cost of the one-appearance decision:** the product will contain no
real `<table>` / `<th scope="col">` DOM in any state, so a screen reader never
receives table semantics. This was accepted knowingly. File it as tracked
accessibility debt when phase 2 lands, so it is not rediscovered later as a bug.

### The original framing of that fork, for the record

**Should the read-only block widget survive for tables the caret is not in?**

- **One appearance (assumed above).** Styled source rows always. Simpler, one
  code path, no jarring switch when the caret arrives, and the DOM-`cellIndex`
  mapping that already produced a CRITICAL bug is deleted. Cost: the real
  `<table>` / `<th scope="col">` DOM disappears entirely, so a screen reader
  never gets table semantics for any table, in any state.
- **Keep the widget when inactive.** The rendered table keeps proper table
  semantics for reading, and only becomes styled source when the caret enters
  it. Cost: two appearances remain, the switch on caret entry remains, and the
  widget path and its coordinate mapping stay alive.

The first was chosen (see the decision table above). It is the cleaner
engineering answer and the one that matches the stated ask most literally, but
it trades away the only proper screen-reader table semantics in the product.

---

## 4b. VERIFIED: `atomicRanges` cannot protect a bare pipe (30 July 2026)

The design delegates caret motion and deletion across a hidden pipe to
`EditorView.atomicRanges`. **That does not work for a one-character range**,
verified against the installed sources:

| path | guard | file |
| --- | --- | --- |
| motion | `if (pos > from && pos < to)` | `@codemirror/view` index.js:3734 |
| deletion | `if (from < pos && to > pos)` | `@codemirror/commands` index.js:1197 |

Both require a position **strictly inside** the range. A pipe hidden as
`[from, from + 1)` has no such integer position, so neither guard can ever fire.
Measured directly:

```
1-char pipe only:  range [4,5) width=1  interior=[]      => atomicRanges CANNOT fire
3-char gap " | ":  range [3,6) width=3  interior=[4,5]   => atomicRanges CAN fire
```

Left unaddressed, Backspace at the start of a cell silently deletes an invisible
delimiter and the table re-parses with a different shape, with nothing on screen
to explain it. That is precisely the silent-corruption class the maintainer's
constraint forbids.

### Resolution — two mechanisms, because one is not always available

1. **Hide the whole inter-cell gap, not the bare pipe.** Decorate ` | ` (the
   trailing space, the pipe, the leading space) as a single replace range. At
   three characters it has interior positions, so `atomicRanges` works. This is
   also what the alignment work already treats as the unit: `TableColumnSlot`
   carries `segmentFrom`/`segmentTo` for exactly this span.
2. **Own the boundary keys explicitly anyway.** A row written `|a|b|` with no
   surrounding spaces still yields a one-character range, so mechanism 1 is not
   guaranteed. Backspace, Delete, ArrowLeft and ArrowRight must be bound to
   commands that detect an adjacent hidden delimiter and step over it or refuse,
   rather than trusting the facet.

Mechanism 2 is a **prerequisite for phase 2**, not a later hardening pass: phase
2 is what makes the pipes invisible, and it must not ship without it.

---

## 5. The hard cases

Each is answered for the recommended design.

### IME composition (CJK/Japanese) inside a cell

The caret is in the real document and there is no widget between the user and
the `contenteditable`, so composition is handled by CodeMirror exactly as it is
in a paragraph. `EditorView.composing` and `EditorView.compositionStarted` are
both available (`index.d.ts:776`, `:783`), and **they do not mean the same thing.**

- `EditorView.composing` is `inputState.composing > 0`
  (`@codemirror/view/dist/index.js:7840`) — true only *after* a composition has
  produced at least one change.
- `EditorView.compositionStarted` is `inputState.composing >= 0` (`:7847`) —
  true from `compositionstart`.

One real hazard remains, and it is ours, not CodeMirror's: the column widths are
recomputed on every document change, and churning widget DOM adjacent to the
composing text node can abort a composition. **Rule: while
`view.compositionStarted` is true, do not recompute column widths for the table
containing the caret — hold the previous widths and recompute on
`compositionend`.** The columns will be momentarily out by a few pixels during
composition, which is the correct trade.

`compositionStarted` is the guard, not `composing`. A freeze gated on `composing`
re-measures and re-lays-out exactly once, at composition start — the worst
possible moment, because it is the frame at which the composing DOM node is
created. Kana→kanji also flips `monospaceWidth` from 1 to 2 per character as
conversion lands (the CJK ranges at `sourceEditorTableModel.ts:54-73` only fire
once it does), so an unfrozen table oscillates in width under the user's hands.

Two things must be frozen together, or the freeze is incomplete:

- the computed column widths; and
- `TableChromeWidget`'s identity — its `eq()`
  (`sourceEditorDecorationsWidgets.ts:19-23`) compares the width value, so any
  width change tears down and rebuilds the widget DOM, which is how IME candidate
  text gets dropped.

This must be proved in the real WKWebView walkthrough; jsdom has no IME, headless
Chromium has no IME, and Tauri's WKWebView cannot be driven headless. **No agent
can settle it, and a green suite is not IME coverage.**

### Undo/redo grouping

Unchanged. One `EditorView`, one `history()` instance, one stack. Decorations
are view-level and generate no history entries. The only new transaction that
enters history is the `|` → `\|` escape below, which is dispatched as a single
`input.type` event so one `Cmd-Z` returns the literal `|` the user typed.

### Selection starting inside a cell and ending outside the table

An ordinary CodeMirror range. The hidden pipes fall inside it and are included
in the copied text, because copy reads `state.doc` rather than the DOM. This is
the case that eliminates options A, B, and C, and D gets it for free.

### Copy / cut / paste

Copy and cut serialise from the document (`index.js:5158`, `copiedRange`), so
they yield source Markdown including pipes. No `clipboardOutputFilter`
(`index.d.ts:1233`) is needed and none should be added — filtering the output
would be the first step toward copying widget labels instead of source, which
the parent spec forbids at rule 4.

Paste is inserted literally and is never transformed. In particular, the pipe
escape below must not apply to pasted text: a pasted Markdown table has to
round-trip byte-for-byte.

### Typing `|` inside a cell

**Decision: auto-escape a typed `|` to `\|`, and justify it as follows.**

Ground truth first, from the installed parser
(`@lezer/markdown/dist/index.js:2051-2072`): the row scanner splits on raw `|`
characters and honours only a preceding backslash (`esc`), and inline parsing
runs *after* the split (`:2054`). So a pipe inside a code span still splits the
cell — backtick quoting does not protect it, and `\|` is the only escape GFM
offers.

The three options were:

1. **Let it through literally.** The purest source-native answer, and the right
   one *today*, because today the pipes are visible so the consequence is
   visible too. Under option D the pipes are hidden, so a stray `|` silently
   splits the cell with no visible cause. Hiding the delimiters is precisely
   what makes this option untenable.
2. **Reject the keystroke.** Silently eating user input violates the project
   invariant that failures are never silent.
3. **Escape it.** The user's evident intent — a pipe in this cell — is
   preserved exactly, in the only encoding GFM accepts.

Implement via `EditorView.inputHandler`
(`index.d.ts:1213`), gated on: the caret is inside a `TableCell` of a valid
`Table` node; `view.compositionStarted` is false; and the input arrived as typed
text. A phase-4 red test must pin that the handler is *not* on the paste path
before this is relied on. The escape is reversible in one undo.

Anyone who genuinely wants to type a structural pipe uses the reveal-source
command — **as an explicit, user-invoked command**, on its own key binding. It is
not an automatic escape hatch and nothing invokes it on the user's behalf; see
"The reveal-source command" below.

### Typing Markdown inside a cell (`**bold**`)

It renders, following the same active-construct reveal rule as everywhere else
in the editor: the `**` markers are hidden while the caret is outside the
emphasis and revealed when it enters. This is consistency, not a special case —
`TableCell` nodes already carry parsed inline children, so removing the
`return false` at `sourceEditorDecorationsPreview.ts:233` is the whole change.

Note the asymmetry this creates and accept it deliberately: emphasis markers
reveal on the active construct, table pipes never reveal. Pipes are structural
delimiters with a dedicated non-textual rendering, in the same family as a task
checkbox; `**` is inline syntax. Section 7 makes this explicit in the spec
rather than leaving it as an undocumented exception.

### A cell whose content makes the row longer than the viewport

**Settled by Gate 2: table row lines opt out of wrapping with `white-space: pre`,
`EditorView.lineWrapping` stays enabled globally, and each table row is its own
horizontal scroll container with the rows' scroll positions kept in sync.** The
table keeps scrolling inside itself, exactly as the read-only widget does today
(`styles.css:613-621`, `overflow-x: auto` on `.nn-lp-table-widget`).

The `white-space: pre` opt-out is sound and scoped: `EditorView.lineWrapping` is a
`contentAttributes` class on `.cm-content` (`@codemirror/view/dist/index.js:8958`)
giving `white-space: break-spaces` (`:6835-6841`), not a per-line property, so a
per-line override reaches table lines and nothing else.

**The measurement this clause originally cited was of a vacuous check, and is
replaced.** It read: "Measured at a 560px pane, table rows returned
`getClientRects().length === 1` while a control paragraph still wrapped to three
visual lines." `.cm-line` is `display: block`
(`@codemirror/view/dist/index.js:6844-6847`), and `Element.getClientRects()`
returns exactly **one** border-box rect for any block box, wrapped or not — so
the check could not have failed for either arm, and the control's "three visual
lines" cannot have come from it. Re-measured in **line boxes** at the default
19.59px line height: table lines **19.59px / 1 box**, control paragraphs
**78.38px / 4 boxes** and **58.78px / 3 boxes**. The treatment holds; the
evidence for it is now a measure that can go red.

**What this clause replaced, and why.** The earlier version of this spec accepted
note-level horizontal scrolling: the row would be `width: max-content`, the
`.cm-scroller` would scroll, and a wide table would scroll the whole note
sideways. Tom rejected that. A wide table scrolls inside its own box *today*, so
under note-level scrolling the scroll behaviour would visibly change the instant
the caret entered the table — the exact discontinuity this slice exists to remove.
An engineering trade this spec had accepted is not one the restated requirement
allows.

**The consequences of the replacement, named honestly.**

- **The scroll container must be the `.cm-line` element itself**, carrying the
  table-row line decoration — never an inner wrapper. CodeMirror's DocView reuses
  a line's own element across updates but rebuilds its children, so a wrapper
  created by a widget loses its `scrollLeft` on every decoration rebuild, i.e. on
  every keystroke. A table that jumps back to column one while you type has failed
  the premise more comprehensively than note-level scrolling ever did.
- **The drawn caret and the drawn selection do not live in the row.** `drawSelection()`
  is enabled (`SourceNoteEditor.tsx:151`) and its layers are appended to
  `view.scrollDOM` (`@codemirror/view/dist/index.js:9403`), positioned from
  `coordsAtPos` (`:9276-9287`), and re-measured only on doc, selection, viewport,
  configuration or geometry change (`:9419`, `:9557`, `:9585`). An element `scroll`
  event does not bubble, so a row scrolling notifies CodeMirror of nothing — and
  the native caret cannot cover for it, because `hideNativeSelection` is
  `Prec.highest` and sets `caret-color: transparent !important` on `.cm-line` and
  `.cm-content` (`:9589` onward), which beats `styles.css:527-530`. **The
  synchroniser must therefore force a layer re-measure from each row's own scroll
  listener**, and the cost of doing that per frame is a measured question, not an
  assumed one.

  > **MEASURED, 30 July 2026. Half of this is rescuable and half is not.** The
  > obvious rescue — `view.requestMeasure(...)` from the row's `scroll` listener —
  > **recovers nothing**: the drift stayed at 380.41px through 61 read callbacks,
  > because a `LayerView` re-queues its *own* `measureReq` only when
  > `layer.update()` returns true or on `update.geometryChanged` (`:9417-9421`),
  > and an unrelated measure request never reaches it. What does work is
  > `view.dispatch({ selection: view.state.selection })`, which makes
  > `cursorLayer.update()` return true (`:9551-9557`) and recovers the caret to
  > **-0.59px** — the marker's own `margin-left: -0.6px`. Its cost is
  > indistinguishable from baseline at frame level (p50 8.3ms / p95 8.7ms / max
  > 9.5ms against 8.3 / 9.0 / 9.3). **What no rescue closes is clipping:** with
  > the caret's character scrolled out of the row's band, the drawn caret painted
  > **369.92px past the row's inline-end edge**. The layers are appended to
  > `scrollDOM` (`:9403`), siblings of `.cm-content`, so no `overflow` on a row
  > can clip them, and clipping CodeMirror's own layers is a kill criterion.
- ~~**`scrollIntoView` will scroll a row scroller, out of band.**~~ **The opposite
  is true, and this bullet was wrong.** `scrollRectIntoView` does walk up and
  scroll any ancestor whose `scrollWidth > clientWidth` (`:540-560`) — but it is
  called as `scrollRectIntoView(this.view.scrollDOM, ...)` (`:3449`), so the walk
  **starts at `.cm-scroller`**, an ancestor of every row, and only ever goes
  further up. It can never descend into a `.cm-line`. Measured: the off-screen
  cell moved **0px** and was never revealed; the note scrolled sideways 178px
  instead. **The hazard is non-reveal, not one-row desync.** A scroll handler
  fixes it, but only one that defers its read — a `scrollHandler` reading layout
  inline throws `Reading the editor layout isn't allowed during an update`, so
  the read must go through `view.requestMeasure`. With that: target row +193px,
  cell in band, 6 of 7 rows following (the 7th is the short alignment row, whose
  `scrollWidth` equals its `clientWidth`, so it physically cannot follow).
- **A scrollbar under every row is unacceptable.** Exactly one scroll affordance is
  presented for the whole table. Two mechanisms are candidates — suppress the
  per-row scrollbars and render one overlay affordance, or let one designated row
  own the visible scrollbar and drive the rest — and the choice is settled by
  measurement, not taste. **Measured: it cannot be.** The engine uses overlay
  scrollbars, so the two candidates are indistinguishable in `clientWidth` /
  `scrollWidth` / `offsetWidth`, and the screenshot half was not run. It reverts
  to a taste call, and it is moot unless Gate 2 survives.
- **Two hazards no analysis anticipated, both measured at P0.** First, CodeMirror
  brackets every inline widget with `<img class="cm-widgetBuffer">`
  (`:2338-2340`, `:2464-2469`); in a grid container those are unplaced items that
  auto-flow into implicit rows, giving **128.78px** rows against a 19.59px line
  box — 6.4x too tall — while every hit-testing probe still passed. Forcing
  `grid-row: 1` on all direct children and parking the buffers in column 1
  returned every row to exactly 19.59px. Second, the deferred-read constraint on
  `scrollHandler` above. Both are encoded in the CT-1 fixture module
  (`app/desktop/src/workspace/sourceEditorTableContractFixture.ts`) so no later
  phase rediscovers them by measuring.
- **Column widths are still shared across rows**, so one long cell widens its
  column for every row. A table is wide for all its rows or none of them.
- **The box is always closed.** Because the frame is the scroll container's own
  border box, the inline-end border stays put while the content scrolls under it.
  This is closer to the read-only widget than the `max-content` design was, and it
  removes the "can the closing border be reached by scrolling?" question — but it
  adds its own: the last column's trailing padding must still be reachable at
  maximum scroll, which grid items in a scroll container classically lose.
- ~~**The global `.cm-content { max-width: 100% }` clamp may no longer be
  needed.**~~ **Measured, and the opposite is true: the clamp is load-bearing
  *for* Gate 2 and no phase may remove it.** The hope was that `width: 100%`
  scroll-container rows would not propagate into `.cm-content`'s intrinsic
  contribution the way a `max-content` row did (measured then: 86.39px → one
  1279.73px line). They do not need to. `.cm-content` is a flex item of
  `.cm-scroller`, its `min-width: auto` resolves to min-content regardless, and
  `overflow-x` on a *descendant* row does not zero that floor. Unclamped:
  `.cm-content` grows to **881.78px**, note-level horizontal scroll appears, a
  control paragraph stops wrapping, and **0 of 7 rows overflow inline** — so no
  row is narrower than its content, no row can become a scroll container, and
  Gate 2 has nothing to scroll. Clamped: `.cm-content` at 400px, no note-level
  scroll, **6 of 7 rows** overflowing correctly.

**This was not proven when it was written, and it has now been measured.** A
scroll container nested inside `contenteditable` is not a well-trodden path.
Every bullet above was a kill check in
`specs/in-place-table-cell-editing-plan.md` §2, run before any production code.
**They ran on 30 July 2026 and the mechanism did not survive intact:** the
`scrollLeft` premise held outright (K2), the clamp turned out to be required
rather than dissolved (K4b), and the drawn caret's *position* is recoverable at
negligible cost — but its *clipping* is not, and `scrollIntoView` never reaches
a row at all. Per this clause's own rule, the decision has returned to Tom with
the numbers and the named fallback rather than being reversed quietly. **Until
he decides, CT-7 is not frozen and the row-scroller phases do not begin.** The
finding is `specs/in-place-table-cell-editing-plan.md` §3 CT-7 and §7 decision 1.

The other alternative — falling back to today's aligned-source rendering above a
measured width, in the spirit of the existing `MAX_TABLE_PREVIEW_CHARS` /
`MAX_TABLE_PREVIEW_ROWS` bounds (`sourceEditorDecorationsPreview.ts:35-36`) — is
not planned and stays in reserve.

Do not escalate to a nested view to solve a layout problem.

### Vertical rules

**Draw them as an absolutely-positioned `::before` on the chrome span, against a
`position: relative` row line.** Measured: 41px of rule inside a 43px row — full
inner height, so the rules join across rows into continuous columns. The chrome
span is inline, so its own border can never be as tall as the row; the
`::before` can.

This supersedes the background-gradient technique this spec originally specified.
The gradient's stated reason was that alignment must not depend on how marks are
split into spans — but under the per-cell mark structure every boundary anchor is
a stable direct grid child at an explicit `grid-column`, so span splitting is
precisely the thing that has been eliminated. The gradient would also require
*cumulative* track offsets, a second computed geometry contract on top of the
track widths, for no measured benefit.

**Two qualifications, both measured at P0 on 30 July 2026.**

*The direct grid children are not only the ones this design emits.* CodeMirror
brackets every inline widget with `<img class="cm-widgetBuffer">`
(`@codemirror/view/dist/index.js:2338-2340`, `:2464-2469`) — eight per row for a
three-column table — and in a grid container they are unplaced items that
auto-flow into implicit rows. Measured: **128.78px** rows against a 19.59px line
box, 6.4x too tall, while every hit-testing probe passed. They must be forced to
`grid-row: 1` and parked in column 1, which returned all five measured rows to
exactly 19.59px. Nothing can stamp them inline, because CodeMirror creates them,
so that rule is the stylesheet's and it is not optional. The full contract is
`app/desktop/src/workspace/sourceEditorTableContractFixture.ts`.

*A genuinely empty cell is unproven, and it cannot use a mark.* `| x |  | z |`
yielded three grid items at columns 1/2/3 with the empty cell honouring its
stamped `grid-column` — but that cell's source is **two spaces**, a non-empty
range. `||`, with nothing between the pipes, is a different path: a
`Decoration.mark` may not be empty, so the cell can only be a zero-length widget,
and that widget brings its own pair of buffers. Recorded as open question CT1-Q1
in the fixture module and settled in the phase that renders it.

Drop the rule widget's own `border-block-start` (`styles.css:705-710`) when the
alignment row becomes a slim divider band, or the header rule draws twice.

### Selection spanning a hidden cell boundary

**Gate 1: refuse the transaction and say why.**

`guardTableDelimiter` returns `null` for any non-empty selection
(`sourceEditorTableCommands.ts:195`), and `atomicRanges` cannot close this: for a
non-empty range `deleteBy` does `from = skipAtomic(from, false); to =
skipAtomic(to, true)` (`@codemirror/commands/dist/index.js:1173-1180`) — atomic
ranges *expand* a deletion outward, they never refuse it. So drag-selecting from
`aa` to `bb` across a cell boundary and typing turns `| aa | bb |` into
`| aabb |`: the row loses a column while the delimiter row still declares two,
Obsidian renders it ragged, and nothing warns. That is a direct breach of the byte
constraint, and it is reachable on this branch **today**, not only under the new
rendering.

The fix is a central `transactionFilter`, all-or-nothing:

- derive the protected delimiter ranges from `tr.startState`;
- inspect **every** component of the `ChangeSet`, including every multicursor
  edit, not just the main range;
- if any part lands inside a protected delimiter, reject the whole transaction —
  the document and every selection range survive unchanged;
- attach the explanation as an `EditorView.announce` effect. Never call into React
  from inside a transaction filter.

Two exceptions are required or ordinary editing breaks: an annotated structural
table command, and a change that removes or replaces an affected table
*entirely*, so Select All and cutting a whole table still work.

One invariant shapes the design and must carry a test rather than be held
quietly: `filter: false` at `@codemirror/commands/dist/index.js:536` means
history's undo and redo dispatch **bypasses transaction filters**. The filter is
safe only because nothing unsafe ever entered history in the first place.

### The reveal-source command

The command is approved and it stays. `Shift-Alt-\`, beside the existing
`Shift-Alt-f` table binding, keyboard-reachable, returning `false` outside a
table. It is the accessible route to the literal delimiters and the route for
anyone who genuinely wants to type a structural pipe.

**What it is not: an automatic escape hatch for the integrity guard.** Nothing
invokes it on the user's behalf. A refused cross-cell transaction announces the
refusal; it does not reveal the source, suggest revealing the source as a bypass,
or fall through to a revealed state. The guard's contract is that the bytes are
preserved and the user is told; the command's contract is that the user can ask
to see the pipes. Wiring the second into the first would turn an explicit user
choice into an invisible fallback, which is the failure this design exists to
avoid.

### Malformed / half-typed tables

Unchanged and free. All decoration keys off a valid `Table` node in the syntax
tree. A half-typed `| a | b` with no delimiter row is not a `Table`, so it gets
no decoration and stays literal — which is the parent spec's rule 3, satisfied
by construction rather than by a check. The moment the delimiter row becomes
valid the table snaps to rendered; a phase-2 test must pin that this transition
does not move the caret.

### Accessibility

- **No focus trap is possible by construction.** There is no separate focusable
  region — no widget with `tabIndex`, no nested editable. This is a positive
  reason to prefer D: the WCAG 2.1.2 bug just fixed at
  `sourceEditorTableCommands.ts:113` cannot recur in the same shape, because
  there is nothing to be trapped in.
- **Tab keeps its current contract.** `tableCellStep` returns `null` at the
  table edges so `Tab` falls through to the browser and keyboard focus leaves
  the editor. Phase 4 must re-assert `SourceNoteEditor.test.tsx:339` and
  `sourceEditorTableCommands.test.ts:59,:63,:70` unchanged, and add the missing
  case: Tab from the last cell of the last row.
- **Screen-reader semantics regress against the rendered widget.** Cell text is
  read as ordinary line content. Do not fake ARIA table roles on sibling line
  elements — invalid ARIA is worse than none. Phase 2 should attach an
  `aria-label` to the table's first row line describing the table's shape
  ("Table, 3 columns, 12 rows"), and phase 6 should raise a follow-up issue for
  proper table semantics rather than pretending this is solved.
- **Reveal must be reachable by keyboard.** The reveal-source command is the
  accessible route to the literal delimiters and must have a key binding, not
  only a pointer affordance. It stays an explicit user-invoked command and is
  never wired in as the integrity guard's automatic fallback — see "The
  reveal-source command" above.
- **A refused edit must be announced.** Under Gate 1 a cross-cell transaction is
  rejected rather than applied. Silence would be indistinguishable from a dead
  keyboard, so the refusal is announced via `EditorView.announce`.
- **Horizontally scrolling rows need a keyboard route.** Under Gate 2 each table
  row is a scroll container, and content scrolled out of view must be reachable
  without a pointer. Cell-to-cell navigation already calls `scrollIntoView`, which
  will scroll the row (`@codemirror/view/dist/index.js:540-560`); confirm that
  covers every off-screen cell.

### CJK / emoji cell widths (issue #86)

**Dissolved for the on-screen path, fixed separately for the on-disk path.**
These are two different problems wearing one function name, and phase 1 splits
them:

- **On screen**, columns are aligned by measured pixel widths. The browser
  measures the glyphs it actually rendered, so East Asian width, emoji ZWJ
  sequences, and proportional fonts all stop mattering. `displayWidth` leaves
  this path entirely.
- **On disk**, `Shift-Alt-f` pads with literal spaces for the benefit of other
  editors, where monospace *column* count is the correct model. That path needs
  a real East-Asian-width (wcwidth-style) count: `Intl.Segmenter` for cluster
  boundaries, then classify each cluster's base code point as wide or narrow.
  The existing test at `sourceEditorTableModel.test.ts:116`, which asserts an
  emoji is one column, is asserting the bug and must be inverted.

---

## 6. Scope

### In scope

Rendering and editing Markdown tables the maintained parser already recognises,
in the existing single source-backed editor, for the desktop client.

### Non-goals

- A table toolbar, drag-to-resize columns, or drag-to-reorder rows.
- Any table syntax GFM does not define (colspan, rowspan, nested block content
  in a cell, multi-line cells).
- Changing what `write_note` sends or how `sourceText.ts` maps separators.
- Any Rust or IPC change. This slice is frontend-only.
- Restoring the read-only block widget as a second appearance. If option D
  ships, one appearance replaces two.

---

## 7. The spec change

### Verdict

The constraint the maintainer was worried about is **not engaged**. Quoting
`specs/source-native-live-preview-editor-implementation-plan.md:14-15`:

> Keep the editor source-backed. No serializer-generated Markdown, hidden
> compatibility mode, or second editable state machine may be introduced.

Option D introduces no serializer (nothing generates Markdown — the document is
the Markdown), no compatibility mode, and no second state machine (one
`EditorState`, one selection, one history, one `contenteditable`). It is the
same class of change as hiding a `##` marker. **No amendment to
`implementation-plan.md` is proposed.**

A different rule *is* engaged, and it needed a small amendment.

### Amendment — `specs/source-native-live-preview-editor.md` — APPLIED

**Status: applied on 30 July 2026**, approved by Tom in session (see section 4).
The diff below is retained for the record and shows the file as it was
*before* the change; its context lines therefore carry the old rule numbering.
The live file now reads 1 through 6, with the new rule at position 2 and the
copy/cut/drag rule at position 5, which is the rule the new rule cross-refers
to. One defect in the diff as originally drafted was corrected on application:
it said "renumbering the rest" but did not renumber, which would have produced
two rule 2s.

The marker-visibility rules at lines 86-95 begin:

> Marker visibility follows these rules:
>
> 1. Reveal all syntax markers for the enclosing construct or active line when
>    the caret or selection enters it.

Option D deliberately does not reveal table pipes when the caret enters a table.
Add one rule after rule 1, renumbering the rest:

```diff
 Marker visibility follows these rules:

 1. Reveal all syntax markers for the enclosing construct or active line when
    the caret or selection enters it.
+2. A structural delimiter that has a dedicated non-textual rendering is exempt
+   from rule 1 and stays hidden while the caret is inside its construct. This
+   applies only to Markdown table cell delimiters and the table's alignment
+   row. Every such construct must offer a keyboard-reachable command that
+   reveals its literal source on request, and its source must still be produced
+   by copy, cut, and drag under rule 5.
 2. Hide or soften markers only when the complete construct is outside every
    selection.
 3. Never hide malformed, ambiguous, or partially typed syntax.
 4. Copy, cut, paste, drag, undo, redo, and selection operate on source text,
    not widget labels.
 5. A decoration failure removes the decoration and leaves the source editable.
```

One further sentence is proposed in the same file, in the list of initially
rendered constructs at line 104, replacing:

```diff
-- Markdown tables supported by the maintained parser;
+- Markdown tables supported by the maintained parser, rendered as bordered
+  cells over their own source rather than as a replacement widget, so the
+  table is editable in place;
```

That is the whole diff: one new rule, one clause. If either is rejected, option
D as specified cannot ship and the behaviour on `feat/table-in-place-editing`
today stands.

---

## 8. Evidence from the throwaway spike

A disposable browser-tier spike was run in real headless Chromium to answer one
question before any of this was recommended:

> With `EditorView.lineWrapping` enabled, do pixel-width pad widgets align table
> columns across rows for a mixed ASCII/CJK/emoji table, does caret hit-testing
> still round-trip, and what happens when a row is wider than the container?

**The spike has been removed from the repository** (30 July 2026). It was
throwaway and uncommitted, and it was picked up by `npm run test:browser` while
it existed. It is preserved outside the repo only as a reference for writing the
phase 1 and phase 5 tests, which replace it. The measurements recorded below are
unaffected by its removal.

It mounted a bare `EditorView` with an inline throwaway decoration builder and
no import from any production table module, in the editor's real **proportional**
font (`Inter Variable`, 16px) rather than the monospace face table source
currently uses. That is the harder case, deliberately.

### What it showed

**Pixel pads align perfectly, in a proportional font, including CJK and emoji.**
Across all six rows of the fixture, both column boundaries landed at exactly the
same x:

| boundary | spread across 6 rows |
|---|---|
| boundary 1 (`x = 311.33`) | **0.00 px** |
| boundary 2 (`x = 539.30`) | **0.00 px** |

The offscreen probe used to measure each cell reproduced the live rendered width
to **0.00 px on all six rows**, CJK and emoji included. The existing browser test
tolerates 1.5px. This is the evidence that browser measurement dissolves issue
#86 rather than merely improving it, and that the monospace requirement can be
dropped entirely.

**Pipes disappear without touching the document.** Rendered pipe count `0`,
document pipe count `18`. `view.contentDOM.textContent` contains no `|`.

**Caret round-trip is exact except where it must not be.** Five of six probes
inside cell text round-tripped exactly through `coordsAtPos` → `posAtCoords`.
The sixth was a mid-surrogate position inside `👍`, which correctly snapped to
the cluster boundary.

**Hidden pipes need `atomicRanges`, and the spike proves it empirically.** The
positions either side of a hidden middle pipe (36 and 37) both render at
`x = 311.33` and both resolve back to 36. Two document positions occupying one
screen point is exactly the ambiguity `EditorView.atomicRanges` exists to
remove, and the phase 2 requirement is not speculative.

**Wrapping does break the grid, as feared.** At a 400px content width with
wrapping on, every row wrapped to two visual lines. Boundary 1 still held at
0.00px spread on the first visual line, but boundary 2 wrapped onto the second
line with a **52.73px spread**, and there was no horizontal scroll to escape to.

There is a design consequence in that number worth stating plainly: column
widths are shared across rows, so **one long cell widens its column for every
row**. In the fixture, a single long row pushed the total to 539px and forced
all six rows to wrap, not just the long one. Wide tables are wide for every row.

**`white-space: pre` on the row lines only is the treatment, and it works.**
Injecting `white-space: pre` on the table-row line class while leaving
`EditorView.lineWrapping` enabled globally:

- every row stayed on one visual line (`visualLines = 1` for all six);
- both boundaries returned to **0.00 px spread**;
- the editor scrolled horizontally (`scrollWidth 539.00` vs
  `clientWidth 400.00`);
- caret round-trip on the long row was **6/6 exact**, and still 2/2 exact after
  `scrollLeft = 120`;
- the cursor layer drew within 0.59px of `coordsAtPos` (device-pixel rounding)
  and the selection layer within 0.02px.

Nothing was detected as broken. **Phase 5 takes the horizontal-scroll route; the
degradation fallback is not needed.**

### Superseded: the horizontal-scroll cost

**This subsection recorded a cost that is no longer accepted.** It read: the
horizontal scroll is the *editor's*, not the table's, so a wide table makes the
whole note scroll sideways, and that is the price of one document and one
`contenteditable`.

Gate 2 rejects it. The scroll stays inside the table, one scroll container per
row, synchronised. The reasoning and the full list of what that costs instead are
in section 5, "A cell whose content makes the row longer than the viewport". The
spike's `white-space: pre` and 0.00px alignment measurements above are unaffected
— what changed is which element owns the overflow, not whether the rows wrap.

The retained-in-reserve alternative is unchanged: cap total column width and clip
long cells, revealing the full cell on caret entry. Not needed to ship, not
planned here.

### Corrected: the line-height finding is stale

**This subsection previously claimed** that the project's `line-height: 1.8` never
reaches the editor content, because CodeMirror's base theme declares `1.4`
directly on `.cm-scroller` and a direct declaration beats an inherited one, and
that measured line height was 22.39px rather than 28.8px.

**That was fixed under issue #92 and the claim is stale at HEAD.** `styles.css`
now carries an explicit rule targeting the scroller, with a comment naming the
issue:

```css
/* CodeMirror's base theme declares `line-height: 1.4` directly on
 * `.cm-scroller` … Target the scroller, with enough specificity to
 * win regardless of stylesheet injection order. (#92) */
.nn-source-editor .cm-editor .cm-scroller { line-height: 1.8; }
```

at `styles.css:490-499`, landed in commit `ec1e509`. Later paragraph measurements
of 28.80px are consistent with the fix having applied. Anyone reading the original
clause today would plan around a bug that no longer exists — which is why it is
corrected here rather than deleted, so the correction is visible to anyone who
remembers the old text.

---

## 9. Phased implementation plan

> **Superseded as the delivery schedule** by
> [`specs/in-place-table-cell-editing-plan.md`](in-place-table-cell-editing-plan.md),
> which carries the phase order, the frozen contracts, the spike's kill checks,
> the lane assignments and the gate commands. The phases below are retained
> because their red-test lists remain the acceptance detail for each area; where
> the two documents disagree on sequencing or ownership, the plan controls.
>
> Three things the plan adds that the phases below do not have: a spike phase
> ahead of everything (Gate 2 is unproven), a `CellPaintPlan` phase between
> phases 1 and 2 (Gate 3), and integrity work as an independently shippable unit
> ahead of the rendering work.

Delivery rules from `implementation-plan.md:10-24` apply unchanged: test-first,
smallest production change per phase, no hand-edited generated contracts.

Every phase below is independently shippable and independently revertable —
each leaves the editor in a coherent state if the next one is never built.

### Phase 1 — Split screen width from disk width (closes #86)

Ships alone as a bug fix, with no visible change to the pipe treatment.

Files:

- update `app/desktop/src/workspace/sourceEditorTableModel.ts`
- update `app/desktop/src/workspace/sourceEditorTableModel.test.ts`
- update `app/desktop/src/workspace/sourceEditorDecorationsWidgets.ts`
  (`TablePadWidget` takes a pixel width)
- update `app/desktop/src/workspace/sourceEditorDecorations.ts`
- update `app/desktop/src/styles.css`
- update `app/desktop/src/workspace/sourceEditorTable.browser.test.tsx`
  (add a CJK row and an emoji row to the fixture)

Red tests:

- `monospaceWidth("中文字")` is 6, `monospaceWidth("日本語です")` is 10,
  `monospaceWidth("👍👍")` is 4 — inverting the assertion at
  `sourceEditorTableModel.test.ts:116`;
- `formatTableAt` pads a CJK table to columns that are equal in monospace
  columns, and is still a no-op on an already-aligned table;
- browser tier: separator x-positions across all rows of a mixed
  ASCII/CJK/emoji table stay within 1.5px (the tolerance the existing test
  already enforces);
- a no-op open of every line-ending fixture still serialises byte-for-byte
  identically.

Green implementation:

- rename `displayWidth` to `monospaceWidth` and give it a real East-Asian-width
  classification; it stays on the `Shift-Alt-f` disk path only;
- measure on-screen column widths in pixels from the rendered glyphs and cache
  the measurement per (font, table revision);
- `TablePadWidget` renders a fixed-width inline-block instead of a run of
  spaces.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorTableModel.test.ts src/workspace/sourceEditorTableCommands.test.ts src/workspace/sourceEditorDecorations.test.ts
npm --prefix app/desktop run test:browser
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run typecheck:browser
npm --prefix app/desktop run lint
```

### Phase 2 — Hide the pipes and draw the cell chrome

The visible payload. After this phase the caret is in a bordered table and there
are no pipes.

Files:

- update `app/desktop/src/workspace/sourceEditorDecorations.ts`
- update `app/desktop/src/workspace/sourceEditorDecorationsPreview.ts`
- update `app/desktop/src/workspace/sourceEditorTableModel.ts`
- update `app/desktop/src/styles.css`
- add `app/desktop/src/workspace/sourceEditorTableChrome.test.ts`
- update `app/desktop/src/workspace/sourceEditorTable.browser.test.tsx`

Red tests:

- every `TableDelimiter` on a header or body row is covered by a zero-width
  replacement, and the same ranges appear in `EditorView.atomicRanges`;
- `ArrowRight` from the end of one cell lands at the start of the next, never
  between the hidden pipes;
- the delimiter row renders as a rule and reveals its literal source when the
  caret is placed inside it;
- the reveal-source command restores every pipe for the table at the caret,
  bound to `Shift-Alt-\` so it sits beside the existing `Shift-Alt-f` table
  binding; a test must assert it collides with nothing already in
  `SourceNoteEditor.tsx:161-196` (three `Mod-Enter` bindings, `completionKeymap`,
  `Tab`, `Shift-Tab`, `Enter`, `Shift-Alt-f`, `foldKeymap`, `defaultKeymap`,
  `historyKeymap`) and that it returns `false` outside a table;
- a half-typed table stays fully literal, and completing the delimiter row does
  not move the caret;
- browser tier: no `|` glyph is rendered on a table row line, and the vertical
  rules align across rows within 1.5px;
- byte-exactness: opening, moving the caret through every cell, and closing
  produces an identical file for LF, CRLF, CR, and mixed-ending fixtures.

Green implementation:

- extend the table `StateField` (never a `ViewPlugin` — `index.js:2743`) with
  the delimiter replacements, the line decorations, and the column-offset custom
  property;
- drop the monospace `.nn-lp-table-source` font treatment
  (`styles.css:657-661`); cells render in the note's own font, which the spike
  measured as aligning to 0.00px once pads are sized in pixels;
- draw vertical rules as an absolutely-positioned `::before` on each chrome span
  against a `position: relative` row line (see section 5, "Vertical rules");
- hold column widths and `TableChromeWidget` identity steady while
  `view.compositionStarted` is true.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorTableChrome.test.ts src/workspace/sourceEditorDecorations.test.ts src/workspace/SourceNoteEditor.test.tsx
npm --prefix app/desktop run test:browser
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
```

### Phase 3 — Live preview inside cells

Files:

- update `app/desktop/src/workspace/sourceEditorDecorationsPreview.ts`
- update `app/desktop/src/workspace/sourceEditorDecorations.test.ts`

Red tests:

- `**bold**`, `*italic*`, `` `code` ``, a wikilink, and an inline tag inside a
  cell each receive their ordinary decoration;
- markers inside a cell follow the ordinary active-construct reveal rule;
- a link inside a cell navigates through the same guarded path as elsewhere and
  an unsafe URL stays inert;
- decoration ranges emitted inside a cell never overlap the hidden pipe ranges.

Green implementation:

- remove the `return false` at `sourceEditorDecorationsPreview.ts:233` and let
  the collector descend into `TableCell`;
- keep the whole-table bounds (`MAX_TABLE_PREVIEW_CHARS`,
  `MAX_TABLE_PREVIEW_ROWS`) as the guard against unbounded descent.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorDecorations.test.ts src/workspace/SourceNoteEditor.test.tsx
npm --prefix app/desktop run test:unit
```

### Phase 4 — Input rules and structure commands

With the pipes hidden, the user needs commands for the operations pipes used to
provide.

Files:

- update `app/desktop/src/workspace/sourceEditorTableCommands.ts`
- update `app/desktop/src/workspace/sourceEditorTableCommands.test.ts`
- update `app/desktop/src/workspace/SourceNoteEditor.tsx` (keymap only)
- update `app/desktop/src/workspace/SourceNoteEditor.test.tsx`
- add an e2e journey under `app/desktop/src/e2e/`

Red tests:

- a typed `|` inside a cell inserts `\|`, and one undo restores a literal `|`;
- a **pasted** `|` is inserted literally and untransformed — and the paste path
  provably does not run `inputHandler`;
- no escaping happens while `view.compositionStarted` is true, or outside a table;
- insert row above/below, insert column left/right, delete row, delete column:
  each produces a well-formed table and each is a single undo step;
- `Tab` at the last cell of the last row still returns `null` so keyboard focus
  leaves the editor (re-assert `sourceEditorTableCommands.test.ts:63` and
  `SourceNoteEditor.test.tsx:339`);
- the e2e journey opens a note with a table, edits a cell, and saves the exact
  expected source through the `mockVault` seam.

Green implementation:

- add the `EditorView.inputHandler` escape, gated on cell context and
  composition state, dispatched as one `input.type` history event;
- add the structure commands beside the existing cell-navigation ones, each
  returning `null` outside a table so every binding falls through.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorTableCommands.test.ts src/workspace/SourceNoteEditor.test.tsx src/e2e
npm --prefix app/desktop run test:unit
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
```

### Phase 5 — Wide rows

**Rewritten for Gate 2.** `white-space: pre` on the table-row line class only,
with `EditorView.lineWrapping` left on globally — and **each table row is its own
horizontal scroll container, with the rows' scroll positions synchronised.** The
note does not scroll sideways.

This phase is no longer stylesheet-only. It splits across two lanes:

Files (`ui-designer`):

- update `app/desktop/src/styles.css` — the row's `overflow`, scrollbar
  suppression, and the single scroll affordance

Files (`coder`):

- add `app/desktop/src/workspace/sourceEditorTableScrollSync.ts` (+ its unit and
  browser tests) — `scroll` listener registration, `scrollLeft` propagation, the
  forced selection-layer re-measure, and scroll-position restoration across a
  decoration rebuild
- update `app/desktop/src/workspace/sourceEditorTable.browser.test.tsx`

Red tests:

- browser tier at a 400px content width, with a row whose natural width exceeds
  the container: every table row stays on one visual line, and both column
  boundaries hold within 1.5px (the spike measured 0.00px);
- set `scrollLeft` on one row; within one frame every other row reports the same
  `scrollLeft`;
- the drawn caret's client rect still coincides with `coordsAtPos` for the caret's
  position after a row has scrolled, and the drawn caret is not painted outside
  the row's border box;
- `scrollLeft` survives a keystroke — no row resets to 0 on a decoration rebuild;
- `posAtCoords`/`coordsAtPos` round-trip exactly for positions on the wide row,
  both at `scrollLeft = 0` and after scrolling;
- Tab to an off-screen cell brings it into view, and the other rows follow within
  one frame;
- exactly one horizontal scroll affordance is visible for a wide table;
- at maximum scroll, the last column's trailing padding and the row's inline-end
  border are both inside the visible band;
- non-table lines still wrap, so the `pre` rule is scoped to table rows and has
  not disabled wrapping for the note.

**Every one of those assertions is spiked before any production code is written.**
The kill checks and their pass/fail observations are in
`specs/in-place-table-cell-editing-plan.md` §2. Phase 5 is no longer exempt from
the kill criteria: if the spike cannot make the scroll containers behave, the
decision returns to Tom rather than falling back silently.

Gate:

```bash
npm --prefix app/desktop run test:browser
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorDecorations.test.ts
```

### Phase 6 — Verification and handoff

No production change. This phase is the definition of done
(`docs/definition-of-done.md`).

Automated:

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run typecheck:browser
npm --prefix app/desktop run test:run
npm --prefix app/desktop run test:browser
npm --prefix app/desktop run coverage
npm --prefix app/desktop run build
bash scripts/rust-quality-gate.sh
gitleaks git . --log-opts=--all --redact
```

`rust-quality-gate.sh` must print GREEN and exit 0; INCOMPLETE (exit 2) is not
green (`docs/definition-of-done.md:44-51`). No Rust changes are expected in this
slice, so a RED there is a pre-existing condition to be reported, not fixed
here.

Manual, in a real WKWebView build:

- Japanese and Chinese IME composition inside a cell, including a composition
  that spans a pad recomputation;
- macOS dictation and dead keys inside a cell;
- VoiceOver over a table, recording honestly what it announces;
- keyboard-only: reach a table, edit a cell, and leave the editor entirely
  using only Tab and arrow keys;
- copy a selection that starts in a cell and ends two paragraphs below, paste it
  into a plain text editor, confirm it is source Markdown with pipes;
- LF, CRLF, CR, and mixed-ending fixtures compared byte-for-byte after a cell
  edit and after a no-op open/close.

Reviews:

- an independent adversarial review, because this changes a decoration layer
  over untrusted Markdown and sits next to the byte-exactness boundary
  (`docs/definition-of-done.md:102-118`);
- a `ux-audit` pass, because a user-facing flow has shipped
  (`docs/definition-of-done.md:137`).

---

## 10. Kill criteria

Abandon this design and revert to the aligned-source behaviour on
`feat/table-in-place-editing` if any of the following is observed. These are
stop conditions, not discussion prompts.

1. **Any byte changes that the user did not type.** A no-op open/close, or a
   caret walk through every cell, produces a file that differs from the
   original for any line-ending fixture. Stop at once; this is the moat.
2. **A phase cannot be built without a nested `EditorView`, a
   `contenteditable` cell, or a DOM-to-source reconcile layer.** That is the
   design failing, not a detail to work around. Reverting is correct; escalating
   to option A is not.
3. **IME corruption.** A real WKWebView CJK composition inside a cell drops,
   duplicates, or reorders characters in a way that does not reproduce in an
   ordinary paragraph — after the `view.compositionStarted` guard is in place.
   Silent text corruption is not a bug to iterate on.
4. **Column rules cannot be aligned in pixels.** The browser-tier spread on the
   mixed ASCII/CJK/emoji fixture stays above 1.5px after phase 1. The spike
   measured 0.00px in a proportional font, so this is now a regression guard
   rather than an open risk — but if the real integration cannot reproduce it,
   the premise that browser measurement dissolves #86 was wrong and everything
   downstream follows from it.
5. **Performance.** p95 key-to-paint exceeds the parent spec's 50ms budget
   (`source-native-live-preview-editor.md:347`) on the 500 KiB fixture with a
   200-row table, after caching the width measurement. A measurement loop on the
   keystroke path that cannot be made cheap is disqualifying.
6. **Focus escape regresses.** In a real keyboard walkthrough, Tab from any
   position inside a table fails to move focus out of the editor. This was a
   real WCAG 2.1.2 bug on this branch already
   (`sourceEditorTableCommands.ts:113`); reintroducing it ends the phase that
   did so.
7. **Caret hit-testing breaks.** `posAtCoords` on a rendered cell returns a
   position outside that cell's source range in the browser tier. Clicking the
   wrong cell is worse than seeing pipes.
8. **Row scroll containers cannot be made to behave. TRIGGERED, 30 July 2026.**
   The drawn caret or drawn selection detaches from the text when a row scrolls
   and cannot be recovered within 1px; or `scrollLeft` resets on a decoration
   rebuild; or no mechanism gives exactly one scroll affordance with the last
   column reachable. This does not silently fall back — the decision returns to
   Tom with the measurements and the named fallback, so it is re-decided rather
   than assumed. The kill checks are in
   `specs/in-place-table-cell-editing-plan.md` §2.

   **What the checks returned.** `scrollLeft` survives a rebuild (all 7 rows kept
   object identity, 0 exceptions) — that half is fine. The caret's *position* is
   recoverable, though not by the prescribed `requestMeasure`: a `selectionSet`
   transaction brings a 380.41px drift back to -0.59px at negligible frame cost.
   The caret's *clipping* is not recoverable at all — 369.92px painted outside
   the scrolled row, and the layers are siblings of `.cm-content` so no row
   `overflow` reaches them. `scrollIntoView` never reveals an off-screen cell
   (0px moved; the note scrolls 178px sideways instead). The single-affordance
   mechanism cannot be chosen by measurement, because the engine uses overlay
   scrollbars. **The decision is with Tom** and the row-scroller phases are
   blocked until he takes it (plan §3 CT-7, §7 decision 1).
9. **Integrity cannot be closed.** Any generic edit, paste, cut, drag or
   multi-selection change can still remove a hidden delimiter after the Gate 1
   transaction filter is in place. The feature cannot ship at all: it breaks the
   byte constraint.

**Phase 5 is now a kill criterion, and it runs first.** The earlier text here read
that phase 5 was deliberately *not* one, because the spike had already proven its
treatment and a disagreeing integration could ship phases 1 to 4 with the
documented degradation. Gate 2 removes that escape: the degradation *was*
note-level horizontal scrolling, and Tom has rejected it. Per-row scroll
containers are unproven, so they are spiked ahead of every other phase — see
criterion 8.

---

## 11. Acceptance

The slice is ready for review only when:

1. A table renders as bordered cells with no visible pipes, and the caret edits
   its source directly, with one appearance rather than two.
2. Copy from inside a cell to outside the table yields source Markdown.
3. Undo after any table edit is one coherent CodeMirror history.
4. Byte-for-byte fixtures pass for BOM, LF, CRLF, CR, mixed endings, and a
   no-op open/close.
5. Issue #86 is closed with a browser-tier regression test carrying a CJK row.
6. Keyboard focus can leave the editor from every position inside a table.
7. A selection spanning a hidden cell boundary cannot change a byte, and the
   refusal is announced (Gate 1).
8. A wide table scrolls inside itself with its rows in sync, one scroll
   affordance, and the caret staying with its text (Gate 2) — or that gate has
   been re-decided by Tom against the spike's measurements.
9. The real-WKWebView IME, dictation, dead-key and VoiceOver walkthrough is
   recorded with its actual results, including the screen-reader regression in
   section 5. A green suite is never read as coverage of it.
10. Frontend, coverage, build, lint, typecheck, **browser-tier**, and
    secret-scanning gates pass, and the independent adversarial review has no
    unresolved high or critical findings.

---

## 12. Changelog

**30 July 2026 — corrections applied.** Each was settled by evidence rather than
preference, verified at HEAD `cd66833`.

| # | What changed | What corrected it |
|---|---|---|
| 1 | The composition guard is `view.compositionStarted`, not `view.composing` (§5 IME, §5 pipe escape, §9 phases 2 and 4, §10 kill 3) | `EditorView.composing` is `inputState.composing > 0` (`@codemirror/view/dist/index.js:7840`) — true only *after* a composition has produced a change — while `compositionStarted` is `>= 0` (`:7847`), true from `compositionstart`. A freeze gated on `composing` re-measures exactly once, at composition start: the worst possible moment. |
| 2 | Vertical rules are an absolutely-positioned `::before` on the chrome span, not a background gradient on the row line (§2 option D, new §5 subsection, §9 phase 2) | The gradient's stated rationale — that alignment must not depend on span splitting — evaporates once every boundary anchor is a stable direct grid child at an explicit `grid-column`. The `::before` was *measured* at 41px of rule in a 43px row (full inner height, joining across rows); the gradient has no measurement and would need a second cumulative-offset geometry contract. |
| 3 | The clause asserting the editor line-height never reaches content is marked stale, not left standing (§8) | Fixed under issue #92 in commit `ec1e509`. `styles.css:490-499` now sets `line-height: 1.8` on `.nn-source-editor .cm-editor .cm-scroller` with a comment naming the issue, and later 28.80px paragraph measurements are consistent with it having applied. |
| 4 | The reveal-source command is reconciled with the integrity guard (§5 pipe escape, new §5 subsection, §5 accessibility) | The command itself is approved and stays, keyboard-bound. What was wrong was wiring it in as the guard's *automatic* escape hatch: under Gate 1 a refused transaction announces the refusal and preserves the bytes; it never reveals the source on the user's behalf or offers reveal as a bypass. |
| 5 | The wide-table clause is rewritten: the table scrolls inside itself, one scroll container per row, synchronised (§2 comparison, §5 wide rows, §8, §9 phase 5, §10 kill 8) | Gate 2. Note-level horizontal scrolling changes the scroll behaviour the instant the caret enters the table, which is the discontinuity this slice exists to remove. The replacement is unproven and is spiked first; its named failure modes are the drawn caret detaching (`@codemirror/view/dist/index.js:9403`, `:9419`, `:9557`, `:9585`, `:9589`+), `scrollLeft` loss on a decoration rebuild, out-of-band `scrollIntoView` (`:540-560`), and the one-affordance requirement. |
| 6 | Gates 1, 2 and 3 are recorded in §4 | Tom, 30 July 2026, after four parallel analyses and a reconciliation. Folded in so the spec stops contradicting the plan. |

**30 July 2026 — P0's measurements landed.** All seven agent-runnable kill checks
in `specs/in-place-table-cell-editing-plan.md` §2 ran in real headless Chromium;
the throwaway spike is deleted. Corrections applied to the clauses concerned:

| # | What changed | What corrected it |
|---|---|---|
| 7 | The drawn-caret rescue is a `selectionSet` transaction, not `view.requestMeasure` (§5 wide rows, §10 kill 8) | `requestMeasure` recovered **nothing** — 380.41px drift unchanged through 61 read callbacks — because a `LayerView` re-queues its own `measureReq` only when `layer.update()` returns true or on `update.geometryChanged` (`@codemirror/view/dist/index.js:9417-9421`). `view.dispatch({ selection: view.state.selection })` makes `cursorLayer.update()` return true (`:9551-9557`) and recovers to -0.59px, at a frame cost indistinguishable from baseline. |
| 8 | The `getClientRects().length === 1` no-wrap measurement is replaced by a line-box count (§5 wide rows) | `.cm-line` is `display: block` (`:6844-6847`), so `getClientRects()` returns exactly one rect whether it wraps or not. The check could not fail for either arm. Re-measured: table lines 19.59px / 1 box, control paragraphs 78.38px / 4 boxes and 58.78px / 3 boxes. |
| 9 | The `.cm-content { max-width: 100% }` clamp stays, and is load-bearing *for* Gate 2 (§5 wide rows) | Unclamped, `.cm-content` grows to 881.78px, note-level scroll appears, and **0 of 7 rows overflow inline** — so no row can become a scroll container. `.cm-content` is a flex item whose `min-width: auto` resolves to min-content; a descendant's `overflow-x` does not zero that floor. Clamped: 400px, 6 of 7 rows overflowing. |
| 10 | `scrollIntoView` does *not* scroll a row scroller; it never reaches one (§5 wide rows, §10 kill 8) | The call is `scrollRectIntoView(this.view.scrollDOM, ...)` (`:3449`), so the walk starts at `.cm-scroller` — an ancestor of every row — and only goes up. Measured: the off-screen cell moved 0px and the note scrolled 178px sideways. The hazard is non-reveal, not one-row desync. |
| 11 | A genuinely zero-length cell (`\|\|`) is recorded as unproven (§5 vertical rules) | The passing probe's middle cell was two spaces, a non-empty range. `\|\|` cannot use a `Decoration.mark` at all, since a mark may not be empty — a different code path, untested. Open question CT1-Q1. |
| 12 | Two hazards no analysis anticipated are recorded (§5 wide rows, §5 vertical rules) | `cm-widgetBuffer` elements (`:2338-2340`, `:2464-2469`) auto-flow into implicit grid rows — 128.78px rows against a 19.59px line box, while every hit-testing probe passed. And a `scrollHandler` cannot read layout inline; it throws `Reading the editor layout isn't allowed during an update`. |
| 13 | The single-affordance mechanism is undecided, not settled by measurement (§5 wide rows) | The engine uses overlay scrollbars, so the two candidates are indistinguishable in layout metrics, and the screenshot half was not run. |

**Known residual staleness, flagged rather than swept.** Section 1's file:line
references describe the branch before its first two phases landed: `TableWidget`
is at `sourceEditorDecorationsWidgets.ts:103` (not `:97`), `TablePadWidget` no
longer exists (it is `TableChromeWidget`), `displayWidth` is now `monospaceWidth`
at `sourceEditorTableModel.ts:99` (not `:62`), and the `Table` `return false` is
at `sourceEditorDecorationsPreview.ts:234` (not `:233`). Section 1 is a historical
framing section; rewriting it wholesale would lose the record of what the design
was reacting to, so it is annotated here instead.
