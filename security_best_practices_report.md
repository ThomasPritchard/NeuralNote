# NeuralNote security review

Date: 2026-07-13

## Outcome

The reviewed desktop application has no open security findings. SonarQube reports zero
vulnerabilities and zero security hotspots, with A ratings for both Security and Security Review.
The production dependency audits report zero npm vulnerabilities and zero RustSec
vulnerabilities.

This review covered the React 19 webview, Tauri 2 IPC boundary, local vault access, provider key
handling, OpenRouter and Hugging Face requests, the app-owned Ollama sidecar, model tool output,
YouTube helper processes, downloaded requirements, CI dependencies, and production CSP and
capabilities.

## Findings fixed

### Immutable CI dependencies

Third-party GitHub Actions are pinned to full commit hashes. Rust tools installed in CI use exact
versions or revisions with `--locked`, preventing mutable tags and unconstrained dependency
resolution from changing executed CI code.

### Ambient yt-dlp code execution

Every app-owned yt-dlp invocation begins with `--ignore-config --no-plugin-dirs`. This prevents
portable, user, system, and default plugin locations from injecting options or Python plugin code.
The caption path explicitly enables only NeuralNote's checksum-pinned POT plugin directory. The
helper still runs with an absolute executable path, argv rather than a shell, a cleared environment,
bounded output, and deadlines.

The built-in updater remains enabled because stale extractors are an expected recovery path. It
stays on yt-dlp's current release channel; first installation and NeuralNote-owned plugin assets
remain URL- and SHA-256-pinned.

### Model-authored image payloads

The model-facing `ask_user` schema no longer advertises image data, and runtime validation rejects
any model-authored image URI. Implementation-authored YouTube thumbnails use a separate path that
accepts only JPEG, PNG, and WebP, caps payload and dimensions, verifies the decoded format, and
fully decodes before creating a data URI. The webview CSP is a second control.

### IPC catalogue boundaries

`hf_model_metadata` accepts only exact Hugging Face repositories from the compiled local-model
catalogue before network I/O. `delete_local_model` accepts only exact curated model tags before the
Ollama sidecar starts. Pull, selection, and chat already enforced the same catalogue.

### Sonar denial-of-service hotspot

The leading-title parser no longer uses the backtracking expression reported by Sonar rule S5852.
It performs a linear scan instead, with a 100,000-character adversarial regression test.

### Local analysis credential

The ignored `.env.sonar` file is owner-readable and owner-writable only (`0600`). No token is
stored in tracked files.

## Controls verified

- Production CSP keeps scripts on `self`, blocks objects and framing, and does not allow remote
  image hosts. Development-only allowances are not shipped.
- Tauri webview capabilities do not expose shell, filesystem, or dialog plugins. Rust commands
  validate paths and inputs at the IPC boundary.
- API keys are stored in the OS keychain and provider errors are redacted before UI or logs.
- Markdown does not enable raw HTML. URLs use react-markdown's safe transform, links are inert,
  rejected images render a fallback, and graph tooltip HTML escapes text and allowlists colours.
- Vault and skill writes are confined to canonical vault parents, reject symlink escape, avoid
  overwrite, enforce per-item budgets, and support hash-guarded undo.
- Requirement downloads use compiled HTTPS URLs and SHA-256 digests, bounded streaming, safe
  archive extraction, locks, and atomic publication.
- External processes use fixed binaries and argv arrays, cleared environments, bounded output,
  timeouts, cancellation, and app-owned working directories.
- npm production audit: 0 vulnerabilities across 207 production dependencies.
- RustSec audit: 0 vulnerabilities across 578 locked dependencies.
- Secret and unsafe-DOM sink sweeps found no production secret or executable DOM sink.

## Residual and accepted risks

- NeuralNote trusts the signed application update channel and the official yt-dlp same-channel
  updater. Compromise of either upstream distribution path remains a supply-chain risk.
- The Rust lockfile contains Linux-only GTK3 transitive packages that RustSec labels unmaintained,
  plus an informational GLib iterator advisory. They are not in the macOS dependency graph, no
  vulnerable NeuralNote call path was found, and `cargo audit` reports no vulnerability. Tauri's
  supported Linux webview stack owns their replacement path.
- A compromised webview remains within the authority of registered Tauri commands. Defence in
  depth therefore depends on retaining the Rust-side allowlists, path confinement, write budgets,
  and explicit error handling reviewed here.

## Verification

- SonarQube quality gate: OK; 0 bugs, 0 vulnerabilities, 0 smells, 0 hotspots; all four ratings A.
- Frontend: 68 test files, 853 tests; 97.2% line coverage.
- Journeys: 15 files, 96 tests.
- Rust quality gate: GREEN, all categories enforced; clippy, rustfmt, generated bindings,
  >=90% coverage, and RustSec audit all pass.
- Production build and TypeScript typecheck pass.
