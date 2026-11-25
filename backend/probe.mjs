/**
 * Pure-Node MCP diagnostics and live connectivity probe (no subprocess spawning).
 *
 * - Remote HTTP / SSE servers: sends MCP `initialize` + `tools/list` via `fetch`, parses both
 *   JSON and SSE (`text/event-stream`) responses, and discovers RFC 9728 / RFC 8414 OAuth metadata
 *   when HTTP 401/403 is returned.
 * - Stdio servers: verifies executable availability on PATH / absolute path via `node:fs/promises`
 *   without spawning any external process.
 */

import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-03-26";

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

async function fetchJsonSafe(url, timeoutMs = 6_000) {
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

  // Step 1: RFC 9728 Protected Resource Metadata
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

  // Step 2: RFC 8414 Authorization Server Metadata
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
      const joined = dataLines.join("\n");
      try {
        messages.push(JSON.parse(joined));
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
          clientInfo: { name: "codexhost-mcp-hub", version: "1.0.0" },
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

    // Best-effort initialized notification + tools/list discovery.
    const sessionHeaders = {
      ...baseHeaders,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    await fetch(parsedUrl.href, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(4_000),
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
          tools = toolsRpc.result.tools.slice(0, 100).map((t) => ({
            name: String(t.name ?? ""),
            description: typeof t.description === "string" ? t.description.slice(0, 240) : "",
          }));
        }
      }
    } catch {
      // Tools discovery is optional if initialize already succeeded.
    }

    return {
      status: "ok",
      httpStatus: initResponse.status,
      latencyMs,
      protocolVersion,
      serverInfo: serverInfo
        ? {
            name: String(serverInfo.name ?? ""),
            version: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
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
  const hasSeparator = command.includes("/") || command.includes("\\") || path.isAbsolute(command);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const extList =
    platform === "win32" && path.extname(command) === ""
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  if (hasSeparator) {
    for (const ext of extList) {
      const candidate = command + ext;
      if (await isRunnableFile(candidate, platform)) return path.resolve(candidate);
    }
    return null;
  }

  const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extList) {
      const candidate = path.join(dir, command + ext);
      if (await isRunnableFile(candidate, platform)) return path.resolve(candidate);
    }
  }
  return null;
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

export async function probeMcpServer(server) {
  if (!server || typeof server !== "object") {
    return { status: "error", latencyMs: 0, message: "Invalid server payload" };
  }
  if (server.transport === "http" || server.transport === "sse" || server.url) {
    return probeRemoteServer(server);
  }
  return probeStdioServer(server);
}
