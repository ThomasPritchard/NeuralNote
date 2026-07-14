# Guidance for coding agents

This file is the operating contract for automated coding agents working in NeuralNote. Follow it together with the nearest human request. If the two conflict, stop and ask rather than widening scope.

## Read before changing code

For every substantive task:

1. Read `specs/neural-note.md` for the product and architecture contract.
2. Read `docs/definition-of-done.md` for the acceptance bar.
3. Read the relevant slice specification under `specs/` and the files at the boundary being changed.
4. Check the working tree before editing. Preserve unrelated user changes.
5. For any external package, library, API, SDK, CLI, or cloud service, verify the current primary documentation before writing code.

Do not infer that a planned feature already exists. Keep the README distinction intact: current chat cites vault notes and lines; full-source capture and chunk- or timestamp-level recall remain incomplete.

## First-time setup

An agent that has not worked in this checkout must establish the local baseline before editing:

1. Confirm Node.js 24 LTS (preferred) or Node.js 22.12 or later in the 22.x release line, npm, Rust 1.96, Cargo, and the operating-system prerequisites for Tauri 2 are installed.
2. Install locked frontend dependencies with `npm --prefix app/desktop ci`. Do not update a lockfile during setup.
3. Confirm the Rust components and quality tools are available. If they are missing,
   request approval before installing them with:

   ```bash
   rustup toolchain install 1.96.0 --component clippy,rustfmt,llvm-tools-preview
   cargo install cargo-llvm-cov --locked --version 0.8.7
   cargo install cargo-audit --locked --version 0.22.2
   ```

4. Fetch the Ollama sidecar only when the task exercises the native local-AI path. Downloads and service startup require the user's approval.
5. Run the fast baseline before changing files and record any pre-existing failure:

   ```bash
   npm --prefix app/desktop run lint
   npm --prefix app/desktop run typecheck
   npm --prefix app/desktop run test:unit
   cargo test --workspace --locked
   ```

Do not install software, start a large service, or alter credentials without approval. A failed or unavailable prerequisite is a blocker to report, not permission to work around the repository's controls.

Frontend pull-request CI runs the fast checks on both supported Node.js lines. Release and native end-to-end workflows use Node.js 24 LTS.

### Local SonarQube

SonarQube is a maintainer-only local milestone gate. It runs through the repository's loopback-only Docker Compose service; it is not available to GitHub Actions or required from external contributors.

Before a task that requires SonarQube, check only whether Docker, `sonar-scanner`, `.env.sonar`, and `http://localhost:9000` are available. Never open, print, echo, or paste `.env.sonar`. Follow [docs/local-sonarqube.md](docs/local-sonarqube.md) for startup, first-run setup, coverage generation, scanning, shutdown, and troubleshooting.

Report the outcome precisely:

- **Passed:** analysis completed and the quality gate passed.
- **Failed:** analysis or the quality gate failed.
- **Unavailable:** a prerequisite, credential file, or local service was absent.

Unavailable is never equivalent to passed. Do not start SonarQube or reset its volumes without approval.

## Protect these invariants

1. **Citation fidelity comes first.** A wrong citation is worse than no answer. Do not trust a model-generated citation marker without deterministic evidence validation.
2. **The vault remains user-owned.** Markdown and YAML frontmatter must remain Obsidian-compatible. Removing the `nn` metadata block should leave a useful note.
3. **Failures are explicit.** Never silently drop or hide user content, capture failures, parse errors, provider errors, or citation failures.
4. **The Rust core is reusable.** Product logic belongs in `crates/neuralnote-core`. The Tauri shell performs native I/O and delegates.
5. **Security boundaries live in code.** Prompts, UI hiding, and model instructions are not authorization controls.

## Repository map

- `crates/neuralnote-core/`: client-independent vault, capture, retrieval, citation, and AI orchestration logic.
- `app/desktop/src-tauri/`: thin Tauri commands, OS keychain, HTTP, process management, updater, and native desktop integration.
- `app/desktop/src/`: React webview. All native calls pass through `src/lib/api.ts`.
- `app/desktop/src/lib/bindings/`: generated TypeScript mirrors of Rust contracts.
- `app/desktop/src/e2e/`: jsdom journeys through the real frontend IPC abstraction.
- `app/desktop/e2e-native/`: WebdriverIO checks for the packaged native boundary on Linux and Windows CI.
- `prototype/`: disposable design exploration. Do not import it into production code.
- `specs/`: authoritative feature and architecture contracts.

## Development rules

- Use test-driven development for every feature and bug fix: write and run the failing test first, implement the smallest change, then run it green.
- Cover failure and edge conditions, not only the golden path. Relevant classes include malformed, empty, oversized, non-UTF-8, cancellation, concurrency, symlink, and path-race cases.
- Keep public contracts and wire shapes stable unless the specification explicitly changes them.
- Do not hand-edit `app/desktop/src/lib/bindings/`. Change the Rust source and run `npm --prefix app/desktop run gen:bindings`.
- Keep Tauri commands thin. Do not duplicate core validation or business logic in the shell or React layer.
- Treat vault content, frontmatter, file paths, webview IPC, provider responses, model output, downloads, archives, and helper processes as untrusted.
- Use fixed argument arrays rather than a shell for external processes. Constrain paths, environments, time, output size, and cancellation.
- Store provider secrets only in the OS keychain. Never return a key to the webview or include it in logs and errors.
- Do not rely on secrecy of prompts or source code. Assume public source and attacker-controlled model input.
- Use platform or maintained library protections before hand-written parser or validator approximations.
- Keep scope narrow. Do not refactor adjacent code, change formatting broadly, or rewrite contracts without an explicit requirement.

## Security-sensitive changes

A change is security-sensitive when it touches a parser or validator, untrusted content, filesystem paths, IPC, credentials, provider traffic, model tools, downloads, archives, external processes, updater behaviour, CI permissions, or future sync/auth code.

For those changes:

- Add adversarial regression cases based on the real grammar or platform behaviour.
- Trace the full boundary from untrusted input to the privileged sink.
- Verify fail-closed behaviour and explicit user-visible errors.
- Request an independent adversarial review after implementation.
- Do not claim completion from green unit tests or static analysis alone.

Update `NeuralNote-threat-model.md` when adding a trust boundary, external origin, native capability, command, helper binary, model tool, identity, or sync authority.

## Verification

Use the smallest relevant checks while iterating, then run the complete applicable set before handing work back:

```bash
npm --prefix app/desktop run lint
npm --prefix app/desktop run typecheck
npm --prefix app/desktop run test:unit
cargo test --workspace --locked
npm --prefix app/desktop run check:bindings
```

For `main`, releases, and milestone verification, also run:

```bash
npm --prefix app/desktop run coverage
npm --prefix app/desktop run build
npm --prefix app/desktop audit --audit-level=high
./scripts/rust-quality-gate.sh
gitleaks git . --log-opts=--all --redact
```

User-facing changes also require a real-app walkthrough with:

```bash
npm --prefix app/desktop run tauri dev
```

Do not report a command as passing unless it was run in the current task and its exit status was checked. If a check is blocked by missing network, local services, platform support, or sandbox permissions, report the exact blocker and do not convert it into a pass.

## Handoff format

At the end of a task, report:

- the behaviour changed and why
- the files changed
- the exact verification commands and results
- any manual journey exercised
- security, privacy, compatibility, or citation implications
- remaining risks, skipped checks, or follow-up work

Do not commit, push, publish a release, change repository visibility, or modify licensing unless the user explicitly asks.
