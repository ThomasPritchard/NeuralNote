# Build plan — Search + Graph view (app phase 2a)

Status: **implemented + verified** (2026-07-03). Evidence: 72 Rust tests + 338 TS tests (36
files) green; typecheck/clippy/fmt clean; SonarQube gate GREEN (0 new violations, 93.4% new
coverage); Rust gate green except pre-existing cargo-audit advisories (tauri→plist transitive,
predates this feature); two adversarial review rounds (code-reviewer + silent-failure-hunter +
cross-model Codex on the parsers) run to clean, all findings fixed; app boots clean via
`tauri dev`. Remaining manual check: WebGL visual truth (bloom/morph/labels) — handed to Tom
with a click-through list; jsdom cannot cover it. Coverage deviation, documented: galaxy
renderer-bound files (nodeChrome 14%, starNode 13%, NeuralGalaxy 83%) execute only under real
WebGL — all pure logic meets the ≥90% bar. Ports the locked prototype designs
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
  SearchResponse { hits: FileHit[], truncated: bool, skippedFiles: number }
  FileHit { path, relPath, title, nameMatch: bool, matches: Match[] }
  Match { line: number (1-based), snippet: string, ranges: [start, end][] }

read_link_graph {} -> LinkGraph
  LinkGraph { nodes: GraphNode[], links: GraphLink[], skippedFiles: number }
  GraphNode { id: relPath, title, cluster: string }   // cluster = top-level folder ("" = root)
  GraphLink { source: id, target: id, bridge: bool }  // bridge = cross-cluster
```

Contract notes (review round 1, 2026-07-03): `ranges` are **Unicode code-point offsets** into
`snippet` (JS slices via `Array.from`, never `String.slice`); ranges straddling the snippet
window are **clipped, not dropped**, and a content match always carries ≥1 range; queries cap
at 256 chars. `skippedFiles` counts unreadable markdown files (each also `log::warn!`ed) so a
permissions failure is distinguishable from an empty result — the UI must surface it when > 0.

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
    (target = part before `#`/`|`); embeds (`![[…]]`) count as links too. Path-qualified
    targets (`[[folder/note]]`) resolve by segment-aligned rel-path suffix match.
  - markdown links: `[text](target)` where target is relative and resolves inside the vault
    (ignore `http(s):`, `mailto:`, absolute URLs); `%20`-decode; extensionless targets get a
    `.md` fallback (Obsidian behavior).
  - **ignore links inside fenced code blocks and inline code spans** (Obsidian behavior).
    Fences track opener char + length (CommonMark: a ````-fence only closes on ≥4 of the same
    char); inline spans are backtick-run matched and may cross newlines.
  - resolution: wikilink target matches by case-insensitive filename (with or without `.md`),
    shortest-rel-path tiebreak, then lexicographic (deterministic); case-colliding rel-paths
    prefer the exact-case match. md links resolve relative to the note's folder. Unresolved →
    skipped. Self-links and duplicate edges deduped on the unordered pair.
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

## Addendum — cluster drill-down (approved 2026-07-03)

