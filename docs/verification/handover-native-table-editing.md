# Handover — native verification of in-place table editing

Give this whole file to an agent that can drive a real GUI on a Mac. It is self-contained.

Everything here exists because it **cannot** be tested any other way. The automated suites are
green: 1547 in jsdom, 47 in headless Chromium. None of that touches input methods, dictation, dead
keys, or the real WebKit renderer the app actually ships in. Do not treat a green suite as evidence
for anything below.

---

## What was built

NeuralNote is a Tauri 2 desktop notes app whose editor previously swapped a Markdown table between
two appearances: a bordered table when the caret was elsewhere, and raw pipe-delimited text the
moment you clicked into it. The work under test draws the bordered cells over the *live editable
text*, so the appearance no longer changes as you type.

The bytes on disk stay ordinary GitHub-Flavoured-Markdown pipe tables. That is a hard product
constraint, not a nicety — the vault must stay openable in Obsidian. **Several checks below exist
purely to catch a violation of it, and they are the most important ones here.**

---

## Setup

```bash
cd /Users/thomaspritchard/Documents/projects/NeuralNote-tables
git rev-parse --abbrev-ref HEAD      # expect: feat/table-in-place-editing
git status --short                   # expect: clean, or only untracked scratch
bash scripts/dev-build.sh
```

The script prints the bundle path. Launch it:

```bash
open '/Users/thomaspritchard/Documents/projects/NeuralNote-tables/target/debug/bundle/macos/NeuralNote-Dev-feat-table-in-place-editing.app'
```

**Confirm you are driving the right build before anything else.** The window title must read
`NeuralNote-Dev-feat-table-in-place-editing`. Two ways to get this wrong, both of which look
completely normal:

- A plain `NeuralNote` title means you opened the user's installed production app.
- **There is a stale `NeuralNote-Dev.app` in that same bundle directory, a day older and built
  before this work existed.** Its window title is `NeuralNote-Dev`, without the branch suffix. It
  will launch, open the vault, and behave like a working app — and show you none of the changes
  under test. Do not open it. The full path above is the one that matters.

Every observation made against the wrong build is worthless.

If the build fails on a missing `binaries/ollama-*` or `yt-dlp` path: those are large gitignored
sidecars a fresh worktree lacks. Copy them from `/Users/thomaspritchard/Documents/projects/NeuralNote`
and rebuild. Do not edit the build config to route around it.

**Open this vault:** `/Users/thomaspritchard/Documents/projects/NeuralNote-tables/fixtures/note-test-vault`
**Open this note:** `02 Markdown` → `Tables.md`

Before you touch anything, in a terminal:

```bash
cd /Users/thomaspritchard/Documents/projects/NeuralNote-tables
git status --short fixtures/
```

Note whether it is clean. You will compare against this repeatedly.

---

## The checks

Record **what you observed** for each, then the verdict. If you cannot tell, say so — "unclear" is
a usable result and a wrong "pass" is not.

### 1. The headline requirement

Click into a table cell and type a few characters.

- **PASS** — the bordered cells and shaded header stay drawn the whole time. You are typing *inside*
  a visible cell.
- **FAIL** — the table turns into raw text with `|` pipes when the caret enters, at any point.

Screenshot before clicking in, and while typing.

### 2. Bytes unchanged by looking (the constraint check)

Close the note **without typing anything** this time. Click into several cells, arrow around the
table, click out, switch notes.

```bash
git status --short fixtures/
git diff -- fixtures/
```

- **PASS** — no change to `Tables.md`.
- **FAIL** — any diff at all. Paste it. Reading a note must never modify it; a spurious change would
  show up as vault churn for anyone syncing.

### 3. Round-trip fidelity

Now type `hello` into a cell, save, and:

```bash
git diff -- fixtures/
```

- **PASS** — the diff shows exactly your five characters inside the existing pipe structure, and the
  line still has the same number of `|` characters as before.
- **FAIL** — pipes added or removed, whitespace reflowed across the whole table, or the row's column
  count changed.

Then `git checkout -- fixtures/` to reset.

### 4. Input methods (this is the main event)

Add Japanese input: System Settings → Keyboard → Text Input → Edit → `+` → Japanese → Romaji.

Click into a table cell, switch to Japanese, and type `nihongo` then press Space to convert to
kanji, then Return to commit.

- **PASS** — the inline conversion candidates appear over the cell, conversion works, the committed
  text lands in the cell, and the table is still drawn as a table.
- **FAIL** — characters dropped, duplicated, or reordered; the candidate window appears somewhere
  unrelated; the cell loses focus mid-composition; the table flickers to raw text.

**Compare against a control**: do the exact same thing in an ordinary paragraph in the same note.
If both behave identically, that is a pass even if the IME itself feels awkward — you are testing
whether the table's drawing *interferes*, not whether macOS IME is pleasant.

### 5. Dead keys

In a table cell, press Option-E then E (should give `é`). Then Option-U then O (`ö`).

- **PASS** — accented character composes correctly, same as in a paragraph.
- **FAIL** — the accent lands in a different cell, gets dropped, or the pending accent is visibly
  lost when the table redraws.

### 6. Dictation

With the caret in a table cell, press the dictation shortcut (Fn twice, or as configured) and speak
a short phrase.

