# CI and Local Quality Gates

**Status:** Implemented. Hosted GitHub Actions run on pull requests, pushes to `main`, a weekly Monday schedule, and manual dispatch.
**Last reviewed:** 2026-08-18

## Decision

NeuralNote will use GitHub Actions for contributor-facing verification and a
repository-owned Docker Compose environment for maintainer-only SonarQube analysis.

Pull requests receive secret-free feedback from linting, type checking, unit
tests, frontend coverage/build/audit, Chromium journeys, Ubuntu and macOS Rust
checks, generated-binding validation, secret scanning, and Ubuntu native
WebDriver. Pushes to `main` add the Rust coverage and `cargo-deny` gates.
WebKit, native macOS, and native Windows are weekly or manual informational
lanes until those runners are deterministic.

SonarQube remains local. It is not called from GitHub-hosted runners and is not a
required check for external contributors. The local environment is reproducible from
tracked configuration, but credentials and analysis tokens remain untracked.

## Goals

- Give contributors fast, deterministic pull request feedback.
- Run the full Definition of Done verification after changes land on `main`.
- Keep native end-to-end coverage on Ubuntu without making every pull request wait for the flaky macOS and Windows informational lanes.
- Detect committed secrets in both current files and Git history.
- Add a real frontend lint gate with a deliberately scoped Oxlint configuration.
- Make first-time setup, including local SonarQube, discoverable for people and agents.
- Keep workflows least-privileged, reproducible, and resistant to supply-chain risk.
- Preserve the current release workflow's signing and publishing responsibilities.

## Non-goals

- Hosting a public or shared SonarQube server.
- Making a maintainer's SonarQube token available to pull request workflows.
- Running native Tauri end-to-end tests on every pull request.
- Replacing GitHub branch protection with workflow logic.
- Automatically publishing releases from ordinary `main` pushes.
- Treating local SonarQube as a production service or durable team database.

## Current Constraints

- The desktop package has Oxlint, TypeScript, Vitest unit, mockIPC, browser, and
  coverage scripts. `coverage` re-runs the full Vitest suite, so CI must not
  precede it with a separate `test:e2e` or markdown-contract step.
- Native WebdriverIO tests live in `.github/workflows/e2e.yml`. Ubuntu is the
  required lane. macOS and Windows are informational and run only on the weekly
  schedule or manual dispatch.
- `scripts/rust-quality-gate.sh` checks formatting, Clippy, generated bindings, Rust
  coverage, and `cargo-deny`. Hosted CI invokes `cargo deny check advisories` on
  `main` (and on schedule/dispatch), not `cargo audit`.
- No merge-blocking job may skip compiling `#[cfg(target_os = "macos")]` code. The
  `Rust / macOS compile and test` job exists for that; it does not drive WebdriverIO.
- `sonar-project.properties` already consumes frontend and Rust LCOV reports.
- `.env.sonar` is local, permission-restricted, and must never be printed or committed.
- GitHub-hosted runners cannot reach the local SonarQube instance.

## Workflow Architecture

### Pull request verification

The new `.github/workflows/ci.yml` runs its pull request path only for pull requests
whose base branch is `main`.

The pull request path contains these required checks:

1. Gitleaks scans the full Git history with `-v` so a finding names the rule and file.
2. Both supported Node lines (22 and 24) run Oxlint, `tsc --noEmit`, the browser
   typecheck, and Vitest unit/component tests (`src/e2e/**` excluded).
3. Node 24 runs `coverage` (which includes mockIPC journeys), the production
   build, and `audit:all` (desktop `npm audit` plus `scripts/audit-e2e-native.mjs`).
4. Chromium real-browser journeys run on Ubuntu.
5. Ubuntu Rust runs workspace tests, the `native-e2e` feature boundary, Clippy,
   rustfmt, and generated-binding drift.
6. macOS Rust compiles and tests the workspace so `cfg(macos)` cannot merge unchecked.

