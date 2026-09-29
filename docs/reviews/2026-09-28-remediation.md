# Main review remediation — 28 September 2026

Base: `main` at `b4fe8315d787bbe5226828557f7f4204d435731b`.
Branch: `fix/main-review-2026-09-28`.

The user requested an isolated worktree to resolve all findings in the [review](2026-09-28-main-review.md). The table identifies the behavior each change must address. No finding is complete until its relevant regression checks have passed; unavailable native, service or live-provider evidence remains explicit. The branch is prepared for pull-request review; native/manual acceptance limits remain explicit.

| ID | Resolution scope | Status | Required evidence |
| --- | --- | --- | --- |
| R01 | Patch native `js-yaml`, desktop Vitest and the additional Rustls advisory without weakening audit policy | Implemented; npm audits, patched runners and final Rust security/quality gate passed | Both audits plus affected test harnesses |
| R02 | Keep private note permissions through atomic saves, including the temporary file | Implemented; focused regressions passed; independent review clear | Unix mode-preservation and failure-cleanup regressions |
| R03 | Return a committed rename/move result independently of a fallible recursive refresh; preserve tab remapping | Implemented; focused regressions passed; independent review clear | Unreadable-child mutation and frontend remapping tests |
| R04 | Prevent case-only rename staging from overwriting existing material | Implemented; collision and rollback regressions passed; independent review clear | Occupied staging path and rollback regressions |
| R05 | Bound reads of the existing disk file during save conflict checks | Implemented; bounded conflict and overwrite regressions passed; independent review clear | Small-opened note replaced by oversized file; draft retained |
| R06 | Bound incoming provider frames, complete responses and tool accumulation; avoid rescanning the whole pending frame | Implemented; focused bounds/full-size-note regressions and independent review passed | Fragmentation, frame/total/argument/cardinality overflow and preview settlement |
| R07 | Sanitize provider errors consistently across HTTP, SSE and buffered completions | Implemented; bounded-redaction regressions and independent review passed | Synthetic token absent from returned errors and emitted events |
| R08 | Reject superseded tree-read successes and failures | Implemented; stale-success/error tests and frontend gates passed | Deferred IPC completion-order regressions |
| R09 | Remove repeated full-line scans in backlink snippet construction | Implemented; scaling and Unicode tests green | Unicode/source correctness and dense-line scaling |
| R10 | Remove quadratic newline-donor lookup during multiline replacements | Implemented; replacement scaling and exact undo/redo regressions passed | Mixed-ending replacement/undo plus realistic scaling |
| R11 | Make deleted-note recovery messaging and supported actions agree | Implemented; corrected notice and copy-to-new-note journey passed | External deletion, retained draft and successful documented recovery path |
| R12 | Reconcile release citation-evaluation policy with actual release enforcement while preserving accepted local-model limits | Implemented manual reviewed-record gate; 60 release/validator checks and independent CLI review passed | Release workflow/policy contract tests; live evaluation evidence separately reported |
| R13 | Reduce repetitive/historical comments in dense files and correct stale or overstated descriptions | Implemented; 555 fewer production comment lines; generated bindings current | Focused diff inspection; remeasure comments; retain safety/lifecycle/API contracts |

## Additional recommendations

The report separates 13 demonstrated findings from improvement opportunities. The latter do not
have enough evidence to justify speculative architecture or product changes in this fix batch:

| Opportunity | Disposition |
| --- | --- |
| Settled-chat rendering | Profile long conversations before adding memoization or virtualization; no measured regression established |
| Coordinated vault scans/blocking work | Backlink snippet hot path fixed in R09; broader scan scheduling needs vault-scale profiling |
| Degraded watcher visibility/reconciliation | Preserve the accepted nonfatal watcher-start policy; a new status/reconciliation UX needs a separate defined behavior |
| Assembled prompt budgeting | Keep as hardening follow-up; this review did not reproduce a supported-model context overrun |
| Exact citation start-line anchoring | Verifier documentation now states its actual guarantee; stricter producer/verifier anchoring remains hardening, with no demonstrated incorrect production citation |
| Authoritative documentation consistency | Corrected the release-evaluation policy, generated-contract pointer and stale/overstated code comments within this scope |

The production build also reports a large main bundle (about 2.32 MB minified / 651 KB gzip).
This is a build warning, not a measured startup regression; dependency/chunk profiling remains a
follow-up. Browser tests emit React `act(...)` warnings in the galaxy preview tests while passing.

## Verification ledger

The original review's checks and limits are in the report. The fixes worktree starts without installed frontend dependencies and with an incomplete Cargo cache. Baseline setup/checks completed using Node 24.20.0 and Rust 1.96.0; installed quality tools are cargo-llvm-cov 0.8.7 and cargo-deny 0.20.2. No sidecar, SonarQube service or paid model call has been started.

Final automated checks passed on 29 September 2026 (BST). Native/manual acceptance limits are recorded below. The results cover the remediation branch before submission for review.