- **PASS** — text lands in the cell; the table stays drawn.
- **FAIL** — text lands outside the table, is split across cells, or the app becomes unresponsive.

If dictation is not enabled and you cannot enable it, report **not run**. Do not skip silently.

### 7. Caret placement by click

Click directly on a specific character in the middle of the *last* cell of the *last* row. Type `X`.

- **PASS** — `X` appears exactly where you clicked.
- **FAIL** — it appears in a different cell, at the start of the table, or in the wrong row.

### 8. Vertical motion

Put the caret in the middle cell of the first body row. Press Down, then Up.

- **PASS** — the caret moves between rows and stays in a sensible column.
- **FAIL** — the caret jumps out of the table, lands in the delimiter row as visible text, or the
  hidden row structure becomes visible.

### 9. Wide table — horizontal scroll (behaviour recently changed here)

Make a table wide enough to overflow: add several columns, or narrow the window.

Scroll the table horizontally (two-finger swipe, or Shift-scroll).

- **PASS** — the table scrolls **inside itself**; the rest of the note does not slide sideways;
  all rows move together and the columns stay lined up.
- **FAIL** — the whole note scrolls sideways, rows move independently, or columns visibly shear
  apart mid-scroll.

### 10. Caret suppression when scrolled away

This behaviour was deliberately changed and has never been seen on this platform.

Put the caret in the **first** cell of that wide table. Now scroll the table right, far enough that
the first cell is off screen.

- **PASS** — the table scrolls freely to its full extent, and the blinking caret is simply not
  drawn while its character is out of view. Scroll back and the caret reappears in the right place.
- **FAIL** — either the table refuses to scroll past a short distance (the caret is "holding it
  hostage"), **or** a caret is drawn floating outside the table, over other text.

Both failure modes matter. The first is the behaviour that was just removed; the second is what the
removal risks reintroducing. Screenshot whichever you see.

### 11. Click after scrolling

Still scrolled right, click on a character in a visible cell and type `Z`.

- **PASS** — `Z` lands where you clicked.
- **FAIL** — it lands in the cell that *would* have been there unscrolled, i.e. the click is being
  resolved against the wrong horizontal position.

### 11b. The keyboard shortcuts actually fire (suspected broken — read before running)

**This is a live suspicion, not a regression check.**

Two commands are bound to Option chords: `Shift-Option-F` reformats a table's source, and
`Shift-Option-\` reveals its hidden pipes so column alignment can be edited.

There is reason to think **neither reaches the editor on macOS**. CodeMirror skips its base-key
fallback for any Option combination without Control or Command
(`@codemirror/view/dist/index.js:9189`, whose own comment reads *"Alt-combinations on macOS tend to
be typed characters"*), so a binding must match the character the OS reports — and macOS turns
Option+Shift+`\` into `»` and Option+Shift+`F` into `Ï`. No automated tier can settle it: the suites
invoke these commands directly and never press the keys.

With the caret inside a table:

1. Press **Shift-Option-\**. Expected: the `|` pipes and the `| --- | --- |` alignment row become
   visible as literal text. Press again — they should hide.
2. Press **Shift-Option-F**. Expected: the source is reformatted so the columns line up.

- **PASS** — both do what they say.
- **FAIL** — nothing happens, or a stray character (`»`, `Ï`) is inserted into the cell.

**A stray character appearing in the cell is the most informative outcome**, so report exactly what
you see rather than only whether it worked. If either fails, say whether the *other* did too:
`Shift-Option-F` shipped some time ago, and the same defect would mean it has never worked from the
keyboard.

### 11c. Column alignment can be edited

With the pipes revealed above, change a column's alignment marker — `| --- |` to `| ---: |` — then
move the caret out of the table.

- **PASS** — the edit is accepted and the table redraws.
- **FAIL** — the edit is refused, or accepted but the drawn table ignores it.

If 11b failed, report this **not run** rather than reaching for another route. It depends on that
reveal.

### 12. Obsidian still opens it

```bash
git checkout -- fixtures/
```

Type into a couple of cells, save. If Obsidian is installed, open the same vault folder in it and
view `Tables.md`.

- **PASS** — Obsidian renders it as a normal table.
- **FAIL** — Obsidian shows a broken or ragged table, or raw pipes.

If Obsidian is not installed, report **not run** — do not substitute a Markdown preview in another
tool and call it equivalent.

### 13. Undo

Type in a cell, then press Cmd-Z several times.

- **PASS** — your edits undo cleanly and the document returns to its original bytes (`git diff`
  clean).
- **FAIL** — undo leaves the table malformed, removes pipes, or stops partway.

---

## Reporting

For every check: what you did, what you saw, the verdict, and a screenshot for anything visual.

Report **not run** for anything you could not perform, and say why. A missing check is information;
a check marked pass because it was skipped is a defect in the report.

If the app crashes, hangs, or a table visibly disappears at any point — stop, capture the state,
note exactly what you had just done, and report it. A table vanishing is a known theoretical risk
and nobody has yet seen whether it happens in practice.

Finally, always finish with:

```bash
cd /Users/thomaspritchard/Documents/projects/NeuralNote-tables
git status --short
```

and report it, so any accidental modification to the repo is visible rather than left behind.
