# Source-native live-preview editor implementation plan

Status: proposed for implementation approval on 15 July 2026.

This plan implements `specs/source-native-live-preview-editor.md` on
`feature/neuralnote-0.2.0`. It does not authorise a commit, push, pull request,
merge, tag, release, or deployment. The existing OpenRouter/model-menu changes
in the worktree remain intact.

## Delivery rules

- Work test-first. Each numbered slice starts red, receives the smallest
  production change, and finishes green before the next slice begins.
- Keep the editor source-backed. No serializer-generated Markdown, hidden
  compatibility mode, or second editable state machine may be introduced.
- Keep `write_note` as the only persistence boundary. Retain its vault-path,
  conflict, symlink/race, atomic-write, and explicit-error controls.
- Treat Markdown, completion text, links, images, embeds, and widget labels as
  untrusted. Raw HTML, MDX, JSX, scripts, and remote media remain inert.
- Do not hand-edit generated TypeScript contracts. Change Rust sources, run the
  binding generator, and remove only obsolete generated outputs that no longer
  have a Rust source type.
- Determine and lock the current stable CodeMirror 6 package versions from the
  primary package metadata immediately before dependency installation.

## Slice 1 — Exact source model

Files:

- add `app/desktop/src/workspace/sourceText.ts`
- add `app/desktop/src/workspace/sourceText.test.ts`
- update `app/desktop/package.json` and `app/desktop/package-lock.json`

Setup before the first red run:

- verify and add only the direct locked CodeMirror dependencies. This makes the
  real `ChangeSet` and editor APIs available to the tests; it does not add
  product behaviour.

Red tests:

- split and rebuild BOM, LF, CRLF, CR, mixed endings, empty files, terminal
  separators, consecutive blank lines, trailing spaces, tabs, and Unicode;
- map unchanged separators through insertions, deletions, replacements, and
  multi-range CodeMirror changes;
- assign a deterministic separator to new boundaries using the nearest edited
  region, then the dominant document separator, then LF;
- reject an ambiguous map update without losing the recoverable draft;
- prove byte-for-byte identity for a no-op document.

Green implementation:

- represent CodeMirror's logical text separately from a bounded per-boundary
  separator map;
- expose pure load, transaction-map, and serialize functions;
- retain BOM and all non-line-ending characters in the logical text;
- never normalize source as an incidental effect of parsing or rendering.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceText.test.ts
```

## Slice 2 — Source editor adapter and tab sessions

Files:

- add `app/desktop/src/workspace/SourceNoteEditor.tsx`
- add `app/desktop/src/workspace/SourceNoteEditor.test.tsx`
- add `app/desktop/src/workspace/sourceEditorSession.ts`
- add `app/desktop/src/workspace/sourceEditorSession.test.ts`

Red tests:

- mount one accessible multiline editor from an exact source string;
- emit exact reconstructed source after transactions and emit nothing for a
  no-op view update;
- surface a specific preservation error when serialization is unsafe;
- restore selection, scroll, folds, and CodeMirror history when switching tabs;
- destroy one session on tab close and every session on vault close;
- keep session objects out of React domain state and IPC contracts.

Green implementation:

- lazy-load `SourceNoteEditor`;
- keep `EditorState` snapshots in an adapter-owned bounded registry keyed by
  tab identity and loaded content hash;
- bridge CodeMirror transactions to the exact-source model from slice 1;
- use CodeMirror history for undo/redo rather than copying whole documents into
  `useNoteTabs`.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceText.test.ts src/workspace/sourceEditorSession.test.ts src/workspace/SourceNoteEditor.test.tsx
npm --prefix app/desktop run typecheck
```

## Slice 3 — Standard Markdown live preview

Files:

- add `app/desktop/src/workspace/sourceEditorDecorations.ts`
- add `app/desktop/src/workspace/sourceEditorDecorations.test.ts`
- update `app/desktop/src/workspace/SourceNoteEditor.tsx`
- update `app/desktop/src/styles.css`

Red tests:

- decorate headings, emphasis, strong, strikethrough, inline/fenced code,
  lists, tasks, blockquotes, thematic breaks, links, inert images, and tables;
- hide or soften markers only outside every selection and reveal the entire
  active construct or line at the caret;
- keep malformed and partially typed constructs literal;
- preserve source selection, copy text, undo, redo, and multi-cursor behaviour;
- convert a decoration exception into undecorated editable source.

Green implementation:

- consume the maintained Markdown syntax tree;
- build viewport-bounded marks, line decorations, replacements, and inert
  widgets through a `ViewPlugin`;
