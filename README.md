# MCP Hub — CodexHost 统一 MCP 管理中心

> 在 **CodexHost Web 左侧边栏**与 **Codex Desktop 插件页面**中，统一管理 **Claude Code · Antigravity (`agy`) · OpenCode · Codex** 四个 Harness 的 MCP 服务。

## 核心能力

- **Web 左侧边栏直达 + Desktop 跨端页面**：通过 `web` 入口调用 `api.panels.register({ placement: "main" })` 挂载到 CH Web 一级侧边栏「MCP 管理」，同时通过 `page` 入口无缝支持 Codex Desktop（设置 → 插件页面）。
- **四端原生配置适配器与同步矩阵**：
  - **Claude Code**：`~/.claude.json`（保留所有无关字段，支持无损停用暂存）
  - **Antigravity (`agy`)**：`~/.gemini/config/mcp_config.json`（兼容 `url` 与 `serverUrl`、`disabled` 标志）
  - **OpenCode**：`~/.config/opencode/opencode.json`（自动转换 `type: "local" | "remote"`、`command` 数组与 `environment`）
  - **Codex**：`~/.codex/config.toml`（外科手术式 TOML 节点补丁，100% 保留原有注释与配置段落）
- **实时连通性探测（Live Probe）**：对远程 Streamable HTTP MCP 发起 `initialize` + `tools/list` 探测并展示延迟与工具清单；对 Stdio MCP 校验命令是否存在于 `PATH`。
- **标准 OAuth 2.1 + PKCE 授权与原生 CLI 命令复制**：当远程 MCP（如 `https://mcp.notion.com/mcp`）返回 `401` 时，自动发现 `.well-known/oauth-protected-resource` 与 `.well-known/oauth-authorization-server`，支持浏览器授权（及远程浏览器手动粘贴回调 URL），并提供四家原生 CLI 登录命令一键复制。
- **零 `child_process` & 自动备份回滚**：纯 Node.js 共享单实例后端，满足 CodexHost 插件市场自动化静态安全校验要求；每次写盘前自动在扩展数据目录留存可回滚快照。

## 本地开发与打包

```bash
# 生成图标
npm run icon

# 运行单元测试
npm test

# 同步样式、执行静态安全与契约校验、生成发布包 dist/mcp-hub-1.0.0.zip
npm run pack
```

## 本地安装试用

1. 打开 CodexHost Web 左侧「插件 → 插件中心」或 Codex Desktop「设置 → 插件」；
2. 点击「导入插件」，选择本地目录（开发期填入本目录路径）或上传 `dist/mcp-hub-1.0.0.zip`；
3. 启用 **MCP 管理中心（MCP Hub）** 后，即可在 CH Web 左侧边栏直接点击「MCP 管理」进入。

## 发布到 CodexHost 官方插件市场

1. 在 GitHub 创建公开仓库并推送本目录代码；
2. 创建正式 GitHub Release（例如 `v1.0.0`），将 `dist/` 下自动生成的 4 个资产全部上传：
   - `dist/mcp-hub-1.0.0.zip`（扩展包本体）
   - `dist/icon.png`（与 `manifest.json` 的 `icon` 逐字节一致）
   - `dist/preview-dark.png`、`dist/preview-light.png`（与 `manifest.json` 的 `screenshots` 逐字节一致）
3. 前往 [codexhost-extensions-registry 提交扩展 Issue](https://github.com/BytePioneer-AI/codexhost-extensions-registry/issues/new?template=submit-extension.yml) 填入仓库地址，等待自动静态检查通过并合并即可上架。
