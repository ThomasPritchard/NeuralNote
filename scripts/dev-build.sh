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
if [[ -d "$app_path" ]]; then
  echo
  echo "Built: ${app_path}"
  echo "Open with: open '${app_path}'"
else
  echo "Expected bundle not found at ${app_path}" >&2
  exit 1
fi
