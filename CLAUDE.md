# NeuralNote — Project Guide

AI-native "second brain" desktop app. A **zero-setup alternative to Obsidian**: the AI does the
filing, tagging, linking, and distilling that Obsidian makes you assemble by hand.

**Full spec:** [`specs/neural-note.md`](specs/neural-note.md). Read it before proposing changes.
**Shipping bar:** [`docs/definition-of-done.md`](docs/definition-of-done.md) — what "done" means
(tests, e2e, both quality gates green; production-audit is periodic, not per-feature).

## The one thing to protect

**Full-source cited recall is the moat.** NeuralNote captures and stores the *entire* source
(full article / PDF / transcript with timestamps), not just the sparse note the user typed, then
runs retrieval over it. Chat answers questions the user never wrote down, citing the exact chunk or
timestamp. Every decision protects retrieval quality and **citation fidelity** first. A wrong
citation is worse than no answer.

> **Built vs vision:** the capture → distil → timestamp loop above isn't built yet. Today chat
> retrieves over the vault markdown you already have and cites the **note and line**, not a chunk or
> timestamp. What's actually defensible right now is the *combination* the spec defines — local-vault
> ownership, the zero-setup loop, and citation fidelity earned in execution, not capture itself. See
> [`specs/neural-note.md`](specs/neural-note.md) lines 4-5 (status) and 49-72 (the moat, reframed).

## v1 scope (the smallest lovable cut)

Desktop only, **Tauri 2**. AI is **BYO-API-key (OpenRouter) _or_ a bundled local model**
(Ollama sidecar) — the user picks a provider on first run and can reconfigure it in Settings; see
[`specs/ai-providers-slice.md`](specs/ai-providers-slice.md). The loop:
`capture → AI distil + infer metadata → write Obsidian-compatible markdown + full source → embed →
cited chat`. Capture paths: links (YouTube/article), PDF, text; voice last. Headline onboarding:
**open an existing Obsidian vault** (migration is free because the format is compatible).

v1 target user: the **Obsidian refugee** (a power user who supplies an API key, or runs a model
locally).

**Not in v1:** sync, mobile, managed cloud AI, PWA, billing, proactive nudges, Notion import
(first fast-follow), tasks/canvas, open-source-release decision. See the spec for the full roadmap.

## Conventions

- **Data format is sacred:** markdown + YAML frontmatter, Obsidian-vault-compatible. Don't break
  compatibility — it's both the ownership promise and the free Obsidian-migration path.
- **Shared Rust core, thin client shell.** Keep product logic in the client-agnostic core so future
  mobile/PWA clients reuse it. The shell's Tauri commands live in `app/desktop/src-tauri/src/commands/`
  (`vault.rs` and `ai.rs`); each one delegates rather than re-implements.
- **The TS types are generated, not written.** `app/desktop/src/lib/bindings/` is emitted from the
  Rust types by `ts-rs` during `cargo test`. Never hand-edit it. `lib/types.ts` is a thin façade that
  re-exports it plus the few types with no Rust counterpart. `rust-quality-gate.sh` fails on stale
  bindings; regenerate with `npm --prefix app/desktop run gen:bindings`.
- **Verify stack specifics against current docs** (Context7) before locking versions or libraries —
  don't assert them from memory.
- **Failures are never silent** — surface capture/LLM/citation failures explicitly. See the spec's
  error-handling section.
