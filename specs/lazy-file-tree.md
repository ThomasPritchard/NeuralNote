# Lazy file-tree scanning (issue #40)

Status: DRAFT — awaiting Tom's approval. Design only; no production code written.
Supersedes the deferred note in [`app-vault-slate-plan.md`](app-vault-slate-plan.md) line 30
("lazy / breadth-capped tree scan for very large folders").

## Problem

`read_tree` scans the **entire** vault recursively up front (`crates/neuralnote-core/src/tree.rs`:
`read_tree` → `scan_dir` recurses to `MAX_DEPTH = 48`). On a large Obsidian vault (the headline v1
user) that is a big synchronous walk on every open and every `tree-changed` refresh, and the whole
tree crosses the IPC boundary as one payload. Tom chose **lazy per-directory child loading** over a
flat entry cap.

## The one thing to protect

Lazy loading is for the **FileTree DISPLAY only.** Search, the link graph, backlinks, AI retrieval
(the moat) and template discovery all need the **full** vault. The design keeps them on the
existing full scan and adds a *separate* shallow command for the tree. Nothing that feeds retrieval
or citation ever reads the lazily-loaded subset.

## Decision: why the moat is safe by construction

Every server-side consumer calls the **core** `neuralnote_core::tree::read_tree` function directly —
not the `read_tree` Tauri command. Verified callers:

| Consumer | File | Uses | Verdict |
|---|---|---|---|
| Full-text search | `crates/neuralnote-core/src/search.rs`:79 | `read_tree` + `markdown_files` | **keeps full scan** |
| Link graph | `crates/neuralnote-core/src/links/mod.rs`:87 | `read_tree` + `markdown_files` | **keeps full scan** |
| Backlinks | `crates/neuralnote-core/src/backlinks.rs`:26 | `read_tree` + `markdown_files` | **keeps full scan** |
| AI retrieval / folder note-counts | `crates/neuralnote-core/src/ai/retrieval.rs`:193,236,373 | `read_tree` + `markdown_files` | **keeps full scan (moat)** |
| Template discovery | `crates/neuralnote-core/src/templates/discovery.rs`:33 | `read_tree` + `markdown_files` | **keeps full scan** (already folder-scoped) |
| CRUD node return | `crates/neuralnote-core/src/entries.rs` (`node_for`) | `node_for` → `scan_dir` | unchanged (see §CRUD) |
| **FileTree display** | `app/desktop/src/lib/store.tsx`:72,85,121 → `api.readTree()` → `read_tree` command | **the only IPC caller** | **moves to lazy** |

Because the tree display is the *only* consumer of the IPC command, making it lazy cannot starve
search or the graph — they never depended on the frontend tree. **Invariant for reviewers: no
server-side consumer may be rewired to reuse the lazy partial tree. Search must find, and chat must
cite, a file that is currently hidden behind an "N more…" row or inside an unexpanded folder.**

## Contract (freeze before fan-out)

### New core function — `crates/neuralnote-core/src/tree.rs`

```rust
/// Per-directory breadth cap for the DISPLAY path only. A single folder with more
/// than this many visible entries returns the first CAP (sorted) plus a truncation
/// count. Search/graph/retrieval are uncapped — a truncated file is still indexed.
const DIR_LISTING_CAP: usize = 5_000;

/// One directory's immediate children, non-recursively. Applies the SAME hidden-skip
/// (`is_hidden`) and symlink-skip (`file_type.is_symlink()`) protections as `scan_dir`,
/// and the SAME folders-first, case-insensitive sort. Folders in the result carry
/// `children: None` — meaning "not loaded yet", distinct from a file's `None`
/// (disambiguated by `kind`). No depth recursion, so `MAX_DEPTH` is irrelevant here.
pub fn list_dir(root: &Path, dir: &Path) -> CoreResult<DirListing>;
```

