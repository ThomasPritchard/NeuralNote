# NeuralNote source-native live-preview editor

Status: approved by the maintainer on 15 July 2026.

This specification replaces the rich-editor/raw-editor split defined in the
0.2.0 interaction release. Where it conflicts with the `In-place note editing`
section of `specs/v0.2.0-interaction-release.md`, this document controls.

## Outcome

Every UTF-8 text note within the existing resource limits has one editing
surface. Markdown remains the actual editor document, while syntax-aware
decorations make it read like rendered content. There is no separate read mode,
raw Markdown mode, compatibility preflight, or whole-note fallback caused by
unsupported syntax.

The intended interaction matches source-native live preview:

- `## Heading` is stored exactly as typed. Away from the active heading, the
  marker is hidden and the line uses heading typography. Entering that heading
  reveals its marker for editing.
- Emphasis, strong text, lists, tasks, blockquotes, links, code, and other
  supported Markdown receive in-place typography and widgets without changing
  their source.
- Typing `[[` opens vault-note completion. Choosing an item inserts an exact
  Obsidian wikilink and the inactive construct renders as a link treatment.
- Unknown, malformed, or plugin-owned syntax stays visible and editable as
  literal source. A missing decoration never blocks editing or saving.

The persistent `Markdown` file-type pill and the global `Continue in raw
Markdown` warning are removed from the note surface.

## Architecture

### One source-backed editor

Replace `RichNoteEditor` and the textarea-based raw `Editor` with one
lazy-loaded `SourceNoteEditor` adapter built directly on CodeMirror 6.

Use direct, locked dependencies rather than relying on transitive packages:

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/commands`
- `@codemirror/language`
- `@codemirror/lang-markdown`
- `@codemirror/autocomplete`

The adapter owns CodeMirror-specific state, decorations, completion, and
history. Application note state continues to own strings, dirty state,
conflicts, and persistence. CodeMirror types must not cross webview IPC or
enter Rust contracts.

The editor document is the complete text file, including a byte-order mark and
frontmatter when present. Frontmatter may be folded or presented through the
existing Properties treatment while inactive, but its exact source remains in
the editor document and can be revealed for editing. NeuralNote must not parse
and reserialize frontmatter as part of an ordinary note save.

### Live-preview decorations

Use the maintained Markdown language parser and syntax tree for standard
Markdown. Viewport-aware `ViewPlugin` extensions build `Decoration.mark`,
`Decoration.line`, `Decoration.replace`, and inert widgets. Decorations update
on document, viewport, and selection changes.

The source string is authoritative. Decorations never create replacement
Markdown and never mutate the document as a side effect of rendering.

Marker visibility follows these rules:

1. Reveal all syntax markers for the enclosing construct or active line when
   the caret or selection enters it.
2. Hide or soften markers only when the complete construct is outside every
   selection.
3. Never hide malformed, ambiguous, or partially typed syntax.
4. Copy, cut, paste, drag, undo, redo, and selection operate on source text,
   not widget labels.
5. A decoration failure removes the decoration and leaves the source editable.

Initial rendered constructs are:

- ATX and Setext headings;
- emphasis, strong emphasis, strikethrough, and inline code;
- ordered and unordered lists, task checkboxes, and blockquotes;
- fenced code, thematic breaks, standard links, and inert image treatments;
- Markdown tables supported by the maintained parser;
- Obsidian wikilinks, aliases, heading and block fragments, and embeds;
- Obsidian callout markers and block IDs where a conservative decoration is
  possible without changing source.

Unsupported extensions, Dataview, raw HTML, MDX, JSX, math, footnotes, or an
unknown plugin grammar remain ordinary editable source until a dedicated
decoration exists. They do not cause a fallback.

Raw HTML, MDX, and JSX are never mounted or executed. Rendered labels and
widgets use DOM text APIs rather than unsanitized HTML.

### Wikilinks and embeds

Reuse the existing vault-note index, filtering, and resolution rules rather
than inventing a second link resolver.

Typing `[[` starts a CodeMirror `CompletionSource`. The completion popup:

- filters by note title, stem, and vault-relative path;
- remains keyboard navigable;
- shows disambiguating paths for duplicate names;
- inserts the selected target before the closing `]]`;
- supports continuing with `#` for a heading or block fragment and `|` for
  display text;
- keeps unresolved and partially typed links editable.

An inactive resolved wikilink renders as a link label. Normal click positions
the caret and reveals its source. Primary-modifier click (Command on macOS,
Control on Windows and Linux) opens the resolved note through the existing
guarded workspace path. Unresolved targets remain visibly distinct and do not
navigate.