- style the editor from existing NeuralNote tokens and the application font;
- use DOM text nodes only and never mount parsed HTML.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/sourceEditorDecorations.test.ts src/workspace/SourceNoteEditor.test.tsx
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
```

## Slice 4 — Obsidian constructs and wikilink completion

Files:

- add `app/desktop/src/workspace/obsidianLivePreview.ts`
- add `app/desktop/src/workspace/obsidianLivePreview.test.ts`
- add `app/desktop/src/workspace/wikilinkCompletion.ts`
- add `app/desktop/src/workspace/wikilinkCompletion.test.ts`
- update `app/desktop/src/workspace/SourceNoteEditor.tsx`
- retain and extend `app/desktop/src/workspace/wikilinkAutocomplete.ts` and its
  tests as the pure trigger/filter/insertion layer;
- retain and reuse `app/desktop/src/workspace/linkResolve.ts`

Red tests:

- recognize wikilinks, aliases, heading/block fragments, embeds, callout
  markers, and block IDs without consuming malformed or unknown syntax;
- open completion after `[[`, filter by title/stem/path, disambiguate duplicate
  names, support keyboard selection, and insert exact source;
- continue editing with `#` and `|` and preserve unresolved links;
- normal click reveals source; primary-modifier click navigates only through a
  validated resolved vault path;
- keep unsafe URLs, unresolved links, images, and embeds inert and non-fetching.

Green implementation:

- add a conservative viewport-aware Obsidian scanner beside the standard
  Markdown syntax tree;
- implement a native CodeMirror `CompletionSource` over the existing note
  index;
- route navigation through the existing `resolveMarkdownLink` and guarded
  workspace `onOpenLink` seam;
- render labels and chips with text nodes, with no filesystem or network access.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/obsidianLivePreview.test.ts src/workspace/wikilinkCompletion.test.ts src/workspace/linkResolve.test.ts src/workspace/SourceNoteEditor.test.tsx
```

## Slice 5 — Workspace integration and single draft state

Files:

- update `app/desktop/src/workspace/NotePane.tsx` and its tests;
- update `app/desktop/src/workspace/Reader.tsx` and its tests;
- add `app/desktop/src/workspace/sourceDocumentTitle.ts` and its tests for a
  conservative BOM/frontmatter/LF/CRLF-aware leading-H1 decision;
- replace the unused `useOpenNote` implementation with a small `OpenNote`
  contract module, port its still-relevant race/save assertions to the tab
  controller, and remove its duplicate hook tests;
- update `app/desktop/src/workspace/useNoteTabs.ts` and its tests;
- update `app/desktop/src/workspace/Workspace.tsx` and its tests;
- retain the pure transforms in `app/desktop/src/workspace/markdownFormat.ts`,
  extend their selection edge-case tests, and invoke them through CodeMirror
  selection transactions;
- update affected journeys under `app/desktop/src/e2e/` and `mockVault.ts`.

Red tests:

- every supported text note mounts the same editor immediately, including
  wikilinks, embeds, tables, Dataview, math, raw HTML, MDX, malformed Markdown,
  malformed frontmatter, and mixed line endings;
- no compatibility request, raw-mode warning, mode switch, or Markdown pill is
  rendered;
- the leading source H1 owns the visible title only when it matches the derived
  title; otherwise the document title remains;
- frontmatter Properties can reveal the exact source without reserialization;
- Save, dirty state, in-flight typing, conflict, reload, overwrite, rename,
  close guards, tab switching, and write failures retain their current safety;
- native Format actions target the focused source editor;
- binary and explicitly oversized/unsupported resources keep a clear
  non-editable treatment.

Green implementation:

- replace the `RichNoteEditor`/textarea selection logic in `NotePane` with the
  lazy source editor;
- make the full exact `draft` the only editable application value;
- remove `NoteMode`, rich document/body/error/history actions, rich refreshes,
  and rich patch construction from both note hooks;
- pass a stable session key from the active tab to the editor and dispose it on
  close/clear;
- remove the file-type pill from `NoteDocumentFrame` while retaining title,
  Properties, warnings, backlinks, Save, and conflict controls;
- keep `setMenuEditing` enabled only for an editable text note.

Gate:

```bash
npm --prefix app/desktop run test:run -- src/workspace/NotePane.test.tsx src/workspace/Reader.test.tsx src/workspace/useNoteTabs.test.ts src/workspace/Workspace.test.tsx src/e2e/backlinks-templates.e2e.test.tsx src/e2e/note-crud.e2e.test.tsx
npm --prefix app/desktop run test:unit
```

## Slice 6 — Retire the obsolete rich-edit protocol

Files:

- remove `app/desktop/src/workspace/RichNoteEditor.tsx` and its tests;
- remove `app/desktop/src/workspace/richEditorAdapter.ts` and its tests;
- remove the old textarea `Editor.tsx` and tests; `NotePane` is its only
  production consumer and is replaced in slice 5;
- remove `@mdxeditor/editor` and its styling;
- remove rich-edit imports, wrappers, and tests from
  `app/desktop/src/lib/api.ts`, `api.test.ts`, and `types.ts`;
- remove `read_rich_note` and `write_rich_note` from
  `app/desktop/src-tauri/src/commands/vault.rs` and command registration;
- remove rich-edit integration from `crates/neuralnote-core/src/note.rs`;
- remove `crates/neuralnote-core/src/rich_edit.rs`,
  `crates/neuralnote-core/tests/rich_edit.rs`, and
  `crates/neuralnote-core/tests/rich_edit_io.rs`;
- remove the `rich_edit` module export;
- regenerate bindings and remove the now-obsolete generated `RichEdit*` files.

Red/green contract:

- first move the existing 8 MiB editable-note bound into the retained note
  boundary as `MAX_EDITABLE_NOTE_BYTES`, and pin rejection at both the native
  command and core write seams so an oversized request cannot mutate the file;
- pin `read_note`/`write_note` conflict, invalid-content, path, symlink, atomic
  write, temp cleanup, overwrite, lossy-text warning, in-flight edit behaviour,
  BOM/frontmatter, LF/CRLF/CR/mixed endings, trailing whitespace, Unicode, and
  arbitrary Obsidian/plugin syntax with focused regression tests;
- then remove the duplicate protocol and prove there are no remaining
  production references to rich editing, MDXEditor, raw fallback, or its DTOs;
- do not weaken the existing full-write boundary to make cleanup easier.

Gate:

```bash
cargo test -p neuralnote-core --locked
npm --prefix app/desktop run gen:bindings
npm --prefix app/desktop run check:bindings
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:unit
```

## Slice 7 — Adversarial, accessibility, and performance proof

Files:

- add focused fixtures/tests beside the source editor modules;
- update `NeuralNote-threat-model.md`;
- update the 0.2.0 specification only if implementation evidence requires a
  documented, user-approved contract change.

Automated proof:

- adversarial constructs cannot execute HTML/MDX/JSX, navigate unsafe schemes,
  fetch remote images/embeds, escape the vault, or inject widget DOM;
- completion and decorations remain bounded on malformed/oversized input;
- 500 KiB/5,000-paragraph fixtures meet the approved cold-open and key-to-paint
  budgets;
- production bundle measurements meet the initial- and editor-chunk budgets;
- exact-source reconstruction is measured in the key-to-paint path; if a full
  rebuild misses the latency budget, update the application draft from mapped
  transaction patches rather than scanning the complete document per keypress;
- accessibility tests cover the editor label, focus, completion semantics,
  task controls, error announcements, and reduced motion.

Manual WKWebView proof:

- caret placement and marker reveal in headings, emphasis, lists, links, and
  wikilinks;
- selection, multi-line clipboard, drag, undo/redo, native Format actions,
  task toggles, `[[` completion, guarded navigation, tab history, and conflicts;
- IME composition, dictation, dead keys, full keyboard access, and VoiceOver;
- LF, CRLF, CR, and mixed-ending fixtures compared byte-for-byte after edits;
- no-op open/close compared byte-for-byte.

Request independent UI and adversarial security reviews after implementation.
Resolve every high/critical issue and material source-loss risk before moving
to the final gate.

## Slice 8 — Full verification and NeuralNote-DEV handoff

Run and inspect the complete applicable gate:

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:unit
cargo test --workspace --locked
npm --prefix app/desktop run check:bindings
npm --prefix app/desktop run coverage
npm --prefix app/desktop run build
npm --prefix app/desktop run audit:all
./scripts/rust-quality-gate.sh
gitleaks git . --log-opts=--all --redact
```

Then:

1. Run the real-app walkthrough and record exact results.
2. Run the local SonarQube milestone gate; report `Unavailable` as unavailable,
   never as passed.
3. Build a fresh local development app and replace
   `/Users/thomaspritchard/Documents/projects/NeuralNote/target/dev-builds/NeuralNote-DEV.app`.
4. Report its build timestamp and bundle hash so Tom can verify he is opening
   the new build.
5. Stop for Tom's hands-on issue review. Do not commit until he says this issue
   batch is ready.

## Completion evidence for this slice

- one exact-source editor works for every supported text note;
- Markdown and Obsidian constructs provide the approved live-preview behaviour;
- unsupported syntax remains editable and inert;
- the Markdown pill, compatibility warning, MDXEditor, rich/raw state split,
  and rich-edit IPC/core protocol are absent;
- automated, native, accessibility, security, performance, and byte-preserving
  checks have recorded results;
- the refreshed `NeuralNote-DEV.app` is available for Tom's manual verification;
- no commit, push, PR, merge, tag, release, or deployment occurs without the
  corresponding approval already established in the parent release workflow.
