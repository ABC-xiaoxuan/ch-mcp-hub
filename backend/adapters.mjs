/**
 * Four-harness native MCP configuration adapters with atomic writes, automatic backups,
 * cross-harness schema conversion, and lossless Claude Code disable stashing.
 *
 * Supported harnesses:
 * - `claude-code`: `~/.claude.json` (`mcpServers`)
 * - `antigravity`: `~/.gemini/config/mcp_config.json` (`mcpServers`)
 * - `opencode`: `~/.config/opencode/opencode.json` (fallback `~/.opencode/opencode.json`) (`mcp`)
 * - `codex`: `~/.codex/config.toml` (`[mcp_servers.<name>]`)
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexMcpToml, patchCodexMcpToml } from "./toml.mjs";

export const HARNESS_IDS = ["claude-code", "antigravity", "opencode", "codex"];

export const HARNESS_META = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    shortName: "Claude",
    format: "json",
    accent: "#d97757",
    cliHints: {
      list: () => "claude mcp list",
      oauth: (name) => `claude mcp login ${shellQuote(name)} --no-browser`,
      oauthBrowser: (name) => `claude mcp login ${shellQuote(name)}`,
      logout: (name) => `claude mcp logout ${shellQuote(name)}`,
    },
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    shortName: "AGY",
    format: "json",
    accent: "#3b82f6",
    cliHints: {
      list: () => "agy mcp list",
      oauth: () => "agy",
      oauthBrowser: () => "agy",
      logout: (name) => `agy mcp disable ${shellQuote(name)}`,
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    shortName: "OpenCode",
    format: "json",
    accent: "#10b981",
    cliHints: {
      list: () => "opencode mcp list",
      oauth: (name) => `opencode mcp auth ${shellQuote(name)}`,
      oauthBrowser: (name) => `opencode mcp auth ${shellQuote(name)}`,
      logout: (name) => `opencode mcp logout ${shellQuote(name)}`,
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    shortName: "Codex",
    format: "toml",
    accent: "#6366f1",
    cliHints: {
      list: () => "codex mcp list",
      oauth: (name) => `codex mcp login ${shellQuote(name)}`,
      oauthBrowser: (name) => `codex mcp login ${shellQuote(name)}`,
      logout: (name) => `codex mcp logout ${shellQuote(name)}`,
    },
  },
};

const MAX_BACKUPS = 40;
const VALID_SERVER_NAME_RE = /^[A-Za-z0-9._:@/-]{1,128}$/u;

function shellQuote(arg) {
  return /^[A-Za-z0-9._:/-]+$/u.test(arg) ? arg : JSON.stringify(arg);
}

export function validateServerName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || !VALID_SERVER_NAME_RE.test(trimmed)) {
    throw new Error(
      "Server name must be 1-128 characters using letters, digits, '.', '_', '-', ':', '@', or '/'",
    );
  }
  return trimmed;
}

function normalizeStringMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).trim();
    if (key && v !== undefined && v !== null) {
      out[key] = String(v);
    }
  }
  return out;
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => String(item)).filter((item) => item.length > 0);
}

export function normalizeServerInput(input) {
  const name = validateServerName(input?.name);
  const transport = input?.transport === "http" || input?.transport === "sse" ? input.transport : "stdio";
  const enabled = input?.enabled !== false;

  if (transport === "http" || transport === "sse") {
    const url = String(input?.url ?? "").trim();
    if (!url) throw new Error("Remote MCP server requires a URL");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Remote MCP URL must use http:// or https://");
    }
    return {
      name,
      transport,
      url: parsed.href,
      headers: normalizeStringMap(input?.headers),
      bearerTokenEnvVar:
        typeof input?.bearerTokenEnvVar === "string" && input.bearerTokenEnvVar.trim()
          ? input.bearerTokenEnvVar.trim()
          : undefined,
      enabled,
    };
  }

  const command = String(input?.command ?? "").trim();
  if (!command) throw new Error("Stdio MCP server requires a command");
  return {
    name,
    transport: "stdio",
    command,
    args: normalizeStringArray(input?.args),
    env: normalizeStringMap(input?.env),
    enabled,
  };
}

function stripJsonComments(raw) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,\s*([}\]])/gu, "$1");
}

function parseJsonFlexible(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw));
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteUtf8(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.mcp-hub-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    // Windows can occasionally throw EPERM/EBUSY on atomic replace if another reader has a handle.
    if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EXDEV")) {
      await writeFile(filePath, content, "utf8");
      await unlink(tmpPath).catch(() => {});
      return;
    }
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function resolveTilde(p, homeDir) {
  if (!p) return p;
  if (p === "~") return homeDir;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homeDir, p.slice(2));
  }
  return p;
}

/**
 * Resolve each harness's native config file path, honoring optional user overrides.
 */
