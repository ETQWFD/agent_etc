#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/android-standalone/llama.cpp"
VERSION="${LLAMA_TAG:-b12405}"
if [ -d "$DEST" ]; then echo "llama.cpp 已存在：$DEST"; exit 0; fi
TMP="$(mktemp -d)"
curl -L --retry 3 -o "$TMP/src.tar.gz" "https://github.com/ggml-org/llama.cpp/archive/refs/tags/${VERSION}.tar.gz"
tar xzf "$TMP/src.tar.gz" -C "$ROOT/android-standalone"
mv "$ROOT/android-standalone/llama.cpp-${VERSION}" "$DEST"
rm -rf "$TMP"
echo "llama.cpp ${VERSION} 已解压到 $DEST"
