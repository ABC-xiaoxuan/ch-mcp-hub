# MCP Hub — CodexHost 统一 MCP 与插件管理中心

> 在 **CodexHost Web 左侧边栏**与 **Codex Desktop 插件页面**中，以极低延迟与极简操作统一管理 **Claude Code · Antigravity (`agy`) · OpenCode · Codex** 四个 Harness 的 MCP 服务与原生插件。

## 核心能力（v1.1.0）

- **Web 左侧边栏直达 + Desktop 跨端页面**：通过 `web` 入口调用 `api.panels.register({ placement: "main" })` 挂载到 CH Web 一级侧边栏「MCP 管理」，同时通过 `page` 入口无缝支持 Codex Desktop（设置 → 插件页面）。
- **极致性能工程**：
  - **Stat 缓存零重解析**：基于文件 `(mtimeMs, size)` 缓存解析结果，面对 200KB+ 的 `~/.claude.json` 热读耗时 `< 1 ms`。
  - **分离式轻量备份索引**：`backups/index.json`（仅元信息）与 `backups/<id>.dat`（原始配置正文）分离，列表零加载全量快照。
  - **按端串行写队列 + 有界并发探测**：并发切换同步胶囊绝不竞态损坏配置文件；「全部探测」限制最大并发数 `4` 并内置 60s 结果缓存与 30s `PATH` 缓存。
  - **前端分区精准渲染**：搜索框 DOM 永不重建（中文 IME 零打断）、单卡探测与工具搜索局部更新、`content-visibility: auto` 长列表渲染优化。
- **四端原生配置适配器与差异 Diff**：
  - **Claude Code**：`~/.claude.json`（保留所有无关字段与项目配置，支持无损停用暂存）
  - **Antigravity (`agy`)**：`~/.gemini/config/mcp_config.json`（兼容 `url` 与 `serverUrl`、`disabled` 标志）
  - **OpenCode**：`~/.config/opencode/opencode.json`（自动转换 `type: "local" | "remote"`、`command` 数组与 `environment`）
  - **Codex**：`~/.codex/config.toml`（外科手术式 TOML 节点补丁，100% 保留原有注释与配置段落）
  - 跨端同步弹窗内置**字段级 Diff 对比**，对齐前一目了然。
- **右侧滑出抽屉 & 实时原生配置预览**：编辑 MCP 时可保留后方矩阵上下文；支持单行 Stdio 命令粘贴自动拆解（含引号与路径转义）、多端来源切换，并可在保存前实时预览写入四端的真实 JSON / TOML 代码片段。
- **项目级 MCP 透视与原生插件管理**：无需额外读盘即可发现 Claude 项目级 MCP 与 Antigravity 插件自带 MCP（支持一键提升至全局），并支持无子进程直接启停 Antigravity / Claude Code 原生插件。
- **批量探测、工具检索与标准 OAuth 2.1**：支持一键全部探测与健康指示灯、工具列表搜索与折叠展开；遇远程 `401` 自动发现 OAuth 元数据并发起浏览器 PKCE 授权（支持远程浏览器手动粘贴回调链接）与四家原生 CLI 登录命令一键复制。

## 本地开发与打包

```bash
# 运行单元测试与性能/并发验证
npm test

# 同步样式、执行静态安全与契约校验、生成发布包 dist/mcp-hub-1.1.0.zip
npm run pack
```

## 自动发布流（GitHub Actions）

已内置 `.github/workflows/release.yml`：只需更新 `manifest.json` 与 `package.json` 版本号后推送对应 Tag（如 `git tag v1.1.0 && git push origin v1.1.0`），CI 将自动执行单测、打包与静态安全审计，并发布携带 ZIP + 图标 + 预览图的 GitHub Release。
