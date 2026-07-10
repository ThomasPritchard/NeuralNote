# Gaps, Edge Cases & Suggested Improvements

Every `GAP-*` id raised in the [LLDs](../lld/README.md), aggregated, deduplicated, severity-rated,
and sized. Plus the cross-cutting findings that belong to no single subsystem, and the architectural
proposals that follow from them.

**Provenance.** Every row was verified against the code at commit `3f325c0` (`main`). Line anchors
live in the owning LLD, not here — this file is the triage view. Nothing below is inferred from a
spec; where a spec and the code disagree, the [drift ledger](spec-vs-built.md) records it and the
code wins.

> **In-flight work.** Three draft slices (conversational chat, the skills bank, the YouTube distil
> skill) are being implemented on another branch as this is written. §3 lists what they already
> cover so nothing here double-counts them. The short version: **they do not close the two most
> serious gaps.**

---

## 1. Rubric

| Severity | Meaning |
|---|---|
| **S1 — Critical** | Can produce an answer the user would wrongly trust, lose their data, or write outside the vault. Violates the product's central promise. |
| **S2 — High** | Breaks a stated project invariant, costs the user money, or leaves a load-bearing guarantee unverified. |
| **S3 — Medium** | A real correctness or robustness gap with a narrow trigger or a workaround. |
| **S4 — Low** | Performance ceilings, documentation rot, cosmetic inconsistency. |

Effort is **S** (under a day), **M** (one to three days), **L** (needs design before it needs code).

---

## 2. The findings that matter

Four things are worth reading before the table.

### 2.1 Verification proves provenance, not support (`GAP-008-1`)

`verify.rs` re-reads each cited span from disk and checks two things: the note's content hash is
unchanged, and the quoted text still occurs verbatim. Both pass, and the citation is surfaced with a
green tick.

Neither check asks whether the quote **supports the sentence it is attached to**. A model that
legitimately retrieves `e1` — "Widgets are small components" — and then writes "Widgets cure cancer
[e1]" produces a citation that verifies cleanly. The UI renders exactly what `specs/neural-note.md`
calls the worst possible outcome: a confident, verified, wrong citation.

The spec is unambiguous that this is the crux, not a detail:

> a **post-hoc verification pass** then checks that each cited chunk actually entails its claim, and
> **drops or flags any citation that fails**. Generated citation markers are never trusted
> unverified — that is exactly how a confident wrong citation slips through.
> — `specs/neural-note.md:294-299`

No entailment check, LLM-judge, or eval harness exists anywhere in the repository. A repo-wide search
for `entail`, `llm.?judge`, `golden.?set`, and `faithfulness` returns hits only inside `specs/`.

**In fairness to the implementation:** the *slice* spec (`ai-cited-chat-slice.md:75-78`) only ever
asked for the hash-and-contains check, and the code meets that bar exactly. The entailment promise
lives in the master spec. So this is not an implementation that fell short of its brief — it is a
**product spec and a slice spec that disagree**, and nobody has reconciled them. That changes who
owns the fix: it is a product decision before it is an engineering task.

What *is* well built, and deserves saying: an invented evidence id is dropped; a note edited
mid-answer fails the hash check and is dropped; an empty-text span is rejected; every drop surfaces
as a `CitationDropped` event rather than vanishing; and stale `[eN]` markers are stripped from
carried history so they cannot re-validate against an unrelated span. The **provenance** guarantee is
real and carefully made. It is the **entailment** guarantee that was never built.

### 2.2 An uncited answer is never checked at all (`GAP-008-2`)

Verification is driven entirely by `extract_cited_ids(answer)`. An answer written from the model's
own knowledge, carrying no `[eN]` markers, yields zero ids, zero `Citation` events, zero
`CitationDropped` events — and streams to the user unchallenged. "Answer only from retrieved
evidence" is enforced by the system prompt and by nothing else.

Together, §2.1 and §2.2 are the two halves of one weakness: the pipeline checks *the citations that
appear*, and never asks whether the citations that *should* appear are there.

### 2.3 `create_note` can write outside the vault, and can silently truncate (`GAP-000-2`)

`create_folder` calls `create_dir`, which fails atomically if the path exists. `create_note` calls
`std::fs::write`, which **creates-or-truncates** and **follows symlinks**. Two consequences:

- **Vault escape.** A dangling symlink named `notes.md` inside a vault is invisible in the file tree
  (`scan_dir` skips symlinks). `ensure_within` admits it, because a dangling symlink fails
  `canonicalize()` and takes the "target doesn't exist yet" branch, where only the *parent* is
  canonicalised and the literal leaf is rejoined. `exists()` then returns `false`. `fs::write`
  follows the link and creates a file **outside the vault root**. The Definition of Done names
  "imported vaults" as untrusted input, so this is inside the threat model.