export async function resolveHarnessConfigPaths({ homeDir = os.homedir(), overrides = {} } = {}) {
  const claude = overrides.claudeConfigPath
    ? resolveTilde(String(overrides.claudeConfigPath).trim(), homeDir)
    : path.join(homeDir, ".claude.json");

  const antigravity = overrides.antigravityConfigPath
    ? resolveTilde(String(overrides.antigravityConfigPath).trim(), homeDir)
    : path.join(homeDir, ".gemini", "config", "mcp_config.json");

  let opencode;
  if (overrides.opencodeConfigPath) {
    opencode = resolveTilde(String(overrides.opencodeConfigPath).trim(), homeDir);
  } else {
    const candidates = [
      path.join(homeDir, ".config", "opencode", "opencode.json"),
      path.join(homeDir, ".config", "opencode", "opencode.jsonc"),
      path.join(homeDir, ".opencode", "opencode.json"),
    ];
    opencode = candidates[0];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        opencode = candidate;
        break;
      }
    }
  }

  const codex = overrides.codexConfigPath
    ? resolveTilde(String(overrides.codexConfigPath).trim(), homeDir)
    : path.join(homeDir, ".codex", "config.toml");

  return {
    "claude-code": claude,
    antigravity,
    opencode,
    codex,
  };
}

// ---------------------------------------------------------------------------
// Per-harness normalization (Native <-> Canonical)
// ---------------------------------------------------------------------------

function decodeClaudeEntry(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (url || raw.type === "http" || raw.type === "sse") {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url,
      headers: normalizeStringMap(raw.headers),
      enabled: true,
    };
  }
  return {
    name,
    transport: "stdio",
    command: typeof raw.command === "string" ? raw.command : "",
    args: normalizeStringArray(raw.args),
    env: normalizeStringMap(raw.env),
    enabled: true,
  };
}

function encodeClaudeEntry(server, previousRaw = {}) {
  const preserved = { ...previousRaw };
  delete preserved.command;
  delete preserved.args;
  delete preserved.env;
  delete preserved.url;
  delete preserved.headers;
  delete preserved.type;

  if (server.transport === "http" || server.transport === "sse") {
    return {
      ...preserved,
      type: server.transport,
      url: server.url,
      ...(Object.keys(server.headers ?? {}).length > 0 ? { headers: server.headers } : {}),
    };
  }
  return {
    ...preserved,
    type: "stdio",
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(Object.keys(server.env ?? {}).length > 0 ? { env: server.env } : {}),
  };
}

function decodeAntigravityEntry(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const enabled = raw.disabled !== true && raw.enabled !== false;
  const url =
    typeof raw.url === "string"
      ? raw.url.trim()
      : typeof raw.serverUrl === "string"
        ? raw.serverUrl.trim()
        : "";
  if (url) {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url,
      headers: normalizeStringMap(raw.headers),
      enabled,
    };
  }
  return {
    name,
    transport: "stdio",
    command: typeof raw.command === "string" ? raw.command : "",
    args: normalizeStringArray(raw.args),
    env: normalizeStringMap(raw.env),
    enabled,
  };
}