These checks are the branch-protection candidates. They do not require repository
secrets and must also work for pull requests from forks. Published check names
must match `CONTRIBUTING.md` exactly. Do not require `Native Tauri (Ubuntu)`:
that workflow is path-filtered, so a docs-only pull request would sit pending.

### Main branch verification

The same `ci.yml` runs its full path for pushes to `main`. Frontend coverage,
the production build, and `audit:all` already run on pull requests. Pushes to
`main` add:

1. Rust LCOV generation with the existing 90 percent line coverage threshold,
   scoped to `-p neuralnote-core`.
2. A mandatory `cargo deny check advisories` run with network access.

`audit:all` still covers both lockfiles. The desktop lockfile is audited with
`npm audit --audit-level=high`; the native-WebDriver lockfile (CI-only dev
tooling, no shipped artifact) goes through `scripts/audit-e2e-native.mjs`, a
fail-closed wrapper that exits non-zero on any high/critical advisory except
explicitly accepted residuals recorded inline in its `ACCEPTED` map (each bound
to one package, with rationale and a removal trigger), and exits 2 whenever the
audit cannot run or its report schema is not understood.

Native Tauri end-to-end tests remain in `.github/workflows/e2e.yml`. Ubuntu runs
on pull requests (path-filtered) and on pushes to `main`. macOS and Windows run
only on the weekly Monday schedule (`17 6 * * 1`) or manual dispatch, and stay
`continue-on-error`. The same schedule and dispatch triggers run WebKit.

The main branch is considered fully verified only when both `ci.yml` and the
required Ubuntu native job succeed. Informational reds do not fail those
workflows.

### Release verification

`.github/workflows/release-alpha.yml` is manual-only. It accepts an existing release
tag, a signing mode (`ad-hoc` or `developer-id`), and an explicit acknowledgement
for an unnotarized ad-hoc build. It never creates or moves a tag, and it requires the
tagged commit to equal the `main` commit selected for the dispatch.

The workflow separates privilege across three jobs. A secret-free preflight rejects
invalid refs and inputs. The build job is bound to the protected `release` environment,
runs with `contents: read`, executes the full release gates, signs the updater archive,
cryptographically verifies it against the configured updater public key, and uploads a fixed
checksum-bound artifact set. The signing-secret-free publisher runs with `contents: write`
but receives no signing environment secrets or variables and executes no repository code.
It revalidates the remote tag before draft creation and publication, creates a draft, uploads the
assets, publishes a non-latest prerelease, and updates the dedicated manifest branch last. An active
tag ruleset must prevent release-tag updates and deletions, and repository release immutability must
protect the published tag and assets.

Updater credentials are always stored in the `release` environment. Apple identity,
certificate, keychain, and notarisation credentials are required only for
`developer-id`. Ad-hoc mode sets the Tauri macOS signing identity to `-`, verifies the
result with `codesign`, skips Apple import and `spctl`, and labels the release
unnotarized. Developer ID mode fails closed when any Apple credential is absent.

Release tags repeat the full relevant quality gates. This duplication is intentional:
a release must prove the exact tagged source before it publishes artifacts. Hosted
SonarQube remains excluded because the local server is unreachable from the runner.

## Test and Lint Boundaries

The desktop package gains an explicit `test:unit` script that excludes `src/e2e/**`.
The existing all-test command remains the main-branch and release path.

Oxlint is added to `app/desktop` at the same compatible version used by the prototype,
with its exact resolved version recorded in the lockfile. The configuration enables
the native ESLint, TypeScript, Unicorn, Oxc, React, Vitest, and JSX accessibility
plugins where they apply.

The initial rule set prioritises correctness and suspicious-code findings. It avoids
large stylistic rewrites and does not duplicate TypeScript's type checker. Any
baseline findings fixed during adoption must be narrowly scoped and behaviour
preserving.

## Workflow Security and Reliability

- Workflow permissions default to `contents: read`.
- Release build and dependency scripts never receive a repository write token. Only the
  signing-secret-free publisher receives `contents: write`, after validating the transferred
  artifact allowlist and checksums.
