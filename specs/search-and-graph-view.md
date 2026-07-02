# Build plan — Search + Graph view (app phase 2a)

Status: **designed, awaiting implementation** (2026-07-03). Ports the locked prototype designs
(search field styling, neural-galaxy graph) into the real app, backed by two new Rust core
capabilities: vault text search and a wikilink/markdown-link graph. **Still no AI** — the AI
phase later layers semantic search and inferred links on top of both.

## Decisions locked (with Tom, 2026-07-03)

- **Graph edges (v1):** `[[wikilinks]]` **and** relative markdown links parsed from note
  bodies. Clusters/colors from top-level folder; node size from link degree; cross-folder
  links get the prototype's pink "bridge" styling, relabelled honestly as **"cross-folder
  link"** (no AI-inference claim until it exists).
- **Graph mount:** **center pane only** — the galaxy replaces the note pane; sidebar + chat
  stay. (Departs from the full-screen prototype; the view must size to its container.)
- **Search UX:** **split.** The sidebar input filters the visible tree by filename (pure
  frontend). The ribbon Search icon opens a dedicated sidebar search panel with full-text
  results (VSCode activity-bar pattern).
- **Search engine (v1):** on-demand async scan per query — no index, no new crates. AI-phase
  embeddings supersede ranking later.
- Sub-decisions (approved as judgment): ⌘K opens the search panel (not the tree filter);
  star node variant only is ported (orb + magnet-pick stay prototype-only); no
  scroll-to-match in v1 (clicking a result opens the note); graph data refetches on view
  entry (no live updates); no ghost nodes for unresolved links.

## View model