function encodeAntigravityEntry(server, previousRaw = {}) {
  const preserved = { ...previousRaw };
  delete preserved.command;
  delete preserved.args;
  delete preserved.env;
  delete preserved.url;
  delete preserved.serverUrl;
  delete preserved.headers;
  delete preserved.disabled;
  delete preserved.enabled;

  const disabledField = server.enabled === false ? { disabled: true } : {};

  if (server.transport === "http" || server.transport === "sse") {
    // Preserve `serverUrl` only if the existing entry exclusively used `serverUrl`; otherwise emit `url`.
    const useLegacyServerUrl =
      Object.hasOwn(previousRaw, "serverUrl") && !Object.hasOwn(previousRaw, "url");
    return {
      ...preserved,
      ...(useLegacyServerUrl ? { serverUrl: server.url } : { url: server.url }),
      ...(Object.keys(server.headers ?? {}).length > 0 ? { headers: server.headers } : {}),
      ...disabledField,
    };
  }
  return {
    ...preserved,
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(Object.keys(server.env ?? {}).length > 0 ? { env: server.env } : {}),
    ...disabledField,
  };
}

function decodeOpenCodeEntry(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const enabled = raw.enabled !== false;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (raw.type === "remote" || url) {
    return {
      name,
      transport: "http",
      url,
      headers: normalizeStringMap(raw.headers),
      enabled,
    };
  }
  let command = "";
  let args = [];
  if (Array.isArray(raw.command) && raw.command.length > 0) {
    command = String(raw.command[0]);
    args = raw.command.slice(1).map((a) => String(a));
  } else if (typeof raw.command === "string") {
    command = raw.command;
    args = normalizeStringArray(raw.args);
  }
  return {
    name,
    transport: "stdio",
    command,
    args,
    env: normalizeStringMap(raw.environment ?? raw.env),
    enabled,
  };
}

function encodeOpenCodeEntry(server, previousRaw = {}) {
  const preserved = { ...previousRaw };
  delete preserved.type;
  delete preserved.command;
  delete preserved.args;
  delete preserved.environment;
  delete preserved.env;
  delete preserved.url;
  delete preserved.headers;
  delete preserved.enabled;

  if (server.transport === "http" || server.transport === "sse") {
    return {
      ...preserved,
      type: "remote",
      url: server.url,
      ...(Object.keys(server.headers ?? {}).length > 0 ? { headers: server.headers } : {}),
      enabled: server.enabled !== false,
    };
  }
  return {
    ...preserved,
    type: "local",
    command: [server.command, ...(server.args ?? [])],
    ...(Object.keys(server.env ?? {}).length > 0 ? { environment: server.env } : {}),
    enabled: server.enabled !== false,
  };
}

function decodeCodexEntry(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const enabled = raw.enabled !== false;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (url) {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url,
      headers: normalizeStringMap(raw.http_headers ?? raw.headers),
      bearerTokenEnvVar:
        typeof raw.bearer_token_env_var === "string" ? raw.bearer_token_env_var : undefined,
      enabled,
    };
  }
  return {
    name,
    transport: "stdio",
    command: typeof raw.command === "string" ? raw.command : "",
    args: normalizeStringArray(raw.args),
    env: normalizeStringMap(raw.env),
    enabled,
  };
}

function encodeCodexEntry(server, previousRaw = {}) {
  const preserved = { ...previousRaw };
  delete preserved.type;
  delete preserved.command;
  delete preserved.args;
  delete preserved.env;
  delete preserved.url;
  delete preserved.http_headers;
  delete preserved.headers;
  delete preserved.bearer_token_env_var;
  delete preserved.enabled;

  if (server.transport === "http" || server.transport === "sse") {
    return {
      ...preserved,
      url: server.url,
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      ...(server.enabled === false ? { enabled: false } : {}),
      ...(Object.keys(server.headers ?? {}).length > 0 ? { http_headers: server.headers } : {}),
    };
  }
  return {
    ...preserved,
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.enabled === false ? { enabled: false } : {}),
    ...(Object.keys(server.env ?? {}).length > 0 ? { env: server.env } : {}),
  };
}