- **Silent truncation.** In the window between `exists()` and the write, a concurrently created file
  is truncated to empty rather than the call failing. This is verified behaviour, not theory.

One change closes both: `OpenOptions::new().write(true).create_new(true).open(&target)`. `O_EXCL |
O_CREAT` fails atomically if the path exists **and** refuses to follow a symlink. `create_new` appears
nowhere in the crate today.

### 2.4 The quality gates do not run anywhere (`GAP-000-1`, `GAP-000-5`)

`.github/workflows/e2e.yml` is the only workflow. It runs the native WebdriverIO smoke test. Nothing
in CI runs `rust-quality-gate.sh`, `cargo test`, `vitest`, `npm run typecheck`, or `sonar-scanner`.

This compounds twice:

- `rust-quality-gate.sh` treats an unreachable advisory database as a **SKIP rather than a failure**,
  and justifies it in a comment: *"a networked CI run will exercise it."* No networked CI run exists.
  The gate's own rationale rests on a job that was never created.
- The workflow's matrix is `[ubuntu-latest, windows-latest]`, because `tauri-driver` has no macOS
  driver. But `SUPPORTED_OS = "macos"` — local AI is macOS-only, and macOS is the shipping target.
  **The one tier CI runs never runs on the platform the product ships to.**

Neither is a code defect. Both mean the Definition of Done is enforced by discipline alone, on one
developer's machine.

### 2.5 A pattern worth naming: comments that assert guarantees living elsewhere, or nowhere

Two independent instances surfaced, and they are worth treating as one problem:

- `llm.rs:141` states the conformance contract that citation fidelity depends on — the returned
  string must equal the concatenation of streamed deltas — and adds: *"(The shell's reqwest client
  gets a test asserting this holds.)"* **That test does not exist**, and there is no HTTP mock
  harness in the workspace for it to run in.
- `ai.rs:230` says *"the core never trusts the client to inject system/tool roles."* The coercion is
  implemented in the **shell**'s `From<ChatTurn> for LlmMessage`. The core's `run_chat` accepts
  `&[LlmMessage]` with any role, and `prepare_history` never filters them. Under the project's own
  "shared Rust core, thin client shell" convention, a future mobile or PWA client reusing the core
  inherits no such protection.

A comment describing a guarantee is not a guarantee. Both should become tests, or move to the layer
they claim to protect.

---

## 3. Already covered by in-flight work — do not double-count

These are real gaps in the code at `3f325c0`, and the draft slices already address them. Listed so
this register is not read as a fresh backlog.

| Gap | Covered by |
|---|---|
| Reasoning toggle can silently do nothing on a non-reasoning model | Slice 3 — capability probe (`supported_parameters` / Ollama `capabilities`), fail-open |
| Every turn is forced to search, so greetings and meta-questions burn tool calls | Slice 3 — two-mode prompt (converse / research) |
| A zero-search turn renders an empty coverage footer | Slice 3 — suppress footer when `searchedTerms` is empty |
| Ollama can return an empty `content` with the whole answer in `reasoning` → blank bubble | Slice 3 — spike + explicit `Error` guard |
| Reasoning on, zero `Thinking` deltas → the toggle lied | Slice 3 — frontend-derived one-time notice |
| No write primitive; no way to ask the user a question mid-run | Slice 4 — `write_note`, `ask_user`, the `UserPrompt` elicitation seam |
| `dispatch` is synchronous and cannot await a user answer | Slice 4 — `dispatch` becomes `async` (a known, priced ripple) |

**What the slices do _not_ close.** Slice 3 ships a behavioural eval, and it is a genuine regression
gate — but it asserts on **search counts, citation counts, and a keyword match**. It never asks
whether a cited span supports its claim. `GAP-008-1`, `GAP-008-2`, and `GAP-008-3` survive all three
slices untouched. Worse, Slice 4 adds `write_note` — the first primitive that lets an ungrounded
model **write into the vault**. The blast radius of an unverified claim grows before the verification
gap closes.

---

## 4. The register

Sorted by severity, then by id. `→` marks a duplicate consolidated into another row.

### S1 — Critical

