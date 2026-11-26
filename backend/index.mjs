/**
 * CodexHost Unified Extension Backend (`mcp-hub`).
 *
 * Runs as a single Host-managed Node.js process shared by Codex Desktop and CH Web.
 * Pure Node.js standard library implementation with stat-cached config reads,
 * separated backup index, bounded-concurrency live probing, and zero subprocess spawning.
 */

import { HARNESS_IDS, McpConfigStore, renderNativePreviews } from "./adapters.mjs";
import { McpOAuthManager } from "./oauth.mjs";
import { MCP_PRESETS, parseImportedMcpJson } from "./presets.mjs";
import { clearProbeCache, getCachedProbes, probeAllServers, probeMcpServer } from "./probe.mjs";

export async function activate(ctx) {
  const oauth = new McpOAuthManager();
  const store = new McpConfigStore({
    dataDir: ctx.dataDir,
    getOverrides: () => ctx.readSettings(),
  });

  const buildPayload = async ({ includeBackups = true } = {}) => {
    const overview = await store.buildOverview({ includeBackups });
    return {
      ...overview,
      cachedProbes: getCachedProbes(overview.servers),
      presets: MCP_PRESETS,
      harnessOrder: HARNESS_IDS,
      pid: process.pid,
    };
  };

  ctx.handle("overview.get", async (params) => {
    return buildPayload({ includeBackups: params?.includeBackups !== false });
  });

  ctx.handle("server.previewNative", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid preview payload");
    }
    return { previews: renderNativePreviews(params.server, params.targets) };
  });

  ctx.handle("server.upsert", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid upsert payload");
    }
    const saved = await store.upsertServer(params.server, params.targets);
    return { saved, overview: await buildPayload() };
  });

  ctx.handle("server.delete", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid delete payload");
    }
    const deleted = await store.deleteServer(params.name, params.targets);
    return { deleted, overview: await buildPayload() };
  });

  ctx.handle("server.toggle", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid toggle payload");
    }
    await store.toggleServer(params.name, params.harnessId, params.enabled);
    return { overview: await buildPayload() };
  });

  ctx.handle("server.sync", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid sync payload");
    }
    const synced = await store.syncServer(params.name, params.sourceHarnessId, params.targets);
    return { synced, overview: await buildPayload() };
  });

  ctx.handle("server.syncAll", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid syncAll payload");
    }
    const synced = await store.syncAllFromHarness(params.sourceHarnessId, params.targets);
    return { synced, overview: await buildPayload() };
  });

  ctx.handle("server.probe", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid probe payload");
    }
    if (params.server) {
      return probeMcpServer(params.server, { force: true });
    }
    const overview = await store.buildOverview({ includeBackups: false });
    const match = overview.servers.find((s) => s.name === params.name);
    if (!match) {
      throw new Error(`Server "${params.name}" not found`);
    }
    const instance =
      (params.harnessId && match.instances[params.harnessId]) ||
      match.instances[match.primaryHarnessId];
    return probeMcpServer(instance, { force: params.force !== false });
  });

  ctx.handle("server.probeAll", async (params) => {
    const overview = await store.buildOverview({ includeBackups: false });
    const list = overview.servers.map((s) => ({
      ...(s.instances[s.primaryHarnessId] ?? s),
      name: s.name,
    }));
    const results = await probeAllServers(list, {
      concurrency: 4,
      force: params?.force !== false,
    });
    return { results };
  });

  ctx.handle("plugin.toggle", async (params) => {
    if (!params || typeof params !== "object") {
      throw new Error("Invalid plugin toggle payload");
    }
    const updated = await store.toggleNativePlugin(
      params.harnessId,
      params.pluginId,
      params.enabled,
    );
    return { updated, overview: await buildPayload() };
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
    return oauth.getStatus(String(params?.flowId ?? ""));
  });

  ctx.handle("oauth.completeManual", async (params) => {
    return oauth.completeManual(String(params?.flowId ?? ""), params?.callbackUrlOrCode);
  });

  ctx.handle("oauth.applyToken", async (params) => {
    const flowId = String(params?.flowId ?? "");
    const serverName = String(params?.serverName ?? "").trim();
    const targets = Array.isArray(params?.targets) ? params.targets : [];
    const token = oauth.consumeToken(flowId);
    const overviewBefore = await store.buildOverview({ includeBackups: false });
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
    return { appliedTargets: applyTargets, overview: await buildPayload() };
  });

  ctx.handle("oauth.cancel", async (params) => {
    oauth.cancelFlow(String(params?.flowId ?? ""));
    return { ok: true };
  });

  ctx.handle("config.importJson", async (params) => {
    const servers = parseImportedMcpJson(params?.rawJson);
    const targets =
      Array.isArray(params?.targets) && params.targets.length > 0 ? params.targets : HARNESS_IDS;
    const imported = [];
    for (const server of servers) {
      await store.upsertServer(server, targets);
      imported.push(server.name);
    }
    return { imported, targets, overview: await buildPayload() };
  });

  ctx.handle("config.exportJson", async (params) => {
    const harnessId =
      typeof params?.harnessId === "string" && params.harnessId ? params.harnessId : null;
    const json = await store.exportStandardJson(harnessId);
    return { json };
  });

  ctx.handle("backups.list", async () => {
    return { backups: await store.listBackups() };
  });

  ctx.handle("backups.restore", async (params) => {
    const restored = await store.restoreBackup(params?.backupId);
    return { restored, overview: await buildPayload() };
  });

  return () => {
    oauth.dispose();
    clearProbeCache();
  };
}
