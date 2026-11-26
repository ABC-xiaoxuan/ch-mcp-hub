/**
 * Pure-Node MCP diagnostics and live connectivity probe (no subprocess spawning).
 *
 * Performance features:
 * - 60s TTL in-memory probe result cache keyed by server fingerprint (instant tab re-open).
 * - 30s TTL PATH executable lookup cache (avoids redundant filesystem scans across Stdio servers).
 * - Bounded concurrency pool (`probeAllServers`, concurrency=4) for batch probing without event-loop spikes.
 */

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const PROBE_CACHE_TTL_MS = 60_000;
const PATH_CACHE_TTL_MS = 30_000;

const probeCache = new Map();
const execCache = new Map();

function serverCacheKey(server) {
  if (server.transport === "http" || server.transport === "sse" || server.url) {
    return `r:${server.url ?? ""}:${Object.keys(server.headers ?? {}).sort().join(",")}:${Boolean(server.headers?.Authorization)}`;
  }
  return `s:${server.command ?? ""}`;
}

export function getCachedProbes(servers) {
  const now = Date.now();
  const out = {};
  for (const s of servers ?? []) {
    const key = serverCacheKey(s);
    const hit = probeCache.get(key);
    if (hit && now - hit.at < PROBE_CACHE_TTL_MS) {
      out[s.name] = { ...hit.data, cached: true, probedAt: hit.at };
    }
  }
  return out;
}

export function clearProbeCache() {
  probeCache.clear();
  execCache.clear();
}

function parseWwwAuthenticate(headerValue) {
  if (!headerValue) return {};
  const result = {};
  const re = /([a-zA-Z0-9_-]+)="([^"]*)"/gu;
  let match;
  while ((match = re.exec(headerValue)) !== null) {
    result[match[1].toLowerCase()] = match[2];
  }
  return result;
}

async function fetchJsonSafe(url, timeoutMs = 5_000) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function discoverOAuthMetadata(mcpUrl, wwwAuthenticateHeader = "") {
  const parsedUrl = new URL(mcpUrl);
  const origin = parsedUrl.origin;
  const authParams = parseWwwAuthenticate(wwwAuthenticateHeader);

  const resourceMetadataCandidates = [];
  if (authParams.resource_metadata) {
    resourceMetadataCandidates.push(authParams.resource_metadata);
  }
  const pathSuffix = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname.replace(/\/+$/u, "");
  if (pathSuffix) {
    resourceMetadataCandidates.push(`${origin}/.well-known/oauth-protected-resource${pathSuffix}`);
  }
  resourceMetadataCandidates.push(`${origin}/.well-known/oauth-protected-resource`);

  let protectedResource = null;
  let protectedResourceUrl = null;
  for (const candidate of resourceMetadataCandidates) {
    const doc = await fetchJsonSafe(candidate);
    if (doc && typeof doc === "object") {
      protectedResource = doc;
      protectedResourceUrl = candidate;
      break;
    }
  }

  const authServerOrigin =
    Array.isArray(protectedResource?.authorization_servers) &&
    typeof protectedResource.authorization_servers[0] === "string"
      ? protectedResource.authorization_servers[0].replace(/\/+$/u, "")
      : origin;

  const authMetaCandidates = [
    `${authServerOrigin}/.well-known/oauth-authorization-server`,
    `${authServerOrigin}/.well-known/openid-configuration`,
  ];
  let authServer = null;
  for (const candidate of authMetaCandidates) {
    const doc = await fetchJsonSafe(candidate);
    if (doc && typeof doc === "object" && typeof doc.authorization_endpoint === "string") {
      authServer = doc;
      break;
    }
  }

  return {
    discovered: Boolean(authServer?.authorization_endpoint),
    resourceMetadataUrl: protectedResourceUrl,
    resource: protectedResource?.resource ?? mcpUrl,
    issuer: authServer?.issuer ?? authServerOrigin,
    authorizationEndpoint: authServer?.authorization_endpoint ?? null,
    tokenEndpoint: authServer?.token_endpoint ?? null,
    registrationEndpoint: authServer?.registration_endpoint ?? null,
    supportsDynamicRegistration: Boolean(authServer?.registration_endpoint),
    supportsPkceS256:
      !Array.isArray(authServer?.code_challenge_methods_supported) ||
      authServer.code_challenge_methods_supported.includes("S256"),
    scopesSupported:
      protectedResource?.scopes_supported ?? authServer?.scopes_supported ?? [],
    rawScopeHint: authParams.scope ?? null,
  };
}

function summarizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const fields = Object.entries(props)
    .slice(0, 24)
    .map(([name, def]) => ({
      name,
      type:
        typeof def?.type === "string"
          ? def.type
          : Array.isArray(def?.type)
            ? def.type.join("|")
            : "any",
      required: required.includes(name),
      description: typeof def?.description === "string" ? def.description.slice(0, 140) : "",
    }));
  return { fields, required };
}