| ID | Finding | LLD | Effort |
|---|---|---|---|
| `GAP-008-1` | Citation verification proves provenance, not entailment. A real quote attached to an unsupported claim surfaces as verified. | [008](../lld/LLD-008-retrieval-evidence-citation.md) | L |
| `GAP-008-2` | An answer with no `[eN]` markers is never checked. Uncited hallucination is undetected; grounding is prompt-only. | [008](../lld/LLD-008-retrieval-evidence-citation.md) · [007](../lld/LLD-007-chat-orchestration.md) | L |
| `GAP-000-2` | `create_note` uses `fs::write`: follows a dangling symlink out of the vault, and truncates on the `exists()`→write race. Consolidates `GAP-001-9`. | [001](../lld/LLD-001-vault-and-path-safety.md) | S |

### S2 — High

| ID | Finding | LLD | Effort |
|---|---|---|---|
| `GAP-000-1` | No CI runs the quality gates. `cargo-audit`'s offline SKIP is justified by a CI job that does not exist. | — | M |
| `GAP-000-3` | Role coercion lives in the shell while the core's comment claims the core enforces it. A second client reusing the core gets no protection. | [007](../lld/LLD-007-chat-orchestration.md) | S |
| `GAP-000-5` | CI e2e runs on Linux + Windows only; the product targets macOS. The shipping platform has no automated end-to-end coverage. | [011](../lld/LLD-011-ipc-and-event-contracts.md) | M |
| `GAP-008-3` | No citation-faithfulness eval harness or golden set, so the spec's ≥95 % release gate is unmeasurable. | [008](../lld/LLD-008-retrieval-evidence-citation.md) | L |
| `GAP-009-7` | `llm.rs:141` promises a conformance test for the returned-equals-streamed invariant. No such test exists, and no HTTP mock harness exists to host one. | [009](../lld/LLD-009-llm-transport-and-sse.md) | M |
| `GAP-007-1` | No chat cancellation. Closing the vault or the window leaves an in-flight run spending the user's tokens, bounded only by `Guards`. Pulls are cancellable; chats are not. | [007](../lld/LLD-007-chat-orchestration.md) · [011](../lld/LLD-011-ipc-and-event-contracts.md) | M |
| `GAP-001-10` | `rename_entry` / `move_entry` race on `exists()`→`rename`, clobbering a concurrently created destination. Unlike delete, the loss is not recoverable from the trash. | [001](../lld/LLD-001-vault-and-path-safety.md) | S |
| `GAP-002-1` | No `fsync`/`sync_all` on any atomic write. Crash-consistent via `rename`, but not power-loss durable — and, unlike the accepted TOCTOU, unremarked in code. | [002](../lld/LLD-002-note-io-and-frontmatter.md) | S |
| `GAP-003-1` | `MAX_DEPTH = 48` truncates deep folders to empty children with no error and no flag. The only place content is hidden without being surfaced — and it hides those notes from search, backlinks, and AI retrieval alike. | [003](../lld/LLD-003-vault-tree-and-watcher.md) | S |
| `GAP-011-1` | `set_menu_editing` and `set_chat_visible` have no `mockVault` case. The only tier that catches a wrong command name never exercises them; their `.catch(console.error)` swallows the mock's throw. → `GAP-012-2` | [011](../lld/LLD-011-ipc-and-event-contracts.md) · [012](../lld/LLD-012-frontend-architecture.md) | S |
| `GAP-012-1` | `store.close()` performs no dirty check. Unsaved-edit protection lives only in `Workspace.guard()`; any future close path bypassing it drops the draft silently. | [012](../lld/LLD-012-frontend-architecture.md) | S |
| `GAP-012-10` | Citation chips are labelled `relPath:startLine` but clicking opens the note at the top — `openNoteAt` takes no line. The spec's "jump-to citations" does not jump. | [012](../lld/LLD-012-frontend-architecture.md) | M |
| `GAP-010-5` | `key_configured` is a persisted flag, not derived from keychain presence. A crash between the two writes leaves them disagreeing. `TODO(key-configured-derive)` | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-000-4` | SonarQube analyses `src-tauri/src`, but the Rust lcov is generated `-p neuralnote-core` only. The shell's keychain, sidecar, and IPC code reports 0 % coverage. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-001-11` | The `authorized`-set authorisation gate — the control that stops a compromised webview repointing the vault — has no direct test coverage. | [001](../lld/LLD-001-vault-and-path-safety.md) | M |

### S3 — Medium

