---
tags:
  - neuralnote/test-vault
  - qa/index
aliases: [Manual test index]
---
# NeuralNote note test vault

This vault is a disposable manual-QA fixture for the current note experience. Work through the checklist in a fresh copy, not this source fixture.

## Core editor journey

- [ ] Open [[01 Frontmatter/All property types]]. The title appears first and Properties appears below it.
- [ ] Click the `qa/frontmatter` property tag. Search opens with `tag:#qa/frontmatter`.
- [ ] Return to the note, click **Edit YAML**, then **Done** without editing. The visual Properties view returns and the note stays clean.
- [ ] Edit a YAML tag, click **Done**, and confirm stale chips are not shown. Save, then confirm the refreshed tag is clickable.
- [ ] Click **Edit YAML**, remove the closing `---`, then click **Done**. Raw YAML remains visible with the repair message. Restore the delimiter, click **Done**, and confirm Properties returns.
- [ ] Open [[02 Markdown/Headings and inline formatting]]. Put the caret into each heading and verify the exact `#` markers remain visible while editing.
- [ ] Open [[02 Markdown/Tables]]. Inactive tables are semantic; clicking one reveals its exact Markdown source.
- [ ] Activate the inline `#qa/editor` tag in [[03 Obsidian/Tags]]. Search includes exact and nested descendants, but excludes prefixes and masked syntax.
- [ ] Follow the links and backlinks among [[05 Search and graph/Project Alpha]], [[05 Search and graph/Project Beta]], and [[05 Search and graph/Project Gamma]].

## Persistence journey

- [ ] Edit [[99 Scratch/Disposable note]], switch to another note, return, and confirm the unsaved draft remains.
- [ ] Save it and reopen it to confirm exact source preservation.
- [ ] Rename it and verify the tree label, breadcrumb, and tab update to the new name. Existing unresolved source links remain unchanged rather than being silently rewritten.
- [ ] Delete it and verify the open pane clears. Recopy the vault to restore it.

## Editing and navigation journey

- [ ] Toggle tasks with pointer, Space, and Enter. Verify undo and redo restore the exact checkbox source.
- [ ] Exercise bold, italic, link, and H1-H3 Format actions on one and multiple selections.
- [ ] Copy, cut, paste, drag, undo, and redo decorated Markdown. The clipboard and saved file contain source text, not widget labels.
- [ ] Type `[[`, choose a completion by keyboard, then continue with `#` and `|`. Verify duplicate `Duplicate.md` notes show disambiguating paths.
- [ ] Plain-click an inactive resolved Markdown link and wikilink; each opens its vault note through the guarded resolver. Place the caret immediately before and after each link, confirm its exact source becomes editable without navigating, and verify Mod-Enter still opens it.
- [ ] Activate the filename-derived title in [[04 Titles/Filename title fallback]], save it, and confirm an exact leading source H1 was inserted.
- [ ] Create a note and folder, move the note, and exercise dirty-tab close, conflict, Reload, and Overwrite prompts without silent data loss.

## Graph, backlinks, and native journey

- [ ] On [[05 Search and graph/Project Alpha]], verify both linked backlinks and the unlinked mention from `Unlinked mention.md`. Open `05 Search and graph/Orphan.md` from the file tree (not through a wikilink) and verify the backlink empty state.
- [ ] In Graph, verify the isolated node, cross-folder relationships, search, cluster drill-down, and Open in reader.
- [ ] Open the generated large, invalid-UTF-8, and binary fixtures. Confirm performance remains usable and failures/content substitutions are explicit.
- [ ] Open generated `Oversized editable note.md`, make an edit, and save. The write is rejected with the 8 MiB limit stated explicitly, the on-disk file is unchanged, and the recoverable draft remains available.
- [ ] With full keyboard access, reduced motion, VoiceOver, an IME, dead keys, and dictation where available, verify the source editor remains operable and announcements are meaningful.

## Edge and failure journey

- [ ] [[01 Frontmatter/Malformed YAML]] shows the parse error and raw offending YAML without hiding its body.
- [ ] [[06 Edge cases/Unsupported syntax]] stays editable and never executes HTML, MDX, Dataview, or math.
- [ ] [[06 Edge cases/Unicode and long content]] preserves Unicode, emoji, combining text, RTL text, and long wrapped lines.
- [ ] `README` renders as Markdown even without an extension; `06 Edge cases/Plain text.txt` keeps its file type and exact source while using the shared source editor.
- [ ] Run `node scripts/verify-note-test-vault.mjs`, open the zero-byte, one-blank-line, BOM, CRLF, CR-only, mixed-ending, trailing-whitespace, and no-final-newline notes, then rerun it. Opening alone must not change a baseline byte.
- [ ] Make these exact one-byte case changes and save: BOM `This`→`this`; CRLF `Edit`→`edit`; CR-only `Every`→`every`; mixed endings `Body`→`body`; trailing whitespace `spaces`→`Spaces`; no-final-newline final `.`→`!`. Run `node scripts/verify-note-test-vault.mjs --controlled-edits`; every entry must pass with BOM, separators, trailing whitespace, and final-newline state preserved.

## Coverage map

| Area | Fixture |
| --- | --- |
| YAML values, scalar/list tags, raw/visual round trip | `01 Frontmatter/` |
| ATX/Setext headings and inline formatting | `02 Markdown/Headings and inline formatting.md` |
| Lists, tasks, quotes, callouts, thematic breaks | `02 Markdown/Lists tasks quotes and callouts.md` |
| Tables and inline cell content | `02 Markdown/Tables.md` |
| Code, standard links, URLs, images, inert HTML | `02 Markdown/Code links and media.md` |
| Inline tags and exclusions | `03 Obsidian/Tags.md` |
| Wikilinks, aliases, fragments, block IDs, embeds | `03 Obsidian/` |
| Title precedence | `04 Titles/` |
| Search, backlinks, and graph relationships | `05 Search and graph/` |
| Unicode, unsupported syntax, extensions, empty notes | `06 Edge cases/` |
| Exact bytes, large file, invalid UTF-8, binary | generated `07 Exact-byte and size/` |