### Baseline and initial fixes

- `npm --prefix app/desktop ci` with Node 24.20.0: exit 0, no setup lockfile change.
- `npm --prefix app/desktop run lint`, `run typecheck`, `run test:unit`: exit 0; unit baseline 143 files / 2,321 tests plus 20 updater-harness tests.
- Raw `cargo test --workspace --locked`: dependency downloads stalled. HTTP/1 mode also stalled; direct registry HTTPS downloads worked. The 604 locked registry archives were fetched from the official registry and individually verified against `Cargo.lock` SHA-256 checksums before entering Cargo's cache. No lockfile or validation policy was changed.
- `cargo test --workspace --locked --offline`: reached compilation but exited 101 because the packaged Ollama sidecar was absent.
- `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}' cargo test --workspace --locked --offline`: exit 0; 1,872 passed, 10 ignored. This is the existing CI bundle override; it does not exercise packaged sidecars or live models.
- R01: native lockfile now uses js-yaml 4.3.2; desktop manifest/lockfile uses Vitest family 4.1.11. Both dependency audit commands exited 0, reporting zero advisories. Locked reinstalls and the patched runner gates passed.
- R09: before the fix, four times as many links took 15.90 times as long and failed the new scaling regression. The same test and Unicode snippet test passed after caching per-line offsets. ASCII lines require no offset allocation.
- R10 additional verified baseline defect: replacing mixed-ending text and undoing it normalized endings. The bounded fix preserves separator metadata through grouped undo/redo using existing in-memory history effects.

### Resolved behavior and principal files

- **R01:** patched native `js-yaml` to 4.3.2 and the desktop Vitest family to 4.1.11 in the two
  lockfiles and desktop package manifest; both locked reinstalls succeeded. The full Rust gate
  then identified `RUSTSEC-2026-0285`; Cargo updated only Rustls 0.23.43 → 0.23.45 and its
  required WebPKI 0.103.13 → 0.103.14 in `Cargo.lock`. Both official archives were checksum-verified.
- **R02–R05:** `note.rs` now uses private temporary files, restores original Unix mode bits and
  bounds conflict reads; `temp_sibling.rs` uses exclusive 0600 creation. `entries.rs` uses an
  exclusive 0700 staging directory for case-only renames, and `tree.rs` builds shallow mutation
  results before disk changes. Failure/rollback paths preserve or explicitly locate the content.
- **R06–R07:** `ai/transport_limits.rs`, `openai.rs`, `tool_stream.rs`, `tool_turn_reader.rs` and
  native `ai.rs` enforce bounded input/retention with amortized growth and incremental framing.
  Error projections are redacted and capped; overflow/error/cancellation closes live previews.
  Normal answer/preview content and IDs retain their original values. The 8 MiB nested-escaping
  acceptance fixture exceeds 55 MiB on the wire and passes the 64 MiB response ceiling.
- **R08:** `useVaultTree.ts` accepts only the latest request's success or failure for the active
  vault, including overlapping initial, watcher and explicit refreshes.
- **R09:** `search.rs`, `links/mod.rs` and `backlinks.rs` reuse per-line offsets. Independent
  old/new parity passed 68,400 line/snippet comparisons; 4× occurrence count measured 15.73×
  baseline work versus 3.44× after the fix in an isolated context benchmark.
- **R10:** `sourceText.ts` finds newline donors with binary search. The real-CodeMirror algorithm
  benchmark for 8,000-line replacement measured 299.35 ms before and 2.604 ms after. The additional
  verified mixed-ending undo bug is fixed by separator-only history effects in `SourceNoteEditor.tsx`.
  Independent history testing passed 24,000 exact undo/redo assertions across 41,871 generated edits.
  These are algorithm/in-memory results, not native interaction latency measurements.
- **R11:** `NotePane.tsx` now tells users to copy the retained draft into a new note after deletion.
  The external-reload journey exercises that documented recovery path successfully.
- **R12:** the release workflow requires a reviewed JSON record tied to its exact commit and source
  defaults, validates it before dependency installation/signing, and retains it separately from
  signed assets. The validator, runbook, spec and threat model describe the accepted local
  missing-citation limitation and the limits of an attestation. No live provider call was made.
- **R13:** focused frontend/Rust comment cleanup and generated comment refresh; measured results
  are in [the comment audit](2026-09-28-comment-audit/README.md). No wire shape changed.

### Independent review

Frontend/history, vault operations, backlink parity, release input handling and provider transport
received independent read-only reviews. The transport review found capacity-growth and diagnostic
bounds problems during implementation; both were corrected and rechecked. Final reviews reported
no unresolved concrete finding within these scopes. Source-level reviews do not establish native
platform or live-provider behavior.

### Verification limits and residuals

- Native GUI acceptance is **not complete**: this session has no Codex native computer-use
  capability. The passing Chromium/WebKit suites and jsdom recovery journey are not a packaged
  WKWebView walkthrough, native clipboard/IME proof, or Windows/Linux device validation.
