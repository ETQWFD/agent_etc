#!/usr/bin/env bash
# 生成 ETC 代码签名体系：ETC Root CA + ETC Code Signing 叶子证书
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
PASS="${ETC_PFX_PASS:-ETC2026-agent-etc}"

if [ ! -f certs/ETC-Root.key ]; then
  echo "[1/4] 生成根证书 ETC Root CA"
  openssl genrsa -out certs/ETC-Root.key 4096 >/dev/null 2>&1
  openssl req -x509 -new -key certs/ETC-Root.key -sha256 -days 7300 \
    -subj "/C=CN/O=ETC/CN=ETC Root CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out certs/ETC-Root.crt
else
  echo "[1/4] 根证书已存在，跳过"
fi

echo "[2/4] 生成代码签名私钥与 CSR"
openssl genrsa -out certs/ETC-CodeSigning.key 2048 >/dev/null 2>&1
openssl req -new -key certs/ETC-CodeSigning.key -subj "/C=CN/O=ETC/CN=ETC/OU=Code Signing" -out certs/ETC-CodeSigning.csr

cat > certs/ETC-CodeSigning.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EXT

echo "[3/4] 签发代码签名证书（有效期 3 年）"
openssl x509 -req -in certs/ETC-CodeSigning.csr \
  -CA certs/ETC-Root.crt -CAkey certs/ETC-Root.key -CAcreateserial \
  -days 1095 -sha256 -extfile certs/ETC-CodeSigning.ext \
  -out certs/ETC-CodeSigning.crt

echo "[4/4] 打包 PFX"
openssl pkcs12 -export \
  -inkey certs/ETC-CodeSigning.key \
  -in certs/ETC-CodeSigning.crt \
  -certfile certs/ETC-Root.crt \
  -name "ETC Code Signing" \
  -passout "pass:${PASS}" \
  -out certs/ETC-CodeSigning.pfx

openssl pkcs12 -export \
  -inkey certs/ETC-Root.key \
  -in certs/ETC-Root.crt \
  -name "ETC Root CA" \
  -passout "pass:${PASS}" \
  -out certs/ETC-Root.pfx

printf '%s\n' "${PASS}" > certs/PASSWORD.txt
echo "完成：certs/ETC-Root.crt  certs/ETC-CodeSigning.crt  certs/ETC-CodeSigning.pfx"
echo "PFX 密码见 certs/PASSWORD.txt"
