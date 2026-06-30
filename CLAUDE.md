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

## v1 scope (the smallest lovable cut)

Desktop only, **Tauri 2**, **BYO-API-key**. The loop:
`capture → AI distil + infer metadata → write Obsidian-compatible markdown + full source → embed →
cited chat`. Capture paths: links (YouTube/article), PDF, text; voice last. Headline onboarding:
**open an existing Obsidian vault** (migration is free because the format is compatible).

v1 target user: the **Obsidian refugee** (a power user who can supply an API key).

**Not in v1:** sync, mobile, managed cloud AI, PWA, billing, proactive nudges, Notion import
(first fast-follow), tasks/canvas, open-source-release decision. See the spec for the full roadmap.

## Conventions

- **Data format is sacred:** markdown + YAML frontmatter, Obsidian-vault-compatible. Don't break
  compatibility — it's both the ownership promise and the free Obsidian-migration path.
- **Shared Rust core, thin client shell.** Keep product logic in the client-agnostic core so future
  mobile/PWA clients reuse it.
- **Verify stack specifics against current docs** (Context7) before locking versions or libraries —
  don't assert them from memory.
- **Failures are never silent** — surface capture/LLM/citation failures explicitly. See the spec's
  error-handling section.
