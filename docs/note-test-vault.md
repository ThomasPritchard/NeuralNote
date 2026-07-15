# Note test vault

`fixtures/note-test-vault` is NeuralNote's reusable manual-QA vault for the
current note surface. It covers frontmatter, title precedence, live-preview
Markdown, tables, Obsidian tags and links, search, backlinks, graph data,
unsupported syntax, Unicode, empty files, extensionless Markdown, plain text,
BOM input, and CRLF preservation.

The source fixture is reviewable test data. Do not open it directly for a
destructive lifecycle test because edits would dirty the repository. Prepare a
fresh ignored copy instead; the preparer also creates exact-byte, large,
   invalid-UTF-8, binary, and over-8-MiB cases that should not live as ordinary
   Git text. It also records byte counts and SHA-256 hashes for preservation
   fixtures:

```bash
node scripts/prepare-note-test-vault.mjs
```

The command refuses to merge into an existing destination. Move or remove a
previous run first so stale files cannot make the walkthrough pass
accidentally. Then:

1. Build `target/dev-builds/NeuralNote-Dev.app` using the commands in
   [Definition of Done](definition-of-done.md).
2. Open `target/manual-note-test-vault` as the vault.
3. Start with `00 Test Index.md` and complete the relevant checklist sections.
4. For note-editor or parser changes, always exercise the Core editor and Edge
   and failure journeys. For search, link, or graph changes, also exercise the
   corresponding linked fixtures.
5. Record skipped cases and blockers in the task handoff. A fixture that could
   not be exercised is not a pass.

Run the preservation verifier before and after merely opening exact-byte notes:

```bash
node scripts/verify-note-test-vault.mjs
```

It compares the disposable vault against its generated baseline and exits
non-zero on a size or SHA-256 mismatch. This makes line-ending, BOM, whitespace,
empty-file, invalid-byte, large-file, and oversized-file checks deterministic.

The test index also defines six exact, equal-length edits. After saving those
edits, verify their expected post-save hashes while retaining the untouched
baseline for every other fixture:

```bash
node scripts/verify-note-test-vault.mjs --controlled-edits
```

When supported note behaviour changes, update the fixture and its coverage map
in the same change. Keep malformed examples explicit and isolated; ordinary
notes must remain valid Obsidian-compatible Markdown and YAML.
