import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import { McpConfigStore } from "../backend/adapters.mjs";
import { activate } from "../backend/index.mjs";
import { parseImportedMcpJson } from "../backend/presets.mjs";
import { probeMcpServer } from "../backend/probe.mjs";
import { parseCodexMcpToml, patchCodexMcpToml } from "../backend/toml.mjs";

describe("Codex surgical TOML parser & patcher", () => {
  it("preserves unrelated sections, inline comments, and nested sub-tables", () => {
    const sample = [
      '# Top user comment',
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.pencil]",
      'command = "pencil-mcp"',
      'args = ["--stdio"]',
      "",
      "[mcp_servers.node_repl]",
      'command = "node"',
      'args = ["repl.js"]',
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.node_repl.env]",
      'CODEX_HOME = "/tmp/codex"',
      "",
      "[profiles.fast]",
      'model = "gpt-5-mini"',
      "",
    ].join("\n");

    const parsed = parseCodexMcpToml(sample);
    assert.equal(parsed.servers.pencil.command, "pencil-mcp");
    assert.deepEqual(parsed.servers.pencil.args, ["--stdio"]);
    assert.equal(parsed.servers.node_repl.env.CODEX_HOME, "/tmp/codex");

    // Upsert a new remote server and verify existing comment + profiles survive untouched.
    const added = patchCodexMcpToml(sample, "notion", {
      url: "https://mcp.notion.com/mcp",
      http_headers: { Authorization: "Bearer tok" },
    });
    assert.match(added, /^# Top user comment/m);
    assert.match(added, /\[profiles\.fast\]\nmodel = "gpt-5-mini"/);
    assert.match(added, /\[mcp_servers\.notion\]/);
    assert.match(added, /\[mcp_servers\.notion\.http_headers\]/);

    const reparsed = parseCodexMcpToml(added);
    assert.equal(reparsed.servers.notion.url, "https://mcp.notion.com/mcp");
    assert.equal(reparsed.servers.notion.http_headers.Authorization, "Bearer tok");
    assert.equal(reparsed.servers.node_repl.env.CODEX_HOME, "/tmp/codex");

    // Delete node_repl (including its .env sub-table) and verify pencil & notion remain.
    const removed = patchCodexMcpToml(added, "node_repl", null);
    const afterDelete = parseCodexMcpToml(removed);
    assert.equal(afterDelete.servers.node_repl, undefined);
    assert.equal(afterDelete.servers.pencil.command, "pencil-mcp");
    assert.equal(afterDelete.servers.notion.url, "https://mcp.notion.com/mcp");
    assert.match(removed, /\[profiles\.fast\]/);
  });
});