// ---------------------------------------------------------------------------
// Backup & Claude Stash store (in ctx.dataDir)
// ---------------------------------------------------------------------------

export class McpConfigStore {
  constructor({ dataDir, homeDir = os.homedir(), getOverrides = async () => ({}) }) {
    this.dataDir = dataDir;
    this.homeDir = homeDir;
    this.getOverrides = getOverrides;
    this.backupsDir = path.join(dataDir, "backups");
    this.stashPath = path.join(dataDir, "claude-disabled-stash.json");
  }

  async #readStash() {
    try {
      const raw = await readFile(this.stashPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async #writeStash(stash) {
    await atomicWriteUtf8(this.stashPath, JSON.stringify(stash, null, 2) + "\n");
  }

  async #createBackup(harnessId, configPath, originalRaw, reason) {
    if (originalRaw === null) return null;
    await mkdir(this.backupsDir, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    const id = `${stamp}_${harnessId}`;
    const meta = {
      id,
      harnessId,
      configPath,
      reason,
      createdAt: now.toISOString(),
      sizeBytes: Buffer.byteLength(originalRaw, "utf8"),
      content: originalRaw,
    };
    await atomicWriteUtf8(path.join(this.backupsDir, `${id}.json`), JSON.stringify(meta));
    await this.#pruneBackups();
    return {
      id: meta.id,
      harnessId: meta.harnessId,
      configPath: meta.configPath,
      reason: meta.reason,
      createdAt: meta.createdAt,
      sizeBytes: meta.sizeBytes,
    };
  }

  async #pruneBackups() {
    try {
      const entries = (await readdir(this.backupsDir))
        .filter((name) => name.endsWith(".json"))
        .sort();
      if (entries.length <= MAX_BACKUPS) return;
      const toDelete = entries.slice(0, entries.length - MAX_BACKUPS);
      for (const file of toDelete) {
        await unlink(path.join(this.backupsDir, file)).catch(() => {});
      }
    } catch {
      // Non-fatal backup pruning error.
    }
  }

  async listBackups() {
    try {
      const entries = (await readdir(this.backupsDir))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .reverse();
      const result = [];
      for (const file of entries.slice(0, MAX_BACKUPS)) {
        try {
          const parsed = JSON.parse(await readFile(path.join(this.backupsDir, file), "utf8"));
          result.push({
            id: parsed.id,
            harnessId: parsed.harnessId,
            configPath: parsed.configPath,
            reason: parsed.reason,
            createdAt: parsed.createdAt,
            sizeBytes: parsed.sizeBytes,
          });
        } catch {
          // Skip malformed backup file.
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  async restoreBackup(backupId) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(String(backupId ?? ""))) {
      throw new Error("Invalid backup ID");
    }
    const filePath = path.join(this.backupsDir, `${backupId}.json`);
    const backup = JSON.parse(await readFile(filePath, "utf8"));
    const paths = await this.#resolvePaths();
    const targetPath = paths[backup.harnessId];
    if (!targetPath) {
      throw new Error(`Unknown harness in backup: ${backup.harnessId}`);
    }
    // Snapshot current file before restoring so restore itself is reversible!
    const currentRaw = await readFile(targetPath, "utf8").catch(() => null);
    if (currentRaw !== null) {
      await this.#createBackup(backup.harnessId, targetPath, currentRaw, `pre-restore:${backupId}`);
    }
    await atomicWriteUtf8(targetPath, backup.content);
    return { restored: true, harnessId: backup.harnessId, configPath: targetPath };
  }

  async #resolvePaths() {
    const overrides = (await this.getOverrides().catch(() => ({}))) ?? {};
    return resolveHarnessConfigPaths({ homeDir: this.homeDir, overrides });
  }

  async readHarness(harnessId) {
    const paths = await this.#resolvePaths();
    const configPath = paths[harnessId];
    if (!configPath) throw new Error(`Unsupported harness: ${harnessId}`);

    let raw = null;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        const stashed = harnessId === "claude-code" ? await this.#readStash() : {};
        const servers = {};
        for (const [name, entry] of Object.entries(stashed)) {
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = { ...decoded, enabled: false };
        }
        return {
          harnessId,
          configPath,
          exists: false,
          parseError: null,
          servers,
        };
      }
      return {
        harnessId,
        configPath,
        exists: true,
        parseError: error instanceof Error ? error.message : String(error),
        servers: {},
      };
    }

