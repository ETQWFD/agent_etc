#!/usr/bin/env bash
# 手工编译 Android WebView 壳（不依赖 Gradle）
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_SDK_ROOT:-/home/user/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
[ -x "$BT/aapt2" ] || { echo "缺少 $BT/aapt2，请先运行 sdkmanager 安装 build-tools;34.0.0"; exit 1; }
[ -f "$PLATFORM" ] || { echo "缺少 $PLATFORM"; exit 1; }

OUT=build/android
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/gen" "$OUT/res" "$OUT/dex"

"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" \
  -I "$PLATFORM" \
  --manifest android/AndroidManifest.xml \
  -R "$OUT/res.zip" \
  -A android/assets \
  --java "$OUT/gen" \
  --auto-add-overlay \
  --min-sdk-version 23 --target-sdk-version 34

javac --release 8 -classpath "$PLATFORM" -d "$OUT/classes" \
  android/java/com/etwqfd/agentetc/MainActivity.java \
  "$OUT/gen/com/etwqfd/agentetc/R.java"
find "$OUT/classes" -name "*.class" -print0 | xargs -0 "$BT/d8" --release --lib "$PLATFORM" --output "$OUT/dex"

zip -q -j "$OUT/unsigned.apk" "$OUT/dex/classes.dex"
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

PASS="${ETC_PFX_PASS:-$(cat certs/PASSWORD.txt 2>/dev/null || echo ETC2026-agent-etc)}"
mkdir -p dist
"$BT/apksigner" sign \
  --ks certs/ETC-CodeSigning.pfx --ks-type PKCS12 \
  --ks-pass "pass:$PASS" --key-pass "pass:$PASS" \
  --ks-key-alias "etc code signing" \
  --out "dist/agent_etc-1.3.0-android.apk" \
  "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs "dist/agent_etc-1.3.0-android.apk" | head -5
ls -lh "dist/agent_etc-1.3.0-android.apk"
