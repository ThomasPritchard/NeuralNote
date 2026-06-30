# Build plan — Vault Slate (app phase 1)

Status: **built + verified** (2026-06-29). Verified by: `cargo test -p neuralnote-core`
(10 tests), `cargo check -p desktop`, `tsc --noEmit`, `vite build`, and a live launch (app
boots, welcome screen renders, `list_recent_vaults` IPC round-trip confirmed). Two
adversarial reviews (code-reviewer + silent-failure-hunter) run; findings fixed (see below).
Remaining manual check: the interactive workspace click-through (open → tree → read → edit →
CRUD) — couldn't be driven headlessly (native WKWebView), handed to Tom with a test script.

## Review findings — fixed

- **HIGH** save could silently clobber a concurrent external edit → optimistic concurrency:
  `write_note` now compares a **content hash** (dependency-free `DefaultHasher`, stable across
  runs, sent as a string) and refuses with `CoreError::Conflict`; the editor offers
  reload-or-overwrite. `write_note` returns the fresh `NoteDoc` it built from the saved bytes,
  so a landed write can never be mislabelled a failure (and can't cascade into a self-conflict).
- **MED** rename forced `.md` onto non-markdown files → only markdown files keep a markdown ext.
- **MED** tree-changed listener leak (cleanup before `listen()` resolved) → `cancelled` flag.
- **MED** `save()` not load-token-guarded (draft clobber) + stuck "Saving…" → guarded + always
  clears `saving`.
- **MED** frontend path math hardcoded `/` → separator-agnostic (`normSep`) for Windows latency.
- **LOW** frontmatter could be a non-object (mis-render) → only YAML mappings accepted; depth cap
  (48) on the recursive scan; watcher errors logged not dropped; atomic-write temp cleaned on
  rename failure; `FormEvent` deprecation removed.

## Deferred (documented, non-blocking for a local-markdown macOS v1)

Restrictive CSP + remote-image gating (revisit in the AI/capture phase, when notes carry remote
content); keyboard-accessible "move to…" alternative to drag-drop + modal focus-trap (a11y
follow-up); lazy / breadth-capped tree scan for very large folders; folder-picker
cancel-vs-conversion-failure distinction. Windows full path-correctness (v1 ships macOS-only).

---


Goal: the desktop "slate" — open or create a vault, view its documents, and add/remove
folders & files. **No AI yet** (capture/distil/embed/chat is the next phase). This is the
foundation the AI features will later plug into.

## Decisions locked (with Tom, 2026-06-29)

- **Welcome UX:** full-screen in-app welcome view (one window). Workspace replaces it once a
  vault is active. No multi-window, no modal-over-empty-room.
- **Edit scope:** view (rendered markdown) + full file/folder management (create, rename,
  delete, move) + **inline markdown editing** that saves to disk (plain editor, not rich yet).
- **Repo structure:** Tauri app in `app/desktop/`; shared Rust core in
  `crates/neuralnote-core/`; Cargo workspace at repo root. Prototype stays in `prototype/`
  as reference only.

## Stack (verified against current Tauri 2 docs via Context7, 2026-06-29)

- **Tauri 2** shell. Scaffold reference: `create-tauri-app@2` (we hand-roll the layout for the
  `app/desktop` + `crates` split). Commands via `#[tauri::command]` + `invoke` from
  `@tauri-apps/api/core`. Backend→frontend via `emit`/`listen`.
- **Native folder picker:** `tauri-plugin-dialog` v2 (`app.dialog().file().pick_folder`).
  Permissions declared in `src-tauri/capabilities/*.json`.
- **All other filesystem work stays in our own typed Rust commands** (core crate, `std::fs` +
  a dir walker + `notify` watcher). The webview gets **no ambient FS authority** — only our
  vault commands. This is the security spine: delete/rename/overwrite of the user's real data
  never goes through an over-broad plugin scope.
- **Frontend:** React 19 + Vite + Tailwind v4 + shadcn, reusing the locked `neuralnote` theme
  tokens and the `NeuralNote.tsx` workspace from the prototype. Markdown render:
  `react-markdown` + `remark-gfm` (verify versions at impl time).
- **Rust:** `serde`, `notify` (fs watch), `trash` (recoverable delete), frontmatter via
  `gray_matter`/`serde_yaml` (verify at impl time).

## Architecture — three layers

```
crates/neuralnote-core   pure Rust domain. scan tree · read/write md+YAML · CRUD ·
  (client-agnostic)      recent vaults · path-safety. No Tauri dep → reusable by future clients.
        ▲
app/desktop/src-tauri    thin shell. wraps core in commands · app state (open vault) ·
  (thin shell)           dialog plugin · notify watcher → emits vault://tree-changed.
        ▲
app/desktop/src          React. welcome screen + workspace, via a thin invoke data layer.
  (frontend)
```

## Contract (frozen before fan-out)

Domain types (Rust serde → camelCase TS mirror): `Vault`, `TreeNode` (folder|file, recursive,
`path` + `relPath`), `NoteDoc` (`frontmatter` map + `body` + `raw` + `frontmatterError`),
`RecentVault`.

Commands: `list_recent_vaults`, `pick_vault_folder`, `pick_new_vault_location`, `open_vault`,
`create_vault`, `close_vault`, `read_tree`, `read_note`, `write_note`, `create_folder`,
`create_note`, `rename_entry`, `delete_entry` (→ OS trash), `move_entry`.

Event: `vault://tree-changed` (watcher → frontend re-reads tree).

## Safety invariants (high-stakes: real user data)

1. **Every path is validated to live inside the open vault root.** Reject `..` escapes / symlink
   escapes. No command operates outside the vault.
2. **Delete → OS trash** (`trash` crate), never permanent `remove`. A wrong delete is recoverable.
3. **Writes are crash-safe** (temp file + atomic rename) so a mid-write crash can't corrupt a note.
4. **Failures are never silent** — malformed frontmatter surfaces as `frontmatterError` (still
   shows the raw file); collisions/permission errors return typed errors the UI renders.
5. **Data format stays Obsidian-compatible** — markdown + YAML frontmatter, our metadata isolated
   in a `.neuralnote/` sidecar that never pollutes the markdown tree.

## Execution (ultracode)

1. **Foundation + contract (inline):** scaffold workspace, Tauri shell, Vite/React, theme port;
   write frozen contract (Rust type/sig stubs + TS types + invoke wrappers + App routing shell).
   Gate: `cargo check` + `tsc` clean, app boots to welcome placeholder.
2. **Fan-out (Workflow) against frozen contract:** Rust slice (core+commands+watcher) ‖ frontend
   welcome/data slice ‖ frontend workspace slice. (Rust isolated to avoid cargo-lock contention.)
3. **Integrate + verify:** `cargo check` + `tsc` + launch app; fix wiring.
4. **Adversarial review (parallel):** `code-reviewer` ‖ `silent-failure-hunter` over the diff;
   fix severity-first; re-review delta.
5. **Surface gaps + persist** decisions to memory.

## Definition of done

App launches → welcome → open an existing folder (incl. a real Obsidian vault) **or** create a
new one → file tree renders real files → click a note → rendered markdown → edit + save → create
/rename/delete/move files & folders, with on-disk changes reflected live → all paths vault-scoped,
deletes recoverable, failures surfaced. Verified by `cargo check` + `tsc` + a manual run.
