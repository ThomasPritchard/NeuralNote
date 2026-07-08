---
name: neuralnote-runbook
description: >-
  Runbook for building, running, testing, and shipping the NeuralNote Tauri 2
  desktop app (shared Rust core + Tauri shell + React/Tailwind frontend). Use
  this whenever you need to run the app in dev, run the Rust or frontend test
  suites, run the quality gates (rust-quality-gate.sh / SonarQube), check what
  "done" means, or produce a release build — even when the ask is just "run it",
  "how do I test this", "is the gate green?", or "build the app". It carries the
  exact, verified commands so you don't guess them from memory.
---

# NeuralNote Runbook

The commands here are verified against `app/desktop/package.json` and
`scripts/rust-quality-gate.sh`. Run them from the **repo root** unless noted.
If a script has changed, re-read those two files — they are the source of truth,
this skill is the map.

## Repo shape (know which layer you're touching)

- `crates/neuralnote-core` — the **shared Rust core** (client-agnostic product
  logic: vault I/O, search, link graph, the `ai` chat orchestrator). Keep product
  logic here so future clients reuse it.
- `app/desktop/src-tauri` — the **Tauri 2 shell** (`desktop` crate): commands,
  OS keychain, HTTP to the LLM. Thin; delegates to the core.
- `app/desktop/src` — the **React 19 + Tailwind v4 frontend**. Talks to the shell
  only through `src/lib/api.ts` (never `invoke` directly).

It's a Cargo workspace (`crates/*` + the shell) plus an npm project under
`app/desktop`.

## Run it (dev)

```bash
npm --prefix app/desktop run tauri dev     # the real app: builds the Rust shell + serves Vite in the Tauri window
npm --prefix app/desktop run dev           # frontend only, in a browser (Vite) — no Rust, no IPC
```

Use the browser-only `dev` for pure UI iteration; use `tauri dev` for anything
that hits a command (vault ops, chat, keychain).

## Test

```bash
cargo test --workspace                     # Rust: neuralnote-core + the desktop shell
npm --prefix app/desktop run typecheck     # tsc --noEmit
npm --prefix app/desktop run test:run      # Vitest (unit + component), one-shot
npm --prefix app/desktop run test:e2e      # Vitest e2e (src/e2e, jsdom + mocked IPC)
npm --prefix app/desktop run coverage      # Vitest with coverage → writes the TS lcov
```

`test` (no `:run`) is watch mode — use `test:run` in CI/verification.

## Quality gates

```bash
bash scripts/rust-quality-gate.sh          # clippy -D warnings + rustfmt --check + llvm-cov ≥90% (neuralnote-core) + cargo-audit
```

**Known, pre-existing gate note — don't misread it as your regression.**
`cargo-audit` reports advisories that live entirely in **Tauri-transitive** deps,
not app code:

- `plist → quick-xml` (RUSTSEC-2026-0194/0195), and `atk`/`gdk` (GTK3 bindings,
  unused on macOS).

Before treating any advisory as caused by your change, prove provenance:

```bash
cargo tree -i <crate> -e normal            # e.g. cargo tree -i quick-xml  → shows it comes via tauri
```

Coverage in the gate is scoped to `neuralnote-core` (the shell's network/keychain
paths aren't unit-coverable — they're exercised by integration + the manual run).

**SonarQube** (the all-A + ≥90% bar): regenerate both coverage files, then scan:

```bash
bash scripts/rust-quality-gate.sh          # writes lcov-rust.info
npm --prefix app/desktop run coverage      # writes the TS lcov
source .env.sonar && sonar-scanner
```

## Ship

```bash
npm --prefix app/desktop run tauri build   # release bundle
npm --prefix app/desktop run build         # frontend production build only (tsc + vite)
```

## What "done" means

Read `docs/definition-of-done.md` — the shipping bar (tests + e2e + both quality
gates green; production-audit is periodic, not per-feature). Full product spec:
`specs/neural-note.md`. Protect the moat: **full-source cited recall** — never
break markdown+YAML Obsidian compatibility, never let a capture/LLM/citation
failure go silent.
