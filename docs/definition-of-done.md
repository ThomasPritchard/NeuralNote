# Definition of Done

The bar a change clears before it ships. It is **tiered on purpose**: a baseline every
feature must meet, a heavier bar for security-adjacent changes, and deeper gates that run
**periodically — not on every feature**.

> The one rule: *tests passing is not done.* A feature is done when it is **verified working
> against the running app**, **the applicable hosted and local gates are green**, and it
> **cannot silently lose data or break vault compatibility**. Everything below makes that
> concrete.

---

## 1. Every feature — the baseline (always)

### Tests
- **Unit tests** for the logic you changed — Rust core (`crates/neuralnote-core`) and/or the
  TS client. Cover the golden path **and** the failure/edge paths (empty, malformed, oversized,
  non-UTF-8, concurrent).
- **≥ 90 % line coverage on the code you changed** (the project target). New uncovered lines
  are a red flag, not a rounding error.
- **An e2e / journey test for any user-facing flow** — the jsdom + `mockIPC` tier in
  `app/desktop/src/e2e/` (drives the app through its real IPC boundary). The native
  WebdriverIO tier (`app/desktop/e2e-native/`) is CI-only (macOS can't run `tauri-driver`).

### Hosted and native quality gates GREEN
- **Pull request CI** — Oxlint, TypeScript type checking, frontend unit/component tests,
  Rust workspace tests, Clippy, rustfmt, generated-binding drift, and full-history Gitleaks.
  These checks are secret-free and must pass before merge.
- **Rust-native gate** — `./scripts/rust-quality-gate.sh` prints **GREEN (all categories
  enforced)** and exits `0`: `clippy -D warnings`, `rustfmt --check`, `cargo llvm-cov
  --fail-under-lines 90`, `cargo-audit`. The exit code is the contract automation reads:
  `0` GREEN (every category ran and passed), `1` RED (real findings — a code verdict), `2`
  INCOMPLETE (a required category could not run — the tool is absent or the advisory DB was
  unreachable/offline). **INCOMPLETE is not green:** the gate exits non-zero (`2`) and never
  prints GREEN, so an incomplete run can't be mistaken for a pass — re-run with the tooling
  installed and network before trusting it.
- **Main branch CI** — all frontend tests including mockIPC journeys, frontend and Rust
  90 % line-coverage gates, production build, dependency audits, and the Linux/Windows native
  WebDriver matrix. A red post-merge check blocks release readiness and is fixed immediately.
- **macOS release verification** — the selected lane passes its platform checks. Ad-hoc releases
  require strict `codesign` verification plus the Tauri updater signature. Developer ID releases
  additionally require Gatekeeper assessment and notarisation. Before declaring a release ready,
  an installed older build must detect the published version from the production manifest.

### Static checks clean
- `npm run lint` and `npm run typecheck` clean, `cargo clippy` clean, and
  `cargo fmt --check` clean. No new warnings.

### Verified against ground truth (not just tests)
- **Actually run it** in the app (`npm run tauri dev`, or the built `.app`). Walk the golden
  path and the key edge cases by hand. A clean diff and green tests are necessary, not
  sufficient — type-checks and unit tests verify *code* correctness, not *feature* correctness.
- **Use the reusable note test vault for note-facing changes.** Run
  `node scripts/prepare-note-test-vault.mjs`, open the generated ignored copy under `target/` in the
  app, and work through the applicable checklist in `00 Test Index.md`. Keep the fixture and
  its coverage map current when supported note behaviour changes. See
  [Note test vault](note-test-vault.md).
- **Give hands-on testing a separate app identity on macOS.** For maintainer handoff, create a
  debug bundle named `NeuralNote-Dev.app` with the `com.neuralnote.desktop.dev` identifier, copy
  it to `target/dev-builds/NeuralNote-Dev.app`, and exercise that exact bundle. This keeps the
  test build visibly separate from the main NeuralNote app and prevents both builds sharing an
  application identity by accident. The repeatable commands are listed below.

### Review
- Every non-trivial change receives a focused review for correctness, silent failures, security,
  data loss, compatibility, and scope. Fix findings severity-first and re-review the delta.
- Security-adjacent changes require an independent adversarial reviewer who did not implement the
  control. Green tests, lint, and static analysis are not a substitute for that review.

### Project invariants (the things this product refuses to break)
- **Failures are never silent.** Capture / LLM / citation / parse / I/O errors are surfaced to
  the user explicitly, and **content is never lost or hidden** (e.g. a note that won't fully
  parse still shows its body + an error; a non-UTF-8 note is shown lossily, not hidden).
- **Data format stays Obsidian-compatible** — markdown + YAML frontmatter. This is both the
  ownership promise and the free-migration moat; a change that breaks it is not done, full stop.
- **Citation fidelity** (once retrieval lands): a wrong citation is worse than no answer. Any
  change to capture/chunking/retrieval must preserve exact source→citation mapping.

### Housekeeping
- The relevant specification, public documentation, and `AGENTS.md` are updated if behaviour,
  architecture, or the agent operating contract changed.
- Any deferred work left as a **greppable `TODO(<context>): <what + why + the trigger>`** at the
  code site — never only in a PR description or a doc that rots.

---

## 2. Security-adjacent changes — extra bar (when touched)

Applies when a change touches: **a parser/validator, untrusted input (note content, frontmatter,
imported vaults), file paths, the IPC boundary, secrets/keys, or auth.**

- **Independent adversarial review is REQUIRED.** A green test suite, lint result, or SonarQube
  result is **not** sign-off here. A separate reviewer must try to *break* the control — comparing
  what the validator *thinks* it accepts against the *real* grammar/threat.
  - *Why this rule exists:* a YAML alias-bomb guard in this codebase passed its full unit suite
    **and** a green Sonar gate, yet adversarial review bypassed it twice (a quote mid-plain-scalar;
    hyphenated anchor names). Tests prove the cases you thought of; adversarial review finds the
    ones you didn't.
- **Prefer the platform/library's own protection over hand-rolled detection.** Re-implementing a
  parser's grammar by hand is a bypass farm. If you must hand-roll, prove it against an explicit
  adversarial corpus and fail safe.
- **Know which threat your dependency actually covers.** (e.g. serde_yaml_ng's repetition limit
  stops *exponential* alias bombs but not *quadratic* flat fan-out — verify, don't assume.)

---

## 3. Periodic / milestone gates (NOT every feature)

Run these at release/milestone boundaries, after a batch of features, or when a change touches a
risk surface broadly — **not on every commit.**

- **Full `/production-audit`** — the multi-engine sweep + gap-pass. Stop condition: **two
  consecutive rounds with 0 CRITICAL and 0 HIGH.** Carry deferred/accepted residuals as in-code
  comments (TODO for deferred, plain rationale for accepted), not a rotting report file.
- **Local SonarQube** (project key `NeuralNote`) — maintainers run the Docker-based gate for
  milestones and release readiness. Status **OK** means `new_violations = 0`,
  `new_coverage ≥ 80 %`, and `new_duplicated_lines ≤ 3 %`; also hold overall coverage at
  90 % or above with no vulnerabilities or open security hotspots. An unavailable local service
  is reported as unavailable, never passed. See [Local SonarQube](local-sonarqube.md).
- **Dependency audit** — `cargo-audit` runs inside the Rust gate every time; run `npm audit` and
  review transitive bumps periodically.
- **a11y + UX pass** — `ux-audit` after a user-facing flow ships; keyboard/focus/contrast check.
- **Performance check** — for anything on the capture→embed→retrieve hot path once it exists.

---

## The checklist (copy into the PR / change notes)

```
Baseline (every feature)
- [ ] Unit tests for changed logic (golden + failure/edge paths)
- [ ] ≥90% coverage on changed code
- [ ] e2e/journey test for any user-facing flow (src/e2e/)
- [ ] Pull request CI green: lint, typecheck, unit tests, Rust checks, bindings, Gitleaks
- [ ] Rust gate GREEN — ./scripts/rust-quality-gate.sh (all categories enforced)
- [ ] typecheck + clippy + fmt clean
- [ ] Ran it in the app — golden path + key edge cases by hand; macOS maintainer handoff uses `target/dev-builds/NeuralNote-Dev.app`
- [ ] Note-facing change: exercised the applicable `fixtures/note-test-vault` checklist against a disposable copy
- [ ] Focused review complete; independent adversarial review when security-adjacent
- [ ] Failures surfaced, never silent; no content lost/hidden
- [ ] Obsidian markdown+YAML compatibility preserved
- [ ] Specs/public docs/AGENTS.md updated; deferrals left as TODO(context) in code
- [ ] Release only: selected macOS trust checks pass and an older build detects the published update

If security-adjacent (parser / untrusted input / paths / IPC / secrets / auth)
- [ ] Independent adversarial review (not just tests + Sonar)
- [ ] Used the library's own protection where possible; hand-rolled detection proven adversarially

Periodic (milestone / batch / risk-surface — not every feature)
- [ ] Local SonarQube gate OK, or explicitly not applicable for an external contribution
- [ ] Full /production-audit → two consecutive rounds 0 CRITICAL / 0 HIGH
- [ ] npm audit reviewed; a11y/ux-audit on new flows
```

---

## Commands

```bash
# Frontend (from app/desktop)
npm run lint
npm run typecheck
npm run test:unit         # unit + component; excludes src/e2e
npm run test:run          # all tests, including jsdom + mockIPC journeys
npm run coverage          # all tests + 90% line gate; writes coverage/lcov.info
npm run build

# macOS maintainer handoff (from the repository root; requires the pinned sidecars)
npm --prefix app/desktop run tauri build -- --debug --bundles app \
  --config '{"productName":"NeuralNote-Dev","identifier":"com.neuralnote.desktop.dev","bundle":{"createUpdaterArtifacts":false}}'
mkdir -p target/dev-builds
rm -rf target/dev-builds/NeuralNote-Dev.app # generated local handoff only
ditto --rsrc --extattr --acl target/debug/bundle/macos/NeuralNote-Dev.app target/dev-builds/NeuralNote-Dev.app
codesign --force --deep --sign - target/dev-builds/NeuralNote-Dev.app
codesign --verify --deep --strict target/dev-builds/NeuralNote-Dev.app

# Rust (from repo root)
cargo test --workspace --locked
./scripts/rust-quality-gate.sh           # clippy + fmt + llvm-cov(≥90) + audit
cargo llvm-cov -p neuralnote-core --lcov --output-path lcov-rust.info

# Repository and dependency security
gitleaks git . --log-opts=--all --redact
npm --prefix app/desktop audit --audit-level=high

# Maintainer-only local SonarQube lifecycle and credential-safe scan
# See docs/local-sonarqube.md
```