| ID | Finding | LLD | Effort |
|---|---|---|---|
| `GAP-001-2` | A transient read error on `recent-vaults.json` makes `load` return empty; the next `record_recent_vault` then atomically truncates the whole history to one entry. Logged, but lost. | [001](../lld/LLD-001-vault-and-path-safety.md) | S |
| `GAP-001-3` | `ensure_within` re-joins a literal leaf for non-existent targets, so a symlink planted at the leaf between check and write is never re-resolved. | [001](../lld/LLD-001-vault-and-path-safety.md) | M |
| `GAP-001-6` | `validate_name` accepts Windows-reserved names (`CON`, `PRN`, …) and trailing dots/spaces. | [001](../lld/LLD-001-vault-and-path-safety.md) | S |
| `GAP-001-7` | The recents file is a trust dependency of the open-vault gate: anything that can write it can pre-seed an accepted path. No webview bypass; a local-filesystem one. | [001](../lld/LLD-001-vault-and-path-safety.md) | M |
| `GAP-002-2` | `CoreError::Frontmatter` is defined, displayed, and tested, but never constructed. Frontmatter failures ride in `NoteDoc.frontmatter_error` instead. | [002](../lld/LLD-002-note-io-and-frontmatter.md) | S |
| `GAP-002-4` | The opening `---` fence is whitespace-strict and fails **silently** — no `frontmatter_error` — where the closing fence's equivalent failure is surfaced. Asymmetric. | [002](../lld/LLD-002-note-io-and-frontmatter.md) | S |
| `GAP-002-5` | `content_hash` is a 64-bit `DefaultHasher`. A collision would silently accept an external edit as unchanged and overwrite it. | [002](../lld/LLD-002-note-io-and-frontmatter.md) | S |
| `GAP-002-6` | The `# ` title scan does not skip fenced code, so a heading inside a code block can win the note title. | [002](../lld/LLD-002-note-io-and-frontmatter.md) | S |
| `GAP-002-7` | Quadratic YAML alias fan-out is bounded only by the 4 KiB frontmatter cap. `TODO(quadratic-yaml-dos)` | [002](../lld/LLD-002-note-io-and-frontmatter.md) | M |
| `GAP-003-2` | No Rust-side watcher debounce and no max-wait cap. A bulk external operation emits one `vault://tree-changed` per FS event; a continuous stream defers the frontend's trailing-edge refresh indefinitely. | [003](../lld/LLD-003-vault-tree-and-watcher.md) · [011](../lld/LLD-011-ipc-and-event-contracts.md) | M |
| `GAP-003-3` | Four independent definitions of "is this markdown": `tree.rs`, `note.rs`, `entries.rs`, and `fileMeta.ts`. `TODO(PA-029)` — whose own comment cites a stale path, a live instance of the drift it warns about. | [003](../lld/LLD-003-vault-tree-and-watcher.md) | M |
| `GAP-003-4` | The watcher refreshes the tree only, so an open reader can show stale content after an external edit. Not data loss — the save hits the `Conflict` backstop. `TODO(reader-stale-on-external-edit)` | [003](../lld/LLD-003-vault-tree-and-watcher.md) · [012](../lld/LLD-012-frontend-architecture.md) | M |
| `GAP-003-6` | `is_hidden_path` checks only the final path component, so writes *inside* `.obsidian/` (which Obsidian rewrites constantly) trigger full tree rescans that cannot change the rendered tree. | [003](../lld/LLD-003-vault-tree-and-watcher.md) | S |
| `GAP-004-3` | Search does no Unicode normalization, so NFC `é` never matches NFD `e`+`◌́`. Vaults migrated from macOS are exactly the population that hits this. | [004](../lld/LLD-004-search.md) | M |
| `GAP-004-2` | No max-file-size cap in search: a single huge `.md` is read whole into memory, and retained in the `with_content` map on the AI path. | [004](../lld/LLD-004-search.md) | S |
| `GAP-004-4` | Search has no binary-content detection, unlike `read_note`. A `.md` full of binary bytes is lossily decoded and scanned. | [004](../lld/LLD-004-search.md) | S |
| `GAP-005-1` | Code masking misses HTML comments, `$…$` math, and escaped brackets, producing false-positive graph edges and unlinked mentions. | [005](../lld/LLD-005-links-backlinks-graph.md) | M |
| `GAP-005-3` | Unlinked mentions match the target's **title** with word-boundary anchoring, so common-word titles ("Rust", "Index") match everywhere, `rust-lang` matches "rust", and aliases never match. | [005](../lld/LLD-005-links-backlinks-graph.md) | M |
| `GAP-005-5` | The core computes `cluster` and `bridge`; the only consumer ignores both and re-derives them per drill level. Dead wire payload, and a trap for anyone who trusts them. | [005](../lld/LLD-005-links-backlinks-graph.md) | S |
| `GAP-006-1` | The templates subsystem has **no spec anywhere**. It shipped undocumented; [LLD-006](../lld/LLD-006-templates.md) is its first design record. | [006](../lld/LLD-006-templates.md) | — |
| `GAP-006-2` | Unknown moment tokens render literally and silently: `{{date:[Week] w}}` yields `Week w`. A typo'd format token is indistinguishable from intentional literal text. | [006](../lld/LLD-006-templates.md) | S |
| `GAP-006-3` | A parseable `templates.json` naming a missing folder is authoritative (`NotFound`, no fallback), while a *malformed* one falls back to discovery. Surprising asymmetry. | [006](../lld/LLD-006-templates.md) | S |
| `GAP-006-4` | Template-folder precedence is a lexicographic sort of on-disk names, not the `FALLBACK_FOLDERS` array order. The array's order coincidentally matches for the three canonical spellings, which validates the wrong mental model — a reorder "fix" would silently no-op. | [006](../lld/LLD-006-templates.md) | S |
| `GAP-006-6` | The Tauri wrapper accepts an absolute template path and normalises it; the core rejects all absolute paths. Two contracts for one operation. No security hole — both layers enforce containment. | [006](../lld/LLD-006-templates.md) | S |
| `GAP-007-2` | No retry or backoff anywhere. One transient 429 or 5xx on a tool-deciding turn ends the whole run. `TODO(llm-retry)` | [007](../lld/LLD-007-chat-orchestration.md) · [009](../lld/LLD-009-llm-transport-and-sse.md) | M |
| `GAP-007-3` | All budgets are in characters, assuming ~4 chars/token. A CJK or symbol-dense vault tokenises nearer ~2, so a near-max turn can overflow a small local `num_ctx` and be silently front-truncated. `TODO(token-aware-context-budget)` | [007](../lld/LLD-007-chat-orchestration.md) | M |
| `GAP-008-5` | Evidence spans are line-granular with no char offsets, capping citation precision below what the spec's chunk-and-offset model assumes. | [008](../lld/LLD-008-retrieval-evidence-citation.md) | L |
| `GAP-008-7` | Re-reading a span with a larger `max_bytes` reuses the first, narrower span because dedupe keys on the line range. `TODO(span-widen)` | [008](../lld/LLD-008-retrieval-evidence-citation.md) | S |
| `GAP-009-1` | `ANSWER_MAX_TOKENS = 4096` truncation is not signalled. A cut-off answer looks complete. `TODO(answer-truncation-signal)` | [009](../lld/LLD-009-llm-transport-and-sse.md) | S |
| `GAP-009-2` | A mid-stream SSE `error` frame reaches the user without passing through `redact`, unlike every buffered error path. Not a proven leak; the one hole in an otherwise consistent defence-in-depth posture. | [009](../lld/LLD-009-llm-transport-and-sse.md) · [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-009-3` | Malformed mid-stream SSE JSON is skipped as `Other` with no log and no counter. A corrupt frame carrying a real token is lost without trace. | [009](../lld/LLD-009-llm-transport-and-sse.md) | S |
| `GAP-009-5` | No response size caps on any HTTP path. `text()`, `json()`, and the stream accumulators are bounded only by timeouts. | [009](../lld/LLD-009-llm-transport-and-sse.md) · [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-010-1` | SIGKILL, panic-abort, or power loss orphans `ollama serve`; the exit handler is `RunEvent`-driven. The next launch picks a fresh port, so nothing conflicts — but the orphan holds RAM. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | M |
| `GAP-010-2` | The sidecar port is reserved by binding `:0` and dropping the listener. Another process can take it in the window, and there is no automatic retry on a fresh port. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-010-3` | No free-disk precheck before a multi-gigabyte model pull. `TODO(pull-disk-precheck)` | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-010-4` | Partial downloads are never cleaned up app-side after a cancel or failure. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-010-8` | The bundled Ollama archive is SHA-256 pinned but has no code-signature verification. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | M |
| `GAP-010-9` | The HuggingFace metadata fetch has no cache, no custom User-Agent, no auth, and no rate limiting — roughly six anonymous calls per Settings visit. | [010](../lld/LLD-010-providers-secrets-sidecar.md) | S |
| `GAP-011-2` | `refresh_menu` re-locks the `AppState` mutex, so every mutating command must scope and drop its guard first. Enforced by comment and discipline only; a deadlock is one careless edit away. | [011](../lld/LLD-011-ipc-and-event-contracts.md) | M |
| `GAP-011-4` | The `MenuAction` union in `api.ts` is hand-maintained against Rust's `CUSTOM_ACTIONS`, while its sibling event *names* are generated and gate-checked. A Rust-only action becomes a dead, silent no-op menu item. `TODO(menu-action-bindings)` | [011](../lld/LLD-011-ipc-and-event-contracts.md) · [012](../lld/LLD-012-frontend-architecture.md) | M |
| `GAP-011-6` | The `toggle-chat` menu checkmark is painted from state the webview pushes back via a fire-and-forget `set_chat_visible`. A failed push drifts the checkmark from reality. | [011](../lld/LLD-011-ipc-and-event-contracts.md) | S |
| `GAP-012-5` | An OS close request overwrites a pending navigation discard, so confirming "Discard" closes the window instead of performing the queued navigation. `TODO(close-vs-pending-discard)` | [012](../lld/LLD-012-frontend-architecture.md) | S |
| `GAP-012-6` | A write in flight when the note is renamed does not bump `loadId`, so it restores the pre-rename path. Display-only, self-healing. `TODO(rename-during-save-race)` | [012](../lld/LLD-012-frontend-architecture.md) | S |
| `GAP-012-9` | `lucide-react ^1.22.0` resolves and installs, but the package's public release line is `0.x`. Needs a human check against the registry. | [012](../lld/LLD-012-frontend-architecture.md) | S |

### S4 — Low

| ID | Finding | LLD |
|---|---|---|
| `GAP-001-1` | The `authorized` set is never pruned. Bounded by picks-per-session. `TODO(authorized-set-unbounded)` → also `GAP-011-3` | [001](../lld/LLD-001-vault-and-path-safety.md) |
| `GAP-001-4` | The case-rename temp name uses pid only, where `note::write_note` adds an `AtomicU64` sequence. Asymmetric. | [001](../lld/LLD-001-vault-and-path-safety.md) |
| `GAP-001-5` | `create_vault` echoes the untrimmed name in `AlreadyExists` while joining the trimmed one. | [001](../lld/LLD-001-vault-and-path-safety.md) |
| `GAP-001-8` | `rel_path` silently falls back to the bare file name for a path not under root, which would mask a containment bug rather than surface it. | [001](../lld/LLD-001-vault-and-path-safety.md) |
| `GAP-002-3` | A closing fence with trailing whitespace reads as "never closed" — stricter than Obsidian. Surfaced as an error, so not silent. | [002](../lld/LLD-002-note-io-and-frontmatter.md) |
| `GAP-003-5` | The live watcher diverges (benignly) from the spec's launch/focus re-index model. There is no index to reconcile. | [003](../lld/LLD-003-vault-tree-and-watcher.md) |
| `GAP-004-1` | No index: every search is a full vault rescan. → consolidated into Proposal D | [004](../lld/LLD-004-search.md) |
| `GAP-004-5` | No multi-line matching; occurrences past the snippet window on one line are unreported. Deliberate. | [004](../lld/LLD-004-search.md) |
| `GAP-004-6` | `ß`→`ss` and other multi-char folds are intentionally absent; only ς→σ is special-cased. Documented trade-off. | [004](../lld/LLD-004-search.md) |
| `GAP-004-7` | Files are fully read even after the match budget is exhausted; only the *scan* is skipped. | [004](../lld/LLD-004-search.md) |
| `GAP-005-2` | Minor CommonMark divergences: a closer with trailing text still closes a fence; over-indented fences are accepted. | [005](../lld/LLD-005-links-backlinks-graph.md) |
| `GAP-005-4` | Markdown-link limits: quoted titles break resolution; `<url>` and `[t][ref]` unsupported; only `%20` decoded. | [005](../lld/LLD-005-links-backlinks-graph.md) |
| `GAP-005-6` | `read_link_graph` and `read_backlinks` each rescan the whole vault per call. → Proposal D | [005](../lld/LLD-005-links-backlinks-graph.md) |
| `GAP-006-5` | `tp.file.creation_date` uses the injected render clock, not the file's real creation time. | [006](../lld/LLD-006-templates.md) |
| `GAP-007-4` | `tools.rs`'s module doc says "Three tools… scoping is deferred" while four tools exist and folder scoping is built and tested. → `GAP-008-8` | [007](../lld/LLD-007-chat-orchestration.md) |
| `GAP-008-6` | Each of the 3–8 searches per turn rescans the vault from disk. `TODO(search-per-run-cache)` → Proposal D | [008](../lld/LLD-008-retrieval-evidence-citation.md) |
| `GAP-009-6` | No TLS pinning; trust is the OS store. Recorded as an accepted posture, not a defect. → `GAP-010-11` | [009](../lld/LLD-009-llm-transport-and-sse.md) |
| `GAP-010-7` | GPU and VRAM are never detected; `gpu_label` is always `None`, and 0.70 × total RAM is the only proxy. `TODO(local-gpu-detection)` | [010](../lld/LLD-010-providers-secrets-sidecar.md) |
| `GAP-011-5` | `open_vault`/`create_vault` rejection messages echo absolute paths — supplied by the webview itself, and the CSP forbids exfiltration. | [011](../lld/LLD-011-ipc-and-event-contracts.md) |
| `GAP-012-7` | `FileTree` rebuilds its row context every render, so `React.memo(TreeRow)` never bites. `TODO(PA-010)` | [012](../lld/LLD-012-frontend-architecture.md) |
| `GAP-012-8` | jsdom cannot hit-test the titlebar drag region; the test proves DOM nesting, not stacking. `TODO(titlebar-drag-hit-test)` | [012](../lld/LLD-012-frontend-architecture.md) |
| `GAP-012-3` | → `GAP-011-4` | [012](../lld/LLD-012-frontend-architecture.md) |
| `GAP-012-2` | → `GAP-011-1` | [012](../lld/LLD-012-frontend-architecture.md) |
| `GAP-012-4` | → `GAP-003-4` | [012](../lld/LLD-012-frontend-architecture.md) |
| `GAP-010-6` | → `GAP-009-2` | [010](../lld/LLD-010-providers-secrets-sidecar.md) |
| `GAP-010-10` | → `GAP-009-5` | [010](../lld/LLD-010-providers-secrets-sidecar.md) |
| `GAP-010-11` | → `GAP-009-6` | [010](../lld/LLD-010-providers-secrets-sidecar.md) |
| `GAP-011-3` | → `GAP-001-1` | [011](../lld/LLD-011-ipc-and-event-contracts.md) |
| `GAP-011-7` | → `GAP-003-2` | [011](../lld/LLD-011-ipc-and-event-contracts.md) |
| `GAP-011-8` | → `GAP-007-1` | [011](../lld/LLD-011-ipc-and-event-contracts.md) |
| `GAP-008-8` | → `GAP-007-4` | [008](../lld/LLD-008-retrieval-evidence-citation.md) |
| `GAP-008-4` | No embeddings, vector store, or chunker. This is a spec-drift entry, not a defect. See the [drift ledger](spec-vs-built.md). | [008](../lld/LLD-008-retrieval-evidence-citation.md) |

---

## 5. Architectural proposals

Seven changes, ordered by what they unblock rather than by size.

### Proposal A — A `ClaimVerifier` seam, composed after `CitationVerifier`

Closes `GAP-008-1`. The existing verifier is the right shape and should not be replaced — provenance
is cheap, deterministic, and must run first. Add a second stage that only sees spans which already
passed:

```
extract_cited_ids → registry.get → CitationVerifier (provenance, local, free)
                                        │ Ok
                                        ▼
                                  ClaimVerifier (entailment, LLM, billed)
                                        │
                          Citation ◀────┴────▶ CitationDropped { reason }
```

`ClaimVerifier` is a trait alongside `LlmClient` and `RetrievalProvider`, so tests script it and the
core stays network-free. The obvious implementation is an LLM-judge: given (claim sentence, cited
span), does the span support the claim? Three design constraints fall out:

- **It costs a call per cited claim.** Batch all claims for one answer into a single judge request.
- **It must fail closed on the moat and open on availability.** A judge that says "not supported"
  drops the citation. A judge that *errors* must not silently pass the citation through — it should
  mark it unverified in the UI, which is a third state the `ChatEvent` enum does not currently have.
- **A cheap first cut exists.** Only judge claims whose cited span was never `read_note_span`'d in
  full — a span the model merely saw as a search hit is the likelier mis-attribution. This halves the
  cost and captures most of the risk.

Note the ordering constraint against Slice 4: `write_note` lets an ungrounded model write into the
vault. Landing Proposal A **before** Slice 4 is the difference between a wrong citation and a wrong
note.

### Proposal B — The citation-faithfulness eval harness

Closes `GAP-008-3`, and makes Proposal A measurable rather than hopeful. The master spec already
specifies it: a golden set of `question → expected answer → known-correct source chunks`, scored two
ways — LLM-judge entailment, and retrieval hit-rate — with a ≥95 % target that blocks release on any
regression.

Build it as a Rust integration test behind a feature flag, with the golden set as vault fixtures.
Slice 3's behavioural eval is the right *harness shape* (scripted mock client for the unit tier, real
providers for the integration tier, skipping loudly) — extend it rather than build a second one. It
asserts on search and citation *counts*; add a third assertion on entailment.

### Proposal C — A cancellation token through `run_chat`

Closes `GAP-007-1`. `EventSink::send` is infallible by design and should stay that way; the sink is
the wrong place to signal cancellation. Thread a `&AtomicBool` (or a `CancellationToken`) into
`run_chat`, checked at the top of each tool-loop iteration and between SSE frames — the same shape
`pull_local_model` already uses successfully.

This is worth doing before Slice 4, which needs it anyway: the elicitation timeout has to abort a
parked run, and Slice 4's own spec assumes cancelling the chat resolves outstanding elicitations.

### Proposal D — One change-detection index, serving four consumers

Consolidates `GAP-004-1`, `GAP-005-6`, `GAP-008-6`, and `TODO(search-per-run-cache)`.

Today `search_vault`, `read_link_graph`, and `read_backlinks` each perform an independent full-vault
rescan, and a single chat turn triggers three to eight of them. The unit of invalidation every one of
them wants is the same: `(rel_path, content_hash)`.

Build it once, under `search`, as an in-memory index rebuilt on `vault://tree-changed` and validated
by content hash. It is the same table a future `VectorRetriever` needs for chunk staleness — which is
the real argument for building it now rather than alongside embeddings. The `RetrievalProvider` trait
already anticipates that successor; give it the substrate first.

### Proposal E — Make CI run what the Definition of Done says

Closes `GAP-000-1`, `GAP-000-4`, `GAP-000-5`. One workflow, on push and PR:

- `./scripts/rust-quality-gate.sh` (which makes the `cargo-audit` SKIP comment true at last)
- `cargo test --workspace`, `npm run typecheck`, `npm run test:run`, `npm run test:e2e`
- `npm run check:bindings`
- `sonar-scanner`, with the Rust lcov widened past `-p neuralnote-core` so the shell's security-relevant code stops reporting 0 %.

The macOS gap (`GAP-000-5`) has no clean fix while `tauri-driver` lacks a macOS driver. The honest
mitigation is to run everything *except* the native tier on `macos-latest`, and to say plainly in the
DoD that the shipping platform's end-to-end coverage is the jsdom `mockIPC` tier plus a manual walk.

### Proposal F — `create_new` for note creation

Closes `GAP-000-2` (and `GAP-001-9`, `GAP-001-10`). Replace `fs::write(&target, "")` with
`OpenOptions::new().write(true).create_new(true).open(&target)`, and give `rename_entry` / `move_entry`
the same atomic-destination treatment. Add adversarial tests for the dangling-symlink case: this
touches file paths and untrusted input, so §2 of the Definition of Done applies and an independent
review is required, not just a green suite.

### Proposal G — Delete the comments that promise things

Closes `GAP-009-7` and `GAP-000-3`, and the pattern behind them.

- Write the conformance test `llm.rs:141` claims exists. It needs an HTTP mock (`wiremock` is the
  obvious choice) — which the workspace lacks, and which Proposal B will want anyway.
- Move role coercion out of the shell's `From<ChatTurn>` and into `prepare_history`, where the
  comment already says it lives. The core then enforces its own invariant, and the second client the
  architecture exists to enable inherits it for free.

Then adopt the rule: a comment asserting a guarantee names the test that proves it, or it does not
assert a guarantee.

---

## 6. What was checked, and what was not

**Checked.** Every claim here was read in the source at `3f325c0`. The symlink-escape and truncation
behaviour in §2.3 was reproduced against the real filesystem, not reasoned about. The absence of any
entailment check, LLM-judge, or eval harness was established by repo-wide search across `.rs`,
`.ts`, `.tsx`, `.toml`, and `.sh`. The command count (36), the mock parity (34), and the binding count
(28 types + `events.ts`) were each independently recounted.

**Not checked.** Nothing here was validated by *running* the app, the test suites, or the quality
gates — this was a static analysis. In particular: `GAP-012-9` (`lucide-react`) needs a human check
against the npm registry; the severity of `GAP-002-1` (no `fsync`) depends on a filesystem-behaviour
question this analysis did not settle empirically; and `GAP-001-3`'s TOCTOU window was reasoned about
rather than reproduced.

**Out of scope.** The three draft slices on the sibling branch were read for context (§3) and are not
documented here. Their code was not reviewed.