    try {
      if (harnessId === "codex") {
        const parsed = parseCodexMcpToml(raw);
        const servers = {};
        for (const [name, entry] of Object.entries(parsed.servers)) {
          const decoded = decodeCodexEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
        return { harnessId, configPath, exists: true, parseError: null, servers };
      }

      const doc = raw.trim() ? parseJsonFlexible(raw) : {};
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error("Config root must be a JSON object");
      }

      const servers = {};
      if (harnessId === "claude-code") {
        const map = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
        for (const [name, entry] of Object.entries(map)) {
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
        const stashed = await this.#readStash();
        for (const [name, entry] of Object.entries(stashed)) {
          if (Object.hasOwn(servers, name)) continue;
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = { ...decoded, enabled: false };
        }
      } else if (harnessId === "antigravity") {
        const map = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
        for (const [name, entry] of Object.entries(map)) {
          const decoded = decodeAntigravityEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
      } else if (harnessId === "opencode") {
        const map = doc.mcp && typeof doc.mcp === "object" ? doc.mcp : {};
        for (const [name, entry] of Object.entries(map)) {
          const decoded = decodeOpenCodeEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
      }

      return { harnessId, configPath, exists: true, parseError: null, servers };
    } catch (error) {
      return {
        harnessId,
        configPath,
        exists: true,
        parseError: error instanceof Error ? error.message : String(error),
        servers: {},
      };
    }
  }

  async upsertServer(serverInput, targets) {
    const server = normalizeServerInput(serverInput);
    const validTargets = (Array.isArray(targets) ? targets : HARNESS_IDS).filter((id) =>
      HARNESS_IDS.includes(id),
    );
    if (validTargets.length === 0) {
      throw new Error("Select at least one target harness");
    }

    const paths = await this.#resolvePaths();
    const results = [];

    for (const harnessId of validTargets) {
      const configPath = paths[harnessId];
      const existingRaw = await readFile(configPath, "utf8").catch(() => null);
      await this.#createBackup(harnessId, configPath, existingRaw, `upsert:${server.name}`);

      if (harnessId === "codex") {
        const content = existingRaw ?? "";
        const parsed = parseCodexMcpToml(content);
        const prev = parsed.servers[server.name] ?? {};
        const encoded = encodeCodexEntry(server, prev);
        const nextContent = patchCodexMcpToml(content, server.name, encoded);
        await atomicWriteUtf8(configPath, nextContent);
      } else if (harnessId === "claude-code") {
        const doc = existingRaw && existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
          doc.mcpServers = {};
        }
        const stash = await this.#readStash();
        const prev = doc.mcpServers[server.name] ?? stash[server.name] ?? {};
        const encoded = encodeClaudeEntry(server, prev);
        if (server.enabled === false) {
          delete doc.mcpServers[server.name];
          stash[server.name] = encoded;
          await this.#writeStash(stash);
        } else {
          doc.mcpServers[server.name] = encoded;
          if (Object.hasOwn(stash, server.name)) {
            delete stash[server.name];
            await this.#writeStash(stash);
          }
        }
        await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
      } else if (harnessId === "antigravity") {
        const doc = existingRaw && existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
          doc.mcpServers = {};
        }
        const prev = doc.mcpServers[server.name] ?? {};
        doc.mcpServers[server.name] = encodeAntigravityEntry(server, prev);
        await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
      } else if (harnessId === "opencode") {
        const doc = existingRaw && existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (!doc.mcp || typeof doc.mcp !== "object" || Array.isArray(doc.mcp)) {
          doc.mcp = {};
        }
        const prev = doc.mcp[server.name] ?? {};
        doc.mcp[server.name] = encodeOpenCodeEntry(server, prev);
        await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
      }

      results.push({ harnessId, configPath, ok: true });
    }
    return { server, results };
  }

