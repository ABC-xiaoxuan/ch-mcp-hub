/**
 * Curated MCP server presets and standard `mcpServers` JSON snippet importer.
 */

export const MCP_PRESETS = [
  {
    id: "notion",
    name: "Notion",
    category: "knowledge",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    oauthHint: true,
    description: {
      en: "Official Notion Streamable HTTP MCP (OAuth 2.1)",
      "zh-CN": "Notion 官方远程 MCP（支持标准 OAuth 授权）",
    },
  },
  {
    id: "context7",
    name: "Context7",
    category: "docs",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: {},
    description: {
      en: "Up-to-date library documentation & code examples",
      "zh-CN": "实时开源库文档与代码示例检索",
    },
  },
  {
    id: "github",
    name: "GitHub",
    category: "devtools",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: {
      Authorization: "Bearer YOUR_GITHUB_PAT",
    },
    description: {
      en: "Official GitHub remote MCP (Issues, PRs, code search)",
      "zh-CN": "GitHub 官方远程 MCP（Issues、PR 与仓库检索）",
    },
  },
  {
    id: "playwright",
    name: "Playwright",
    category: "browser",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: {},
    description: {
      en: "Browser automation and accessibility snapshot inspection",
      "zh-CN": "浏览器自动化控制与页面快照检查",
    },
  },
  {
    id: "filesystem",
    name: "Filesystem",
    category: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: {},
    description: {
      en: "Scoped local directory read/write access",
      "zh-CN": "受控本地目录文件读写工具",
    },
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    category: "reasoning",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    env: {},
    description: {
      en: "Structured multi-step reasoning scratchpad",
      "zh-CN": "结构化分步推理与反思工具",
    },
  },
  {
    id: "memory",
    name: "Memory Graph",
    category: "knowledge",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
    description: {
      en: "Persistent local knowledge-graph memory",
      "zh-CN": "本地持久化知识图谱记忆服务",
    },
  },
  {
    id: "linear",
    name: "Linear",
    category: "workflow",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    oauthHint: true,
    description: {
      en: "Official Linear remote MCP (Issues, cycles, roadmaps)",
      "zh-CN": "Linear 官方远程 MCP（项目管理与需求追踪）",
    },
  },
  {
    id: "figma",
    name: "Figma",
    category: "design",
    transport: "http",
    url: "https://mcp.figma.com/mcp",
    oauthHint: true,
    description: {
      en: "Official Figma remote MCP (Design context & tokens)",
      "zh-CN": "Figma 官方远程 MCP（设计稿上下文与变量）",
    },
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "data",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    oauthHint: true,
    description: {
      en: "Official Supabase remote MCP (SQL, schema, logs)",
      "zh-CN": "Supabase 官方远程 MCP（数据库与日志）",
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "devtools",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    oauthHint: true,
    description: {
      en: "Official Sentry remote MCP (Errors, traces, releases)",
      "zh-CN": "Sentry 官方远程 MCP（异常追踪与发布监控）",
    },
  },
  {
    id: "fetch",
    name: "Fetch",
    category: "local",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    env: {},
    description: {
      en: "Fetch and convert web pages to clean Markdown",
      "zh-CN": "抓取网页并转换为干净 Markdown 供模型阅读",
    },
  },
];

function normalizeStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.trim() && v !== undefined && v !== null) {
      out[k.trim()] = String(v);
    }
  }
  return out;
}

/**
 * Parse a pasted JSON snippet in any common MCP config shape:
 * - `{ "mcpServers": { "name": { ... } } }` (Claude / Cursor / Antigravity / Desktop)
 * - `{ "mcp": { "name": { ... } } }` (OpenCode)
 * - `{ "name": { "command": ... | "url": ... } }` (direct map)
 */
export function parseImportedMcpJson(rawText) {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) {
    throw new Error("JSON input is empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }

  let map = parsed;
  if (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) {
    map = parsed.mcpServers;
  } else if (parsed.mcp && typeof parsed.mcp === "object" && !Array.isArray(parsed.mcp)) {
    map = parsed.mcp;
  }

  const servers = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const normalized = normalizeIncomingEntry(name, entry);
    if (normalized) servers.push(normalized);
  }
  if (servers.length === 0) {
    throw new Error("No valid MCP server definitions found in JSON");
  }
  return servers;
}

function normalizeIncomingEntry(name, entry) {
  const id = String(name).trim();
  if (!id) return null;

  const url =
    typeof entry.url === "string"
      ? entry.url.trim()
      : typeof entry.serverUrl === "string"
        ? entry.serverUrl.trim()
        : "";
  if (url) {
    const transport = entry.type === "sse" ? "sse" : "http";
    return {
      name: id,
      transport,
      url,
      headers: normalizeStringMap(entry.headers ?? entry.http_headers),
      enabled: entry.enabled !== false && entry.disabled !== true,
    };
  }

  let command = "";
  let args = [];
  if (Array.isArray(entry.command) && entry.command.length > 0) {
    command = String(entry.command[0]).trim();
    args = entry.command.slice(1).map((a) => String(a));
  } else if (typeof entry.command === "string" && entry.command.trim()) {
    command = entry.command.trim();
    args = Array.isArray(entry.args) ? entry.args.map((a) => String(a)) : [];
  }
  if (!command) return null;

  return {
    name: id,
    transport: "stdio",
    command,
    args,
    env: normalizeStringMap(entry.env ?? entry.environment),
    enabled: entry.enabled !== false && entry.disabled !== true,
  };
}
