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
npm --prefix app/desktop run gen:bindings  # regenerate src/lib/bindings/ from the Rust ts-rs types
npm --prefix app/desktop run check:bindings # regenerate + git-diff: fails if the committed bindings are stale
```

`test` (no `:run`) is watch mode — use `test:run` in CI/verification.

The frontend type mirror in `app/desktop/src/lib/bindings/` is **generated** from the
Rust types by the `ts-rs` crate during `cargo test` (the façade `src/lib/types.ts`
re-exports it). It is committed; edit the Rust type, not the `.ts`. `check:bindings`
(also run by the gate) fails the build if the committed output drifts from the Rust
source, so a Rust↔TS mismatch can never reach a user silently.

## Quality gates

```bash
bash scripts/rust-quality-gate.sh          # clippy -D warnings + rustfmt --check + ts-rs bindings drift + llvm-cov ≥90% (neuralnote-core) + cargo-audit
```

The gate prints **GREEN (all categories enforced)** on a clean tree. If it doesn't,
that's a real finding — treat it as yours until you've proved otherwise.

**On `cargo-audit` advisories.** They are usually Tauri-transitive rather than app
code, and it's tempting to shrug them off as "inherited, not mine". Don't. Prove
provenance *and then try to fix it* — a transitive advisory is often a lockfile bump
away, and a permanently-red security gate teaches everyone to ignore it.

```bash
cargo tree -i <crate> -e normal            # where does it come from?
cargo update --dry-run -p <parent>         # would a bump of the parent carry it forward?
```

Worked example (2026-07-10): `quick-xml 0.39.4` (RUSTSEC-2026-0194/0195, fix
`>=0.41.0`) arrived via `plist → tauri`. It looked unfixable — 0.39→0.41 is a
breaking bump under Cargo's 0.x rules, so we can't force it. But `plist 1.10.0` had
already done it upstream. `cargo update -p plist` moved both, four lines of
`Cargo.lock`, no manifest change, all tests green, and `cargo audit` went to exit 0.
The gate had been red for months for want of one command.

`cargo audit` fails only on **vulnerabilities**. The ~17 remaining `unmaintained` /
`unsound` warnings (gtk-rs GTK3 bindings, unused on macOS) do not fail it and need no
ignore-list.

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