Images and embeds begin as non-fetching, inert preview treatments. Rendering an
attachment or note body is a separate capability that requires native
vault-path validation, bounded reads, file-type checks, and explicit tests.
Neither construct may fetch an arbitrary network URL or escape the vault
through a widget.

### Note frame and title

Remove the file-type pill from `NoteDocumentFrame` for all notes.

When the body contains a leading H1, that source heading is the visible title
and receives live-preview heading typography. Do not remove it from the editor
document. When no leading H1 exists, show the derived title as an accessible
placeholder inside the same CodeMirror surface. Activating it inserts an exact
source H1 after any valid frontmatter and places the caret in that heading. It
must not mutate the note merely because it was rendered or focused. Malformed
frontmatter retains the external derived title because a safe insertion point
cannot be proven.

Keep the existing path toolbar, Save action, frontmatter error, lossy-text
warning, Properties treatment, conflict controls, and backlinks. Save remains
explicit through the toolbar and Command-S.

## Source preservation and persistence

### Single save path

Text notes save through the existing full-document `write_note` boundary using
the vault-relative path, replacement text, and expected content hash. Preserve
the existing path authorization, symlink and race protections, optimistic
conflict detection, atomic temp-sibling write, cleanup, overwrite, and reload
behaviour.

The editor must not save merely because a note was opened, focused, decorated,
or parsed. A no-op document remains clean. A save sends only the exact source
string represented by the editor session.

After the source-native path is proven, remove the obsolete rich-edit surface:

- the syntax allowlist and raw dispositions in `neuralnote-core`;
- top-level rich block parsing and block IDs;
- source-range patch DTOs and rich read/write commands;
- generated rich-edit bindings;
- `richEditorAdapter`, MDXEditor preflight, and fallback state;
- the MDXEditor dependency and app-level duplicate rich/raw histories.

Do not keep two editable state machines after migration.

### Exact text and line endings

CodeMirror uses a logical line model internally, so NeuralNote owns exact
serialization.

On load:

1. Preserve the byte-order mark as part of the source string.
2. Record every original line separator (`LF`, `CRLF`, or `CR`) by logical line
   boundary.
3. Give CodeMirror the logical text and a per-document default separator.

On each transaction, map unchanged line boundaries through the change set.
Retain their original separators. New boundaries inherit the nearest separator
in the edited region, falling back to the document's dominant separator and
then the platform-independent `LF` default.

On save, rebuild the complete string from logical lines and the mapped
separator sequence. Preserve trailing separators, trailing spaces, tabs,
Unicode, BOM, and mixed line endings outside the edited region exactly.

If the separator map cannot be updated unambiguously, block that save, retain
the draft, and show a specific preservation error. Do not silently normalize
the file and do not switch to another editor mode.

### Tabs, history, and external changes

The editor adapter owns an ephemeral CodeMirror session per open tab, keyed by
the tab identity and loaded content hash. This keeps selection, scroll, folded
state, and undo history when switching tabs without putting CodeMirror objects
in application or IPC contracts.

Closing a tab destroys its session after the existing unsaved-change guard.
Vault close destroys all sessions. Reload after an external change creates a
fresh session from disk. Overwrite preserves the active draft and uses the
existing explicit conflict path.

## Formatting and commands

The native Format menu remains the command source. The adapter translates
format actions into CodeMirror transactions over every selection.

- Bold, italic, headings, and links edit Markdown source directly.
- Undo and redo use CodeMirror history.
- Command-S uses the existing save action.
- Remove the obsolete mode-toggle command and Command-E path.

Formatting must remain deterministic for empty selections, multiple
selections, nested delimiters, Unicode, and selections crossing line endings.

## Failure handling

- Parser or decoration errors leave the exact source visible and editable and
  surface a non-blocking error.
- Unknown or malformed Markdown is not an error unless an explicit user action
  such as navigation or embed resolution cannot be completed.
- Unsafe or unsupported links remain inert source.
- Binary notes retain the existing non-editable preview treatment.
- Invalid UTF-8 retains the current visible lossy-text warning. Saving remains
  an explicit destructive choice because exact recovery of unreadable bytes is
  impossible in a text editor.
- Oversized notes surface a clear resource-limit error and retain their source;
  the limit is not presented as a Markdown compatibility failure.
- Save, conflict, and I/O failures keep the draft recoverable and visible.

## Security and trust boundaries

Markdown, frontmatter, file paths, links, completion input, pasted content,
widgets, and embed targets are untrusted.

- Editing and decoration do not authorize filesystem or network access.
- Raw HTML, MDX, JSX, scripts, event attributes, and unsafe URLs never execute.
- Link navigation uses the existing validated vault-relative resolver and
  guarded open-note path.
- External URL navigation retains the maintained safe-scheme boundary.
- Embed resolution remains native-owned, vault-scoped, bounded, and
  non-following for unsafe symlinks before any file content is exposed.
