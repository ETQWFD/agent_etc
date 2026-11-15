#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-/home/user/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
NDK="${ANDROID_NDK_HOME:-$SDK/ndk/android-ndk-r26d}"
APP="$ROOT/android-standalone"
OUT="$ROOT/build/standalone"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

mkdir -p "$OUT" "$ROOT/dist"
rm -rf "$OUT"; mkdir -p "$OUT"

# 1. native arm64 lib
cmake --build "$APP/build-android" --target agentllama -j 4
SO="$(find "$APP/build-android" -name 'libagentllama.so' | head -1)"
"${NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-unneeded "$SO" || true
[ -n "$SO" ] || { echo "libagentllama.so 未找到"; exit 1; }

# 2. resources
"$BT/aapt2" compile --dir "$APP/app/src/main/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLATFORM" \
  --manifest "$APP/app/src/main/AndroidManifest.xml" \
  -A "$APP/app/src/main/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 23 --target-sdk-version 34 \
  "$OUT/res.zip"

# 3. java + dex
mkdir -p "$OUT/classes" "$OUT/dex"
find "$APP/app/src/main/java" -name '*.java' > "$OUT/sources.txt"
echo "$OUT/gen/com/etwqfd/agentetc/R.java" >> "$OUT/sources.txt"
javac --release 8 -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"
find "$OUT/classes" -name '*.class' -print0 | xargs -0 "$BT/d8" --release --min-api 23 --lib "$PLATFORM" --output "$OUT/dex"

cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex )
mkdir -p "$OUT/lib/arm64-v8a"
cp "$SO" "$OUT/lib/arm64-v8a/libagentllama.so"
( cd "$OUT" && zip -q -0 unsigned.apk lib/arm64-v8a/libagentllama.so )

# 4. align + sign
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$ROOT/certs/ETC-CodeSigning.pfx" --ks-type PKCS12 \
  --ks-pass pass:ETC2026-agent-etc --key-pass pass:ETC2026-agent-etc \
  --ks-key-alias "etc code signing" \
  --out "$ROOT/dist/agent_etc-1.4.0-android.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$ROOT/dist/agent_etc-1.4.0-android.apk" | head -4
ls -lh "$ROOT/dist/agent_etc-1.4.0-android.apk"
