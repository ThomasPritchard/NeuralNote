#!/usr/bin/env bash
# Build a branch-labelled dev app, so it is obvious which branch a running
# window came from when several are open at once.
#
#   bash scripts/dev-build.sh            # debug profile, fast
#   bash scripts/dev-build.sh --release  # optimised, slow
#
# The product name becomes NeuralNote-Dev-<branch>. The bundle identifier is
# deliberately NOT varied: every branch build shares com.neuralnote.desktop.dev,
# so you configure a vault once rather than re-onboarding per branch, and none of
# them can touch the installed NeuralNote's data.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

branch="$(git rev-parse --abbrev-ref HEAD)"
# Bundle names cannot contain "/" and macOS dislikes spaces in .app names.
safe_branch="$(printf '%s' "$branch" | tr '/ ' '--' | tr -cd '[:alnum:]._-')"
product="NeuralNote-Dev-${safe_branch}"

profile_flag="--debug"
profile_name="debug"
if [[ "${1:-}" == "--release" ]]; then
  profile_flag=""
  profile_name="release"
fi

echo "Building ${product} (${profile_name}) from ${branch}"

# Two --config values, merged in order: the shared dev flavour, then the
# branch-specific name. Tauri accepts a JSON string as well as a path.
npm --prefix app/desktop run tauri build -- \
  ${profile_flag} \
  --config src-tauri/tauri.dev-build.conf.json \
  --config "{\"productName\":\"${product}\",\"app\":{\"windows\":[{\"title\":\"${product}\"}]}}"

app_path="${repo_root}/target/${profile_name}/bundle/macos/${product}.app"
if [[ ! -d "$app_path" ]]; then
  echo "Expected bundle not found at ${app_path}" >&2
  exit 1
fi

# Sign with a STABLE identity when one is available.
#
# Keychain ACLs bind to the Designated Requirement of the writing process. An
# ad-hoc signature derives its requirement from the code hash, so every rebuild
# looks like a different application to the keychain and macOS re-prompts for the
# login password every single time — "Always Allow" can never stick. A stable
# identity yields `certificate leaf = H"<cert hash>"`, which does not change
# between rebuilds, so one authorisation holds for good.
#
# Falls back to ad-hoc when the identity is absent (CI, a fresh clone, another
# maintainer's machine) — exactly the previous behaviour. Create the identity
# once with: bash scripts/ensure-dev-signing-identity.sh
#
# No `-v` on find-identity: that filters to *trusted* identities and a
# self-signed root never passes it, though codesign signs with it fine.
signing_identity="${NEURALNOTE_DEV_SIGNING_IDENTITY:-NeuralNote Dev Signing}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  if security find-identity -p codesigning 2>/dev/null | grep -qF "$signing_identity"; then
    echo "Signing with stable identity: ${signing_identity}"
    codesign --force --sign "$signing_identity" "$app_path"
  else
    echo "No stable signing identity found; falling back to ad-hoc." >&2
    echo "The keychain will re-prompt on every rebuild until you run:" >&2
    echo "  bash scripts/ensure-dev-signing-identity.sh" >&2
    codesign --force --sign - "$app_path"
  fi
  codesign --verify --strict "$app_path"
fi

echo
echo "Built: ${app_path}"
echo "Open with: open '${app_path}'"
