import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  McpConfigStore,
  computeServerDrift,
  countHardcodedSecrets,
  isHardcodedSecret,
  renderNativePreviews,
} from "../backend/adapters.mjs";
import { activate } from "../backend/index.mjs";
import { parseImportedMcpJson } from "../backend/presets.mjs";
import {
  callMcpTool,
  clearProbeCache,
  getCachedProbes,
  probeAllServers,
  probeMcpServer,
} from "../backend/probe.mjs";
import { parseCodexMcpToml, patchCodexMcpToml } from "../backend/toml.mjs";
import { tokenizeCommandLine } from "../shared/ui.mjs";

describe("Codex surgical TOML parser & patcher", () => {
  it("preserves unrelated sections, inline comments, and nested sub-tables", () => {
    const sample = [
      "# Top user comment",
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

    const removed = patchCodexMcpToml(added, "node_repl", null);
    const afterDelete = parseCodexMcpToml(removed);
    assert.equal(afterDelete.servers.node_repl, undefined);
    assert.equal(afterDelete.servers.pencil.command, "pencil-mcp");
    assert.equal(afterDelete.servers.notion.url, "https://mcp.notion.com/mcp");
    assert.match(removed, /\[profiles\.fast\]/);
  });
});

describe("Four-harness McpConfigStore & Performance Engine", () => {
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
    clearProbeCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("upserts, converts schemas across all 4 harnesses, preserves unrelated keys, and syncs cleanly", async () => {
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

    const claudeRaw = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeRaw.numStartups, 42);
    assert.equal(claudeRaw.mcpServers.playwright.command, "npx");
    assert.deepEqual(claudeRaw.mcpServers.playwright.args, ["-y", "@playwright/mcp@latest"]);

    const openRaw = JSON.parse(
      await readFile(path.join(homeDir, ".config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(openRaw.mcp.playwright.type, "local");
    assert.deepEqual(openRaw.mcp.playwright.command, ["npx", "-y", "@playwright/mcp@latest"]);
    assert.equal(openRaw.mcp.playwright.environment.PW_HEADLESS, "1");
    assert.equal(openRaw.mcp.playwright.enabled, true);

    const agyRaw = JSON.parse(
      await readFile(path.join(homeDir, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    assert.equal(agyRaw.mcpServers.playwright.command, "npx");

    const codexRaw = await readFile(path.join(homeDir, ".codex", "config.toml"), "utf8");
    const codexParsed = parseCodexMcpToml(codexRaw);
    assert.equal(codexParsed.servers.playwright.command, "npx");
    assert.equal(codexParsed.servers.playwright.env.PW_HEADLESS, "1");

    await store.toggleServer("playwright", "claude-code", false);
    const claudeDisabled = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeDisabled.mcpServers.playwright, undefined);
    const overviewMid = await store.buildOverview();
    const pwEntry = overviewMid.servers.find((s) => s.name === "playwright");
    assert.equal(pwEntry.instances["claude-code"].enabled, false);

    await store.toggleServer("playwright", "claude-code", true);
    const claudeRestored = JSON.parse(await readFile(path.join(homeDir, ".claude.json"), "utf8"));
    assert.equal(claudeRestored.mcpServers.playwright.env.PW_HEADLESS, "1");

    // Verify separated backup index + .dat payload storage & restore
    const backupFiles = await readdir(path.join(dataDir, "backups"));
    assert.ok(backupFiles.includes("index.json"));
    assert.ok(backupFiles.some((f) => f.endsWith(".dat")));

    const backups = await store.listBackups();
    assert.ok(backups.length >= 2);
    const claudeBackup = backups.find((b) => b.harnessId === "claude-code");
    assert.ok(claudeBackup);
    await store.restoreBackup(claudeBackup.id);
  });

  it("achieves 4/4 StatFileCache hits on warm buildOverview even with large configs", async () => {
    // Seed a realistic large ~/.claude.json (~250 KB) + 3 other harness configs.
    const bigProjects = {};
    for (let i = 0; i < 60; i += 1) {
      bigProjects[`/workspace/repo-${i}`] = {
        history: Array.from({ length: 20 }, (_, j) => `entry-${i}-${j}-${"x".repeat(80)}`),
        mcpServers:
          i === 0 ? { "local-db": { command: "uvx", args: ["mcp-server-sqlite", "dev.db"] } } : {},
      };
    }
    await writeFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } }, projects: bigProjects }),
      "utf8",
    );
    await store.syncServer("notion", "claude-code", ["antigravity", "opencode", "codex"]);

    // Cold read populates stat cache
    const cold = await store.buildOverview();
    assert.equal(cold.perf.harnessTotal, 4);
    assert.equal(cold.scopedServers.length, 1);
    assert.equal(cold.scopedServers[0].name, "local-db");
    assert.equal(cold.scopedServers[0].scope, "project");

    // Warm reads hit 4/4 stat cache without re-reading or re-parsing the 250KB file
    const warm1 = await store.buildOverview();
    assert.equal(warm1.perf.cacheHits, 4);
    assert.ok(warm1.perf.readMs < 50, `Expected fast warm read (<50ms), got ${warm1.perf.readMs}ms`);

    // Multiple warm reads average sub-5ms
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const ov = await store.buildOverview();
      assert.equal(ov.perf.cacheHits, 4);
    }
    const avgMs = (performance.now() - t0) / 20;
    assert.ok(avgMs < 15, `Expected avg warm read <15ms, got ${avgMs.toFixed(2)}ms`);
  });

  it("migrates legacy v1.0.0 single-file JSON backups into index.json + .dat", async () => {
    const backupsDir = path.join(dataDir, "backups");
    await mkdir(backupsDir, { recursive: true });
    const targetCfg = path.join(homeDir, ".claude.json");
    await writeFile(targetCfg, JSON.stringify({ mcpServers: { newer: { url: "https://example.com" } } }), "utf8");

    const legacyId = "2026-01-01T00-00-00-000Z_claude-code";
    const legacyContent = JSON.stringify({ mcpServers: { restored: { url: "https://old.example.com" } } });
    await writeFile(
      path.join(backupsDir, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        harnessId: "claude-code",
        configPath: targetCfg,
        reason: "legacy-test",
        createdAt: "2026-01-01T00:00:00.000Z",
        sizeBytes: Buffer.byteLength(legacyContent, "utf8"),
        content: legacyContent,
      }),
      "utf8",
    );

    const list = await store.listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, legacyId);
    const files = await readdir(backupsDir);
    assert.ok(files.includes("index.json"));
    assert.ok(files.includes(`${legacyId}.dat`));
    assert.ok(!files.includes(`${legacyId}.json`));

    await store.restoreBackup(legacyId);
    const restored = JSON.parse(await readFile(targetCfg, "utf8"));
    assert.equal(restored.mcpServers.restored.url, "https://old.example.com");
  });

  it("serializes concurrent writes to the same harness without corruption", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `srv-${i}`);
    await Promise.all(
      names.map((name) =>
        store.upsertServer(
          {
            name,
            transport: "http",
            url: `https://mcp.example.com/${name}`,
            enabled: true,
          },
          ["claude-code", "codex"],
        ),
      ),
    );

    const overview = await store.buildOverview();
    assert.equal(overview.servers.length, 10);
    const claudeH = overview.harnesses.find((h) => h.id === "claude-code");
    const codexH = overview.harnesses.find((h) => h.id === "codex");
    assert.equal(claudeH.totalCount, 10);
    assert.equal(codexH.totalCount, 10);
  });

  it("discovers & toggles native plugins for Antigravity and Claude Code", async () => {
    const agyPluginDir = path.join(homeDir, ".gemini", "config", "plugins", "notion");
    await mkdir(agyPluginDir, { recursive: true });
    await writeFile(
      path.join(agyPluginDir, "plugin.json"),
      JSON.stringify({ name: "Notion Official" }),
      "utf8",
    );
    await writeFile(
      path.join(agyPluginDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { notion: { serverUrl: "https://mcp.notion.com/mcp" } } }),
      "utf8",
    );
    await mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "context7@claude-plugins-official": true } }),
      "utf8",
    );

    const ov1 = await store.buildOverview();
    assert.equal(ov1.nativePlugins.length, 2);
    assert.equal(ov1.scopedServers.length, 1);
    assert.equal(ov1.scopedServers[0].scope, "plugin");

    await store.toggleNativePlugin("antigravity", "notion", false);
    await store.toggleNativePlugin("claude-code", "context7@claude-plugins-official", false);

    const ov2 = await store.buildOverview();
    const agyP = ov2.nativePlugins.find((p) => p.harnessId === "antigravity" && p.id === "notion");
    const claudeP = ov2.nativePlugins.find((p) => p.harnessId === "claude-code");
    assert.equal(agyP.enabled, false);
    assert.equal(claudeP.enabled, false);
  });

  it("renders native JSON/TOML previews and computes field-level drift", () => {
    const previews = renderNativePreviews(
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
    assert.equal(previews["claude-code"].format, "json");
    assert.match(previews["claude-code"].snippet, /"mcpServers"/);
    assert.equal(previews.opencode.format, "json");
    assert.match(previews.opencode.snippet, /"environment"/);
    assert.equal(previews.codex.format, "toml");
    assert.match(previews.codex.snippet, /\[mcp_servers\.playwright\]/);

    const drift = computeServerDrift({
      "claude-code": { transport: "http", url: "https://a.example.com/mcp", headers: { Authorization: "x" } },
      codex: { transport: "http", url: "https://b.example.com/mcp", headers: {} },
    });
    assert.equal(drift.hasDrift, true);
    const fieldNames = drift.fields.map((f) => f.field);
    assert.ok(fieldNames.includes("url"));
    assert.ok(fieldNames.includes("headers"));
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

  it("detects hardcoded secrets, redacts exports by default, previews backups, and executes batch ops", async () => {
    assert.equal(isHardcodedSecret("Authorization", "Bearer sk-1234567890"), true);
    assert.equal(isHardcodedSecret("Authorization", "Bearer ${NOTION_TOKEN}"), false);
    assert.equal(isHardcodedSecret("GITHUB_TOKEN", "ghp_abcdef123456789"), true);
    assert.equal(isHardcodedSecret("PW_HEADLESS", "1"), false);

    await store.upsertServer(
      {
        name: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_supersecret123456" },
        enabled: true,
      },
      ["claude-code"],
    );
    await store.upsertServer(
      {
        name: "context7",
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        enabled: true,
      },
      ["claude-code"],
    );

    const ov = await store.buildOverview({ includeBackups: false });
    assert.equal(ov.backups, undefined);
    assert.equal(typeof ov.backupCount, "number");
    const gh = ov.servers.find((s) => s.name === "github");
    assert.equal(gh.secretCount, 1);
    assert.equal(countHardcodedSecrets(gh.instances), 1);

    // Safe redacted export by default
    const redacted = await store.exportStandardJson(null, { redactSecrets: true });
    assert.match(redacted, /Bearer <REDACTED>/);
    assert.doesNotMatch(redacted, /ghp_supersecret123456/);

    // Explicit unredacted export preserves raw token
    const rawExport = await store.exportStandardJson(null, { redactSecrets: false });
    assert.match(rawExport, /ghp_supersecret123456/);

    // Batch sync -> batch disable -> backup preview -> batch delete
    await store.batchSync(["github", "context7"], ["antigravity", "codex"]);
    const afterSync = await store.buildOverview({ includeBackups: false });
    assert.equal(afterSync.servers.find((s) => s.name === "github").harnessCount, 3);

    await store.batchToggle(["github", "context7"], false);
    const afterDisable = await store.buildOverview({ includeBackups: false });
    assert.equal(afterDisable.servers.find((s) => s.name === "context7").instances.codex.enabled, false);

    const backups = await store.listBackups();
    assert.ok(backups.length >= 1);
    const preview = await store.previewBackup(backups[0].id);
    assert.equal(preview.id, backups[0].id);
    assert.equal(typeof preview.content, "string");
    assert.ok(preview.content.length > 0);

    await store.batchDelete(["github", "context7"], ["claude-code", "antigravity", "opencode", "codex"]);
    const afterDel = await store.buildOverview({ includeBackups: false });
    assert.equal(afterDel.servers.length, 0);
  });
});

describe("Command tokenizer, JSON import, MCP HTTP live probe & bounded batch probe", () => {
  afterEach(() => {
    clearProbeCache();
  });

  it("tokenizes single-line Stdio commands preserving quoted args and Windows paths", () => {
    assert.deepEqual(tokenizeCommandLine("npx -y @playwright/mcp@latest --headless"), [
      "npx",
      "-y",
      "@playwright/mcp@latest",
      "--headless",
    ]);
    assert.deepEqual(tokenizeCommandLine('node "C:\\Program Files\\mcp\\server.js" --flag=\'a b\''), [
      "node",
      "C:\\Program Files\\mcp\\server.js",
      "--flag=a b",
    ]);
  });

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

  it("probes Streamable HTTP MCP, caches results with TTL, detects 401 OAuth, and enforces batch concurrency", async () => {
    let requireAuth = false;
    let inFlight = 0;
    let maxInFlight = 0;

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
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const msg = JSON.parse(body);
        setTimeout(() => {
          inFlight -= 1;
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
                result: {
                  tools: [
                    {
                      name: "search_docs",
                      description: "Search documents",
                      inputSchema: {
                        type: "object",
                        properties: { query: { type: "string", description: "Search term" } },
                        required: ["query"],
                      },
                    },
                  ],
                },
              }),
            );
            return;
          }
          if (msg.method === "tools/call") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: `Matched: ${msg.params?.arguments?.query ?? ""}` }],
                },
              }),
            );
            return;
          }
          res.writeHead(202);
          res.end();
        }, 25);
      });
    });

    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    const url = `http://127.0.0.1:${port}/mcp`;

    try {
      const okRes = await probeMcpServer({ name: "demo", transport: "http", url }, { force: true });
      assert.equal(okRes.status, "ok");
      assert.equal(okRes.cached, false);
      assert.equal(okRes.serverInfo.name, "mock-mcp");
      assert.equal(okRes.toolCount, 1);
      assert.equal(okRes.tools[0].inputSchema.fields[0].name, "query");
      assert.equal(okRes.tools[0].inputSchema.fields[0].required, true);

      // Live tools/call runner
      const toolOut = await callMcpTool({ transport: "http", url }, "search_docs", { query: "mcp" });
      assert.equal(toolOut.ok, true);
      assert.equal(toolOut.rawText, "Matched: mcp");

      // Non-forced call hits 60s TTL cache immediately
      const cachedRes = await probeMcpServer({ name: "demo", transport: "http", url }, { force: false });
      assert.equal(cachedRes.cached, true);
      assert.equal(cachedRes.status, "ok");

      const cachedMap = getCachedProbes([{ name: "demo", transport: "http", url }]);
      assert.equal(cachedMap.demo.status, "ok");

      // Batch probe with concurrency = 2 over 6 endpoints
      inFlight = 0;
      maxInFlight = 0;
      const batchList = Array.from({ length: 6 }, (_, i) => ({
        name: `ep-${i}`,
        transport: "http",
        url: `http://127.0.0.1:${port}/mcp-${i}`,
      }));
      const batch = await probeAllServers(batchList, { concurrency: 2, force: true });
      assert.equal(Object.keys(batch).length, 6);
      assert.ok(maxInFlight <= 2, `Expected max concurrency <= 2, got ${maxInFlight}`);

      requireAuth = true;
      const authRes = await probeMcpServer({ name: "demo", transport: "http", url }, { force: true });
      assert.equal(authRes.status, "auth_required");
      assert.equal(authRes.oauth.discovered, true);
      assert.equal(authRes.oauth.supportsDynamicRegistration, true);
    } finally {
      srv.close();
    }
  });

  it("activates backend entrypoint and exposes all v1.1.0 RPC handlers cleanly", async () => {
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
      for (const rpc of [
        "overview.get",
        "overview.poll",
        "server.previewNative",
        "server.upsert",
        "server.sync",
        "server.batchToggle",
        "server.batchSync",
        "server.batchDelete",
        "server.probe",
        "server.probeAll",
        "server.callTool",
        "plugin.toggle",
        "backups.preview",
        "oauth.start",
      ]) {
        assert.ok(handlers.has(rpc), `Missing RPC handler: ${rpc}`);
      }

      const overview = await handlers.get("overview.get")();
      assert.equal(overview.harnesses.length, 4);
      assert.equal(overview.servers.length, 0);
      assert.ok(Array.isArray(overview.presets) && overview.presets.length > 0);
      assert.equal(overview.backups, undefined);
      assert.equal(overview.backupCount, 0);
      assert.ok(overview.perf && typeof overview.perf.readMs === "number");

      // Zero-I/O incremental poll returns changed:false when revision matches
      const pollIdle = await handlers.get("overview.poll")({ sinceRevision: overview.revision });
      assert.equal(pollIdle.changed, false);
      assert.equal(pollIdle.revision, overview.revision);

      // Mutation returns slim payload (no presets, no full backups array) & advances revision
      const up = await handlers.get("server.upsert")({
        server: { name: "demo", transport: "http", url: "https://mcp.example.com/mcp" },
        targets: ["claude-code"],
      });
      assert.equal(up.overview.presets, undefined);
      assert.equal(up.overview.backups, undefined);
      assert.ok(up.overview.revision > overview.revision);

      const pollChanged = await handlers.get("overview.poll")({ sinceRevision: overview.revision });
      assert.equal(pollChanged.changed, true);
      assert.equal(pollChanged.overview.servers.length, 1);
    } finally {
      await dispose();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
