# agent_etc 1.3.0

作者：ETC · 许可证：MIT

## 记忆：会记、会忘、会重新想起
- 每条记忆带重要度（1–5）与强度；强度按半衰期指数衰减：重要度越高忘得越慢（约 0.7 天 / 2 天 / 7 天 / 30 天 / 120 天）。
- 被搜索命中会“回想”，强度回升；低强度不会立即删除，只排到后面。
- 自动从“我叫… / 我喜欢… / 记住…”这类话里提取长期事实；也可以让模型显式调用 `memory_save`。
- 设置里新增「记忆」页：可添加、搜索、查看强度与年龄、单条忘记。
- 记忆只存在本机 `userData/memory.json`，不上传。

## 插件市场：真的能装
- 新增「插件市场」：接 MCP 官方注册表（registry.modelcontextprotocol.io）与 npm。
- 搜到带 npm 包的 MCP 服务可直接安装，注册成 Agent 工具（用 `npx -y <package>` 启动）。
- 支持自定义 JSON 市场源；原生插件可从 GitHub zip 安装（自动找 `plugin.json`）。
- 说明：第三方与 DeepSeek Harness 的官方插件市场没有公开安装 API，本市场不以“官方”名义伪装；若你有对方导出的 JSON 源地址，填到「自定义源」即可接入。

## QQ 助手
- 新增「QQ 助手」设置页：填 OneBot HTTP 地址与 access token，连上后私聊小号即可让 Agent 回复、调用工具干活。
- 不在本应用里收集 QQ 密码、不代扫码；扫码登录由你本机的 NapCat / LLOneBot 完成，本应用只连它的接口。
- 支持允许 QQ 号白名单、断线 5 秒重连、网关测试。

## Android APK
- 新增 Android WebView 壳 `agent_etc-1.3.0-android.apk`：手机与电脑同一 Wi-Fi，填电脑端「手机版」地址与 token 即可用。
- 使用 ETC 代码签名证书签名（PKCS12），`apksigner verify` 通过。

## 人机验证边界
- 不提供自动完成验证码 / 人机验证的能力：给“眼睛和手”去点验证码仍然是代过验证，不做。
- 检测到验证码时停止自动操作，给出明确提示，由用户本人完成；其余桌面视觉、精确定位、点击、输入不受影响。

## 沿用 1.2.0
- 内置 llama.cpp b12405 Windows CPU x64 引擎；
- 屏幕截图 + 鼠标键盘控制（默认需审批）；
- `fs_search` / `fs_drives` 文件检索；
- `ask_user` 桌面/手机双端选择弹窗；
- ETC 证书签名与校验和。