- Third-party actions are pinned to full commit SHAs.
- Dependency installation uses lockfiles and frozen or locked modes.
- Caches use the relevant lockfile as part of their key.
- Every job has a finite timeout.
- Failed quality gates fail the workflow. Quality jobs do not use
  `continue-on-error`.
- Pull request jobs do not receive secrets.
- A new run cancels an older in-progress run for the same pull request.
- Runs on `main` are not cancelled by newer pushes.
- Gitleaks checks out full history rather than a shallow snapshot.
- Generated coverage reports and build outputs are ephemeral unless a failed job
  needs an explicitly non-sensitive diagnostic artifact.
- Release publication is manual, existing-tag-only, always a non-latest prerelease, and
  makes the updater manifest visible only after the signed assets are public. The publisher can
  resume a failed manifest-last step only after byte-comparing an existing release's assets.

## Local SonarQube Environment

### Architecture

The repository gains `compose.sonar.yml` using the official SonarQube Community Build
image pinned to `sonarqube:26.7.0.124771-community`. The service binds only to
`127.0.0.1:9000` and uses named Docker volumes for data, logs, and extensions.

The initial local setup uses SonarQube's embedded database. This is acceptable for a
single-developer quality gate, but not for a production or shared deployment. No
database passwords, administrator passwords, or analysis tokens appear in Compose.

The image supports both Apple Silicon and x86-64 development machines.

### Credential model

The repository contains a safe `.env.sonar.example` with:

```dotenv
SONAR_HOST_URL=http://localhost:9000
SONAR_TOKEN=
```

Each maintainer copies it to `.env.sonar`, creates a project token in the local
SonarQube UI, and restricts the file to mode `0600`. `.env.sonar` remains ignored.
Documentation never asks an agent to display, echo, or inspect the token's value.

### First run

The documented lifecycle is:

1. Confirm Docker and the SonarScanner CLI are installed.
2. Start the service with `docker compose -f compose.sonar.yml up -d`.
3. Wait until SonarQube's system status API reports that the server is ready.
4. Open `http://localhost:9000`, sign in with the documented first-run credentials,
   and immediately replace the default password.
5. Create the NeuralNote project and a project-scoped analysis token.
6. Copy `.env.sonar.example` to `.env.sonar`, add the token without printing it, and
   run `chmod 600 .env.sonar`.
7. Generate both frontend and Rust LCOV reports.
8. Load the environment file into the current shell and run `sonar-scanner` from the
   repository root.
9. Confirm the analysis completed and inspect the local quality gate in the UI.

Routine shutdown uses `docker compose -f compose.sonar.yml stop`. A documented reset
uses `docker compose -f compose.sonar.yml down --volumes` and clearly warns that it
deletes local SonarQube data and tokens.

### Availability semantics

Local SonarQube has three reportable outcomes:

- **Passed:** the server was reachable, analysis completed, and the quality gate passed.
- **Failed:** analysis ran and the quality gate failed, or the scanner returned an error.
- **Unavailable:** Docker, SonarScanner, `.env.sonar`, or the local server was absent.

Unavailable is never described as passed. External contributors are not expected to
run this maintainer-only gate, while maintainers run it for milestones and release
readiness as defined in `docs/definition-of-done.md`.

## First-time Agent Setup

`AGENTS.md` gains a first-time setup section. Before modifying the repository, an
unfamiliar agent must:

1. Read the product spec and Definition of Done.
2. Check the installed Node.js, npm, Rust, Cargo, and Tauri prerequisites against the
   repository's pinned or documented versions.
3. Install JavaScript dependencies from the lockfiles without updating them.
4. Confirm the Rust components and gate tools required by repository scripts are
   available.
5. Install or prepare the Ollama sidecar only when the assigned work exercises local
   AI paths.
6. Run the fast baseline gates before editing and record pre-existing failures.
7. Check whether Docker, SonarScanner, `.env.sonar`, and the local SonarQube server are
   available when the task requires the maintainer quality gate.

