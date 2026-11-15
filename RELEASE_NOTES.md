# agent_etc 1.6.2（Android 优化版）

作者：ETC · 许可证：MIT

## 本次优化

- **技能库扩充到 25 个**：自动、办公整理、正式文书、会议纪要、表格处理、演示文稿、数据分析、网页调研、事实核查、写作、营销文案、代码修改、排错调试、Android、前端网页、后端接口、Git/GitHub、本地文件、翻译润色、学习讲解、计划管理、创意策划、生活助手、安全隐私、记忆管理。
- **技能搜索**：设置 → 技能里可按名称/用途过滤，不再靠长列表找；新增 `list_skills` 和 `use_skill` 工具，Agent 自己也能列技能和切换。
- **本地模型自动加载**：启动时自动检测并加载上次模型；从后台回到前台也会检测；切到本地模式、导入新模型都会自动加载；设置页增加自动加载开关、加载中状态、失败原因和“加载/重载”按钮。
- **模型路径双备份**：除设置文件外，模型路径同时存入 Android SharedPreferences；即使设置文件损坏或旧版本迁移，也能恢复上次模型。
- **沿用 1.6.1 修复**：工作目录写代码异常保护/私有目录回退、消息改为原生文件持久化、多 MCP 插件、崩溃日志、双 ABI（arm64-v8a + armeabi-v7a）与 ETC 签名。

## 安装包

- `agent_etc-1.6.2-android.apk`
- `versionCode 9 / versionName 1.6.2`
- `lib/arm64-v8a/libagentllama.so` + `lib/armeabi-v7a/libagentllama.so`
- ETC Code Signing 签名

## 边界

- 当前环境没有 32 位 Android 真机；32 位库已做 ELF/ABI/JNI 静态校验并打包，真机加载推理仍需安装验证。
- 手机版不能运行电脑端 `npx` 本地插件；远程 HTTPS MCP 支持多服务连接。