Workspace-local UI state (not the vault store — it's frozen glue):

- `sidebarPanel: "files" | "search"` — ribbon **Files**/**Search** icons swap the sidebar.
- `centerView: "note" | "graph"` — ribbon **Graph view** toggles the center pane.

`Ribbon` becomes prop-driven (current panel/view + callbacks) with real active states.
Opening any note (tree, search result, graph "Open in reader") routes through the existing
unsaved-edits `guard()` and lands in `centerView: "note"`.

## Contract (frozen before fan-out)

New Tauri commands, following the established recipe (core fn → `#[tauri::command]` →
`generate_handler!` → `model.rs` DTO → `types.ts` → `api.ts` wrapper → `mockVault.ts` case):

```
search_vault { query } -> SearchResponse
  SearchResponse { hits: FileHit[], truncated: bool }
  FileHit { path, relPath, title, nameMatch: bool, matches: Match[] }
  Match { line: number, snippet: string, ranges: [start, end][] }  // char offsets into snippet

read_link_graph {} -> LinkGraph
  LinkGraph { nodes: GraphNode[], links: GraphLink[] }
  GraphNode { id: relPath, title, cluster: string }   // cluster = top-level folder ("" = root)
  GraphLink { source: id, target: id, bridge: bool }  // bridge = cross-cluster
```

Both commands are `async fn` (worker pool; never hold the state Mutex across `.await` — copy
the `root_of()` idiom). Errors are `CoreError` (existing kinds suffice: `io`, `notFound`).

## Rust core

- **`search.rs`** — `search_vault(root, query) -> SearchResponse`. Walk with the tree-scan
  rules (skip hidden dotdirs, symlinks, depth cap 48), **markdown notes only**,
  case-insensitive match over the raw file text (frontmatter included, like Obsidian).
  Caps: 200 total matches, 50 per file, snippet length ~200 chars; `truncated` flag set when
  clipped; empty/whitespace query → empty response. **All snippet slicing must be UTF-8
  char-boundary safe** — byte-offset panics are the known hazard; dedicated tests (emoji,
  CJK, combining marks, match at snippet clip boundary). Filename/title matches rank before
  content-only matches.
- **`links.rs`** — `read_link_graph(root) -> LinkGraph`. Per note, extract:
  - wikilinks: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#heading|alias]]`
    (target = part before `#`/`|`); embeds (`![[…]]`) count as links too.
  - markdown links: `[text](target)` where target is relative and resolves inside the vault
    (ignore `http(s):`, `mailto:`, absolute URLs); `%20`-decode.
  - **ignore links inside fenced code blocks and inline code spans** (Obsidian behavior).
  - resolution: wikilink target matches by case-insensitive filename (with or without `.md`),
    shortest-rel-path tiebreak (Obsidian's rule); md links resolve relative to the note's
    folder. Unresolved → skipped. Self-links and duplicate edges deduped.
  - nodes: every markdown note in the vault (linked or not — orphans render too); cluster =
    first path segment. Node title reuses the existing precedence rule (`note.rs::title_from`:
    frontmatter `title` → first `# H1` → file stem), so graph, tree, and reader agree on names.
- Tests live in the core crate's existing `#[cfg(test)] mod tests` (lib.rs), tempdir
  fixtures, failure/edge-path heavy per house style.

## Frontend

- **Tree filter** (`FileTree.tsx` + a pure `filterTree` helper w/ tests): the existing
  disabled input goes live. Case-insensitive filename substring; folders shown + auto-expanded
  when a descendant matches; ✕/Esc clears; "no files match" empty state. No backend, no ⌘K
  chip (that belongs to the search panel).
- **`SearchPanel.tsx`**: prototype-styled field (Search icon, `Search or ask…` placeholder →
  actual: `Search vault…`, ⌘K kbd chip), 200 ms debounce, min 2 chars. Results grouped by
  file (name + rel path), nested match rows with `<mark>`-highlighted snippets. Click →
  `guard()`ed open. States: idle hint, empty (`No notes match "q"`), truncated banner
  ("Showing first 200 matches"), error via the existing toast channel. ⌘K global handler
  opens panel + focuses input; Esc clears then returns focus.
- **Galaxy port** → `app/desktop/src/workspace/galaxy/`: copy `NeuralGalaxy.tsx`, `graph.ts`
  (types + cluster palette only — mock data deleted), `nodeChrome.ts`, `starNode.ts`,
  `starfield.glsl.ts`, `nodeRegistry.ts`. Sever: `nav.ts` (→ props/state), URL flags, orb
  variant + toggle, magnet-pick, `__nnFg` debug handle, "Workspace" back button (ribbon owns
  view switching). Keep: 3D/2D morph toggle, in-graph node search (Enter-to-fly, Esc-clear),
  cluster legend, detail panel + neighbour traversal + camera-restore ✕.
- **`GraphView.tsx` wrapper**: fetches `readLinkGraph()` on mount, transforms to the galaxy
  shape (cluster → rotating 5-color bloom-tuned palette; `val` from link degree, hub
  threshold preserved; `bridge` → pink), **container-sized via ResizeObserver** (prototype
  used window size — center-pane mount requires explicit `width`/`height` props), empty state
  ("No notes yet") and error surface. Legend + stats copy: "N notes · M links · K
  cross-folder links".
- **"Open in reader"** in the detail panel: opens the node's note (guarded) and switches to
  `centerView: "note"`.

## Dependencies (judgment, prototype-verified — not latest-chasing)

`react-force-graph-3d ^1.29.1`, `three ^0.185.0`, `three-spritetext ^1.10.0`,
`@types/three ^0.185.0` (dev). Bloom via three's own `examples/jsm` (version-sensitive import
path — pinned three makes it safe). Prod CSP (`script-src 'self'`) does not restrict WebGL;
no eval/WASM in the trio at these versions.

## Testing (per docs/definition-of-done.md)

- **Rust unit**: search (unicode boundaries, caps/truncation, case-insensitivity, empty
  query, binary/non-md skipped, hidden-dir skip) + links (all wikilink forms, embeds, md-link
  resolution incl. `%20` and `../`, ambiguity tiebreak, code-block/span skipping, dedup,
  unresolved skipped, cluster/bridge assignment). ≥90% line coverage on changed code.
- **TS unit**: `filterTree`, `SearchPanel` (debounce, states, highlight), graph transform,
  `Ribbon` active states/callbacks, `GraphView` states (lib mocked).
- **e2e (`src/e2e/`)**: `mockVault.ts` gains `search_vault` + `read_link_graph` handlers
  mirroring core semantics; journeys: search (type → grouped results → click → note opens,
  + error path), tree filter (filter → tree narrows → clear), graph (ribbon → graph view
  mounts with data → open-in-reader returns to note). `react-force-graph-3d` is module-mocked
  in jsdom (no WebGL) — the mock records props and renders a stub so wiring is honestly
  tested.
- **Security-adjacent gate**: both new Rust parsers consume untrusted note content →
  independent adversarial review (code-reviewer + silent-failure-hunter) required, not just
  green tests.
- **Manual/live**: real 3D rendering, morph, hover/labels verified in the running app
  (`npm run tauri dev`) — jsdom cannot cover WebGL truth.

## Known gaps / deferred

Scroll-to-match in reader/editor; live graph refresh on `vault://tree-changed`; ghost nodes
for unresolved links; inline `#tag` facets; search ranking beyond name-first; very large
vault perf (label bands were tuned at ~40 nodes; no node cap in v1 — revisit if >2k-note
vaults stutter); orb variant + magnet picking (prototype-only experiments).
