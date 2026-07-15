#!/usr/bin/env bash
#
# Contract tests for scripts/rust-quality-gate.sh — the three-state exit scheme.
#
# The gate must distinguish three outcomes and encode them in its exit code:
#   0  GREEN       — every category ran and passed.
#   1  RED         — a category produced real findings/failures (a code verdict).
#   2  INCOMPLETE  — a required category could not run (tool missing or advisory
#                    DB unreachable/offline). NOT a pass, NOT a code verdict.
#
# These tests are hermetic: they stub `cargo`, `cargo-audit`, and `git` on a
# private PATH so the real toolchain, network, and working tree are never
# touched. Each scenario drives only the security/cargo-audit category and
# asserts the gate's exit code and the banner it prints.
#
# Run:  bash scripts/rust-quality-gate.test.sh
# macOS ships bash 3.2 — keep this script 3.2-compatible (no associative arrays).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$REPO_ROOT/scripts/rust-quality-gate.sh"

pass_count=0
fail_count=0

# --- stub factory ----------------------------------------------------------
# Builds a throwaway bin/ dir containing fake `cargo`, `git`, and (optionally)
# `cargo-audit`, all driven by env vars, then echoes the dir path.
make_stub_bin() {
  local audit_rc="$1"        # exit code for `cargo audit`
  local audit_out="$2"       # stdout/stderr text for `cargo audit`
  local with_audit_tool="$3" # "yes" -> provide cargo-audit on PATH; else absent

  local bin
  bin="$(mktemp -d)"

  cat >"$bin/cargo" <<CARGO
#!/usr/bin/env bash
# Fake cargo: every non-audit category passes; audit is scenario-driven.
sub="\$1"; shift 2>/dev/null || true
case "\$sub" in
  clippy|fmt|test|llvm-cov) exit 0 ;;
  audit)
    printf '%s\n' "$audit_out"
    exit $audit_rc ;;
  *) exit 0 ;;
esac
CARGO
  chmod +x "$bin/cargo"

  cat >"$bin/git" <<'GIT'
#!/usr/bin/env bash
# Fake git: `diff --quiet` reports no binding drift (exit 0); everything is a no-op.
exit 0
GIT
  chmod +x "$bin/git"

  if [ "$with_audit_tool" = "yes" ]; then
    # Presence is all that matters — the gate probes it with `command -v` and
    # then invokes the audit subcommand through the fake `cargo` above.
    printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/cargo-audit"
    chmod +x "$bin/cargo-audit"
  fi

  printf '%s' "$bin"
}

# --- assertion runner ------------------------------------------------------
# run_case <name> <expected_exit> <audit_rc> <audit_out> <with_audit_tool> <expect_grep> <forbid_grep>
run_case() {
  local name="$1" expected_exit="$2" audit_rc="$3" audit_out="$4" with_tool="$5" \
        expect_grep="$6" forbid_grep="$7"

  local bin out actual_exit
  bin="$(make_stub_bin "$audit_rc" "$audit_out" "$with_tool")"

  # A minimal PATH: our stubs first, then only the system coreutils dirs, so a
  # real cargo/cargo-audit/git installed elsewhere can never leak in.
  out="$(PATH="$bin:/usr/bin:/bin" "$GATE" 2>&1)"
  actual_exit=$?

  rm -rf "$bin"

  local ok=1
  [ "$actual_exit" -eq "$expected_exit" ] || ok=0
  if [ -n "$expect_grep" ]; then
    printf '%s' "$out" | grep -qE "$expect_grep" || ok=0
  fi
  if [ -n "$forbid_grep" ]; then
    printf '%s' "$out" | grep -qE "$forbid_grep" && ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    printf '  \033[32mPASS\033[0m  %s (exit %s)\n' "$name" "$actual_exit"
    pass_count=$((pass_count + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "$name"
    printf '        expected exit %s, got %s\n' "$expected_exit" "$actual_exit"
    [ -n "$expect_grep" ] && printf '        expected output to match: %s\n' "$expect_grep"
    [ -n "$forbid_grep" ] && printf '        expected output NOT to match: %s\n' "$forbid_grep"
    printf '        --- banner tail ---\n'
    printf '%s\n' "$out" | tail -3 | sed 's/^/        /'
    fail_count=$((fail_count + 1))
  fi
}

printf '\033[1mrust-quality-gate.sh — contract tests\033[0m\n\n'

# 1. PASS: audit runs and finds nothing -> GREEN, exit 0.
run_case "pass — all categories enforced and green" \
  0 0 "no vulnerabilities found" yes \
  "GREEN" "INCOMPLETE"

# 2. FAIL: audit reports a real vulnerability -> RED, exit 1.
run_case "fail — real vulnerability is a code verdict" \
  1 1 "Crate: openssl
Title: RCE
ID: RUSTSEC-2099-0001
error: 1 vulnerability found!" yes \
  "RED" "GREEN|INCOMPLETE"

# 3. OFFLINE SKIP: advisory DB unreachable -> INCOMPLETE, exit 2, never "GREEN".
run_case "offline skip — advisory DB unreachable is not a pass" \
  2 1 "error: couldn't fetch advisory database: error sending request" yes \
  "INCOMPLETE" "GREEN"

# 4. MISSING TOOL: cargo-audit absent -> INCOMPLETE, exit 2, never "GREEN".
run_case "missing tool — cargo-audit not installed is not a pass" \
  2 0 "" no \
  "INCOMPLETE" "GREEN"

printf '\n\033[1msummary:\033[0m %s passed, %s failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ] || exit 1
