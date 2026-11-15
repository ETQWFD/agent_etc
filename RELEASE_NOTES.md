# agent_etc 1.2.0

作者：ETC · 许可证：MIT

## 这次新增

### 自带模型引擎，不再让你自己找 llama.cpp
安装包内置 llama.cpp `b12405` Windows CPU x64 运行时（`llama-server.exe` + `ggml-*.dll`），落在
`resources/engines/llama-win`。启动本地 GGUF 时自动探测这个内置引擎，选好 `.gguf` 就能跑；
不需要联网下载引擎，也不需要另装 Visual C++ 运行库。

之前你遇到的 `llm_demo.exe` 报错（`config path is --model`、`Unable to open llm_config file`）
是 MNN demo 的用法不兼容 GGUF。现在选到 MNN 会直接说明原因，并引导改用内置的 llama-server。

### 屏幕视觉 + 精准点击（“眼睛”和“手”）
- `screen_capture`：截取整个屏幕（实测 1920×1080），保存到工作区 `screenshots/`；
  使用视觉模型（GPT-4o / Claude / Qwen-VL 等）时，截图会自动作为图片送给模型。
- `screen_click` / `screen_type` / `screen_key`：按屏幕像素坐标真实点击、输入、按快捷键。
  Windows 下走 PowerShell + user32，不依赖原生模块。
- 所有鼠标键盘操作默认需要你在弹窗里点“允许这一次”，可在设置里改。

### 本机文件检索
- `fs_drives`：列出磁盘与剩余空间；
- `fs_search`：按文件名关键词递归搜索，支持根目录、扩展名、最大条数；默认 12 秒超时、最多 60 条，
  不会把整块磁盘扫到卡死。

### 需要你拍板时会弹选择
- 新增 `ask_user` 工具：模型遇到多方案、缺关键信息时弹窗列出 2–4 个选项；
- 桌面端与手机版都能选，选完继续执行；2 分钟不选会返回“用户未选择”。

### 人机验证
检测到验证码 / 人机验证时立即停止自动操作，提示需要你本人完成，**不做绕过**。

### 修复与优化
- 修复截图 base64 被写进会话导致会话文件膨胀的问题，只在当轮上下文里传图；
- 关于页版本号改为动态读取，不再写死；作者 ETC、检查更新保持可用；
- 新增桌面控制权限项；会话、工具卡渲染做了防御处理。

## 打包与签名
- Windows 安装包与便携版均由 electron-builder 生成；
- 图标、版本信息由 `scripts/after-pack.js`（纯 JS，resedit）写入，不依赖 Wine 的 rcedit；
- 产物使用 ETC 代码签名证书签名，可用随包的 `ETC-Root.crt` 验证。

## 已知边界
- 内置引擎是 Windows x64 CPU 版；Linux 版请自行编译 llama-server。
- 屏幕点击使用绝对坐标，缩放/多显示器场景请先 `screen_capture` 确认位置。
- 人机验证只做检测与转人工，不提供自动过验证码能力。
