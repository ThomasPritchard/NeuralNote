# NeuralNote

[![CI](https://github.com/ThomasPritchard/NeuralNote/actions/workflows/ci.yml/badge.svg)](https://github.com/ThomasPritchard/NeuralNote/actions/workflows/ci.yml)
[![Native E2E](https://github.com/ThomasPritchard/NeuralNote/actions/workflows/e2e.yml/badge.svg)](https://github.com/ThomasPritchard/NeuralNote/actions/workflows/e2e.yml)

NeuralNote is a local-first desktop knowledge base for people who want the usefulness of an AI second brain without giving up plain Markdown files.

It opens an existing Obsidian-compatible vault, keeps the user's files as the source of truth, and adds search, links, graph exploration, templates, and cited chat. The long-term product loop is capture, distil, organise, retrieve, and answer with citations that can be checked against the source.

> [!WARNING]
> NeuralNote is pre-alpha software. Back up any vault before opening it, expect breaking changes, and do not rely on it as the only copy of important data.

## Project status

The vault foundation and the first AI slices are working, but the full product described in the specification is not finished.

| Area | Status |
| --- | --- |
| Open or create a Markdown vault | Available |
| Browse, render, edit, search, and organise notes | Available |
| Backlinks, templates, and graph view | Available |
| Cited chat over existing vault Markdown | Available; citations point to a note and line |
| OpenRouter and local Ollama providers | Available |
| YouTube distillation | Early implementation; still being hardened |
| Full-source article, PDF, and transcript capture | Planned |
| Chunk- or timestamp-level cited recall | Planned |
| Device sync, mobile, and hosted AI | Planned |

The important distinction is citation fidelity. NeuralNote does not yet deliver the full-source capture and timestamp-aware recall described in the product vision. Today, chat retrieves from the Markdown already in the vault and cites the note and line it used.

## Why NeuralNote

Obsidian-compatible Markdown is the ownership boundary. NeuralNote can add an opinionated AI workflow, but removing NeuralNote should still leave a readable vault that works with ordinary Markdown tools.

Three constraints shape the project:

- User data remains normal Markdown and YAML frontmatter.
- Product logic lives in a reusable Rust core, not in the desktop shell.
- A wrong citation is worse than no answer, so citation evidence is treated as a release gate.

See the [product and technical specification](specs/neural-note.md) for the complete direction and the [Definition of Done](docs/definition-of-done.md) for the shipping bar.

## Architecture

```text
app/desktop/src/             React 19 webview
        |                    typed calls through src/lib/api.ts
        v
app/desktop/src-tauri/       thin Tauri 2 shell, keychain and native I/O
        |
        v
crates/neuralnote-core/      reusable vault, retrieval and AI domain logic
```

The TypeScript files in `app/desktop/src/lib/bindings/` are generated from Rust with `ts-rs`. Change the Rust type and regenerate the bindings; do not edit generated files by hand.

## Privacy model

The vault stays on the user's filesystem. That does not automatically mean every AI operation is local.

- OpenRouter mode sends the content needed for the selected AI operation to OpenRouter and the model provider. The API key is stored in the operating system keychain.
- Local Ollama mode runs inference through an app-owned loopback service.
- NeuralNote does not currently provide cloud sync.

The app should be described as local-first and user-owned, not as universally private. Review the [threat model](NeuralNote-threat-model.md) for the current trust boundaries.

## Development setup

The current release path targets Apple Silicon macOS. Linux and Windows run native end-to-end checks in CI, but they are not supported release targets yet.

Install:

- Node.js 22
- Rust 1.96 through `rustup`
- The [Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

Then run:

```bash
git clone https://github.com/ThomasPritchard/NeuralNote.git
cd NeuralNote

rustup toolchain install 1.96.0 --component clippy,rustfmt,llvm-tools-preview
npm --prefix app/desktop ci

# macOS: fetch the checksum-pinned local-AI sidecar used by the native app
./scripts/fetch-ollama-sidecar.sh

npm --prefix app/desktop run tauri dev
```

For frontend-only work, `npm --prefix app/desktop run dev` starts Vite without the Rust shell or native IPC.

## Tests and quality gates

The quick local checks are:

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:unit
cargo test --workspace --locked
npm --prefix app/desktop run check:bindings
```

Pull requests targeting `main` run these fast checks plus a full-history Gitleaks scan. Pushes to `main` add all frontend journeys, 90 percent frontend and Rust line-coverage gates, the production build, dependency audits, and the Linux/Windows native WebDriver matrix.

The complete Rust gate also needs `cargo-llvm-cov` and `cargo-audit`:

```bash
cargo install cargo-llvm-cov --locked --version 0.8.7
cargo install cargo-audit --locked --version 0.22.2
./scripts/rust-quality-gate.sh
```

Maintainers can run the SonarQube milestone gate locally through Docker. It is not required for external pull requests and is never called from GitHub-hosted runners. See [Local SonarQube](docs/local-sonarqube.md).

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Coding agents should also read [AGENTS.md](AGENTS.md).

## Roadmap and business model

The local desktop client and the user's Markdown data are intended to remain the open foundation. The planned commercial layer is a hosted sync API that keeps vaults available across devices, with managed cloud AI as a possible later service. Sync, authentication, billing, and a server are not present in this repository today.

Keeping that boundary clear matters: paid convenience should not weaken local ownership or make the file format proprietary.

## Contributing

Feedback, issue discussion, and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), especially for changes to storage, citations, provider handling, or the Tauri IPC boundary.

Do not post suspected vulnerabilities in a public issue. Follow the private reporting process in [SECURITY.md](SECURITY.md).

## Licence

Copyright (C) 2026 Thomas Pritchard and contributors.

NeuralNote is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). You may use, study, modify, and redistribute the code under that licence. Modified versions offered to users over a network must also make their corresponding source available under the AGPL.

The licence applies to the code in this repository. The planned hosted sync service is a separate product and is not included here.
