/**
 * High-performance four-harness native MCP & plugin configuration engine.
 *
 * Performance & reliability design:
 * - `stat()` `(mtimeMs, size)` cache per config file: warm reads do 0 disk reads and 0 JSON/TOML parses.
 * - Separated backup index (`backups/index.json`) & raw payloads (`backups/<id>.dat`):
 *   listing backups never loads full config snapshots into memory.
 * - Per-harness serialized write queue: concurrent pill clicks never race or corrupt configs.
 * - Lossless preservation: unknown JSON keys and Codex TOML comments/sections stay intact.
 * - Discovers Global MCPs, Claude project-scoped MCPs, and Antigravity/Claude native plugins.
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCodexMcpToml, patchCodexMcpToml, renderCodexMcpServerBlock } from "./toml.mjs";

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
  const transport =
    input?.transport === "http" || input?.transport === "sse" ? input.transport : "stdio";
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
    const bearer =
      typeof input?.bearerTokenEnvVar === "string" && input.bearerTokenEnvVar.trim()
        ? input.bearerTokenEnvVar.trim()
        : null;
    return {
      name,
      transport,
      url: parsed.href,
      headers: normalizeStringMap(input?.headers),
      ...(bearer ? { bearerTokenEnvVar: bearer } : {}),
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
  return out.replace(/,\s*([}\]])/gu, "$1");
}

function parseJsonFlexible(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw));
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

let atomicWriteSeq = 0;

async function atomicWriteUtf8(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  atomicWriteSeq += 1;
  const tmpPath = `${filePath}.mcp-hub-${process.pid}-${Date.now()}-${atomicWriteSeq}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
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
    const checks = await Promise.all(candidates.map((c) => pathExists(c)));
    const foundIdx = checks.findIndex(Boolean);
    opencode = foundIdx >= 0 ? candidates[foundIdx] : candidates[0];
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
// Per-harness codecs (Native <-> Canonical)
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
      ...(typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var
        ? { bearerTokenEnvVar: raw.bearer_token_env_var }
        : {}),
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

/**
 * Preview exact serialized native configuration snippets for each target harness
 * without touching disk.
 */
export function renderNativePreviews(serverInput, targets = HARNESS_IDS) {
  const server = normalizeServerInput(serverInput);
  const validTargets = (Array.isArray(targets) ? targets : HARNESS_IDS).filter((id) =>
    HARNESS_IDS.includes(id),
  );
  const previews = {};
  for (const hid of validTargets) {
    if (hid === "claude-code") {
      previews[hid] = {
        format: "json",
        snippet: JSON.stringify({ mcpServers: { [server.name]: encodeClaudeEntry(server) } }, null, 2),
      };
    } else if (hid === "antigravity") {
      previews[hid] = {
        format: "json",
        snippet: JSON.stringify(
          { mcpServers: { [server.name]: encodeAntigravityEntry(server) } },
          null,
          2,
        ),
      };
    } else if (hid === "opencode") {
      previews[hid] = {
        format: "json",
        snippet: JSON.stringify({ mcp: { [server.name]: encodeOpenCodeEntry(server) } }, null, 2),
      };
    } else if (hid === "codex") {
      previews[hid] = {
        format: "toml",
        snippet: renderCodexMcpServerBlock(server.name, encodeCodexEntry(server)),
      };
    }
  }
  return previews;
}

/**
 * Compute structured field-level differences across harnesses for one MCP server.
 */
export function computeServerDrift(instances) {
  const entries = Object.entries(instances);
  if (entries.length <= 1) return { hasDrift: false, fields: [] };

  const fields = [];
  const checkField = (field, getter) => {
    const byHarness = {};
    const distinct = new Set();
    for (const [hid, inst] of entries) {
      const val = getter(inst);
      byHarness[hid] = val;
      distinct.add(JSON.stringify(val));
    }
    if (distinct.size > 1) {
      fields.push({ field, values: byHarness });
    }
  };

  checkField("transport", (e) => e.transport);
  checkField("url", (e) => e.url ?? "");
  checkField("command", (e) => e.command ?? "");
  checkField("args", (e) => e.args ?? []);
  checkField("headers", (e) => Object.keys(e.headers ?? {}).sort());
  checkField("env", (e) => Object.keys(e.env ?? {}).sort());

  return { hasDrift: fields.length > 0, fields };
}

