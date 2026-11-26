# MCP Hub — CodexHost 统一 MCP 与插件管理中心

> 在 **CodexHost Web 左侧边栏**与 **Codex Desktop 插件页面**中，以极低延迟与极简操作统一管理 **Claude Code · Antigravity (`agy`) · OpenCode · Codex** 四个 Harness 的 MCP 服务、工具调试与原生插件。

## 核心能力（v1.2.0）

- **现代应用卡片画廊 UI（Bento App Gallery）**：3 列应用卡片画廊呈现每个 MCP 能力（确定性双色字母圆角徽标、状态胶囊、四端迷你停靠栏、末位预设快速接入卡）；点击「探测 / 调试 / 授权」自动全宽展开工具与 OAuth 工作区，独立调校亮/暗双主题并完整适配 390px 移动端。
- **Web 左侧边栏直达 + Desktop 跨端页面**：通过 `web` 入口调用 `api.panels.register({ placement: "main" })` 挂载到 CH Web 一级侧边栏「MCP 管理」，同时通过 `page` 入口无缝支持 Codex Desktop（设置 → 插件页面）。
- **极致性能工程**：
  - **投影式 Stat 缓存 + 概览记忆化**：按 `(mtimeMs, size)` 缓存投影后的精简 MCP 结构（自动丢弃 `~/.claude.json` 中数 MB 项目历史），热读延迟低至 **~1.3 ms**，堆内存仅 **~11 MB**。
  - **零 I/O 实时监听增量同步**：后端内置 `fs.watch` + 版本号心跳（`overview.poll` 未变更时仅 ~28 字节零磁盘 I/O），在终端通过 CLI 修改配置时界面自动刷新。
  - **瘦身 IPC 载荷**：变更类操作不重复下发静态预设与全量备份（载荷约缩减 70%），备份列表按需懒加载。
  - **按端串行写队列 + 备份索引独立串行队列**：并发操作绝不竞态损坏配置或备份索引。
  - **前端精准渲染**：IME 安全的常驻搜索框、单行 O(1) 同步胶囊局部更新、`rAF` 合批探测回显与 `content-visibility: auto`。
- **MCP 工具在线调试器（Tool Playground）**：对远程 Streamable HTTP MCP 执行探测后，点击任意工具即可查看完整 `inputSchema` 参数定义并在滑出抽屉直接发起真实 `tools/call` 试运行。
- **安全密钥识别与默认脱敏导出**：自动检测硬编码明文 Token / API Key；导出 JSON 默认勾选「脱敏导出」，一键将敏感凭据替换为 `<REDACTED>` 防止意外泄露。
- **多选批量操作与键盘快捷键**：支持批量启用/停用、批量跨端同步与批量移除；支持 `/` 搜索、`N` 新增、`R` 刷新、`Esc` 退出。
- **备份快照内容预览 & 一键回滚**：恢复前可直接在线查看完整 JSON / TOML 快照源码。
- **右侧滑出抽屉、原生 JSON/TOML 预览与项目/插件透视**：支持单行 Stdio 命令粘贴自动拆解、多端字段级 Diff、项目级 MCP 提升到全局、无子进程启停 Antigravity / Claude Code 原生插件与标准 OAuth 2.1 浏览器授权。

## 本地开发与打包

```bash
# 运行单元测试与并发/性能验证
npm test

# 同步样式、执行静态安全与契约校验、生成发布包 dist/mcp-hub-1.2.0.zip
npm run pack
```

## 自动发布流（GitHub Actions）

已内置 `.github/workflows/release.yml`：更新 `manifest.json` 与 `package.json` 版本号并推送对应 Tag（如 `git tag v1.2.0 && git push origin v1.2.0`），CI 将自动执行单测、打包与静态安全审计，并发布携带 ZIP + 图标 + 双主题预览图的 GitHub Release。
