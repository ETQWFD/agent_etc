# ETC 代码签名说明

本项目的 Windows 产物由一套自签发的 **ETC** 代码签名证书签名：

```
ETC Root CA（根，20 年）
   └── ETC Code Signing（叶子，CN=ETC，EKU=codeSigning，3 年）
```

## 生成与签名

```bash
bash scripts/make_cert.sh          # 生成 certs/ 下的根证书、叶子证书与 PFX
npm run dist:win                   # 构建
bash scripts/sign.sh               # 用 osslsigncode 给 dist 下所有 exe 签名
```

`certs/` 里的私钥与 PFX **不会**提交到仓库（见 `.gitignore`），只在本地和发布包里分发。

## 为什么 Windows 还会提示「未知发布者」

Authenticode 的信任链依赖 CA 是否在系统的「受信任的根证书颁发机构」中。自签发证书默认不在，所以：

- 签名本身真实有效（`signtool verify /pa` 能看到 `CN=ETC`）；
- 但 SmartScreen / UAC 仍会提示未知发布者，除非手动信任根证书，或购买 CA 签发的 OV/EV 代码签名证书。

这是证书信任模型决定的，任何工具都无法「绕过」它。

## 让本机信任 ETC

**图形方式**

1. 双击 `ETC-Root.crt` → 安装证书 → 本地计算机 → 「将所有证书放入下列存储」→ 浏览 → **受信任的根证书颁发机构** → 完成。
2. 重新运行安装包，UAC 弹窗的发布者会显示 `ETC`。

**命令行方式（管理员 PowerShell / CMD）**

```bat
certutil -addstore -f Root ETC-Root.crt
```

验证：

```bat
signtool verify /pa /v agent_etc-1.0.0-x64.exe
```

> 仅在你信任该证书私钥保管方时安装根证书。分发给他人时，请一并提供 `ETC-Root.crt` 与校验值（SHA-256）。

## 发布到 GitHub Releases

建议把以下文件一起上传：

- `agent_etc-1.0.0-x64.exe`（安装包）
- `agent_etc-1.0.0-portable.exe`（便携版）
- `ETC-Root.crt`（根证书，供用户选择信任）
- `SHA256SUMS.txt`

## 如果要做「无提示」正式分发

需要 CA 签发的代码签名证书（OV 需企业实名，EV 需硬件令牌），然后用同样的 `osslsigncode` / `signtool` 流程签名即可，应用代码无需改动。
