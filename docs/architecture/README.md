# NeuralNote — Documentation Map

> **Read this first:** if you are new to the codebase, read
> [`system-overview.md`](system-overview.md) top to bottom — it is the as-built high-level
> design, and everything else hangs off it.

## How the docs are organised

```
docs/
├── definition-of-done.md      The shipping bar. What "done" means for any change:
│                              tests, e2e, both quality gates green, verified in the
│                              running app. Tiered — baseline / security-adjacent /
│                              periodic. Read before shipping anything.
│
├── architecture/              ★ AS-BUILT documentation (this set). Describes what the
│   │                          code actually does today, with file:line evidence —
│   │                          not what we intend it to do.
│   ├── README.md              This map.
│   ├── system-overview.md     The flagship: layered architecture, trust boundaries,
│   │                          data-flow walkthroughs, enforced invariants, and known
│   │                          limitations — all anchored to code.
│   ├── spec-vs-built.md       The drift ledger: every spec claim vs what the code
│   │                          does (BUILT / PARTIAL / NOT BUILT), and what the gaps
│   │                          mean for the product thesis.
│   └── gaps-and-improvements.md
│                              Every GAP-* id from the LLDs, deduplicated, severity-
│                              rated and sized, plus the cross-cutting findings and
│                              seven architectural proposals. The triage view.
│
└── lld/                       Twelve per-subsystem low-level designs, one per coherent
    └── README.md              feature area. Start at its index.

specs/                         DESIGN INTENT, not as-built. The product spec
│                              (neural-note.md) plus one spec per vertical slice.
│                              Some slice specs carry stale status lines; the honest
│                              reconciliation lives in architecture/spec-vs-built.md.
├── neural-note.md             Master product + v1 technical spec ("design draft").
├── app-vault-slate-plan.md    Phase 1: vault open/browse/edit/CRUD (built + verified).
├── search-and-graph-view.md   Phase 2a: lexical search + link graph (built + verified).
├── ai-cited-chat-slice.md     AI slice 1: cited chat (fully built despite its
│                              "design, approved in principle" status line).
└── ai-providers-slice.md      AI slice 2: OpenRouter + local Ollama providers (built).
```

## The one distinction that matters

**`specs/` is intent; `docs/architecture/` is reality.** Specs are written before the code
and are not reliably updated after it ships — several status lines are already stale, and
the master spec describes subsystems (embeddings, vector store, capture pipeline) that do
not exist. When the two disagree, trust `spec-vs-built.md`, which cites both sides.

## If you read only one page

[`gaps-and-improvements.md`](gaps-and-improvements.md) §2. It carries the four findings that
change what you would do next — chief among them that citation verification proves a quote is
**real**, not that it **supports the claim it is attached to**.

## Provenance

These documents describe commit `3f325c0`. They were written from a full read of the source, with
every factual claim anchored to `file:line`; inferences are marked as such. Nothing here was
validated by running the app or the test suites — see `gaps-and-improvements.md` §6 for exactly what
was and was not checked.

## Related ground truth

- `CLAUDE.md` (repo root) — project conventions, the moat statement, and the honest
  built-vs-vision note.
- `scripts/rust-quality-gate.sh` — the enforced Rust gate (clippy, fmt, ts-rs binding
  drift, ≥90% core coverage, cargo-audit).
- `app/desktop/src/lib/bindings/` — generated TS types (ts-rs, emitted during
  `cargo test`). Never hand-edited; the gate fails on drift.