- Completion labels and widget text use text nodes, not raw HTML.
- The editor document and line-ending map are bounded before being retained in
  memory or sent through IPC.
- Update `NeuralNote-threat-model.md` for the source-native decoration,
  completion, navigation, and future embed boundaries.

This is security-sensitive because it removes a grammar rejection boundary.
An independent adversarial review must compare editor interaction behaviour
with the real Markdown and Obsidian grammars before the change is merge-ready.

## Accessibility and interaction

- The editor exposes a stable `Note content` accessible name and multiline
  text-editing semantics.
- Keyboard navigation, selection, completion, formatting, undo, redo, Save,
  Escape, and focus return work without a pointer.
- Completion follows maintained combobox/listbox semantics and announces its
  result count and active option.
- Replaced syntax and widgets do not trap the caret or remove source from copy
  and screen-reader output.
- Task checkboxes have an accessible name and update the Markdown source.
- Reduced-motion preferences disable decorative transitions.
- VoiceOver, IME composition, dictation, dead keys, and full keyboard access
  require a real WKWebView walkthrough before merge readiness.

## Test-first implementation contract

Every production change begins with a focused failing test.

### Pure editor logic

- decoration ranges for headings, emphasis, lists, tasks, links, code, tables,
  wikilinks, embeds, callouts, and block IDs;
- active-construct marker reveal and multiple selections;
- malformed and unknown syntax remaining undecorated and editable;
- `[[` completion filtering, insertion, aliases, fragments, unresolved targets,
  duplicate names, and keyboard selection;
- deterministic Format-menu source transforms;
- line-separator map creation, transaction mapping, inserted boundaries,
  deleted boundaries, mixed endings, terminal separators, BOM, trailing spaces,
  tabs, and Unicode;
- exact no-op source identity.

### Component and journey tests

- one editor surface for every text note with no compatibility request or raw
  fallback banner;
- Markdown pill removal;
- heading and wikilink marker reveal away from and inside the active construct;
- completion popup and guarded note navigation;
- Save, no-op, dirty state, tabs, history, reload, overwrite, and write errors;
- malformed frontmatter, raw HTML, MDX, Dataview, math, tables, callouts,
  embeds, and unknown plugin syntax all remaining editable;
- unsafe links and embeds staying inert;
- accessibility labels and completion semantics.

### Native and manual verification

- exact full-document writes and stale-hash conflicts through the real IPC
  boundary;
- no symlink, path-race, or atomic-write regression;
- real WKWebView caret placement, selection, clipboard, drag, IME, dictation,
  undo, redo, task toggles, completion, navigation, and VoiceOver;
- LF, CRLF, CR, and mixed-ending fixtures compared byte for byte after local
  edits;
- no-op open and close compared byte for byte;
- 500 KiB and 5,000-paragraph performance fixtures.

## Performance and packaging gates

Build decorations only for visible ranges plus a bounded margin. Parsing and
decoration must not scan the entire document on every keystroke.

On the maintainer's release machine:

- median editor-ready time over five cold opens of the 500 KiB fixture is at
  most 1.5 seconds;
- p95 key-to-paint latency across 20 representative edits is at most 50 ms;
- the source editor is lazy-loaded;
- the initial JavaScript bundle grows by no more than 50 KiB gzip;
- the editor chunk remains at most 600 KiB gzip;
- removing MDXEditor must not leave duplicate editor dependencies or dead
  production code.

## Acceptance

The editor slice is ready for the release branch only when:

1. Every supported text note opens in the same source-native editor without a
   mode switch or compatibility warning.
2. Standard Markdown and wikilinks demonstrate live-preview behaviour while
   preserving the exact source.
3. Unknown and malformed syntax remains editable and cannot execute.
4. Exact-file tests pass for BOM, LF, CRLF, CR, mixed endings, trailing
   whitespace, tabs, Unicode, frontmatter, and no-op opens.
5. Conflict, atomic-write, path, link, and embed safety controls pass.
6. Frontend, Rust, bindings, coverage, build, audit, and secret-scanning gates
   pass.
7. The packaged DEV build passes the manual keyboard, IME, VoiceOver,
   completion, navigation, and source-preservation walkthrough.
8. Independent UI and adversarial security reviews have no unresolved high or
   critical findings.

## Non-goals

- Executing raw HTML, MDX, JSX, Dataview, or plugin code.
- Fetching remote content from embeds.
- Rendering every third-party Obsidian plugin grammar in the first pass.
- Changing the vault's Markdown or YAML ownership contract.
- Weakening path, conflict, atomic-write, or explicit failure handling.
- Reintroducing separate read, rich, and raw editing modes.
