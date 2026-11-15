# agent_etc

一个**可自改装的桌面 Agent 工作台**：像豆包「办公任务模式」那样拆解任务、调用工具、操作浏览器，但模型、插件、权限、骨架全部由你自己配置。所有会话与配置都保存在本机。

![主界面](docs/screenshot-main.png)

## 它是什么

| 维度 | 说明 |
| --- | --- |
| 形态 | Electron 桌面应用，Windows 安装包 / 便携版单文件 exe |
| 模型 | 任意 OpenAI 兼容接口（OpenAI、DeepSeek、Moonshot、vLLM、Ollama、llama.cpp），Anthropic Messages API，本地 GGUF |
| 工具 | 文件读写、Shell、网页抓取、浏览器自动化（CDP）、剪贴板、HTTP、插件与 MCP 工具 |
| 插件 | 原生 JS 插件目录 + 任意 MCP 服务器（stdio JSON-RPC），可开关、可卸载 |
| 权限 | Shell / 写文件 / 网络 / 页面脚本分别可设为「询问 / 自动 / 禁止」 |
| 数据 | 全部本地：配置、会话、密钥、插件、工作区文件 |

## 快速开始

1. 安装 `agent_etc-Setup-1.0.0.exe`，或直接运行 `agent_etc-1.0.0-portable.exe`。
2. 打开 **设置 → 模型服务**，填 Base URL、API Key、模型名，点「测试连接」，再「设为当前」。
3. 回到主界面，输入任务，例如「读取工作区里的 CSV，做一份分析并写成报告」。

### 本地 GGUF 模型

1. 下载 llama.cpp 的 Windows 发行包（`llama-*-bin-win-x64.zip`），解压。
2. **设置 → 本地 GGUF**：运行时选择 `llama-server.exe`，模型选择 `.gguf` 文件，按显存调整 GPU 层数。
3. 点「启动模型服务」。就绪后会自动把当前模型切到本地，后续对话全部离线。

> 纯 CPU 也能跑：GPU 层数填 0，上下文按内存调整（7B 模型建议 4096–8192）。

### 浏览器操作

Agent 通过 Chrome DevTools Protocol 操作你本机的 Chrome / Edge，**保留真实登录态**：

- `browser_open` 打开页面，`browser_read` 读正文；
- `browser_click` / `browser_type` 支持 CSS 选择器或可见文字；
- `browser_screenshot` 截图落到工作区 `screenshots/`。

首次调用会自动拉起一个独立配置目录的浏览器实例，需要登录时在弹出的窗口里手动登录一次即可。

## 插件

### 原生插件

在用户数据目录 `plugins/<id>/` 放两个文件：

```json
// plugin.json
{ "id": "hello", "name": "示例", "version": "1.0.0", "main": "index.js" }
```

```js
// index.js
module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'hello_world',
      description: '打个招呼',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      async run(args) { return { hello: args.name || 'world' }; },
    });
  },
};
```

`ctx` 提供 `registerTool`、`getConfig`、`workspace`、`log`、`pluginDir`；工具可标记 `danger: true` 以触发确认弹窗。

### MCP 服务器

**设置 → 插件 → 添加 MCP 服务器**，填命令与参数即可，例如：

```
命令: npx
参数: -y @modelcontextprotocol/server-filesystem D:\data
```

启动后其工具会自动并入 Agent 的工具列表（前缀 `mcp_<server>_`）。

## 权限与安全

- 默认所有有副作用的操作都弹窗确认；可在 **设置 → 权限与工作区** 改成自动。
- 写文件默认限制在工作区，Shell 命令展示完整内容后再执行。
- API Key 保存在本机配置文件，不会上传；请勿把包含 Key 的配置文件提交到仓库。

## 开发与构建

```bash
npm install
npm start                  # 本地运行
npm run icon               # 生成图标（需要 Python + Pillow）
npm run dist:win           # 交叉编译 Windows（Linux 上需要 wine）
```

构建产物在 `dist/`：

- `agent_etc-1.0.0-x64.exe`：NSIS 安装程序（可选安装目录、桌面快捷方式）
- `agent_etc-1.0.0-portable.exe`：便携版单文件
- `win-unpacked/`：免安装目录版

## 代码签名

仓库提供 `scripts/make_cert.sh` 与 `scripts/sign.sh`，会生成 **ETC Root CA → ETC Code Signing** 两级证书并签名所有 exe。

```bash
bash scripts/make_cert.sh
npm run dist:win
bash scripts/sign.sh
```

签名后的 exe 带有 `CN=ETC` 的 Authenticode 签名。由于是自签发证书，Windows 默认不信任；把 `ETC-Root.crt` 安装到「受信任的根证书颁发机构」后，`signtool verify /pa` 即可通过。详见 [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md)。

## 目录结构

```
src/main/            主进程：Agent 循环、模型适配、工具、插件、本地模型
src/preload/         安全桥（contextIsolation）
src/renderer/        界面（无框架，纯 HTML/CSS/JS）
plugins/builtin/     内置插件：系统信息、HTTP 客户端、剪贴板
skills/              内置技能（注入系统提示的 Markdown）
scripts/             图标、证书、签名、自测脚本
```

## 许可

MIT