An agent must not install software, start a large service, reset SonarQube volumes, or
alter credentials without user approval. It must not read or print `.env.sonar`.

`AGENTS.md` links to a human-readable SonarQube runbook rather than duplicating every
command. The runbook is the source of truth for Docker startup, first-run setup,
coverage generation, analysis, shutdown, reset, and troubleshooting.

## Documentation Changes

Implementation updates these public documents:

- `README.md`: verification overview, CI badges once workflow names are stable, and a
  link to the local SonarQube runbook.
- `CONTRIBUTING.md`: the pull request gate, optional maintainer-only SonarQube context,
  and how contributors run the fast checks locally.
- `AGENTS.md`: first-time setup, baseline verification, permission boundaries, and
  local SonarQube availability semantics.
- `docs/definition-of-done.md`: hosted checks are mandatory; SonarQube is a local
  maintainer milestone gate rather than a contributor or GitHub Actions requirement.
- `docs/local-sonarqube.md`: complete Docker-based setup and operating runbook.
- `SECURITY.md`: no local credentials or reports containing sensitive source material
  are attached to public issues.

## Repository Settings

Branch protection on `main` requires the published names listed in
`CONTRIBUTING.md`. Informational WebKit and native macOS/Windows jobs are not
required. Native Ubuntu is not required either, because its workflow is
path-filtered.

Repository settings remain a manual operation. The workflow must not assume permission
to modify branch protection.

## Implementation Surface

The planned implementation may change or add:

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/release-alpha.yml`
- `app/desktop/package.json`
- `app/desktop/package-lock.json`
- `app/desktop/.oxlintrc.json`
- `compose.sonar.yml`
- `.env.sonar.example`
- `.gitignore`
- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `docs/definition-of-done.md`
- `docs/local-sonarqube.md`

Files outside this list require an implementation-time justification. Generated
bindings and coverage reports are verification outputs, not hand-edited source files.

## Acceptance Criteria

- Pull requests targeting `main` run the secret-free quality gates, including
  frontend coverage/build/audit, Chromium, Ubuntu Rust, and macOS Rust compile.
- Pushes to `main` add Rust coverage and `cargo-deny`. Ubuntu native WebDriver
  runs on relevant pull requests and on `main`; WebKit and native macOS/Windows
  run weekly or on manual dispatch only.
- Release jobs no longer attempt to contact a local SonarQube server.
- Oxlint is installed, configured, and green in the desktop package.
- Frontend unit tests are separable from mockIPC journey tests.
- Frontend and Rust line coverage gates both enforce 90 percent on `main`.
- Dependency audits fail when they find disallowed advisories or vulnerabilities;
  accepted residuals live only in `scripts/audit-e2e-native.mjs`'s `ACCEPTED` map
  with per-advisory justification and removal triggers.
- Gitleaks scans full history in hosted CI.
- Every referenced action is pinned to a full commit SHA.
- `docker compose -f compose.sonar.yml up -d` starts a loopback-only local SonarQube
  instance on supported development machines.
- The local scan consumes both expected LCOV reports and reports the quality gate
  without exposing credentials.
- A first-time human or agent can distinguish passed, failed, and unavailable local
  SonarQube outcomes.
- Public documentation agrees on which gates contributors, maintainers, `main`, and
  releases must run.

## Primary References

- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions event triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [Tauri WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/)
- [Vitest CLI](https://v4.vitest.dev/guide/cli)
- [Vitest exclude configuration](https://v4.vitest.dev/config/exclude)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxlint plugins](https://oxc.rs/docs/guide/usage/linter/plugins)
- [SonarQube Community Build Docker installation](https://docs.sonarsource.com/sonarqube-community-build/server-installation/from-docker-image/installation-overview)
- [SonarQube Community Build Docker preparation](https://docs.sonarsource.com/sonarqube-community-build/server-installation/from-docker-image/prepare-installation)