  async deleteServer(serverName, targets) {
    const name = validateServerName(serverName);
    const validTargets = (Array.isArray(targets) ? targets : HARNESS_IDS).filter((id) =>
      HARNESS_IDS.includes(id),
    );
    const paths = await this.#resolvePaths();
    const results = [];

    for (const harnessId of validTargets) {
      const configPath = paths[harnessId];
      const existingRaw = await readFile(configPath, "utf8").catch(() => null);
      if (existingRaw === null && harnessId !== "claude-code") {
        results.push({ harnessId, removed: false });
        continue;
      }

      let changed = false;
      if (harnessId === "codex" && existingRaw !== null) {
        const parsed = parseCodexMcpToml(existingRaw);
        if (Object.hasOwn(parsed.servers, name)) {
          await this.#createBackup(harnessId, configPath, existingRaw, `delete:${name}`);
          const nextContent = patchCodexMcpToml(existingRaw, name, null);
          await atomicWriteUtf8(configPath, nextContent);
          changed = true;
        }
      } else if (harnessId === "claude-code") {
        const stash = await this.#readStash();
        if (Object.hasOwn(stash, name)) {
          delete stash[name];
          await this.#writeStash(stash);
          changed = true;
        }
        if (existingRaw !== null) {
          const doc = existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
          if (doc.mcpServers && Object.hasOwn(doc.mcpServers, name)) {
            await this.#createBackup(harnessId, configPath, existingRaw, `delete:${name}`);
            delete doc.mcpServers[name];
            await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
            changed = true;
          }
        }
      } else if (harnessId === "antigravity" && existingRaw !== null) {
        const doc = existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (doc.mcpServers && Object.hasOwn(doc.mcpServers, name)) {
          await this.#createBackup(harnessId, configPath, existingRaw, `delete:${name}`);
          delete doc.mcpServers[name];
          await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
          changed = true;
        }
      } else if (harnessId === "opencode" && existingRaw !== null) {
        const doc = existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (doc.mcp && Object.hasOwn(doc.mcp, name)) {
          await this.#createBackup(harnessId, configPath, existingRaw, `delete:${name}`);
          delete doc.mcp[name];
          await atomicWriteUtf8(configPath, JSON.stringify(doc, null, 2) + "\n");
          changed = true;
        }
      }

      results.push({ harnessId, removed: changed });
    }
    return { name, results };
  }

  async toggleServer(serverName, harnessId, enabled) {
    const name = validateServerName(serverName);
    if (!HARNESS_IDS.includes(harnessId)) {
      throw new Error(`Unsupported harness: ${harnessId}`);
    }
    const state = await this.readHarness(harnessId);
    const current = state.servers[name];
    if (!current) {
      throw new Error(`Server "${name}" is not configured in ${harnessId}`);
    }
    return this.upsertServer({ ...current, enabled: Boolean(enabled) }, [harnessId]);
  }

  async syncServer(serverName, sourceHarnessId, targetHarnessIds) {
    const name = validateServerName(serverName);
    if (!HARNESS_IDS.includes(sourceHarnessId)) {
      throw new Error(`Unsupported source harness: ${sourceHarnessId}`);
    }
    const source = await this.readHarness(sourceHarnessId);
    const entry = source.servers[name];
    if (!entry) {
      throw new Error(`Server "${name}" not found in ${sourceHarnessId}`);
    }
    const targets = (targetHarnessIds ?? HARNESS_IDS).filter(
      (id) => HARNESS_IDS.includes(id) && id !== sourceHarnessId,
    );
    if (targets.length === 0) {
      throw new Error("No valid target harnesses to sync to");
    }
    return this.upsertServer(entry, targets);
  }

