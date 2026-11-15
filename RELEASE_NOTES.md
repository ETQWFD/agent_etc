# agent_etc 1.6.1（Android 修复版）

作者：ETC · 许可证：MIT

## 本版修复

- **设置工作目录后写代码闪退/写入失败**：`wsWrite` 增加完整异常保护、MIME 按扩展名选择、`wt` 写入失败自动回退 `w`、目录权限失效时明确提示；工作目录写失败时自动改存应用私有目录，不再让任务中断。
- **消息加载不出来/重启后会话丢失**：会话、设置、记忆改存应用私有目录的原生 JSON 文件（原子写入），不再依赖 WebView `localStorage` 的 5MB 配额；启动时自动兼容旧 localStorage 数据，并对损坏会话做过滤恢复。
- **每次进 App 都要手动加载本地模型**：启动时若上次是本地模式且有模型路径，会自动检测原生引擎；进程重启后自动重新加载，切到本地模式时也会自动加载，不需要每次进设置点“加载”。
- **插件只能装一个**：插件配置改为多 MCP 服务列表，可重复连接不同地址；每个服务独立保存 URL、Token 和工具，工具名带服务前缀，互不覆盖；插件页可单独断开某个服务。
- **崩溃可追踪**：增加未捕获异常日志 `files/state/last-crash.txt`，后续排查闪退有据可查；Java 桥接写文件、读文件统一捕获 `Throwable`，不让异常直接抛到 WebView。
- **版本/UI**：统一为 `1.6.1 / versionCode 8`；保留 1.6.0 的四个工作模式、技能导入、文本附件、屏幕读取/点击与双 ABI。

## 安装包

- `agent_etc-1.6.1-android.apk`
- `lib/arm64-v8a/libagentllama.so` + `lib/armeabi-v7a/libagentllama.so`
- ETC Code Signing 签名，`apksigner verify` 通过

## 边界

- 仍需在真实 Android 设备上验证 SAF 目录写入和本地 GGUF 加载；当前环境没有 32 位真机。
- 手机版不能运行电脑端的 `npx` 本地插件；远程 HTTPS MCP 可多服务连接。