New model type in `crates/neuralnote-core/src/model.rs` (ts-rs `#[ts(export)]`, regenerates the TS
binding on `cargo test`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirListing {
    /// One level of children. Folders carry `children: None` (unloaded).
    pub entries: Vec<TreeNode>,
    /// `Some(n)` = n further entries in THIS directory were omitted by the cap;
    /// `None` = complete listing. Drives the explicit "N more…" row (never silent).
    pub truncated: Option<u32>,
}
```

`TreeNode` is **unchanged** — reused as-is. A folder node with `children: None` now means
"unloaded"; a folder with `children: Some(_)` still means "children present" (still produced by
`read_tree`/`node_for`, so those paths are untouched).

### New Tauri command — `app/desktop/src-tauri/src/commands/vault.rs`

```rust
#[tauri::command]
pub(crate) async fn list_dir(state: SharedState<'_>, path: String) -> Result<DirListing, CoreError>;
```

- `async` → Tauri worker pool, same recipe as `read_tree` (sync body, guard never crosses an await).
- Path safety: resolve `path` against the vault root and pass through
  `neuralnote_core::paths::ensure_within` before listing — the webview may not list outside the root
  (mirrors `read_backlinks`). An empty/`"."` path lists the root.
- Error shape: existing `CoreError`. An unreadable directory (permissions) surfaces as
  `CoreError::Io`, rendered by the UI as a per-folder error row (§UI). Never swallowed.
- `read_tree` command **stays** (search/graph still trigger through their own commands, and the
  full walk is the server-side primitive). It is simply no longer called by the frontend store.

### Frozen frontend contract (coder ↔ ui-designer boundary)

Store surface (coder owns):

```ts
type DirStatus = "loading" | "loaded" | "error";
interface LoadedDir { status: DirStatus; children: TreeNode[]; truncated: number | null; error?: string; }

// store state
loaded: Map<string, LoadedDir>;   // key = relPath ("" for root)
expanded: Set<string>;            // relPaths of expanded folders (persisted)

// store actions
listDir(relPath: string): Promise<void>;   // fetch + cache; sets loading→loaded/error
toggle(relPath: string): void;             // expand (triggers listDir if unloaded) / collapse
refreshDir(relPath: string): Promise<void>;// re-list one directory (CRUD + watcher use this)
```

New `FlatRow` variants (coder owns the union in `flattenTree.ts`; ui-designer owns their rendering):

```ts
type FlatRow =
  | { kind: "node"; node: TreeNode; depth: number }
  | { kind: "create"; /* … unchanged … */ }
  | { kind: "loading"; parentРath: string; depth: number }   // folder children in flight
  | { kind: "error"; parentPath: string; message: string; depth: number }
  | { kind: "more"; parentPath: string; count: number; depth: number }; // "N more…" truncation
```

## Data flow (lazy)

```
open vault → store.listDir("")                         // root only
user expands folder F → store.toggle(F)
    ├─ if unloaded → listDir(F): loading row → list_dir IPC → loaded rows (+ "N more…" if capped)
    └─ if loaded   → just reveal cached children
collapse F → keep cache (fast re-expand); flattenTree stops descending into F
watcher tree-changed (debounced) → refreshDir() for EVERY currently-loaded dir
CRUD (create/rename/delete/move) → refreshDir(affected parent[s]) — never a full re-read
```

## Design fork for Tom — default expand state

Lazy loading is incompatible with today's **"all folders open by default"** (empty collapsed set =
everything expanded). Rendering all-open requires loading every folder's children, which is the
eager walk again. So expansion must *drive* loading, which means folders **default to collapsed**.

- **Recommended — collapse-by-default, persist the EXPANDED set.** `treeState.ts` flips from a
  collapsed-set to an expanded-set (`nn:tree-expanded:<vault>`); old `nn:tree-collapsed:` keys are
  ignored (fresh start, empty = all collapsed). On mount: load root, then re-expand + load any
  persisted-expanded folders. **This matches Obsidian**, whose file explorer also starts collapsed —
  so it is arguably better for the Obsidian refugee, not just a concession to lazy loading.
- **Alternative — keep default-open, load one level at a time as folders scroll into view.** Rejected:
  for a fresh vault (empty collapsed set) this still loads every folder, just incrementally — it does
  not solve the large-vault problem the issue exists to fix.

**Tom decides:** accept the collapse-by-default flip (recommended), or keep open-by-default and
accept that large vaults stay eager on first paint. Everything below assumes the recommended flip.

## `tree.rs` changes, precisely

- **Add** `list_dir` (shallow, non-recursive) + `DirListing`. Reuses `is_hidden`, the symlink skip,
  the folders-first sort. Applies `DIR_LISTING_CAP` with an explicit `truncated` count.
- **Keep** `read_tree`, `scan_dir`, `MAX_DEPTH`, `markdown_files`, `node_for` **unchanged** — they
  remain the full-scan primitives for every server-side consumer. `MAX_DEPTH` is irrelevant to the
  lazy path (no recursion) but still guards the full walk.
- The per-directory cap is the **residual** protection lazy loading does not cover: lazy solves
  depth/total; the cap solves one pathological *wide* folder (e.g. 20k files in one directory) whose
  single `list_dir` payload would still be large. It is per-directory, never a global flat cap.

## CRUD coherence

`node_for` (entries.rs) still returns the created/renamed/moved node — used to identify the node
(e.g. select a just-created note). The **tree structure** updates by re-listing the affected parent,
not by trusting `node_for`'s subtree:

- create note/folder in P → `refreshDir(P)`; then select the new note by path.
- rename X in P → `refreshDir(P)` (name + sort order changed).
- delete X in P → `refreshDir(P)`.
- move X from P1 to P2 → `refreshDir(P1)`; and `refreshDir(P2)` **only if P2 is loaded** (if P2 is
  collapsed/unloaded there is nothing on screen to update — a later expand fetches it fresh).

Consequence: after moving a large folder, `node_for` still eagerly scans its subtree server-side and
the frontend discards it (the parent re-list returns that folder as `children: None`). Harmless and
rare (user-initiated move); a shallow `node_for` variant is a deferred micro-optimization, not v1.

## Coherence checklist (every consumer, explicit)

| Consumer | Behaviour with a partial tree |
|---|---|
| **Search** (`⌘K`) | Full scan server-side. Finds files inside unexpanded folders and behind "N more…". **Unchanged.** |
| **Link graph / backlinks** | Full scan. Whole graph built regardless of what's expanded. **Unchanged.** |
| **AI retrieval (moat)** | Full scan; embeddings + citations cover the entire vault. **Unchanged — this is the guardrail.** |
| **Template discovery** | Full scan of the templates folder. **Unchanged.** |
| **Filename filter** (sidebar `filterTree`) | Only matches **loaded** nodes — it is a display filter over the visible tree, and always was. It is NOT vault search (that is `⌘K`, which stays full). Acceptable; note the distinction so nobody mistakes it for full search. |
| **Recents** | Vault-level list; independent of the tree. **Unchanged.** |
| **Watcher `tree-changed`** | Debounced `refreshDir` over all loaded dirs (bounded by what the user expanded). Live external edits still show. |
| **CRUD refresh** | Targeted `refreshDir` of affected parent(s), per §CRUD. |

## Failure modes

- Unreadable directory → `list_dir` returns `CoreError::Io` → per-folder **error row** with a retry
  affordance; siblings and the rest of the tree stay usable (no whole-tree failure).
- Truncated directory → explicit **"N more…" row**, never silent hiding. (Search still reaches those
  files.)
- `list_dir` in flight → **loading row** under the expanding folder.
- Symlink / hidden entries → skipped exactly as `scan_dir` does (same predicates), so escapes and
  loops remain impossible and `.obsidian`/`.neuralnote`/`.git` stay invisible.

## Test fixtures (per acceptance)

Rust core (`list_dir`):
1. **Large-width folder** (> `DIR_LISTING_CAP` entries) → returns exactly CAP entries, `truncated =
   Some(total − CAP)`, sort order preserved.
2. **Deep nesting** → `list_dir` on a deep folder returns only its immediate children (proves no
   recursion; a folder child carries `children: None`).
3. **Unreadable dir** → `list_dir` returns `CoreError::Io` (not a panic, not empty-and-silent).
4. **Symlink** → a symlinked entry is skipped (no escape, no loop); a hidden dotfile is skipped.
5. **Coherence guard** → in a vault with a truncated wide folder, `search_vault` / `read_link_graph`
   still return the files beyond the cap (proves the moat is uncapped).

Frontend:
6. Store: `listDir` transitions loading→loaded/error; `refreshDir` re-lists one dir without touching
   siblings; watcher refreshes all loaded dirs.
7. `flattenTree`: emits `loading` / `error` / `more` rows at the correct depth; collapsed folders are
   not descended into; cached children survive collapse→re-expand.
8. Persistence: expanded set round-trips; old collapsed-set keys are ignored.

## Out of scope

Path-carrying watcher events (targeted single-dir refresh), shallow `node_for`, prefetch-on-hover,
Windows path correctness (v1 is macOS-only). All deferred.
