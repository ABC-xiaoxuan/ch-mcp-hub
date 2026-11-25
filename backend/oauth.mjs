/**
 * Standard MCP OAuth 2.1 + PKCE (S256) + RFC 7591 Dynamic Client Registration flow manager.
 *
 * Pure Node (`node:http`, `node:crypto`, `fetch`), no subprocess spawning.
 * Supports both automatic localhost browser callback and manual redirect URL/code completion
 * (for remote `codexhost web` access where the browser runs on a different device).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { discoverOAuthMetadata } from "./probe.mjs";

const FLOW_TTL_MS = 5 * 60 * 1_000;

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function callbackHtml(ok, message) {
  const title = ok ? "Authorization Complete" : "Authorization Failed";
  const accent = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title} · MCP Hub</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #0d1117; color: #e6edf3; }
  .card { max-width: 440px; padding: 28px 32px; border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.12); background: #161b22; text-align: center; }
  .dot { width: 12px; height: 12px; border-radius: 999px; background: ${accent};
         display: inline-block; margin-right: 8px; }
  h1 { font-size: 18px; margin: 0 0 10px; display: flex; align-items: center; justify-content: center; }
  p { font-size: 14px; line-height: 1.5; color: #9da7b3; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>${title}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

export class McpOAuthManager {
  #flows = new Map();

  async startFlow({ serverName, url, scope }) {
    const metadata = await discoverOAuthMetadata(url);
    if (!metadata.discovered || !metadata.authorizationEndpoint || !metadata.tokenEndpoint) {
      throw new Error(
        "Remote MCP server did not advertise standard OAuth 2.1 endpoints (.well-known/oauth-authorization-server)",
      );
    }

    const flowId = randomUUID();
    const state = base64Url(randomBytes(24));
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

    // Bind an ephemeral loopback callback listener.
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const flow = {
      flowId,
      serverName,
      url,
      metadata,
      state,
      codeVerifier,
      redirectUri,
      clientId: null,
      clientSecret: null,
      status: "pending", // pending | completed | error | cancelled
      error: null,
      token: null,
      server,
      timer: null,
      createdAt: Date.now(),
    };

    try {
      if (!metadata.registrationEndpoint) {
        throw new Error(
          "Authorization server does not expose a Dynamic Client Registration endpoint; use the native CLI login command instead.",
        );
      }
      const regRes = await fetch(metadata.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "CodexHost MCP Hub",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!regRes.ok) {
        const text = (await regRes.text().catch(() => "")).slice(0, 200);
        throw new Error(`Dynamic client registration failed (HTTP ${regRes.status}): ${text}`);
      }
      const regData = await regRes.json();
      if (!regData?.client_id) {
        throw new Error("Dynamic client registration did not return a client_id");
      }
      flow.clientId = String(regData.client_id);
      flow.clientSecret = regData.client_secret ? String(regData.client_secret) : null;
    } catch (error) {
      server.close();
      throw error;
    }

    const authUrl = new URL(metadata.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", flow.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (metadata.resource) {
      authUrl.searchParams.set("resource", metadata.resource);
    }
    const requestedScope =
      scope ||
      metadata.rawScopeHint ||
      (Array.isArray(metadata.scopesSupported) && metadata.scopesSupported.length > 0
        ? metadata.scopesSupported.join(" ")
        : "");
    if (requestedScope) {
      authUrl.searchParams.set("scope", requestedScope);
    }

    server.on("request", (req, res) => {
      void this.#handleCallbackRequest(flow, req, res);
    });

    flow.timer = setTimeout(() => {
      if (flow.status === "pending") {
        flow.status = "error";
        flow.error = "Authorization timed out after 5 minutes";
        this.#closeServer(flow);
      }
    }, FLOW_TTL_MS);

    this.#flows.set(flowId, flow);

    return {
      flowId,
      authorizationUrl: authUrl.href,
      redirectUri,
      expiresAt: new Date(flow.createdAt + FLOW_TTL_MS).toISOString(),
    };
  }

  async #handleCallbackRequest(flow, req, res) {
    try {
      const reqUrl = new URL(req.url ?? "/", flow.redirectUri);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const errorParam = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description");
      if (errorParam) {
        flow.status = "error";
        flow.error = errorDesc ? `${errorParam}: ${errorDesc}` : errorParam;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false, flow.error));
        this.#closeServer(flow);
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      if (!code || returnedState !== flow.state) {
        flow.status = "error";
        flow.error = "Invalid OAuth callback state or missing authorization code";
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(callbackHtml(false, flow.error));
        this.#closeServer(flow);
        return;
      }
      await this.#exchangeCode(flow, code);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        callbackHtml(
          true,
          "Token received. Return to CodexHost MCP Hub to apply it to your selected harnesses.",
        ),
      );
      this.#closeServer(flow);
    } catch (error) {
      flow.status = "error";
      flow.error = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, flow.error));
      this.#closeServer(flow);
    }
  }

  async completeManual(flowId, callbackUrlOrCode) {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new Error("OAuth session not found or expired");
    if (flow.status !== "pending") return this.getStatus(flowId);

    const raw = String(callbackUrlOrCode ?? "").trim();
    if (!raw) throw new Error("Please paste the callback URL or authorization code");

    let code = raw;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const parsed = new URL(raw);
      const err = parsed.searchParams.get("error");
      if (err) {
        flow.status = "error";
        flow.error = parsed.searchParams.get("error_description") ?? err;
        this.#closeServer(flow);
        return this.getStatus(flowId);
      }
      const returnedState = parsed.searchParams.get("state");
      if (returnedState && returnedState !== flow.state) {
        throw new Error("Callback state mismatch");
      }
      code = parsed.searchParams.get("code") ?? "";
      if (!code) throw new Error("Callback URL does not contain a code parameter");
    }

    await this.#exchangeCode(flow, code);
    this.#closeServer(flow);
    return this.getStatus(flowId);
  }

  async #exchangeCode(flow, code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.codeVerifier,
    });
    if (flow.clientSecret) body.set("client_secret", flow.clientSecret);
    if (flow.metadata.resource) body.set("resource", flow.metadata.resource);

    const res = await fetch(flow.metadata.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 240);
      throw new Error(`Token exchange failed (HTTP ${res.status}): ${detail}`);
    }
    const tokenData = await res.json();
    if (!tokenData?.access_token) {
      throw new Error("Token endpoint did not return an access_token");
    }
    flow.token = {
      accessToken: String(tokenData.access_token),
      tokenType: typeof tokenData.token_type === "string" ? tokenData.token_type : "Bearer",
      expiresIn: typeof tokenData.expires_in === "number" ? tokenData.expires_in : null,
      scope: typeof tokenData.scope === "string" ? tokenData.scope : null,
    };
    flow.status = "completed";
  }

  getStatus(flowId) {
    const flow = this.#flows.get(flowId);
    if (!flow) return { status: "expired", error: "OAuth session expired" };
    return {
      flowId: flow.flowId,
      serverName: flow.serverName,
      status: flow.status,
      error: flow.error,
      hasToken: Boolean(flow.token?.accessToken),
      tokenType: flow.token?.tokenType ?? null,
      expiresIn: flow.token?.expiresIn ?? null,
      scope: flow.token?.scope ?? null,
    };
  }

  consumeToken(flowId) {
    const flow = this.#flows.get(flowId);
    if (!flow || flow.status !== "completed" || !flow.token) {
      throw new Error("OAuth flow has not completed with a token");
    }
    const token = flow.token;
    this.cancelFlow(flowId);
    return token;
  }

  cancelFlow(flowId) {
    const flow = this.#flows.get(flowId);
    if (!flow) return;
    if (flow.status === "pending") flow.status = "cancelled";
    this.#closeServer(flow);
    this.#flows.delete(flowId);
  }

  #closeServer(flow) {
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    try {
      flow.server.close();
    } catch {
      // Ignore already closed server.
    }
  }

  dispose() {
    for (const id of [...this.#flows.keys()]) {
      this.cancelFlow(id);
    }
  }
}
