# Inline tag rendering and search

Status: approved for implementation (2026-07-15).

## User-visible contract

- `#tag` in ordinary Markdown text is an Obsidian-compatible inline tag, not a
  heading. `# Heading` remains an ATX heading.
- The editor preserves and displays the exact tag source while applying a
  restrained tag treatment. Only the contiguous tag token is styled.
- Activating a tag with a pointer, or pressing Mod-Enter while the caret is in
  it, opens the Search sidebar and submits the visible query `tag:#tag`.
- Activating a string tag in the visual YAML Properties treatment uses the
  same search path. Scalar and sequence forms of the root `tags` property are
  supported; unrelated properties and non-string values remain inert.
- Search is case-insensitive. An exact tag query also matches its nested
  descendants: `tag:#inbox` matches `#inbox` and `#inbox/to-read`, but not
  `#myjob/inbox` or `#inbox-old`.
- Tag search includes valid inline tags and the frontmatter `tags` property.
  It ignores tag-like text in code, inline and reference links, embeds, escaped
  text, HTML syntax, and malformed or ambiguous frontmatter.
- Search results keep the existing `SearchResponse` shape, explicit skipped
  file and truncation reporting, guarded note opening, and editable query field.

## Tag grammar

- A tag begins at the start of text or after whitespace and starts with `#`.
- The name may contain letters, numbers, underscore, hyphen, forward slash,
  and commonly accepted Unicode symbols, including emoji and joined emoji
  sequences. The editor, native search, and test mock use the same grammar.
- A tag contains no whitespace and must contain at least one non-numeric
  character. Bare `#` and numeric-only tags such as `#1984` are invalid.
- Tag comparison is case-insensitive. The source spelling is never rewritten.

## Architecture

- The viewport-bounded Obsidian live-preview scanner emits source-preserving
  marked ranges with the canonical tag value as data.
- The shared Properties renderer emits native tag buttons only when a search
  callback is present and the value satisfies the same tag grammar. It keeps
  the displayed YAML spelling while normalizing the callback to one leading
  `#`.
- `Workspace` owns a nonce-based search request. It switches the persistent
  Search panel into view and injects `tag:#tag`; the nonce allows repeated
  activation of the same tag to refocus and rerun safely.
- `search_vault` recognizes the single `tag:` operator without changing its
  IPC request or response contract. Ordinary full-text search remains
  unchanged.
- The mock vault mirrors tag-search semantics for frontend journeys.

## Verification requirements

- Parser tests cover valid Unicode and nested tags, invalid boundaries,
  numeric-only tags, quoted and malformed frontmatter, code, escaped text,
  inline and reference links, embeds, and HTML.
- Interaction tests cover pointer and keyboard activation, repeated requests,
  stale search cancellation, exact source preservation, and accessible status
  announcements.
- An end-to-end journey proves tag activation opens filtered results and a
  result still opens through the existing guarded path.
- Search/parser changes receive an independent adversarial review and the
  relevant performance regression checks.