// ---------------------------------------------------------------------------
// Projected stat-cached file reader:
// - Stores ONLY the small projected result (drops giant raw text & unused JSON subtrees
//   like Claude project histories so RAM stays tiny even with multi-MB configs).
// - Zero disk reads and zero JSON/TOML parses when (mtimeMs, size) is unchanged.
// ---------------------------------------------------------------------------

class StatFileCache {
  #entries = new Map();

  async readParsed(filePath, projector) {
    let info;
    try {
      info = await stat(filePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.#entries.delete(filePath);
        return { exists: false, parsed: null, parseError: null, cacheHit: false, sig: "missing" };
      }
      return {
        exists: true,
        parsed: null,
        parseError: error instanceof Error ? error.message : String(error),
        cacheHit: false,
        sig: `err:${Date.now()}`,
      };
    }

    const sig = `${info.mtimeMs}:${info.size}`;
    const cached = this.#entries.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return {
        exists: true,
        parsed: cached.parsed,
        parseError: cached.parseError,
        cacheHit: true,
        sig,
      };
    }

    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      return {
        exists: true,
        parsed: null,
        parseError: error instanceof Error ? error.message : String(error),
        cacheHit: false,
        sig: `readerr:${Date.now()}`,
      };
    }

    let parsed = null;
    let parseError = null;
    try {
      parsed = projector(raw);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    this.#entries.set(filePath, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      parsed,
      parseError,
    });

    return { exists: true, parsed, parseError, cacheHit: false, sig };
  }

  invalidate(filePath) {
    this.#entries.delete(filePath);
  }

  clear() {
    this.#entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Main McpConfigStore
// ---------------------------------------------------------------------------

export class McpConfigStore {
  #fileCache = new StatFileCache();
  #writeQueues = new Map();
  #backupIndexCache = null;
  #backupVersion = 0;
  #overviewMemo = null; // { sig, payload }

  constructor({ dataDir, homeDir = os.homedir(), getOverrides = async () => ({}) }) {
    this.dataDir = dataDir;
    this.homeDir = homeDir;
    this.getOverrides = getOverrides;
    this.backupsDir = path.join(dataDir, "backups");
    this.backupIndexPath = path.join(this.backupsDir, "index.json");
    this.stashPath = path.join(dataDir, "claude-disabled-stash.json");
  }

  #enqueue(key, task) {
    const prev = this.#writeQueues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const cleanup = next.finally(() => {
      if (this.#writeQueues.get(key) === cleanup) {
        this.#writeQueues.delete(key);
      }
    });
    this.#writeQueues.set(key, cleanup);
    return next;
  }

  async #readStash() {
    const res = await this.#fileCache.readParsed(this.stashPath, (raw) =>
      raw.trim() ? JSON.parse(raw) : {},
    );
    if (!res.exists || res.parseError || !res.parsed || typeof res.parsed !== "object" || Array.isArray(res.parsed)) {
      return {};
    }
    return { ...res.parsed };
  }

  async #writeStash(stash) {
    await atomicWriteUtf8(this.stashPath, JSON.stringify(stash, null, 2) + "\n");
    this.#fileCache.invalidate(this.stashPath);
  }

  // Separated lightweight backup index (`backups/index.json`) + raw payload (`backups/<id>.dat`).
  async #loadBackupIndex() {
    if (this.#backupIndexCache !== null) return this.#backupIndexCache;
    try {
      const raw = await readFile(this.backupIndexPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.#backupIndexCache = parsed;
        return parsed;
      }
    } catch {
      // Fall back to migrating any legacy v1.0.0 `*.json` backup files once.
    }

    const migrated = [];
    try {
      const entries = (await readdir(this.backupsDir))
        .filter((name) => name.endsWith(".json") && name !== "index.json")
        .sort()
        .reverse();
      for (const file of entries.slice(0, MAX_BACKUPS)) {
        try {
          const full = JSON.parse(await readFile(path.join(this.backupsDir, file), "utf8"));
          if (!full?.id || typeof full.content !== "string") continue;
          await atomicWriteUtf8(path.join(this.backupsDir, `${full.id}.dat`), full.content);
          migrated.push({
            id: full.id,
            harnessId: full.harnessId,
            configPath: full.configPath,
            reason: full.reason,
            createdAt: full.createdAt,
            sizeBytes: full.sizeBytes ?? Buffer.byteLength(full.content, "utf8"),
          });
          await unlink(path.join(this.backupsDir, file)).catch(() => {});
        } catch {
          // Ignore corrupted legacy backup.
        }
      }
      if (migrated.length > 0) {
        await atomicWriteUtf8(this.backupIndexPath, JSON.stringify(migrated, null, 2) + "\n");
      }
    } catch {
      // backupsDir doesn't exist yet.
    }
    this.#backupIndexCache = migrated;
    return migrated;
  }

  async #createBackup(harnessId, configPath, originalRaw, reason) {
    if (originalRaw === null) return null;
    return this.#enqueue("__backups__", async () => {
      await mkdir(this.backupsDir, { recursive: true });
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/gu, "-");
      const rand = Math.random().toString(36).slice(2, 6);
      const id = `${stamp}_${rand}_${harnessId}`;
      const meta = {
        id,
        harnessId,
        configPath,
        reason,
        createdAt: now.toISOString(),
        sizeBytes: Buffer.byteLength(originalRaw, "utf8"),
      };

      await atomicWriteUtf8(path.join(this.backupsDir, `${id}.dat`), originalRaw);
      const index = [meta, ...(await this.#loadBackupIndex())];
      const removed = index.splice(MAX_BACKUPS);
      this.#backupIndexCache = index;
      this.#backupVersion += 1;
      this.#overviewMemo = null;
      await atomicWriteUtf8(this.backupIndexPath, JSON.stringify(index, null, 2) + "\n");
      for (const old of removed) {
        await unlink(path.join(this.backupsDir, `${old.id}.dat`)).catch(() => {});
      }
      return meta;
    });
  }

  async listBackups() {
    const index = await this.#loadBackupIndex();
    return [...index];
  }

  async restoreBackup(backupId) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(String(backupId ?? ""))) {
      throw new Error("Invalid backup ID");
    }
    const index = await this.#loadBackupIndex();
    const meta = index.find((item) => item.id === backupId);
    if (!meta) throw new Error(`Backup snapshot "${backupId}" not found`);

    const content = await readFile(path.join(this.backupsDir, `${backupId}.dat`), "utf8");
    const targetPath = meta.configPath;
    return this.#enqueue(meta.harnessId, async () => {
      const currentRaw = await readFile(targetPath, "utf8").catch(() => null);
      if (currentRaw !== null) {
        await this.#createBackup(meta.harnessId, targetPath, currentRaw, `pre-restore:${backupId}`);
      }
      await atomicWriteUtf8(targetPath, content);
      this.#fileCache.invalidate(targetPath);
      return { restored: true, harnessId: meta.harnessId, configPath: targetPath };
    });
  }

  async #resolvePaths() {
    const overrides = (await this.getOverrides().catch(() => ({}))) ?? {};
    return resolveHarnessConfigPaths({ homeDir: this.homeDir, overrides });
  }

  async readHarness(harnessId, preResolvedPaths = null) {
    const paths = preResolvedPaths ?? (await this.#resolvePaths());
    const configPath = paths[harnessId];
    if (!configPath) throw new Error(`Unsupported harness: ${harnessId}`);

    if (harnessId === "codex") {
      const file = await this.#fileCache.readParsed(configPath, (raw) => {
        const parsed = parseCodexMcpToml(raw);
        const servers = {};
        for (const [name, entry] of Object.entries(parsed.servers ?? {})) {
          const decoded = decodeCodexEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
        return servers;
      });
      if (!file.exists) {
        return { harnessId, configPath, exists: false, parseError: null, servers: {}, cacheHit: false, sig: `codex:${configPath}:missing` };
      }
      if (file.parseError) {
        return { harnessId, configPath, exists: true, parseError: file.parseError, servers: {}, cacheHit: file.cacheHit, sig: `codex:${configPath}:${file.sig}` };
      }
      return {
        harnessId,
        configPath,
        exists: true,
        parseError: null,
        servers: file.parsed ?? {},
        cacheHit: file.cacheHit,
        sig: `codex:${configPath}:${file.sig}`,
      };
    }

    // Project ONLY the MCP entries into cache (drops multi-MB unrelated fields like Claude project histories).
    const file = await this.#fileCache.readParsed(configPath, (raw) => {
      const doc = raw.trim() ? parseJsonFlexible(raw) : {};
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error("Config root must be a JSON object");
      }
      const servers = {};
      const projectServers = [];
      if (harnessId === "claude-code") {
        const map = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
        for (const [name, entry] of Object.entries(map)) {
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = decoded;
        }
        if (doc.projects && typeof doc.projects === "object") {
          for (const [projectPath, projCfg] of Object.entries(doc.projects)) {
            const pMap = projCfg?.mcpServers;
            if (!pMap || typeof pMap !== "object") continue;
            for (const [name, entry] of Object.entries(pMap)) {
              const decoded = decodeClaudeEntry(name, entry);
              if (decoded) {
                projectServers.push({
                  ...decoded,
                  harnessId: "claude-code",
                  scope: "project",
                  scopeLabel: projectPath,
                });
              }
            }
          }
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
      return { servers, projectServers };
    });

    if (!file.exists) {
      const servers = {};
      let stashSig = "";
      if (harnessId === "claude-code") {
        const stashRes = await this.#fileCache.readParsed(this.stashPath, (raw) =>
          raw.trim() ? JSON.parse(raw) : {},
        );
        stashSig = stashRes.sig;
        const stashed =
          stashRes.exists && !stashRes.parseError && stashRes.parsed && typeof stashRes.parsed === "object"
            ? stashRes.parsed
            : {};
        for (const [name, entry] of Object.entries(stashed)) {
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = { ...decoded, enabled: false };
        }
      }
      return {
        harnessId,
        configPath,
        exists: false,
        parseError: null,
        servers,
        projectServers: [],
        cacheHit: false,
        sig: `${harnessId}:${configPath}:missing:${stashSig}`,
      };
    }

    if (file.parseError) {
      return {
        harnessId,
        configPath,
        exists: true,
        parseError: file.parseError,
        servers: {},
        projectServers: [],
        cacheHit: file.cacheHit,
        sig: `${harnessId}:${configPath}:${file.sig}`,
      };
    }

    let servers = file.parsed?.servers ?? {};
    const projectServers = file.parsed?.projectServers ?? [];
    let stashSig = "";

    if (harnessId === "claude-code") {
      const stashRes = await this.#fileCache.readParsed(this.stashPath, (raw) =>
        raw.trim() ? JSON.parse(raw) : {},
      );
      stashSig = stashRes.sig;
      const stashed =
        stashRes.exists && !stashRes.parseError && stashRes.parsed && typeof stashRes.parsed === "object"
          ? stashRes.parsed
          : null;
      if (stashed && Object.keys(stashed).length > 0) {
        servers = { ...servers };
        for (const [name, entry] of Object.entries(stashed)) {
          if (Object.hasOwn(servers, name)) continue;
          const decoded = decodeClaudeEntry(name, entry);
          if (decoded) servers[name] = { ...decoded, enabled: false };
        }
      }
    }

    return {
      harnessId,
      configPath,
      exists: true,
      parseError: null,
      servers,
      projectServers,
      cacheHit: file.cacheHit,
      sig: `${harnessId}:${configPath}:${file.sig}:${stashSig}`,
    };
  }

  /**
   * Discover native plugins & plugin-bundled MCP servers for Antigravity and Claude Code
   * (zero subprocess spawning; pure stat-cached file inspection).
   */
  async readNativePlugins() {
    const plugins = [];
    const pluginMcpServers = [];
    const sigParts = [];

    // 1. Antigravity plugins (`~/.gemini/config/plugins/<id>` + `~/.gemini/config/config.json`)
    const agyConfigPath = path.join(this.homeDir, ".gemini", "config", "config.json");
    const agyPluginsDir = path.join(this.homeDir, ".gemini", "config", "plugins");
    const agyCfgRes = await this.#fileCache.readParsed(agyConfigPath, (raw) => {
      const doc = raw.trim() ? parseJsonFlexible(raw) : {};
      return doc?.plugins && typeof doc.plugins === "object" ? doc.plugins : {};
    });
    sigParts.push(`agycfg:${agyCfgRes.sig}`);
    const agyPluginState = agyCfgRes.parsed ?? {};

    try {
      const entries = await readdir(agyPluginsDir, { withFileTypes: true });
      const dirNames = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
      sigParts.push(`agydirs:${dirNames.join(",")}`);
      await Promise.all(
        dirNames.map(async (dirName) => {
          const pluginDir = path.join(agyPluginsDir, dirName);
          const [manifestRes, mcpRes] = await Promise.all([
            this.#fileCache.readParsed(path.join(pluginDir, "plugin.json"), (raw) => {
              const doc = JSON.parse(raw);
              return { name: doc?.name || dirName, disabled: doc?.disabled === true };
            }),
            this.#fileCache.readParsed(path.join(pluginDir, "mcp_config.json"), (raw) => {
              const doc = raw.trim() ? parseJsonFlexible(raw) : {};
              const out = [];
              for (const [sName, sRaw] of Object.entries(doc?.mcpServers ?? {})) {
                const decoded = decodeAntigravityEntry(sName, sRaw);
                if (decoded) out.push(decoded);
              }
              return out;
            }),
          ]);
          sigParts.push(`${dirName}:${manifestRes.sig}:${mcpRes.sig}`);
          const defaultDisabled = manifestRes.parsed?.disabled === true;
          const override = agyPluginState[dirName];
          const enabled =
            typeof override?.enabled === "boolean" ? override.enabled : !defaultDisabled;

          const bundledServers = [];
          for (const decoded of mcpRes.parsed ?? []) {
            bundledServers.push(decoded.name);
            pluginMcpServers.push({
              ...decoded,
              enabled: enabled && decoded.enabled,
              harnessId: "antigravity",
              scope: "plugin",
              scopeLabel: dirName,
            });
          }

          plugins.push({
            id: dirName,
            name: manifestRes.parsed?.name || dirName,
            harnessId: "antigravity",
            enabled,
            bundledMcps: bundledServers,
            configPath: agyConfigPath,
          });
        }),
      );
    } catch {
      sigParts.push("agydirs:missing");
    }

    // 2. Claude Code enabledPlugins (`~/.claude/settings.json`)
    const claudeSettingsPath = path.join(this.homeDir, ".claude", "settings.json");
    const claudeSettingsRes = await this.#fileCache.readParsed(claudeSettingsPath, (raw) => {
      const doc = raw.trim() ? parseJsonFlexible(raw) : {};
      return doc?.enabledPlugins && typeof doc.enabledPlugins === "object" && !Array.isArray(doc.enabledPlugins)
        ? doc.enabledPlugins
        : {};
    });
    sigParts.push(`claudesettings:${claudeSettingsRes.sig}`);
    for (const [pluginKey, isEnabled] of Object.entries(claudeSettingsRes.parsed ?? {})) {
      if (typeof isEnabled !== "boolean") continue;
      plugins.push({
        id: pluginKey,
        name: pluginKey.split("@")[0] || pluginKey,
        harnessId: "claude-code",
        enabled: isEnabled,
        bundledMcps: [],
        configPath: claudeSettingsPath,
      });
    }

    plugins.sort((a, b) => a.name.localeCompare(b.name, "en"));
    pluginMcpServers.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { plugins, pluginMcpServers, sig: sigParts.join("|") };
  }

  async toggleNativePlugin(harnessId, pluginId, enabled) {
    const id = String(pluginId ?? "").trim();
    if (!id) throw new Error("Invalid plugin ID");

    if (harnessId === "antigravity") {
      const cfgPath = path.join(this.homeDir, ".gemini", "config", "config.json");
      return this.#enqueue("plugin:antigravity", async () => {
        const existingRaw = await readFile(cfgPath, "utf8").catch(() => null);
        await this.#createBackup("antigravity", cfgPath, existingRaw, `plugin-toggle:${id}`);
        const doc = existingRaw && existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (!doc.plugins || typeof doc.plugins !== "object" || Array.isArray(doc.plugins)) {
          doc.plugins = {};
        }
        doc.plugins[id] = { ...(doc.plugins[id] ?? {}), enabled: Boolean(enabled) };
        await atomicWriteUtf8(cfgPath, JSON.stringify(doc, null, 2) + "\n");
        this.#fileCache.invalidate(cfgPath);
        return { harnessId, pluginId: id, enabled: Boolean(enabled) };
      });
    }

    if (harnessId === "claude-code") {
      const cfgPath = path.join(this.homeDir, ".claude", "settings.json");
      return this.#enqueue("plugin:claude-code", async () => {
        const existingRaw = await readFile(cfgPath, "utf8").catch(() => null);
        await this.#createBackup("claude-code", cfgPath, existingRaw, `plugin-toggle:${id}`);
        const doc = existingRaw && existingRaw.trim() ? parseJsonFlexible(existingRaw) : {};
        if (!doc.enabledPlugins || typeof doc.enabledPlugins !== "object" || Array.isArray(doc.enabledPlugins)) {
          doc.enabledPlugins = {};
        }
        doc.enabledPlugins[id] = Boolean(enabled);
        await atomicWriteUtf8(cfgPath, JSON.stringify(doc, null, 2) + "\n");
        this.#fileCache.invalidate(cfgPath);
        return { harnessId, pluginId: id, enabled: Boolean(enabled) };
      });
    }

    throw new Error(`Native plugin toggle is not supported for harness "${harnessId}"`);
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
    const results = await Promise.all(
      validTargets.map((harnessId) =>
        this.#enqueue(harnessId, async () => {
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

          this.#fileCache.invalidate(configPath);
          return { harnessId, configPath, ok: true };
        }),
      ),
    );
    return { server, results };
  }

  async deleteServer(serverName, targets) {
    const name = validateServerName(serverName);
    const validTargets = (Array.isArray(targets) ? targets : HARNESS_IDS).filter((id) =>
      HARNESS_IDS.includes(id),
    );
    const paths = await this.#resolvePaths();

    const results = await Promise.all(
      validTargets.map((harnessId) =>
        this.#enqueue(harnessId, async () => {
          const configPath = paths[harnessId];
          const existingRaw = await readFile(configPath, "utf8").catch(() => null);
          if (existingRaw === null && harnessId !== "claude-code") {
            return { harnessId, removed: false };
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

          if (changed) this.#fileCache.invalidate(configPath);
          return { harnessId, removed: changed };
        }),
      ),
    );
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

  async buildOverview({ includeBackups = true } = {}) {
    const t0 = performance.now();
    // Single-pass path resolution avoids 4x redundant opencode candidate stat probes.
    const paths = await this.#resolvePaths();
    const [snapshots, nativePlugins, backups] = await Promise.all([
      Promise.all(HARNESS_IDS.map((id) => this.readHarness(id, paths))),
      this.readNativePlugins(),
      includeBackups ? this.listBackups() : Promise.resolve(null),
    ]);

    const cacheHits = snapshots.filter((s) => s.cacheHit).length;
    const memoSig = `${snapshots.map((s) => s.sig).join("|")}::${nativePlugins.sig}::${
      includeBackups ? `b${this.#backupVersion}:${backups?.length ?? 0}` : "nobkp"
    }`;

    if (this.#overviewMemo && this.#overviewMemo.sig === memoSig) {
      return {
        ...this.#overviewMemo.payload,
        perf: {
          readMs: Math.round((performance.now() - t0) * 100) / 100,
          cacheHits,
          harnessTotal: snapshots.length,
        },
      };
    }

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

    const byName = new Map();
    const scopedEntries = [...nativePlugins.pluginMcpServers];

    for (const snap of snapshots) {
      if (Array.isArray(snap.projectServers)) {
        scopedEntries.push(...snap.projectServers);
      }
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
        const drift = computeServerDrift(group.instances);
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
          hasDrift: drift.hasDrift,
          driftFields: drift.fields,
          harnessCount: Object.keys(group.instances).length,
          instances: group.instances,
          cliHints,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));

    const payload = {
      harnesses,
      servers,
      scopedServers: scopedEntries,
      nativePlugins: nativePlugins.plugins,
      ...(backups !== null ? { backups } : {}),
    };
    this.#overviewMemo = { sig: memoSig, payload };

    return {
      ...payload,
      perf: {
        readMs: Math.round((performance.now() - t0) * 100) / 100,
        cacheHits,
        harnessTotal: snapshots.length,
      },
    };
  }

  async exportStandardJson(harnessId = null) {
    const overview = await this.buildOverview({ includeBackups: false });
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