The legend is interactive. **Hover** a cluster row → dim-preview (the hover-focus machinery
lights that cluster's nodes, rest dims). **Click** → true isolation: the graph regenerates
with only that folder's notes (frontend filter — no backend call), the force layout re-runs
so the cluster unfolds, auto zoom-to-fit. **Sub-clusters = folder levels**: inside an
isolated folder the legend re-keys to its sub-folders (palette reassigned) and a breadcrumb
(`All notes / Areas / Health`) navigates back up. Bridge (pink) styling and the
cross-folder stat recompute per level — a bridge means "crosses the current boundary".
Isolated stats gain a muted "N links lead outside" line (links with exactly one endpoint
inside). Notes directly in the focused folder cluster under the folder's own name (mirroring
root files → vault name). Mechanism: `toGalaxy(graph, rootLabel, focusPath)`; GraphView owns
the focus trail and remounts the galaxy per level (the immutable-data-per-mount contract);
NeuralGalaxy gains optional `onClusterSelect`/`onClusterHover` props. Chosen over soft-focus
only (clusters never unfold) and link-community detection (unnameable clusters, superseded by
the AI phase's semantic clustering later).

## Perf — large-vault graph rendering (#39)

The deferred ">2k-note vaults stutter" worry is now bounded. `graphTransform.ts` caps the
nodes handed to the 3D force sim at `GALAXY_NODE_CAP = 500` per level (keeping the most-linked
notes, re-derived per drill-down level) and the view surfaces the trim honestly ("Showing the
{shown} most-linked of {total} notes"). Small vaults are untouched: under the cap, `truncation`
is `null` and every note renders.

**What is measured, and why not the render.** The real galaxy is WebGL + a d3 force layout;
neither runs headlessly in jsdom (the e2e suite already renders a stub — see the *Testing*
section). So the render itself is bounded **by construction, not by direct measurement**: its
input is capped at 500 nodes regardless of vault size, so its cost cannot grow with the vault.
What we *do* measure is the pure `toGalaxy` transform that feeds it, plus that structural cap.

**Thresholds** (`graphTransform.perf.test.ts`, over the reproducible ≥2,000-note fixture):

- **Structural cap — the hard gate.** `toGalaxy` never returns more than `GALAXY_NODE_CAP`
  nodes, every rendered link joins two rendered nodes, and `truncation` reports `{ shown, total }`
  honestly — asserted for the fixture *and* for an even larger `40 × 200 = 8,000`-note graph, so
  the guarantee is proven size-independent. This is the interaction-responsiveness bound.
- **Transform time — a generous smoke ceiling.** Median transform ≤ 100 ms. Deliberately loose:
  a tight wall-clock p95 flakes in CI (cf. `sourceEditorPerformance.test.ts`), so the cap
  invariant is the gate and timing only trips on a catastrophic regression.

**Reproducible fixture** (`graphTransform.fixture.ts`). `buildSyntheticVault()` constructs the
graph structurally — **no randomness**, so results are identical every run and every machine.
Default `20 folders × 120 notes = 2,400 notes` (> the 2,000 bar and > the 500-node cap), each
folder with a "map of content" hub every note links to (skewed degree — hubs high, leaves low,
exactly what the cap ranks on), a hub ring, and a cross-folder bridge from every 10th leaf.

**Recorded result** (Apple Silicon dev machine, Node 24.18, Vitest 4.1):

| Metric | Value |
| --- | --- |
| Fixture | 2,400 nodes / 2,620 links |
| Rendered after cap | 500 nodes / 720 links |
| Truncation reported | `{ shown: 500, total: 2400 }` |
| Transform median | ~1.1 ms |
| Transform p95 | ~1.5 ms |

The transform is ~70× under the 100 ms ceiling on dev hardware. CI thresholds are kept generous
against this dev measurement — the 100 ms budget is a regression tripwire, not a hardware SLA.

## Known gaps / deferred

Scroll-to-match in reader/editor; live graph refresh on `vault://tree-changed`; ghost nodes
for unresolved links; inline `#tag` facets; search ranking beyond name-first; very large
vault perf (label bands were tuned at ~40 nodes — **now bounded**, see *Perf — large-vault
graph rendering (#39)* below); orb variant + magnet picking (prototype-only experiments).

Documented v1 search behaviour (review round 1, revised by issue #37): case-insensitivity is
char-wise Unicode **full** case folding (`ß↔ss`, `ﬀ↔ff`, `İ`, final sigma `ς→σ`) via the
vetted `caseless` crate (Unicode 16.0.0), never hand-rolled tables. The per-char fold keeps
the folded→original byte-range map exact, so a `ß` matched by an `ss` query still cites the
`ß`'s precise source span. Non-UTF-8 notes are
searched lossily (U+FFFD), so a search can miss text the reader shows — the reader flags such
notes via `lossyText`. Fold-map memory is O(largest line) transiently; acceptable for local
markdown, revisit in the capture phase.
