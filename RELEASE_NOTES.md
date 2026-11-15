# agent_etc 1.1.0

本次更新聚焦「装好就能用」：

## 本地模型引擎
- 新增引擎探测：区分 llama.cpp 的 `llama-server` 与 MNN 的 `llm_demo.exe`。
- 修掉把 `--model` 传给 MNN demo 时出现的 `config path is --model` / `tokenizer file not found` 类报错，改为明确提示「llm_demo 只能读 config.json，不能加载 .gguf」。
- 新增「自动安装引擎」：从 llama.cpp 官方 Release 解析最近的 `b####` 构建，下载 `llama-b*-bin-win-cpu-x64.zip`，解压到用户数据目录并自动填好路径。GitHub API 限流时改用 Release 页面解析，不依赖 API 配额。

## 技能
- 兼容豆包单文件 `.md` 与 DeepSeek Harness / Claude 目录 `SKILL.md` 两种格式，支持 front matter。
- 支持导入文件、导入目录、导入 `.zip`、从 `~/.dsh/skills` 等默认目录批量导入。
- 每个技能可开关、打开、删除；技能注入系统提示时按启用状态与长度预算截断。

## 关于与更新
- 关于页补齐作者 **ETC**、许可证、GitHub / Release 入口。
- 新增「检查更新」：查询 GitHub 最新 Release 并比较版本；API 被限流时回退到 `releases/latest` 跳转地址，仍能给出结果。

## 手机版
- 新增局域网手机端：同一份会话、同一套工具与权限，工具执行前手机确认。
- 令牌鉴权（`?t=` / Cookie），默认端口 8787；支持流式输出、工具卡、任务切换、添加到主屏幕。
- 设置页可开启/关闭、复制访问地址，自动过滤 169.254 链路本地地址。

## 其他
- 版本号 1.1.0；安装包与便携版继续使用 ETC 代码签名证书签名。
