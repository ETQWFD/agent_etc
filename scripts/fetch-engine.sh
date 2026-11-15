#!/usr/bin/env bash
# 下载 Windows x64 CPU 版 llama.cpp 运行时到 vendor/llama/win（打包时会被塞进安装包）
set -euo pipefail
VER="${LLAMA_BUILD:-b12405}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor/llama/win"
mkdir -p "$DEST"
ZIP="/tmp/llama-${VER}-win-cpu-x64.zip"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${VER}/llama-${VER}-bin-win-cpu-x64.zip"
if [ ! -f "$DEST/llama-server.exe" ]; then
  echo "downloading $URL"
  curl -fL --retry 3 -o "$ZIP" "$URL"
  unzip -q -o "$ZIP" -d "$DEST"
fi
echo "engine ready: $DEST"
