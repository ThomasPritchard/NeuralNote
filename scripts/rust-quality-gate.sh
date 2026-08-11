#!/usr/bin/env bash
#
# Rust quality gate — the cargo-native equivalent of a SonarQube quality gate.
#
# SonarQube's bundled Rust analyzer already grades the .rs sources inside the
# `NeuralNote` Sonar project (bugs, code smells, coverage via sonar.rust.lcov).
# This script is the local/CI complement Tom asked for: it maps Rust-native
# tooling onto the same quality categories and fails (non-zero exit) if any is red,
# so the gate can run without a SonarQube server.
#
#   Maintainability + Reliability (bugs/smells) -> clippy (deny ALL warnings)
#   Consistency (style)                          -> rustfmt --check
#   Reliability + Coverage (>=90% lines)         -> cargo-llvm-cov (runs tests too)
#   Security / Vulnerabilities                   -> cargo-deny (RUSTSEC advisories)
#
# Usage:  scripts/rust-quality-gate.sh
# Deps:   rustup component add clippy rustfmt llvm-tools-preview
#         cargo install cargo-llvm-cov cargo-deny
#
# Exit code (the contract automation reads):
#   0  GREEN       every category ran and passed.
#   1  RED         a category produced real findings/failures (a code verdict).
#   2  INCOMPLETE  a required category could not run (tool absent or advisory DB
#                  unreachable/offline). Not a pass, not a code verdict — re-run
#                  with the tooling installed and network before trusting the gate.
#
set -uo pipefail
cd "$(dirname "$0")/.."

COVERAGE_MIN=90
fail=0
skipped=0
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
pass() { printf '  \033[32m✓ PASS\033[0m  %s\n' "$1"; }
redx() { printf '  \033[31m✗ FAIL\033[0m  %s\n' "$1"; fail=1; }
skip() { printf '  \033[33m• SKIP\033[0m  %s\n' "$1"; skipped=1; }

section "Maintainability + Reliability — clippy (-D warnings)"
if cargo clippy --workspace --all-targets --all-features -- -D warnings; then
  pass "clippy: no warnings (bugs + code smells)"
else
  redx "clippy: warnings/errors — fix or justify with #[allow(...)]"
fi

section "Consistency — rustfmt --check"
if cargo fmt --all -- --check; then
  pass "rustfmt: clean"
else
  redx "rustfmt: needs formatting — run 'cargo fmt --all'"
fi

section "Contract drift — ts-rs bindings match the Rust source"
# The `#[ts(export)]` types + event-name constants regenerate `app/desktop/src/lib/
# bindings/` during `cargo test`. Re-run just those export tests and fail if the
# committed output changed — a stale mirror must break the build here, never a user
# with a silent Rust↔TS type mismatch. `--intent-to-add` makes `git diff` also catch
# a brand-new (as-yet-untracked) binding file for a newly added type.
if cargo test --workspace export >/dev/null 2>&1; then
  git add --intent-to-add -- app/desktop/src/lib/bindings >/dev/null 2>&1 || true
  if git diff --quiet -- app/desktop/src/lib/bindings; then
    pass "generated bindings are current (no drift)"
  else
    redx "bindings are STALE — run 'npm --prefix app/desktop run gen:bindings' and commit app/desktop/src/lib/bindings/"
    git --no-pager diff --stat -- app/desktop/src/lib/bindings | head
  fi
else
  redx "ts-rs export tests failed to run — bindings could not be regenerated"
fi

section "Reliability + Coverage — cargo-llvm-cov (tests, fail-under ${COVERAGE_MIN}% lines)"
if cargo llvm-cov -p neuralnote-core --fail-under-lines "$COVERAGE_MIN" \
     --lcov --output-path lcov-rust.info; then
  pass "tests green AND line coverage >= ${COVERAGE_MIN}% (lcov-rust.info written)"
else
  redx "tests failed OR line coverage < ${COVERAGE_MIN}%"
fi

section "Security / Vulnerabilities — cargo-deny (RUSTSEC, resolved feature graph)"
if command -v cargo-deny >/dev/null 2>&1; then
  # cargo-deny audits the RESOLVED feature graph, not Cargo.lock's union of every
  # optional dependency, so a crate no feature ever activates cannot raise an
  # advisory against code we never compile. Policy — including why unmaintained
  # and unsound advisories don't fail, and why there is no ignore list — lives in
  # deny.toml next to the evidence.
  deny_out=$(cargo deny check advisories 2>&1); deny_rc=$?
  if [ "$deny_rc" -eq 0 ]; then
    pass "cargo-deny: no vulnerabilities in the resolved graph (allowed warnings: docs/security/dependency-advisories.md)"
  elif printf '%s' "$deny_out" | grep -qiE "failed to fetch advisory database|unable to fetch advisory database"; then
    # Network couldn't reach the RUSTSEC git DB — an availability problem, not a
    # code verdict. Don't fail the gate; a networked CI run will exercise it.
    # Keep this pattern narrow: widening it until it also swallows real failures
    # would relabel breakage as INCOMPLETE, which is how a gate stops being read.
    skip "cargo-deny: advisory DB unreachable (offline) — not a verdict, category INCOMPLETE. Re-run with network (SonarQube also covers vulns server-side)."
  else
    redx "cargo-deny: vulnerable dependency reported"
    printf '%s\n' "$deny_out" | grep -iE "^error|ID:|Crate:|Title:|Solution:|RUSTSEC-" | head -20
  fi
else
  skip "cargo-deny not installed — category INCOMPLETE (install: cargo install cargo-deny --locked). SonarQube also covers this category server-side."
fi

# Three-state verdict — the exit code is the contract automation reads:
#   0  GREEN       every category ran and passed.
#   1  RED         a category produced real findings/failures (a code verdict).
#   2  INCOMPLETE  a required category could not run (tool absent or advisory DB
#                  unreachable). NOT a pass and NOT a code verdict — the DoD says
#                  a skipped required category is not green, so this must never
#                  exit 0 or print "GREEN". A real finding (RED) outranks a skip.
EXIT_GREEN=0
EXIT_RED=1
EXIT_INCOMPLETE=2

echo
if [ "$fail" -ne 0 ]; then
  printf '\033[1;31m══ RUST QUALITY GATE: RED (findings — see above) ══\033[0m\n'
  exit "$EXIT_RED"
elif [ "$skipped" -ne 0 ]; then
  printf '\033[1;33m══ RUST QUALITY GATE: INCOMPLETE — a required category was SKIPPED (could not run; not a pass — re-run with the tool installed and network) ══\033[0m\n'
  exit "$EXIT_INCOMPLETE"
else
  printf '\033[1;32m══ RUST QUALITY GATE: GREEN (all categories enforced) ══\033[0m\n'
  exit "$EXIT_GREEN"
fi
