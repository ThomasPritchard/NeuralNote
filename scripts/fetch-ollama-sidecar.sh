#!/usr/bin/env bash
set -euo pipefail

# Fetch the official macOS Ollama CLI sidecar for the current Rust host triple.
# The resulting path is the target-specific filename Tauri expects for the
# `externalBin` entry `binaries/ollama`.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/app/desktop/src-tauri/binaries"
URL="${OLLAMA_DARWIN_TGZ_URL:-https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz}"

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

tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"
OLLAMA_BIN="$(find "$EXTRACT_DIR" -type f -name ollama -perm -111 | head -n 1)"
if [ -z "$OLLAMA_BIN" ]; then
  echo "Could not find an executable named 'ollama' in the downloaded archive." >&2
  exit 1
fi

TMP_DEST="$DEST.tmp.$$"
install -m 0755 "$OLLAMA_BIN" "$TMP_DEST"
mv "$TMP_DEST" "$DEST"

echo "Installed Ollama sidecar at $DEST"