describe("Four-harness McpConfigStore", () => {
  let tmpDir;
  let homeDir;
  let dataDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-test-"));
    homeDir = path.join(tmpDir, "home");
    dataDir = path.join(tmpDir, "data");
    await mkdir(homeDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    store = new McpConfigStore({ dataDir, homeDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("upserts, converts schemas across all 4 harnesses, preserves unrelated keys, and syncs cleanly", async () => {
    // Pre-populate unrelated fields in ~/.claude.json to verify lossless preservation.
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ numStartups: 42, mcpServers: {} }, null, 2),
      "utf8",
    );

    await store.upsertServer(
      {
        name: "playwright",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        env: { PW_HEADLESS: "1" },
        enabled: true,
      },
      ["claude-code", "antigravity", "opencode", "codex"],
    );

    // Verify Claude preserved numStartups
    const claudeRaw = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeRaw.numStartups, 42);
    assert.equal(claudeRaw.mcpServers.playwright.command, "npx");
    assert.deepEqual(claudeRaw.mcpServers.playwright.args, ["-y", "@playwright/mcp@latest"]);

    // Verify OpenCode uses command array + `environment`
    const openRaw = JSON.parse(
      await readFile(path.join(homeDir, ".config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(openRaw.mcp.playwright.type, "local");
    assert.deepEqual(openRaw.mcp.playwright.command, ["npx", "-y", "@playwright/mcp@latest"]);
    assert.equal(openRaw.mcp.playwright.environment.PW_HEADLESS, "1");
    assert.equal(openRaw.mcp.playwright.enabled, true);

    // Verify Antigravity
    const agyRaw = JSON.parse(
      await readFile(path.join(homeDir, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    assert.equal(agyRaw.mcpServers.playwright.command, "npx");

    // Verify Codex TOML
    const codexRaw = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const codexParsed = parseCodexMcpToml(codexRaw);
    assert.equal(codexParsed.servers.playwright.command, "npx");
    assert.equal(codexParsed.servers.playwright.env.PW_HEADLESS, "1");

    // Verify lossless Claude disable + re-enable via stash
    await store.toggleServer("playwright", "claude-code", false);
    const claudeDisabled = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeDisabled.mcpServers.playwright, undefined);
    const overviewMid = await store.buildOverview();
    const pwEntry = overviewMid.servers.find((s) => s.name === "playwright");
    assert.equal(pwEntry.instances["claude-code"].enabled, false);

    await store.toggleServer("playwright", "claude-code", true);
    const claudeRestored = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeRestored.mcpServers.playwright.env.PW_HEADLESS, "1");

    // Verify backups exist and restore works
    const backups = await store.listBackups();
    assert.ok(backups.length >= 2);
    const claudeBackup = backups.find((b) => b.harnessId === "claude-code");
    assert.ok(claudeBackup);
    await store.restoreBackup(claudeBackup.id);
  });

  it("syncs a remote HTTP server from Antigravity legacy serverUrl to all other harnesses", async () => {
    await mkdir(path.join(homeDir, ".gemini", "config"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { notion: { serverUrl: "https://mcp.notion.com/mcp" } } }),
      "utf8",
    );

    await store.syncServer("notion", "antigravity", ["claude-code", "opencode", "codex"]);
    const overview = await store.buildOverview();
    const notion = overview.servers.find((s) => s.name === "notion");
    assert.equal(notion.harnessCount, 4);
    assert.equal(notion.hasDrift, false);
    assert.equal(notion.instances.opencode.url, "https://mcp.notion.com/mcp");
    assert.equal(notion.instances.codex.url, "https://mcp.notion.com/mcp");
  });
});

describe("JSON import & MCP HTTP live probe", () => {
  it("parses standard mcpServers and OpenCode mcp snippets", () => {
    const a = parseImportedMcpJson(
      JSON.stringify({
        mcpServers: {
          notion: { url: "https://mcp.notion.com/mcp" },
          fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
        },
      }),
    );
    assert.equal(a.length, 2);
    assert.equal(a[0].transport, "http");
    assert.equal(a[1].transport, "stdio");

    const b = parseImportedMcpJson(
      JSON.stringify({
        mcp: {
          localTool: { type: "local", command: ["uvx", "mcp-server-git"], environment: { A: "1" } },
        },
      }),
    );
    assert.equal(b.length, 1);
    assert.equal(b[0].command, "uvx");
    assert.deepEqual(b[0].args, ["mcp-server-git"]);
    assert.equal(b[0].env.A, "1");
  });

  it("probes a Streamable HTTP MCP server (initialize + tools/list) and detects 401 OAuth", async () => {
    let requireAuth = false;
    const srv = http.createServer((req, res) => {
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: "http://127.0.0.1",
            authorization_endpoint: "http://127.0.0.1/authorize",
            token_endpoint: "http://127.0.0.1/token",
            registration_endpoint: "http://127.0.0.1/register",
          }),
        );
        return;
      }
      if (requireAuth) {
        res.writeHead(401, { "WWW-Authenticate": 'Bearer scope="mcp:read"' });
        res.end("Unauthorized");
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body);
        if (msg.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                serverInfo: { name: "mock-mcp", version: "0.1.0" },
              },
            }),
          );
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools: [{ name: "search_docs", description: "Search documents" }] },
            }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });

    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    const url = `http://127.0.0.1:${port}/mcp`;

    try {
      const okRes = await probeMcpServer({ transport: "http", url });
      assert.equal(okRes.status, "ok");
      assert.equal(okRes.serverInfo.name, "mock-mcp");
      assert.equal(okRes.toolCount, 1);
      assert.equal(okRes.tools[0].name, "search_docs");

      requireAuth = true;
      const authRes = await probeMcpServer({ transport: "http", url });
      assert.equal(authRes.status, "auth_required");
      assert.equal(authRes.oauth.discovered, true);
      assert.equal(authRes.oauth.supportsDynamicRegistration, true);
    } finally {
      srv.close();
    }
  });

  it("activates backend entrypoint and exposes all RPC handlers cleanly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-hub-act-"));
    const handlers = new Map();
    const dispose = await activate({
      extensionId: "mcp-hub",
      extensionDir: tmp,
      dataDir: tmp,
      readSettings: async () => ({
        claudeConfigPath: path.join(tmp, ".claude.json"),
        antigravityConfigPath: path.join(tmp, "mcp_config.json"),
        opencodeConfigPath: path.join(tmp, "opencode.json"),
        codexConfigPath: path.join(tmp, "config.toml"),
      }),
      writeSettings: async (v) => v,
      handle: (method, fn) => handlers.set(method, fn),
    });

    try {
      assert.ok(handlers.has("overview.get"));
      assert.ok(handlers.has("server.upsert"));
      assert.ok(handlers.has("server.sync"));
      assert.ok(handlers.has("server.probe"));
      assert.ok(handlers.has("oauth.start"));

      const overview = await handlers.get("overview.get")();
      assert.equal(overview.harnesses.length, 4);
      assert.equal(overview.servers.length, 0);
    } finally {
      await dispose();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
