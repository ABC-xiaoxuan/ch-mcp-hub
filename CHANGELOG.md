# Changelog · 更新日志

All notable changes to **MCP Hub (`ch-mcp-hub`)** are documented in this file.
每次发布版本前均需在此更新对应版本章节；GitHub Actions 发布流水线会自动提取该章节作为 GitHub Release 更新说明。

---

## [1.3.0] - 2026-11-28

### ✨ 新增功能（Added）
- **单工具粒度开关 & 上下文 Token 省流估算（Per-Tool Disable & Token Budget）**
  - 在展开的远程 MCP 工具列表中新增每个工具的独立开关与估算 Token 消耗，支持「一键全部启用」与实时展示每轮节省的上下文 Token 数。
  - 原生写入四端客户端配置，零子进程、不破坏已有规则：
    - **Codex**：`~/.codex/config.toml` 中的 `disabled_tools`
    - **Claude Code**：`~/.claude/settings.json` 中的 `permissions.deny`（`mcp__<server>__<tool>`）
    - **OpenCode**：`~/.config/opencode/opencode.json` 中的 `tools["<server>_<tool>"] = false`
    - **Antigravity**：`~/.gemini/config/mcp_config.json` 中的 `excludeTools`
- **官方 MCP Registry 在线发现 + 智能粘贴解析（Live Registry & Smart Resolver）**
  - 「发现与预设」页接入官方 `registry.modelcontextprotocol.io/v0/servers` 检索（内置 10 分钟 TTL 缓存与 6.5s 超时离线降级）。
  - 搜索框直接粘贴远程 MCP URL、`@scope/pkg`、npmjs / PyPI 链接或 GitHub `owner/repo` 即可智能识别并一键预填到配置抽屉（保留 `@scope/mcp` 的包作用域命名与图标字母）。
- **多账号 / 多环境凭据档案（Multi-Account Profiles）**
  - 支持为单个 MCP 服务保存多套命名凭据档案（如工作账号 / 个人账号 / 测试环境），一键切换即同步写入全部已启用客户端。
  - 凭据档案独立持久化于扩展数据目录 `hub-state.json`，概览接口仅返回脱敏元信息，不泄露明文密钥。
- **全局一键暂停 / 原样恢复（Global Pause & Resume with Memory）**
  - 暂停服务时自动记住该服务此前启用的客户端子集；再次点击恢复按钮时按原样精准还原，不误启用原本关闭的客户端。
- **Codex 超时控制 & 缺失 `${ENV_VAR}` 即时诊断**
  - 编辑抽屉新增「启动超时 (`startup_timeout_sec`)」与「工具调用超时 (`tool_timeout_sec`)」配置，缓解 `npx` / `uvx` 首次冷启动超时问题，并支持清空删除已有超时字段。
  - 自动检测配置中引用的未定义 `${ENV_VAR}` 环境变量，在卡片右上角显示紧凑告警徽章（悬停查看完整缺失变量列表）。

### 🎨 体验与界面打磨（Improved）
- Bento 卡片底栏新增暂停/恢复按钮、多账号入口按钮与紧凑状态微标签（`已关 N` / 当前账号芯片），并在 1440px Dark/Light 与 390px 移动端通过 0 Error / 0 Warning 视觉与触控目标审计。
- 自动化发布流新增 `CHANGELOG.md` 版本校验与 Release Notes 自动提取脚本（`scripts/extract-release-notes.mjs`）。

### ✅ 测试与安全（Testing & Security）
- 单元测试扩展至 **16 / 16 全部通过**，完整覆盖四端工具禁用、暂停记忆、多账号切换、超时读写、缺失环境变量检测与 Registry 智能解析。
- 保持纯 Node.js 标准库实现、零 `child_process`、零运行时依赖、静态安全扫描 0 风险。

---

## [1.2.0] - 2026-11-26

### ✨ 新增功能（Added）
- **全新 Concept C「现代应用卡片画廊（Bento App Gallery）」UI**
  - 3 列响应式 Bento 卡片画廊，配备确定性双色字母圆角徽标、状态胶囊、四端迷你停靠栏与末位预设快速接入卡；点击「探测 / 调试 / 授权」自动全宽展开工作区。
  - 完整适配亮/暗双主题及 390px 移动端，修复长路径 Stdio 文本导致的窄屏溢出问题。
- **MCP 工具在线调试器（Tool Playground）**：点击探测出的工具即可查看完整 `inputSchema` 参数并在抽屉内发起真实 `tools/call` 试运行。
- **实时文件监听与零 I/O 增量同步**：后端集成 `fs.watch` 与版本号心跳（`overview.poll`），外部 CLI 修改配置后界面自动刷新。
- **安全密钥检测与默认脱敏导出**：识别明文 Token / API Key，导出 JSON 默认开启 `<REDACTED>` 脱敏。
- **多选批量操作、备份快照在线预览与键盘快捷键**：支持批量启停/同步/移除、快照源码预览，以及 `/`、`N`、`R`、`Esc` 快捷键。

---

## [1.1.0] - 2026-11-26

### ✨ 新增功能（Added）
- **投影式 Stat 缓存引擎与概览记忆化**：按 `(mtimeMs, size)` 缓存精简 MCP 投影结构（跳过 `~/.claude.json` 多 MB 项目历史），热读延迟低至 ~1.3 ms。
- **右侧滑出配置抽屉 + 原生 JSON/TOML 实时预览**：支持单行 Stdio 命令自动拆解与多端字段级配置差异（Drift Diff）对比。
- **原生插件与项目级 MCP 透视**：无子进程直接读写 `~/.gemini/config/config.json` 与 `~/.claude/settings.json` 启停原生插件，并支持将项目级/插件自带 MCP 一键提升至全局。
- **轻量化备份索引**：迁移旧版单文件 JSON 备份至 `backups/index.json` + 独立 `.dat` 快照，且写队列与备份索引写操作完全串行防竞态。

---

## [1.0.0] - 2026-11-26

### 🎉 首个正式版本（Initial Release）
- 发布 CodexHost 统一宿主扩展 `mcp-hub`（`manifestVersion: 2`），同时挂载至 **CH Web 一级侧边栏**与 **Codex Desktop 设置 → 插件页面**。
- 支持 **Claude Code · Antigravity (`agy`) · OpenCode · Codex** 四端 MCP 配置统一读写、跨端格式转换（含 Codex 手术级 TOML 补丁保留注释与无关字段）、一键跨端同步、写前自动备份、内置精选预设市场、Streamable HTTP 连通性探测及 OAuth 2.1 PKCE 浏览器授权流。
