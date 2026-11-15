# agent_etc 1.0.0

首个可用版本：一个可自改装的桌面 Agent 工作台。

## 下载

| 文件 | 说明 |
| --- | --- |
| `agent_etc-1.0.0-x64.exe` | NSIS 安装程序：可选安装目录、创建桌面/开始菜单快捷方式 |
| `agent_etc-1.0.0-portable.exe` | 便携版单文件：免安装，双击即用 |
| `ETC-Root.crt` | ETC 根证书：安装到「受信任的根证书颁发机构」后签名可验证 |
| `SHA256SUMS.txt` | 三个文件的 SHA-256 校验值 |

## 功能

- **模型自由接**：OpenAI 兼容接口（OpenAI / DeepSeek / Moonshot / vLLM / Ollama / llama.cpp）、Anthropic、本地 GGUF（内置 llama.cpp 运行时管理）。
- **像办公模式一样干活**：任务拆解 → 调用工具 → 逐轮执行，流式输出、步骤计数、随时中止。
- **真实工具链**：文件读写、Shell、网页抓取、浏览器自动化（Chrome DevTools Protocol，保留登录态）、剪贴板、HTTP 请求。
- **可改装骨架**：原生 JS 插件（`plugin.json` + `ctx.registerTool`）+ 任意 MCP 服务器（stdio JSON-RPC），设置里可开关、卸载。
- **权限可控**：Shell / 写文件 / 网络 / 页面脚本各自支持「询问 · 自动 · 禁止」。
- **本地优先**：会话、配置、插件、工作区全部保存在本机。

## 代码签名

安装包与便携版均使用 **ETC** 代码签名证书签名（`CN=ETC`，签发者 `ETC Root CA`），SHA-256 Authenticode 签名可见。

自签发证书默认不被 Windows 信任，因此首次运行可能出现「未知发布者」。安装 `ETC-Root.crt` 到受信任根存储后可验证通过；若要彻底消除提示，需要购买 CA 签发的 OV/EV 代码签名证书重新签名，应用本身无需改动。

## 校验

```bash
sha256sum -c SHA256SUMS.txt
```
