#!/usr/bin/env bash
# 用 ETC 代码签名证书给 dist 下所有 exe 签名
set -euo pipefail
cd "$(dirname "$0")/.."
PASS="${ETC_PFX_PASS:-$(cat certs/PASSWORD.txt 2>/dev/null || echo ETC2026-agent-etc)}"

[ -f certs/ETC-CodeSigning.pfx ] || { echo "缺少 certs/ETC-CodeSigning.pfx，请先运行 scripts/make_cert.sh"; exit 1; }
[ -d dist ] || { echo "缺少 dist 目录，请先构建"; exit 1; }

mapfile -t FILES < <(find dist -maxdepth 1 -name '*.exe' -type f ! -name '*signed*' | sort)
if [ ${#FILES[@]} -eq 0 ]; then echo "没有找到 exe"; exit 0; fi

for f in "${FILES[@]}"; do
  echo "签名：$f"
  out="${f%.exe}.signed.exe"
  if osslsigncode sign \
      -pkcs12 certs/ETC-CodeSigning.pfx -pass "$PASS" \
      -n "agent_etc" -i "https://github.com/ETQWFD/agent_etc" \
      -in "$f" -out "$out" >/dev/null 2>&1; then
    mv "$out" "$f"
    echo "  完成"
  else
    echo "  失败（保留原文件）"; rm -f "$out"
  fi
done

echo "全部处理完成。验证："
find dist -maxdepth 1 -name '*.exe' -type f | while read -r f; do
  printf '%-60s ' "$f"
  osslsigncode verify "$f" 2>&1 | grep -E "Subject:|Signature verification:" | tr '\n' ' ' || true
  echo
done