  async syncAllFromHarness(sourceHarnessId, targetHarnessIds) {
    if (!HARNESS_IDS.includes(sourceHarnessId)) {
      throw new Error(`Unsupported source harness: ${sourceHarnessId}`);
    }
    const source = await this.readHarness(sourceHarnessId);
    const targets = (targetHarnessIds ?? HARNESS_IDS).filter(
      (id) => HARNESS_IDS.includes(id) && id !== sourceHarnessId,
    );
    if (targets.length === 0) {
      throw new Error("No valid target harnesses to sync to");
    }
    const synced = [];
    for (const server of Object.values(source.servers)) {
      await this.upsertServer(server, targets);
      synced.push(server.name);
    }
    return { sourceHarnessId, targets, synced };
  }

  async buildOverview() {
    const snapshots = await Promise.all(HARNESS_IDS.map((id) => this.readHarness(id)));
    const harnesses = snapshots.map((snap) => {
      const list = Object.values(snap.servers);
      return {
        id: snap.harnessId,
        name: HARNESS_META[snap.harnessId].name,
        shortName: HARNESS_META[snap.harnessId].shortName,
        format: HARNESS_META[snap.harnessId].format,
        accent: HARNESS_META[snap.harnessId].accent,
        configPath: snap.configPath,
        exists: snap.exists,
        parseError: snap.parseError,
        totalCount: list.length,
        enabledCount: list.filter((s) => s.enabled).length,
      };
    });

    // Build unified cross-harness matrix keyed by server name.
    const byName = new Map();
    for (const snap of snapshots) {
      for (const [name, entry] of Object.entries(snap.servers)) {
        if (!byName.has(name)) {
          byName.set(name, {
            name,
            primary: entry,
            primaryHarnessId: snap.harnessId,
            instances: {},
          });
        }
        const group = byName.get(name);
        group.instances[snap.harnessId] = entry;
      }
    }

    const servers = [...byName.values()]
      .map((group) => {
        const fingerprints = new Set(
          Object.values(group.instances).map((e) => serverFingerprint(e)),
        );
        const cliHints = {};
        for (const hid of HARNESS_IDS) {
          cliHints[hid] = {
            list: HARNESS_META[hid].cliHints.list(group.name),
            oauth: HARNESS_META[hid].cliHints.oauth(group.name),
            oauthBrowser: HARNESS_META[hid].cliHints.oauthBrowser(group.name),
            logout: HARNESS_META[hid].cliHints.logout(group.name),
          };
        }
        return {
          name: group.name,
          transport: group.primary.transport,
          url: group.primary.url ?? null,
          command: group.primary.command ?? null,
          args: group.primary.args ?? [],
          env: group.primary.env ?? {},
          headers: group.primary.headers ?? {},
          bearerTokenEnvVar: group.primary.bearerTokenEnvVar ?? null,
          primaryHarnessId: group.primaryHarnessId,
          hasDrift: fingerprints.size > 1,
          harnessCount: Object.keys(group.instances).length,
          instances: group.instances,
          cliHints,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));

    const backups = await this.listBackups();
    return { harnesses, servers, backups };
  }

  async exportStandardJson(harnessId = null) {
    const overview = await this.buildOverview();
    const mcpServers = {};
    for (const item of overview.servers) {
      const source = harnessId ? item.instances[harnessId] : item.instances[item.primaryHarnessId];
      if (!source) continue;
      if (source.transport === "http" || source.transport === "sse") {
        mcpServers[item.name] = {
          type: source.transport,
          url: source.url,
          ...(Object.keys(source.headers ?? {}).length > 0 ? { headers: source.headers } : {}),
        };
      } else {
        mcpServers[item.name] = {
          command: source.command,
          ...(source.args?.length ? { args: source.args } : {}),
          ...(Object.keys(source.env ?? {}).length > 0 ? { env: source.env } : {}),
        };
      }
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }
}

function serverFingerprint(entry) {
  if (entry.transport === "http" || entry.transport === "sse") {
    return JSON.stringify({
      t: entry.transport,
      u: entry.url,
      h: Object.keys(entry.headers ?? {}).sort(),
    });
  }
  return JSON.stringify({
    t: "stdio",
    c: entry.command,
    a: entry.args ?? [],
    e: Object.keys(entry.env ?? {}).sort(),
  });
}
