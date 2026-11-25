/**
 * CodexHost Unified Extension Backend (`mcp-hub`).
 *
 * Runs as a single Host-managed Node.js process shared by Codex Desktop and CH Web.
 * Pure Node.js standard library implementation with zero external subprocess spawning.
 */

import { McpConfigStore, HARNESS_IDS } from "./adapters.mjs";
import { McpOAuthManager } from "./oauth.mjs";
import { MCP_PRESETS, parseImportedMcpJson } from "./presets.mjs";
import { probeMcpServer } from "./probe.mjs";

export async function activate(ctx) {
  const oauth = new McpOAuthManager();
  const store = new McpConfigStore({
    dataDir: ctx.dataDir,
    getOverrides: () => ctx.readSettings(),
  });

  ctx.handle("overview.get", async () => {
    const overview = await store.buildOverview();
    return {
      ...overview,
      presets: MCP_PRESETS,
      harnessOrder: HARNESS_IDS,
      pid: process.pid,
    };
  });

  ctx.handle("server.upsert", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid upsert payload");
    }
    const { server, targets } = params;
    const saved = await store.upsertServer(server, targets);
    const overview = await store.buildOverview();
    return { saved, overview };
  });

  ctx.handle("server.delete", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid delete payload");
    }
    const deleted = await store.deleteServer(params.name, params.targets);
    const overview = await store.buildOverview();
    return { deleted, overview };
  });

  ctx.handle("server.toggle", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid toggle payload");
    }
    await store.toggleServer(params.name, params.harnessId, params.enabled);
    const overview = await store.buildOverview();
    return { overview };
  });

  ctx.handle("server.sync", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid sync payload");
    }
    const synced = await store.syncServer(params.name, params.sourceHarnessId, params.targets);
    const overview = await store.buildOverview();
    return { synced, overview };
  });

  ctx.handle("server.syncAll", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid syncAll payload");
    }
    const synced = await store.syncAllFromHarness(params.sourceHarnessId, params.targets);
    const overview = await store.buildOverview();
    return { synced, overview };
  });

  ctx.handle("server.probe", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid probe payload");
    }
    if (params.server) {
      return probeMcpServer(params.server);
    }
    const overview = await store.buildOverview();
    const match = overview.servers.find((s) => s.name === params.name);
    if (!match) {
      throw new Error(`Server "${params.name}" not found`);
    }
    const instance =
      (params.harnessId && match.instances[params.harnessId]) ||
      match.instances[match.primaryHarnessId];
    return probeMcpServer(instance);
  });

  ctx.handle("oauth.start", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid OAuth start payload");
    }
    const url = String(params.url ?? "").trim();
    const serverName = String(params.serverName ?? "").trim();
    if (!url) throw new Error("Remote MCP URL is required");
    return oauth.startFlow({
      serverName,
      url,
      scope: typeof params.scope === "string" ? params.scope.trim() : undefined,
    });
  });

  ctx.handle("oauth.status", async (params) => {
    const flowId = String(params?.flowId ?? "");
    return oauth.getStatus(flowId);
  });

  ctx.handle("oauth.completeManual", async (params) => {
    const flowId = String(params?.flowId ?? "");
    return oauth.completeManual(flowId, params?.callbackUrlOrCode);
  });

  ctx.handle("oauth.applyToken", async (params) => {
    const flowId = String(params?.flowId ?? "");
    const serverName = String(params?.serverName ?? "").trim();
    const targets = Array.isArray(params?.targets) ? params.targets : [];
    const token = oauth.consumeToken(flowId);
    const overviewBefore = await store.buildOverview();
    const existing = overviewBefore.servers.find((s) => s.name === serverName);
    if (!existing) {
      throw new Error(`Server "${serverName}" not found`);
    }
    const applyTargets = targets.length > 0 ? targets : Object.keys(existing.instances);
    for (const hid of applyTargets) {
      const base = existing.instances[hid] ?? existing.instances[existing.primaryHarnessId];
      await store.upsertServer(
        {
          ...base,
          headers: {
            ...(base.headers ?? {}),
            Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}`,
          },
        },
        [hid],
      );
    }
    const overview = await store.buildOverview();
    return { appliedTargets: applyTargets, overview };
  });

  ctx.handle("oauth.cancel", async (params) => {
    oauth.cancelFlow(String(params?.flowId ?? ""));
    return { ok: true };
  });

  ctx.handle("config.importJson", async (params) => {
    const servers = parseImportedMcpJson(params?.rawJson);
    const targets = Array.isArray(params?.targets) && params.targets.length > 0
      ? params.targets
      : HARNESS_IDS;
    const imported = [];
    for (const server of servers) {
      await store.upsertServer(server, targets);
      imported.push(server.name);
    }
    const overview = await store.buildOverview();
    return { imported, targets, overview };
  });

  ctx.handle("config.exportJson", async (params) => {
    const harnessId = typeof params?.harnessId === "string" && params.harnessId ? params.harnessId : null;
    const json = await store.exportStandardJson(harnessId);
    return { json };
  });

  ctx.handle("backups.list", async () => {
    return { backups: await store.listBackups() };
  });

  ctx.handle("backups.restore", async (params) => {
    const restored = await store.restoreBackup(params?.backupId);
    const overview = await store.buildOverview();
    return { restored, overview };
  });

  return () => {
    oauth.dispose();
  };
}