- Rust checks use the repository's sidecar-free CI bundle override. No Ollama download/service,
  real provider call or billable model evaluation ran. The release-record gate validates a
  maintainer attestation; it does not establish actual model quality or remote evidence truth.
- Local SonarQube is **unavailable** in the worktree: `.env.sonar` is absent, and the sandboxed
  loopback probe was denied. Docker and `sonar-scanner` are present. No service was started and no
  credential contents were read. This is not a passing Sonar quality gate.
- Unix mode bits are tested and preserved. ACLs, extended attributes, ownership metadata and hostile
  concurrent path replacement are not established. The existing cooperative-writer race and
  durability policies were preserved rather than represented as newly solved.
- Provider cleanup was verified with valid unique call IDs. Pre-existing duplicate provider IDs
  can produce duplicate abandonment notifications; broader call-ID validation and partial-JSON
  preview reparsing remain separate hardening/performance work, with no stronger impact demonstrated.
- This local verification did not run hosted CI, a signed release or a production deployment. Main's tracked
  files and the two unrelated worktrees were preserved.

### Final commands and results — 29 September 2026 (BST)

All frontend commands used Node 24.20.0 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`);
Rust used 1.96.0. Each listed command's exit status was checked in this task.

| Command | Result |
| --- | --- |
| `npm --prefix app/desktop run lint` | Exit 0 |
| `npm --prefix app/desktop run typecheck` | Exit 0 |
| `npm --prefix app/desktop run coverage` | Exit 0; 167 files passed, 1 skipped; 2,484 tests passed, 3 skipped; 97.08% line coverage |
| `npm --prefix app/desktop run test:updater-harness` | Exit 0; 20 tests passed |
| `npm --prefix app/desktop run build` | Exit 0; production automation exclusion checks passed; bundle-size warning retained above |
| `npm --prefix app/desktop run test:browser:chromium` | Exit 0; 192 tests passed |
| `npm --prefix app/desktop run test:browser:webkit` | Exit 0; 189 passed, 3 skipped under existing browser-specific conditions |
| `npm --prefix app/desktop/e2e-native run typecheck` | Exit 0 |
| `npm --prefix app/desktop/e2e-native run test:config` | Exit 0; 71 tests passed; configuration coverage, not native runtime acceptance |
| `npm --prefix app/desktop audit --package-lock-only --audit-level=high --json` | Exit 0; zero advisories |
| `node scripts/audit-e2e-native.mjs` | Exit 0; zero advisories |
| `node scripts/check-release-workflow.mjs` | Exit 0; 60 tests including the 31 validator cases |
| `cargo test --workspace --locked --offline` | Exit 0; 1,901 passed, 10 ignored, with the bundle override below |
| `./scripts/rust-quality-gate.sh` | Exit 0, GREEN: Clippy all targets/features with warnings denied, rustfmt, bindings, 96.29% core line coverage, and cargo-deny advisories passed |
| `npm --prefix app/desktop run check:bindings` | Exit 0; exact regenerated bindings match the isolated review index described below |
| `gitleaks git . --log-opts=--all --redact` | Exit 0; 115 commits scanned, no leaks found in history |
| `git diff --check` | Exit 0 |

Rust tests and gates used `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'`,
the repository's existing sidecar-free CI override. Quality/binding gates also used
`CARGO_NET_OFFLINE=true` and an isolated `GIT_INDEX_FILE` initialized from HEAD plus the intentional
regenerated bindings. This checks regeneration reproducibility while preserving the real index and
all uncommitted work; a plain bindings diff against unchanged HEAD would report the intended comment
updates as drift. No wire shapes changed. Before PR submission, `check:bindings` was also rerun
against the actual staged index and exited 0.

The first full Rust gate exited 1: one module-order formatting difference and the Rustls advisory.
After formatting and the Cargo-generated two-package patch, the complete gate and workspace tests
were rerun and exited 0. Cargo's registry client stalled; official metadata and archive checksums
were verified before populating its ordinary cache and resolving offline. Cargo generated the lockfile update; no source origin changed, advisory was ignored, or repository
network/verification policy was disabled.

The baseline `test:unit` command passed before editing (2,321 tests plus the 20-test updater harness).
After the Vitest patch, the final coverage run exercised the full unit/e2e suite and the separate
updater harness passed; those superseding results are reported above rather than represented as a
second execution of the exact baseline command.

Full logs and independent probe records are retained at
`/private/tmp/neuralnote-main-review-a39x66_8/logs`. The durable review, comment counts and this ledger
are in this worktree. Final Git inspection: main remains at
`b4fe8315d787bbe5226828557f7f4204d435731b`, tracked-clean with its original `.grilling/` and
`.superpowers/` untracked directories. The existing activity-journal and architecture-docs worktrees
retain their original branch heads. The fixes are on `fix/main-review-2026-09-28`.
