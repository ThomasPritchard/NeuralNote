#!/usr/bin/env bash
set -euo pipefail

# Fetch the official macOS Ollama runtime for the current Rust host triple.
#
# Ollama's macOS archive is a FLAT bundle of three things, and all three must
# ship — a common trap is grabbing only `ollama`:
#   1. `ollama`        — the orchestrator/server/CLI (Tauri externalBin)
#   2. `llama-server`  — the SEPARATE inference runner ollama spawns per model
#                        load; ollama locates it next to its own binary, so it is
#                        a second externalBin (lands beside `ollama` in MacOS/)
#   3. the ggml/Metal runtime libraries (~35 .dylib/.so + mlx_metal_* dirs) —
#                        staged as bundled resources; found at runtime via the
#                        OLLAMA_LIBRARY_PATH env var (set in local.rs). These can
#                        live in a separate dir; only the two executables must be
#                        co-located.
# Shipping only `ollama` yields "llama-server binary not found" at inference time.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/app/desktop/src-tauri/binaries"
LIBS_DIR="$ROOT/app/desktop/src-tauri/ollama-libs"

# Pin a specific Ollama release and verify a hardcoded SHA-256 of the archive
# before installing it — the sidecar ships inside the app and is spawned on every
# user's machine, so acquiring it without integrity verification is OWASP A08
# supply-chain risk. The checksum is the sha256 of `ollama-darwin.tgz` for this
# exact release (from the release's sha256sum.txt, independently confirmed). Bump
# both together when moving to a newer Ollama.
OLLAMA_VERSION="v0.31.1"
OLLAMA_DARWIN_TGZ_SHA256="0c4f92389fcc1f651c17282e2eaffd68c8d3d06e1f7b307604102ad0e09a10c9"
# The URL is overridable, but the checksum is verified regardless — an override
# that doesn't match the pinned archive fails closed (nothing is installed).
URL="${OLLAMA_DARWIN_TGZ_URL:-https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-darwin.tgz}"

command -v rustc >/dev/null 2>&1 || {
  echo "rustc is required to compute the target triple." >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to download Ollama." >&2
  exit 1
}

command -v tar >/dev/null 2>&1 || {
  echo "tar is required to unpack Ollama." >&2
  exit 1
}

TARGET_TRIPLE="$(rustc -Vv | awk '/^host: / { print $2 }')"
DEST="$BIN_DIR/ollama-$TARGET_TRIPLE"
LLAMA_DEST="$BIN_DIR/llama-server-$TARGET_TRIPLE"

case "$TARGET_TRIPLE" in
  *-apple-darwin) ;;
  *)
    echo "This sidecar fetcher is macOS-only for now; got host triple: $TARGET_TRIPLE" >&2
    exit 1
    ;;
esac

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/ollama-darwin.tgz"
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"

echo "Downloading Ollama sidecar from $URL"
curl --fail --location --progress-bar "$URL" --output "$ARCHIVE"

# Verify the archive against the pinned SHA-256 BEFORE extracting or installing.
# Fail closed on any mismatch (OWASP A08). Portable across macOS (shasum) and
# Linux (sha256sum).
if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
else
  echo "Neither shasum nor sha256sum is available to verify the download." >&2
  exit 1
fi

EXPECTED_SHA256="$(printf '%s' "$OLLAMA_DARWIN_TGZ_SHA256" | tr '[:upper:]' '[:lower:]')"
ACTUAL_SHA256="$(printf '%s' "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')"
# Fail closed if EITHER side is empty: without this, a future empty pin ("") would
# compare equal to an empty hash-tool result and install an UNVERIFIED archive.
if [ -z "$EXPECTED_SHA256" ] || [ -z "$ACTUAL_SHA256" ]; then
  echo "Refusing to install: expected or actual SHA-256 is empty (nothing was verified)." >&2
  echo "  expected: '$EXPECTED_SHA256'" >&2
  echo "  actual:   '$ACTUAL_SHA256'" >&2
  exit 1
fi
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Ollama archive checksum mismatch — refusing to install." >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA256" >&2
  exit 1
fi
echo "Verified Ollama archive SHA-256: $ACTUAL_SHA256"

tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"

# Locate BOTH executables. The runner (`llama-server`) is a separate binary from
# the orchestrator (`ollama`) since Ollama split the monolith; shipping only
# `ollama` fails at inference with "llama-server binary not found".
OLLAMA_BIN="$(find "$EXTRACT_DIR" -type f -name ollama -perm -111 | head -n 1)"
LLAMA_SERVER_BIN="$(find "$EXTRACT_DIR" -type f -name llama-server -perm -111 | head -n 1)"
if [ -z "$OLLAMA_BIN" ] || [ -z "$LLAMA_SERVER_BIN" ]; then
  echo "Could not find both 'ollama' and 'llama-server' executables in the archive." >&2
  exit 1
fi
SRC_DIR="$(dirname "$OLLAMA_BIN")"

# Atomic install: stage to a temp path in the same dir, then rename into place.
install_bin() {
  local src="$1" dest="$2" tmp
  tmp="$dest.tmp.$$"
  install -m 0755 "$src" "$tmp"
  mv "$tmp" "$dest"
}
install_bin "$OLLAMA_BIN" "$DEST"
install_bin "$LLAMA_SERVER_BIN" "$LLAMA_DEST"

# Stage the runtime libraries — everything EXCEPT the two executables (~35 ggml
# .dylib/.so + the mlx_metal_* Metal-backend dirs) — into the bundled resources
# dir, preserving subdir structure. Rebuilt from scratch so a version bump can't
# leave a stale lib behind.
rm -rf "$LIBS_DIR"
mkdir -p "$LIBS_DIR"
find "$SRC_DIR" -mindepth 1 -maxdepth 1 ! -name ollama ! -name llama-server \
  -exec cp -R {} "$LIBS_DIR/" \;

echo "Installed Ollama runtime:"
echo "  ollama       -> $DEST"
echo "  llama-server -> $LLAMA_DEST"
echo "  libraries    -> $LIBS_DIR ($(find "$LIBS_DIR" -type f | wc -l | tr -d ' ') files)"
