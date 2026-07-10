# Low-Level Designs

One document per subsystem, describing **what is actually built** — not what was intended. Where
the code and a spec disagree, these documents follow the code and cite both sides.

Each LLD carries the same skeleton: purpose, public API, data model, algorithms, invariants (every
one anchored to `file:line`), error handling, performance, testing, and a **Known gaps & edge
cases** table whose rows are `GAP-<NNN>-<n>` ids. Those ids are aggregated, severity-rated, and
triaged in [`../architecture/gaps-and-improvements.md`](../architecture/gaps-and-improvements.md).

New here? Read [`../architecture/system-overview.md`](../architecture/system-overview.md) first,
then the LLD for whatever you are about to touch.

## The set

### Vault domain — files on disk, and the safety around them

| Doc | Covers | Why you'd read it |
|---|---|---|
| [LLD-001](LLD-001-vault-and-path-safety.md) | `vault`, `paths`, `entries`, `recents`, and the shell's vault-open authorisation gate | Before touching anything that resolves a path, creates a file, or opens a vault |
| [LLD-002](LLD-002-note-io-and-frontmatter.md) | `note`, `error`, `NoteDoc`; atomic writes, optimistic concurrency, YAML frontmatter and its DoS defence | Before touching reads, writes, hashing, or frontmatter parsing |
| [LLD-003](LLD-003-vault-tree-and-watcher.md) | `tree`, the `notify` watcher, `vault://tree-changed` | Before changing how the file tree is scanned or refreshed |

### Knowledge layer — what the vault means

| Doc | Covers | Why you'd read it |
|---|---|---|
| [LLD-004](LLD-004-search.md) | `search`; lexical substring matching, Unicode case-folding, offset mapping | Before changing search, or anything that consumes its offsets |
| [LLD-005](LLD-005-links-backlinks-graph.md) | `links`, `mask`, `backlinks`; the wikilink grammar and the link graph | Before changing link parsing, backlinks, or the graph view's data |
| [LLD-006](LLD-006-templates.md) | `templates`; the whitelist interpreter and Obsidian/Templater compatibility | Before extending the template grammar. **Read the security section first** |

### AI — the cited-recall pipeline

| Doc | Covers | Why you'd read it |
|---|---|---|
| [LLD-007](LLD-007-chat-orchestration.md) | `orchestrator`, `tools`, `events`; the agentic tool loop, guards, the event protocol | Before changing the chat turn, the tool surface, or the system prompt |
| [LLD-008](LLD-008-retrieval-evidence-citation.md) | `retrieval`, `evidence`, `verify`; what a citation *is* and what verification actually proves | **Read this before touching anything near citations.** It documents the product's central mechanism and its central gap |
| [LLD-009](LLD-009-llm-transport-and-sse.md) | `llm`, `openai`, the shell HTTP client; wire mapping and SSE stream parsing | Before changing streaming, timeouts, or provider wire formats |
| [LLD-010](LLD-010-providers-secrets-sidecar.md) | `provider_config`, `ai/local/*`, keychain, the Ollama sidecar, CSP and capabilities | Before touching secrets, process spawning, or network egress. Security-adjacent — see [`../definition-of-done.md`](../definition-of-done.md) §2 |

### Boundaries and the client

| Doc | Covers | Why you'd read it |
|---|---|---|
| [LLD-011](LLD-011-ipc-and-event-contracts.md) | Every Tauri command and event, app state, the native menu, the `ts-rs` binding pipeline | The authoritative contract reference. Read it before adding or renaming a command |
| [LLD-012](LLD-012-frontend-architecture.md) | React state model, the API seam, the markdown pipeline, chat rendering, the galaxy graph, test topology | Before changing frontend state, rendering, or the test strategy |

## Conventions these documents assume

- **The core is client-agnostic.** Product logic lives in `crates/neuralnote-core`; the Tauri shell
  wires it to a webview. Where a command breaks that rule, the LLD says so by name.
- **The TypeScript types are generated.** `app/desktop/src/lib/bindings/` is emitted from Rust by
  `ts-rs`. Never hand-edit it. See [LLD-011](LLD-011-ipc-and-event-contracts.md).
- **Failures are never silent.** Every subsystem surfaces capture, parse, I/O, and LLM failures
  rather than swallowing them. Where a silence exists, it is recorded as a gap.
- **The data format is sacred.** Markdown plus YAML frontmatter, Obsidian-compatible. It is both the
  ownership promise and the migration path.

## A note on the specs

`specs/` holds **design intent**, some of it aspirational and some of it stale. `specs/neural-note.md`
describes a capture → distil → embed → vector-retrieval pipeline that does not exist. The
[drift ledger](../architecture/spec-vs-built.md) reconciles every such claim against the code. When
the two disagree, believe the code and the LLD.