function parseJsonRpcResponse(text, contentType) {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    const messages = [];
    const blocks = text.split(/\r?\n\r?\n/u);
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/u)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) continue;
      try {
        messages.push(JSON.parse(dataLines.join("\n")));
      } catch {
        // Ignore non-JSON SSE control events.
      }
    }
    return messages.find((m) => m && (Object.hasOwn(m, "result") || Object.hasOwn(m, "error"))) ?? null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function probeRemoteServer(server) {
  const startedAt = Date.now();
  const url = server.url;
  if (!url) {
    return { status: "error", latencyMs: 0, message: "Missing remote MCP URL" };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { status: "error", latencyMs: 0, message: "URL must start with http:// or https://" };
    }
  } catch {
    return { status: "error", latencyMs: 0, message: "Invalid remote MCP URL" };
  }

  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };

  try {
    const initResponse = await fetch(parsedUrl.href, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codexhost-mcp-hub", version: "1.1.0" },
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - startedAt;

    if (initResponse.status === 401 || initResponse.status === 403) {
      const wwwAuth = initResponse.headers.get("www-authenticate") ?? "";
      const oauth = await discoverOAuthMetadata(parsedUrl.href, wwwAuth);
      return {
        status: "auth_required",
        httpStatus: initResponse.status,
        latencyMs,
        message: `Authentication required (HTTP ${initResponse.status})`,
        oauth,
      };
    }

    if (!initResponse.ok) {
      const snippet = (await initResponse.text().catch(() => "")).slice(0, 240);
      return {
        status: "error",
        httpStatus: initResponse.status,
        latencyMs,
        message: `HTTP ${initResponse.status}${snippet ? `: ${snippet}` : ""}`,
      };
    }

    const sessionId = initResponse.headers.get("mcp-session-id");
    const initText = await initResponse.text();
    const initRpc = parseJsonRpcResponse(initText, initResponse.headers.get("content-type"));
    if (!initRpc || initRpc.error) {
      return {
        status: "error",
        httpStatus: initResponse.status,
        latencyMs,
        message: initRpc?.error?.message ?? "Server did not return a valid MCP initialize response",
      };
    }

    const serverInfo = initRpc.result?.serverInfo ?? null;
    const protocolVersion = initRpc.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

    const sessionHeaders = {
      ...baseHeaders,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    await fetch(parsedUrl.href, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(3_500),
    }).catch(() => {});

    let tools = [];
    try {
      const toolsRes = await fetch(parsedUrl.href, {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (toolsRes.ok) {
        const toolsRpc = parseJsonRpcResponse(
          await toolsRes.text(),
          toolsRes.headers.get("content-type"),
        );
        if (Array.isArray(toolsRpc?.result?.tools)) {
          tools = toolsRpc.result.tools.slice(0, 120).map((t) => ({
            name: String(t.name ?? ""),
            description: typeof t.description === "string" ? t.description.slice(0, 240) : "",
            inputSchema: summarizeInputSchema(t.inputSchema),
          }));
        }
      }
    } catch {
      // Optional tools listing.
    }

    return {
      status: "ok",
      httpStatus: initResponse.status,
      latencyMs,
      protocolVersion,
      serverInfo: serverInfo
        ? {
            name: String(serverInfo.name ?? ""),
            ...(typeof serverInfo.version === "string" ? { version: serverInfo.version } : {}),
          }
        : null,
      tools,
      toolCount: tools.length,
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function isRunnableFile(candidate, platform) {
  try {
    await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

async function resolveExecutableOnPath(command, env = process.env, platform = process.platform) {
  if (!command) return null;
  const cached = execCache.get(command);
  if (cached && Date.now() - cached.at < PATH_CACHE_TTL_MS) {
    return cached.resolved;
  }

  const hasSeparator = command.includes("/") || command.includes("\\") || path.isAbsolute(command);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const extList =
    platform === "win32" && path.extname(command) === ""
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  let found = null;
  if (hasSeparator) {
    for (const ext of extList) {
      const candidate = command + ext;
      if (await isRunnableFile(candidate, platform)) {
        found = path.resolve(candidate);
        break;
      }
    }
  } else {
    const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
    outer: for (const dir of dirs) {
      for (const ext of extList) {
        const candidate = path.join(dir, command + ext);
        if (await isRunnableFile(candidate, platform)) {
          found = path.resolve(candidate);
          break outer;
        }
      }
    }
  }

  execCache.set(command, { resolved: found, at: Date.now() });
  return found;
}

async function probeStdioServer(server) {
  const startedAt = Date.now();
  const command = typeof server.command === "string" ? server.command.trim() : "";
  if (!command) {
    return { status: "error", latencyMs: 0, message: "Missing stdio command" };
  }
  const resolved = await resolveExecutableOnPath(command);
  const latencyMs = Date.now() - startedAt;
  if (!resolved) {
    return {
      status: "error",
      latencyMs,
      message: `Executable "${command}" was not found on PATH`,
    };
  }
  return {
    status: "ok",
    latencyMs,
    resolvedCommand: resolved,
    message: `Executable found at ${resolved}`,
  };
}

export async function probeMcpServer(server, { force = true } = {}) {
  if (!server || typeof server !== "object") {
    return { status: "error", latencyMs: 0, message: "Invalid server payload" };
  }
  const key = serverCacheKey(server);
  if (!force) {
    const hit = probeCache.get(key);
    if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) {
      return { ...hit.data, cached: true, probedAt: hit.at };
    }
  }
  const data =
    server.transport === "http" || server.transport === "sse" || server.url
      ? await probeRemoteServer(server)
      : await probeStdioServer(server);
  const now = Date.now();
  probeCache.set(key, { data, at: now });
  return { ...data, cached: false, probedAt: now };
}

/**
 * Probe multiple servers with bounded concurrency (default 4).
 */
export async function probeAllServers(servers, { concurrency = 4, force = true } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const results = {};
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      const item = list[idx];
      if (!item?.name) continue;
      results[item.name] = await probeMcpServer(item, { force });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/**
 * Execute a live Streamable HTTP MCP `tools/call` invocation for interactive testing
 * inside the Tool Playground drawer (pure Node fetch, 15s timeout, 64KB response cap).
 */
export async function callMcpTool(server, toolName, toolArgs = {}) {
  const startedAt = Date.now();
  const url = String(server?.url ?? "").trim();
  const name = String(toolName ?? "").trim();
  if (!url) {
    return { ok: false, latencyMs: 0, isError: true, errorMessage: "Tool runner requires a remote HTTP/SSE MCP URL", rawText: "", truncated: false };
  }
  if (!name) {
    return { ok: false, latencyMs: 0, isError: true, errorMessage: "Tool name is required", rawText: "", truncated: false };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("URL must use http:// or https://");
    }
  } catch (err) {
    return { ok: false, latencyMs: 0, isError: true, errorMessage: err instanceof Error ? err.message : "Invalid URL", rawText: "", truncated: false };
  }

  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };

  try {
    const initRes = await fetch(parsedUrl.href, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codexhost-mcp-hub", version: "1.2.0" },
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!initRes.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        isError: true,
        errorMessage: `MCP initialize failed (HTTP ${initRes.status})`,
        rawText: "",
        truncated: false,
      };
    }

    const sessionId = initRes.headers.get("mcp-session-id");
    await initRes.text().catch(() => "");
    const sessionHeaders = {
      ...baseHeaders,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };

    await fetch(parsedUrl.href, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});

    const callRes = await fetch(parsedUrl.href, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name,
          arguments: toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs) ? toolArgs : {},
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - startedAt;
    const bodyText = await callRes.text();
    if (!callRes.ok) {
      return {
        ok: false,
        latencyMs,
        isError: true,
        errorMessage: `HTTP ${callRes.status}: ${bodyText.slice(0, 240)}`,
        rawText: "",
        truncated: false,
      };
    }

    const rpc = parseJsonRpcResponse(bodyText, callRes.headers.get("content-type"));
    if (!rpc) {
      return {
        ok: false,
        latencyMs,
        isError: true,
        errorMessage: "Server did not return a valid JSON-RPC response",
        rawText: bodyText.slice(0, 2000),
        truncated: bodyText.length > 2000,
      };
    }
    if (rpc.error) {
      return {
        ok: false,
        latencyMs,
        isError: true,
        errorMessage: rpc.error.message || JSON.stringify(rpc.error),
        rawText: "",
        truncated: false,
      };
    }

    const result = rpc.result ?? {};
    const contentItems = Array.isArray(result.content) ? result.content : [];
    const textParts = [];
    for (const item of contentItems) {
      if (item && typeof item === "object") {
        if (typeof item.text === "string") textParts.push(item.text);
        else textParts.push(JSON.stringify(item, null, 2));
      }
    }
    const formatted =
      textParts.length > 0 ? textParts.join("\n\n") : JSON.stringify(result, null, 2);
    const truncated = formatted.length > MAX_TOOL_OUTPUT_CHARS;

    return {
      ok: !result.isError,
      latencyMs,
      isError: Boolean(result.isError),
      errorMessage: result.isError ? "Tool returned an error response" : "",
      rawText: truncated ? formatted.slice(0, MAX_TOOL_OUTPUT_CHARS) : formatted,
      truncated,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
      rawText: "",
      truncated: false,
    };
  }
}
