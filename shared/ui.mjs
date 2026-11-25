/**
 * Shared MCP Hub UI controller — mounted by both `web/index.mjs` (Web left sidebar panel)
 * and `page/index.mjs` (Desktop Settings plugin page & Web Plugin workspace tab).
 */

import { createTranslator, resolveLocale } from "./i18n.mjs";
import { iconSvg } from "./icons.mjs";

const HARNESS_ORDER = ["claude-code", "antigravity", "opencode", "codex"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes ?? 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso, locale) {
  try {
    return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso ?? "");
  }
}

function endpointSummary(server) {
  if (server.transport === "http" || server.transport === "sse") {
    return server.url || "";
  }
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

function shortenPath(p) {
  if (!p) return "";
  return p.replace(/^([A-Za-z]:\\Users\\[^\\]+|\/Users\/[^/]+|\/home\/[^/]+)/u, "~");
}

async function copyToClipboard(text, doc) {
  const nav = doc?.defaultView?.navigator;
  if (nav?.clipboard?.writeText) {
    await nav.clipboard.writeText(text);
    return true;
  }
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  doc.body.appendChild(ta);
  ta.select();
  const ok = doc.execCommand("copy");
  ta.remove();
  return ok;
}

export function mountMcpHub(container, bridge) {
  const doc = container.ownerDocument;
  const signal = bridge.signal;
  const t = createTranslator(() => bridge.getLocale());

  const root = doc.createElement("div");
  root.className = "mh-root";
  root.dataset.mhScheme = bridge.getColorScheme() === "dark" ? "dark" : "light";
  container.replaceChildren(root);

  const state = {
    loading: true,
    busy: false,
    error: null,
    overview: null,
    activeTab: "servers", // servers | presets | backups
    selectedHarness: null, // null = all
    transportFilter: "all", // all | http | stdio
    onlyDrift: false,
    search: "",
    probes: new Map(), // serverName -> { loading, data }
    expandedProbe: new Set(),
    oauthFlows: new Map(), // serverName -> { flowId, authorizationUrl, redirectUri, status, error, hasToken, manualInput, starting }
    modal: null, // { type: 'editor'|'import'|'export'|'sync'|'delete', ... }
    toast: null, // { text, isError }
  };

  let toastTimer = null;
  const oauthTimers = new Map();
  let disposed = false;

  const stopOAuthPolling = (serverName) => {
    const timer = oauthTimers.get(serverName);
    if (timer) {
      clearInterval(timer);
      oauthTimers.delete(serverName);
    }
  };

  const showToast = (text, isError = false) => {
    state.toast = { text, isError };
    if (toastTimer) clearTimeout(toastTimer);
    renderToastOnly();
    toastTimer = setTimeout(() => {
      state.toast = null;
      renderToastOnly();
    }, 3400);
  };

  const renderToastOnly = () => {
    const existing = root.querySelector(".mh-toast");
    if (existing) existing.remove();
    if (!state.toast) return;
    const el = doc.createElement("div");
    el.className = `mh-toast${state.toast.isError ? " is-error" : ""}`;
    el.setAttribute("role", "status");
    el.innerHTML = `${iconSvg(state.toast.isError ? "warning" : "check", 15)}<span>${escapeHtml(state.toast.text)}</span>`;
    root.appendChild(el);
  };

  const loadOverview = async (silent = false) => {
    if (!silent) {
      state.loading = true;
      state.error = null;
      render();
    }
    try {
      const data = await bridge.invoke("overview.get");
      if (disposed || signal.aborted) return;
      state.overview = data;
      state.loading = false;
      state.error = null;
      render();
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.loading = false;
      state.error = error instanceof Error ? error.message : String(error);
      render();
    }
  };

  const invokeAndRefresh = async (method, params, successMsg) => {
    state.busy = true;
    render();
    try {
      const res = await bridge.invoke(method, params);
      if (disposed || signal.aborted) return res;
      if (res?.overview) {
        state.overview = {
          ...state.overview,
          ...res.overview,
        };
      }
      state.busy = false;
      if (successMsg) showToast(successMsg);
      render();
      return res;
    } catch (error) {
      if (disposed || signal.aborted) return null;
      state.busy = false;
      showToast(error instanceof Error ? error.message : String(error), true);
      render();
      return null;
    }
  };

  const runProbe = async (serverName, harnessId = null) => {
    state.expandedProbe.add(serverName);
    state.probes.set(serverName, { loading: true, data: null });
    render();
    try {
      const data = await bridge.invoke("server.probe", { name: serverName, harnessId });
      if (disposed || signal.aborted) return;
      state.probes.set(serverName, { loading: false, data });
      render();
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.probes.set(serverName, {
        loading: false,
        data: { status: "error", message: error instanceof Error ? error.message : String(error) },
      });
      render();
    }
  };

  const startOAuth = async (server) => {
    stopOAuthPolling(server.name);
    state.oauthFlows.set(server.name, { starting: true, status: "starting" });
    render();
    try {
      const started = await bridge.invoke("oauth.start", {
        serverName: server.name,
        url: server.url,
      });
      if (disposed || signal.aborted) return;
      const flowState = {
        ...started,
        status: "pending",
        hasToken: false,
        error: null,
        manualInput: "",
      };
      state.oauthFlows.set(server.name, flowState);
      render();

      const timer = setInterval(async () => {
        if (disposed || signal.aborted) {
          stopOAuthPolling(server.name);
          return;
        }
        try {
          const st = await bridge.invoke("oauth.status", { flowId: started.flowId });
          if (disposed || signal.aborted) return;
          const prev = state.oauthFlows.get(server.name);
          if (!prev || prev.flowId !== started.flowId) {
            stopOAuthPolling(server.name);
            return;
          }
          if (st.status !== prev.status || st.hasToken !== prev.hasToken || st.error !== prev.error) {
            state.oauthFlows.set(server.name, { ...prev, ...st });
            if (st.status !== "pending") stopOAuthPolling(server.name);
            render();
          }
        } catch {
          stopOAuthPolling(server.name);
        }
      }, 1500);
      oauthTimers.set(server.name, timer);
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.oauthFlows.set(server.name, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      render();
    }
  };

  const filteredServers = () => {
    const list = state.overview?.servers ?? [];
    const q = state.search.trim().toLowerCase();
    return list.filter((item) => {
      if (state.selectedHarness && !item.instances[state.selectedHarness]) return false;
      if (state.transportFilter === "http" && item.transport !== "http" && item.transport !== "sse") {
        return false;
      }
      if (state.transportFilter === "stdio" && item.transport !== "stdio") return false;
      if (state.onlyDrift && !item.hasDrift && item.harnessCount >= HARNESS_ORDER.length) return false;
      if (q) {
        const hay = `${item.name} ${item.url ?? ""} ${item.command ?? ""} ${(item.args ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  };

  const openAddModal = (prefill = null) => {
    const base = prefill ?? {
      name: "",
      transport: "http",
      url: "",
      command: "npx",
      args: [],
      headers: {},
      env: {},
      bearerTokenEnvVar: "",
      enabled: true,
    };
    const kvEntries =
      base.transport === "stdio"
        ? Object.entries(base.env ?? {})
        : Object.entries(base.headers ?? {});

    state.modal = {
      type: "editor",
      isEdit: Boolean(prefill?._isEdit),
      name: base.name ?? "",
      transport: base.transport ?? "http",
      url: base.url ?? "",
      command: base.command ?? "npx",
      argsText: Array.isArray(base.args) ? base.args.join("\n") : "",
      bearerTokenEnvVar: base.bearerTokenEnvVar ?? "",
      enabled: base.enabled !== false,
      kv: kvEntries.length > 0 ? kvEntries.map(([k, v]) => ({ k, v, reveal: false })) : [{ k: "", v: "", reveal: false }],
      targets: prefill?._targets
        ? new Set(prefill._targets)
        : new Set(
            (state.overview?.harnesses ?? [])
              .filter((h) => h.exists)
              .map((h) => h.id),
          ),
      probeResult: null,
      probing: false,
      formError: null,
    };
    if (state.modal.targets.size === 0) {
      for (const id of HARNESS_ORDER) state.modal.targets.add(id);
    }
    render();
  };

  const openEditModal = (server) => {
    const primary = server.instances[state.selectedHarness ?? server.primaryHarnessId] ?? server.instances[server.primaryHarnessId];
    openAddModal({
      ...primary,
      name: server.name,
      _isEdit: true,
      _targets: Object.keys(server.instances),
    });
  };

  const openSyncModal = (server) => {
    const configured = Object.keys(server.instances);
    const source = state.selectedHarness && server.instances[state.selectedHarness]
      ? state.selectedHarness
      : configured[0];
    const missing = HARNESS_ORDER.filter((id) => id !== source && !server.instances[id]);
    state.modal = {
      type: "sync",
      server,
      sourceHarnessId: source,
      targets: new Set(missing.length > 0 ? missing : HARNESS_ORDER.filter((id) => id !== source)),
    };
    render();
  };

  const openDeleteModal = (server) => {
    state.modal = {
      type: "delete",
      server,
      targets: new Set(Object.keys(server.instances)),
    };
    render();
  };

  const openImportModal = () => {
    const existingHarnesses = (state.overview?.harnesses ?? []).filter((h) => h.exists).map((h) => h.id);
    state.modal = {
      type: "import",
      rawJson: "",
      targets: new Set(existingHarnesses.length > 0 ? existingHarnesses : HARNESS_ORDER),
      formError: null,
    };
    render();
  };

  const openExportModal = async () => {
    try {
      const res = await bridge.invoke("config.exportJson", {
        harnessId: state.selectedHarness,
      });
      if (disposed || signal.aborted) return;
      state.modal = {
        type: "export",
        json: res.json,
      };
      render();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  };

  // -------------------------------------------------------------------------
  // HTML Builders
  // -------------------------------------------------------------------------

  const renderHarnessRail = () => {
    const harnesses = state.overview?.harnesses ?? [];
    return `
      <section class="mh-harness-rail" aria-label="Harnesses">
        ${harnesses
          .map((h) => {
            const selected = state.selectedHarness === h.id;
            const pathLabel = h.exists ? shortenPath(h.configPath) : t("notCreatedYet");
            return `
              <div class="mh-harness-card${selected ? " is-selected" : ""}" data-action="filter-harness" data-harness="${escapeHtml(h.id)}" role="button" tabindex="0">
                <div class="mh-harness-top">
                  <span class="mh-harness-name">
                    <span class="mh-dot" style="background:${escapeHtml(h.accent)}"></span>
                    ${escapeHtml(h.name)}
                  </span>
                  <span class="mh-format-tag">${escapeHtml(h.format)}</span>
                </div>
                <div class="mh-harness-metric">
                  <span class="mh-harness-count">
                    ${h.enabledCount}<small>/ ${h.totalCount}</small>
                  </span>
                  ${
                    h.totalCount > 0
                      ? `<button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="sync-all" data-harness="${escapeHtml(h.id)}" title="${escapeHtml(t("syncAll"))}">${iconSvg("sync", 13)}<span>${escapeHtml(t("sync"))}</span></button>`
                      : ""
                  }
                </div>
                ${
                  h.parseError
                    ? `<div class="mh-harness-err">${escapeHtml(t("parseError"))}: ${escapeHtml(h.parseError)}</div>`
                    : `<div class="mh-harness-path" title="${escapeHtml(h.configPath)}">${escapeHtml(pathLabel)}</div>`
                }
              </div>
            `;
          })
          .join("")}
      </section>
    `;
  };

  const renderProbePanel = (server) => {
    if (!state.expandedProbe.has(server.name)) return "";
    const probeState = state.probes.get(server.name);
    const oauthState = state.oauthFlows.get(server.name);
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));

    if (!probeState || probeState.loading) {
      return `
        <div class="mh-probe-panel">
          <div class="mh-probe-status">${iconSvg("radar", 15)}<span>${escapeHtml(t("probing"))}</span></div>
        </div>
      `;
    }

    const res = probeState.data ?? { status: "error", message: "No probe data" };
    let body = "";

    if (res.status === "ok") {
      if (server.transport === "stdio") {
        body = `
          <div class="mh-probe-header">
            <div class="mh-probe-status is-ok">
              ${iconSvg("check", 15)}
              <span>${escapeHtml(t("probeOkStdio", { path: res.resolvedCommand ?? server.command }))}</span>
            </div>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-probe" data-name="${escapeHtml(server.name)}">${iconSvg("close", 13)}</button>
          </div>
        `;
      } else {
        const tools = Array.isArray(res.tools) ? res.tools : [];
        body = `
          <div class="mh-probe-header">
            <div class="mh-probe-status is-ok">
              ${iconSvg("check", 15)}
              <span>${escapeHtml(
                t("probeOkRemote", {
                  latency: res.latencyMs ?? 0,
                  version: res.protocolVersion ?? "2025-03-26",
                }),
              )}${res.serverInfo?.name ? ` · ${escapeHtml(res.serverInfo.name)}${res.serverInfo.version ? ` v${escapeHtml(res.serverInfo.version)}` : ""}` : ""}</span>
            </div>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-probe" data-name="${escapeHtml(server.name)}">${iconSvg("close", 13)}</button>
          </div>
          ${
            tools.length > 0
              ? `
                <div class="mh-label">${escapeHtml(t("probeToolsHeading", { count: tools.length }))}</div>
                <div class="mh-tools-grid">
                  ${tools
                    .map(
                      (tool) => `
                        <div class="mh-tool-item">
                          <span class="mh-tool-name">${escapeHtml(tool.name)}</span>
                          ${tool.description ? `<span class="mh-tool-desc">${escapeHtml(tool.description)}</span>` : ""}
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              `
              : `<p class="mh-hint">${escapeHtml(t("probeNoTools"))}</p>`
          }
        `;
      }
    } else if (res.status === "auth_required") {
      const canBrowserOAuth = Boolean(res.oauth?.discovered && res.oauth?.supportsDynamicRegistration);
      let oauthSection = "";

      if (oauthState?.starting) {
        oauthSection = `<div class="mh-hint">${escapeHtml(t("startingOAuth"))}</div>`;
      } else if (oauthState?.status === "pending") {
        oauthSection = `
          <div class="mh-oauth-actions">
            <a class="mh-btn mh-btn--primary mh-btn--sm" href="${escapeHtml(oauthState.authorizationUrl)}" target="_blank" rel="noopener noreferrer">
              ${iconSvg("external", 14)}<span>${escapeHtml(t("openAuthPage"))}</span>
            </a>
            <button type="button" class="mh-btn mh-btn--sm" data-action="copy-text" data-text="${escapeHtml(oauthState.authorizationUrl)}">
              ${iconSvg("copy", 13)}<span>${escapeHtml(t("copy"))} URL</span>
            </button>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="oauth-cancel" data-name="${escapeHtml(server.name)}">
              ${escapeHtml(t("oauthCancel"))}
            </button>
          </div>
          <p class="mh-hint">${escapeHtml(t("oauthWaiting"))}</p>
          <div class="mh-oauth-manual">
            <input class="mh-input" type="text" data-oauth-manual="${escapeHtml(server.name)}" placeholder="${escapeHtml(t("oauthPastePlaceholder"))}" value="${escapeHtml(oauthState.manualInput ?? "")}" />
            <button type="button" class="mh-btn mh-btn--sm" data-action="oauth-manual-submit" data-name="${escapeHtml(server.name)}">${escapeHtml(t("oauthCompleteManual"))}</button>
          </div>
        `;
      } else if (oauthState?.status === "completed" && oauthState.hasToken) {
        oauthSection = `
          <div class="mh-probe-status is-ok">${iconSvg("check", 15)}<span>${escapeHtml(t("oauthSuccess"))}</span></div>
          <div class="mh-oauth-actions">
            <button type="button" class="mh-btn mh-btn--primary mh-btn--sm" data-action="oauth-apply" data-name="${escapeHtml(server.name)}">
              ${iconSvg("check", 14)}<span>${escapeHtml(t("oauthApplyBtn"))}</span>
            </button>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="oauth-cancel" data-name="${escapeHtml(server.name)}">
              ${escapeHtml(t("cancel"))}
            </button>
          </div>
        `;
      } else {
        oauthSection = `
          ${oauthState?.error ? `<div class="mh-error-banner">${escapeHtml(oauthState.error)}</div>` : ""}
          <div class="mh-oauth-actions">
            ${
              canBrowserOAuth
                ? `<button type="button" class="mh-btn mh-btn--primary mh-btn--sm" data-action="oauth-start" data-name="${escapeHtml(server.name)}">${iconSvg("lock", 14)}<span>${escapeHtml(t("startOAuth"))}</span></button>`
                : ""
            }
          </div>
        `;
      }

      body = `
        <div class="mh-probe-header">
          <div class="mh-probe-status is-auth">
            ${iconSvg("lock", 15)}
            <span>${escapeHtml(t("probeAuthTitle", { status: res.httpStatus ?? 401 }))}</span>
          </div>
          <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-probe" data-name="${escapeHtml(server.name)}">${iconSvg("close", 13)}</button>
        </div>
        <div class="mh-oauth-box">
          <p class="mh-hint">${escapeHtml(t("probeAuthHint"))}</p>
          ${oauthSection}
          <div class="mh-label" style="margin-top:4px">${escapeHtml(t("nativeCliTitle"))}</div>
          <div class="mh-cli-grid">
            ${HARNESS_ORDER.map((hid) => {
              const cmd = server.cliHints?.[hid]?.oauth ?? "";
              return `
                <div class="mh-cli-row">
                  <div class="mh-cli-cmd">
                    <span class="mh-cli-label">${escapeHtml(harnessMap[hid]?.name ?? hid)}</span>
                    <code class="mh-cli-code" title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</code>
                  </div>
                  <button type="button" class="mh-btn mh-btn--sm" data-action="copy-text" data-text="${escapeHtml(cmd)}">${iconSvg("copy", 13)}</button>
                </div>
              `;
            }).join("")}
          </div>
          <p class="mh-hint">${escapeHtml(t("agyOauthTip"))}</p>
        </div>
      `;
    } else {
      body = `
        <div class="mh-probe-header">
          <div class="mh-probe-status is-error">
            ${iconSvg("warning", 15)}
            <span>${escapeHtml(res.message ?? "Probe failed")}</span>
          </div>
          <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-probe" data-name="${escapeHtml(server.name)}">${iconSvg("close", 13)}</button>
        </div>
      `;
    }

    return `<div class="mh-probe-panel">${body}</div>`;
  };

  const renderServersTab = () => {
    const allCount = state.overview?.servers?.length ?? 0;
    const rows = filteredServers();
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));

    if (allCount === 0) {
      return `
        <div class="mh-empty">
          ${iconSvg("hub", 28)}
          <h3>${escapeHtml(t("noServersTitle"))}</h3>
          <p>${escapeHtml(t("noServersHint"))}</p>
          <div class="mh-header-actions" style="margin-top:6px">
            <button type="button" class="mh-btn mh-btn--primary" data-action="open-add">${iconSvg("plus", 14)}<span>${escapeHtml(t("addServer"))}</span></button>
            <button type="button" class="mh-btn" data-action="switch-tab" data-tab="presets">${iconSvg("spark", 14)}<span>${escapeHtml(t("tabPresets"))}</span></button>
          </div>
        </div>
      `;
    }

    if (rows.length === 0) {
      return `
        <div class="mh-empty">
          ${iconSvg("search", 24)}
          <h3>${escapeHtml(t("noMatchTitle"))}</h3>
          <p>${escapeHtml(t("noMatchHint"))}</p>
        </div>
      `;
    }

    return `
      <div class="mh-list">
        ${rows
          .map((server) => {
            const isRemote = server.transport === "http" || server.transport === "sse";
            const endpoint = endpointSummary(server);
            const probeState = state.probes.get(server.name);
            const probeBadge =
              probeState?.data?.status === "ok"
                ? `<span class="mh-badge mh-badge--ok">${probeState.data.toolCount !== undefined ? `${probeState.data.toolCount} tools` : "OK"}</span>`
                : probeState?.data?.status === "auth_required"
                  ? `<span class="mh-badge mh-badge--warn">OAuth</span>`
                  : "";

            return `
              <article class="mh-server-card" data-server="${escapeHtml(server.name)}">
                <div class="mh-server-row">
                  <div class="mh-server-meta">
                    <div class="mh-server-head">
                      <span class="mh-server-name">${escapeHtml(server.name)}</span>
                      <span class="mh-badge${isRemote ? " mh-badge--http" : ""}">${iconSvg(isRemote ? "globe" : "terminal", 11)}${escapeHtml(server.transport)}</span>
                      ${server.hasDrift ? `<span class="mh-badge mh-badge--warn">${escapeHtml(t("driftBadge"))}</span>` : ""}
                      ${probeBadge}
                    </div>
                    <div class="mh-server-endpoint" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</div>
                  </div>

                  <div class="mh-matrix" aria-label="Harness presence">
                    ${HARNESS_ORDER.map((hid) => {
                      const meta = harnessMap[hid];
                      const inst = server.instances[hid];
                      if (!inst) {
                        return `
                          <button
                            type="button"
                            class="mh-pill mh-pill--missing"
                            data-action="quick-sync"
                            data-name="${escapeHtml(server.name)}"
                            data-source="${escapeHtml(server.primaryHarnessId)}"
                            data-target="${escapeHtml(hid)}"
                            title="${escapeHtml(t("pillMissingHint", { harness: meta?.name ?? hid }))}"
                          >
                            ${iconSvg("plus", 11)}
                            <span>${escapeHtml(meta?.shortName ?? hid)}</span>
                          </button>
                        `;
                      }
                      const cls = inst.enabled ? "mh-pill--enabled" : "mh-pill--disabled";
                      const hintKey = inst.enabled ? "pillEnabledHint" : "pillDisabledHint";
                      return `
                        <button
                          type="button"
                          class="mh-pill ${cls}"
                          style="--pill-accent:${escapeHtml(meta?.accent ?? "#2563eb")}"
                          data-action="toggle-instance"
                          data-name="${escapeHtml(server.name)}"
                          data-harness="${escapeHtml(hid)}"
                          data-next="${inst.enabled ? "false" : "true"}"
                          title="${escapeHtml(t(hintKey, { harness: meta?.name ?? hid }))}"
                        >
                          <span class="mh-pill-dot"></span>
                          <span>${escapeHtml(meta?.shortName ?? hid)}</span>
                        </button>
                      `;
                    }).join("")}
                  </div>

                  <div class="mh-row-actions">
                    <button type="button" class="mh-btn mh-btn--sm" data-action="probe" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("probe"))}">
                      ${iconSvg("radar", 13)}<span>${escapeHtml(t("probe"))}</span>
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-sync" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("sync"))}">
                      ${iconSvg("sync", 14)}
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-edit" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("edit"))}">
                      ${iconSvg("edit", 14)}
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-delete" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("remove"))}">
                      ${iconSvg("trash", 14)}
                    </button>
                  </div>
                </div>
                ${renderProbePanel(server)}
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderPresetsTab = () => {
    const presets = state.overview?.presets ?? [];
    const configured = new Set((state.overview?.servers ?? []).map((s) => s.name));
    const lang = resolveLocale(bridge.getLocale());
    return `
      <p class="mh-hint">${escapeHtml(t("presetsHint"))}</p>
      <div class="mh-presets-grid">
        ${presets
          .map((preset) => {
            const isRemote = preset.transport === "http" || preset.transport === "sse";
            const desc = preset.description?.[lang] ?? preset.description?.en ?? "";
            const isInstalled = configured.has(preset.id);
            const targetPreview = isRemote
              ? preset.url
              : [preset.command, ...(preset.args ?? [])].join(" ");
            return `
              <div class="mh-preset-card">
                <div>
                  <div class="mh-preset-head">
                    <span class="mh-preset-title">${escapeHtml(preset.name)}</span>
                    <div style="display:flex;gap:5px;align-items:center">
                      ${preset.oauthHint ? `<span class="mh-badge mh-badge--warn">${escapeHtml(t("oauthBadge"))}</span>` : ""}
                      ${isInstalled ? `<span class="mh-badge mh-badge--ok">${escapeHtml(t("installedBadge"))}</span>` : ""}
                    </div>
                  </div>
                  <p class="mh-preset-desc">${escapeHtml(desc)}</p>
                </div>
                <div class="mh-server-endpoint" title="${escapeHtml(targetPreview)}">${escapeHtml(targetPreview)}</div>
                <div class="mh-preset-footer">
                  <span class="mh-badge${isRemote ? " mh-badge--http" : ""}">${escapeHtml(preset.transport)}</span>
                  <button type="button" class="mh-btn mh-btn--sm${isInstalled ? "" : " mh-btn--primary"}" data-action="use-preset" data-preset="${escapeHtml(preset.id)}">
                    ${iconSvg("plus", 13)}<span>${escapeHtml(t("usePreset"))}</span>
                  </button>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderBackupsTab = () => {
    const backups = state.overview?.backups ?? [];
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));
    const lang = resolveLocale(bridge.getLocale());

    if (backups.length === 0) {
      return `
        <div class="mh-empty">
          ${iconSvg("history", 26)}
          <p>${escapeHtml(t("backupsEmpty"))}</p>
        </div>
      `;
    }

    return `
      <p class="mh-hint">${escapeHtml(t("backupsHint"))}</p>
      <div class="mh-list">
        ${backups
          .map((b) => {
            const h = harnessMap[b.harnessId];
            return `
              <div class="mh-backup-row">
                <div class="mh-backup-info">
                  <div class="mh-backup-title">
                    <span class="mh-dot" style="background:${escapeHtml(h?.accent ?? "#64748b")}"></span>
                    <span>${escapeHtml(h?.name ?? b.harnessId)}</span>
                    <span class="mh-badge">${escapeHtml(b.reason)}</span>
                    <span class="mh-hint">${escapeHtml(formatTime(b.createdAt, lang))} · ${escapeHtml(formatBytes(b.sizeBytes))}</span>
                  </div>
                  <div class="mh-backup-sub">${escapeHtml(b.configPath)}</div>
                </div>
                <button type="button" class="mh-btn mh-btn--sm" data-action="restore-backup" data-backup="${escapeHtml(b.id)}" data-harness="${escapeHtml(h?.name ?? b.harnessId)}">
                  ${iconSvg("history", 13)}<span>${escapeHtml(t("restore"))}</span>
                </button>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderModal = () => {
    const m = state.modal;
    if (!m) return "";
    const harnesses = state.overview?.harnesses ?? [];

    if (m.type === "editor") {
      const isRemote = m.transport === "http" || m.transport === "sse";
      return `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(m.isEdit ? "modalEditTitle" : "modalAddTitle"))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t(m.isEdit ? "modalEditTitle" : "modalAddTitle"))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              ${m.formError ? `<div class="mh-error-banner">${escapeHtml(m.formError)}</div>` : ""}
              <div class="mh-field">
                <label class="mh-label" for="mh-f-name">${escapeHtml(t("fieldName"))}</label>
                <input id="mh-f-name" class="mh-input" data-field="name" value="${escapeHtml(m.name)}" placeholder="${escapeHtml(t("fieldNamePlaceholder"))}" ${m.isEdit ? "readonly" : ""} />
              </div>
              <div class="mh-field">
                <label class="mh-label" for="mh-f-transport">${escapeHtml(t("fieldTransport"))}</label>
                <select id="mh-f-transport" class="mh-select" data-field="transport">
                  <option value="http"${m.transport === "http" ? " selected" : ""}>${escapeHtml(t("transportHttp"))}</option>
                  <option value="stdio"${m.transport === "stdio" ? " selected" : ""}>${escapeHtml(t("transportStdio"))}</option>
                  <option value="sse"${m.transport === "sse" ? " selected" : ""}>${escapeHtml(t("transportSse"))}</option>
                </select>
              </div>

              ${
                isRemote
                  ? `
                    <div class="mh-field">
                      <label class="mh-label" for="mh-f-url">${escapeHtml(t("fieldUrl"))}</label>
                      <input id="mh-f-url" class="mh-input" data-field="url" value="${escapeHtml(m.url)}" placeholder="${escapeHtml(t("fieldUrlPlaceholder"))}" />
                    </div>
                    <div class="mh-field">
                      <label class="mh-label" for="mh-f-bearer">${escapeHtml(t("fieldBearerEnv"))}</label>
                      <input id="mh-f-bearer" class="mh-input" data-field="bearerTokenEnvVar" value="${escapeHtml(m.bearerTokenEnvVar)}" placeholder="${escapeHtml(t("fieldBearerEnvPlaceholder"))}" />
                    </div>
                  `
                  : `
                    <div class="mh-field">
                      <label class="mh-label" for="mh-f-cmd">${escapeHtml(t("fieldCommand"))}</label>
                      <input id="mh-f-cmd" class="mh-input" data-field="command" value="${escapeHtml(m.command)}" placeholder="${escapeHtml(t("fieldCommandPlaceholder"))}" />
                    </div>
                    <div class="mh-field">
                      <label class="mh-label" for="mh-f-args">${escapeHtml(t("fieldArgs"))}</label>
                      <textarea id="mh-f-args" class="mh-textarea" data-field="argsText" placeholder="${escapeHtml(t("fieldArgsPlaceholder"))}">${escapeHtml(m.argsText)}</textarea>
                    </div>
                  `
              }

              <div class="mh-field">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <label class="mh-label">${escapeHtml(t(isRemote ? "fieldHeaders" : "fieldEnv"))}</label>
                  <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="kv-add">${iconSvg("plus", 12)}<span>${escapeHtml(t("addRow"))}</span></button>
                </div>
                <div class="mh-kv-list">
                  ${m.kv
                    .map(
                      (row, idx) => `
                        <div class="mh-kv-row">
                          <input class="mh-input" data-kv-key="${idx}" value="${escapeHtml(row.k)}" placeholder="${escapeHtml(t("keyPlaceholder"))}" />
                          <input class="mh-input" type="${row.reveal ? "text" : "password"}" data-kv-val="${idx}" value="${escapeHtml(row.v)}" placeholder="${escapeHtml(t("valuePlaceholder"))}" />
                          <div style="display:flex;gap:3px">
                            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="kv-reveal" data-idx="${idx}" title="${escapeHtml(t("toggleSecret"))}">${iconSvg("eye", 13)}</button>
                            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="kv-del" data-idx="${idx}">${iconSvg("close", 13)}</button>
                          </div>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </div>

              <div class="mh-field">
                <label class="mh-label">${escapeHtml(t("fieldTargets"))}</label>
                <div class="mh-check-grid">
                  ${harnesses
                    .map(
                      (h) => `
                        <label class="mh-check-item">
                          <input type="checkbox" data-modal-target="${escapeHtml(h.id)}" ${m.targets.has(h.id) ? "checked" : ""} />
                          <span class="mh-dot" style="background:${escapeHtml(h.accent)}"></span>
                          <span>${escapeHtml(h.name)}</span>
                        </label>
                      `,
                    )
                    .join("")}
                </div>
              </div>

              <label class="mh-check-item" style="width:fit-content">
                <input type="checkbox" data-field-bool="enabled" ${m.enabled ? "checked" : ""} />
                <span>${escapeHtml(t("fieldEnabled"))}</span>
              </label>

              ${
                m.probeResult
                  ? `<div class="mh-oauth-box">
                      <div class="mh-probe-status ${m.probeResult.status === "ok" ? "is-ok" : m.probeResult.status === "auth_required" ? "is-auth" : "is-error"}">
                        ${iconSvg(m.probeResult.status === "ok" ? "check" : m.probeResult.status === "auth_required" ? "lock" : "warning", 14)}
                        <span>${escapeHtml(
                          m.probeResult.status === "ok"
                            ? m.probeResult.resolvedCommand
                              ? t("probeOkStdio", { path: m.probeResult.resolvedCommand })
                              : t("probeOkRemote", {
                                  latency: m.probeResult.latencyMs ?? 0,
                                  version: m.probeResult.protocolVersion ?? "2025-03-26",
                                })
                            : m.probeResult.message ?? "Probe completed",
                        )}</span>
                      </div>
                    </div>`
                  : ""
              }
            </div>
            <div class="mh-modal-foot">
              <button type="button" class="mh-btn" data-action="modal-probe" ${m.probing ? "disabled" : ""}>
                ${iconSvg("radar", 14)}<span>${escapeHtml(m.probing ? t("probing") : t("testConnection"))}</span>
              </button>
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn mh-btn--ghost" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="modal-save" ${state.busy ? "disabled" : ""}>${escapeHtml(state.busy ? t("saving") : t("save"))}</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (m.type === "import") {
      return `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("modalImportTitle"))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalImportTitle"))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              ${m.formError ? `<div class="mh-error-banner">${escapeHtml(m.formError)}</div>` : ""}
              <p class="mh-hint">${escapeHtml(t("modalImportHint"))}</p>
              <textarea class="mh-textarea" style="min-height:180px" data-field="rawJson" placeholder='{\n  "mcpServers": {\n    "notion": { "url": "https://mcp.notion.com/mcp" }\n  }\n}'>${escapeHtml(m.rawJson)}</textarea>
              <div class="mh-field">
                <label class="mh-label">${escapeHtml(t("fieldTargets"))}</label>
                <div class="mh-check-grid">
                  ${harnesses
                    .map(
                      (h) => `
                        <label class="mh-check-item">
                          <input type="checkbox" data-modal-target="${escapeHtml(h.id)}" ${m.targets.has(h.id) ? "checked" : ""} />
                          <span class="mh-dot" style="background:${escapeHtml(h.accent)}"></span>
                          <span>${escapeHtml(h.name)}</span>
                        </label>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn mh-btn--ghost" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="modal-import-submit" ${state.busy ? "disabled" : ""}>${escapeHtml(t("importSubmit"))}</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (m.type === "export") {
      return `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("modalExportTitle"))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalExportTitle"))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("modalExportHint"))}</p>
              <textarea class="mh-textarea" style="min-height:240px" readonly>${escapeHtml(m.json)}</textarea>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn mh-btn--ghost" data-action="close-modal">${escapeHtml(t("close"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="copy-text" data-text="${escapeHtml(m.json)}">${iconSvg("copy", 14)}<span>${escapeHtml(t("copy"))} JSON</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (m.type === "sync") {
      const configured = Object.keys(m.server.instances);
      return `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalSyncTitle", { name: m.server.name }))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("modalSyncHint"))}</p>
              <div class="mh-field">
                <label class="mh-label" for="mh-sync-src">${escapeHtml(t("syncSource"))}</label>
                <select id="mh-sync-src" class="mh-select" data-field="sourceHarnessId">
                  ${configured
                    .map((hid) => {
                      const h = harnesses.find((x) => x.id === hid);
                      return `<option value="${escapeHtml(hid)}"${m.sourceHarnessId === hid ? " selected" : ""}>${escapeHtml(h?.name ?? hid)}</option>`;
                    })
                    .join("")}
                </select>
              </div>
              <div class="mh-field">
                <label class="mh-label">${escapeHtml(t("syncTargets"))}</label>
                <div class="mh-check-grid">
                  ${harnesses
                    .filter((h) => h.id !== m.sourceHarnessId)
                    .map(
                      (h) => `
                        <label class="mh-check-item">
                          <input type="checkbox" data-modal-target="${escapeHtml(h.id)}" ${m.targets.has(h.id) ? "checked" : ""} />
                          <span class="mh-dot" style="background:${escapeHtml(h.accent)}"></span>
                          <span>${escapeHtml(h.name)}</span>
                        </label>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn mh-btn--ghost" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="modal-sync-submit" ${state.busy ? "disabled" : ""}>${iconSvg("sync", 14)}<span>${escapeHtml(t("syncSubmit"))}</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (m.type === "delete") {
      const configured = Object.keys(m.server.instances);
      return `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("deleteConfirmTitle", { name: m.server.name }))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("deleteConfirmHint"))}</p>
              <div class="mh-check-grid">
                ${configured
                  .map((hid) => {
                    const h = harnesses.find((x) => x.id === hid);
                    return `
                      <label class="mh-check-item">
                        <input type="checkbox" data-modal-target="${escapeHtml(hid)}" ${m.targets.has(hid) ? "checked" : ""} />
                        <span class="mh-dot" style="background:${escapeHtml(h?.accent ?? "#64748b")}"></span>
                        <span>${escapeHtml(h?.name ?? hid)}</span>
                      </label>
                    `;
                  })
                  .join("")}
              </div>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn mh-btn--ghost" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--danger" data-action="modal-delete-submit" ${state.busy ? "disabled" : ""}>${iconSvg("trash", 14)}<span>${escapeHtml(t("deleteSubmit"))}</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return "";
  };

  const buildPayloadFromEditor = () => {
    const m = state.modal;
    const isRemote = m.transport === "http" || m.transport === "sse";
    const kvObj = {};
    for (const row of m.kv) {
      const k = row.k.trim();
      if (k) kvObj[k] = row.v;
    }
    if (isRemote) {
      return {
        name: m.name.trim(),
        transport: m.transport,
        url: m.url.trim(),
        headers: kvObj,
        bearerTokenEnvVar: m.bearerTokenEnvVar.trim() || undefined,
        enabled: m.enabled,
      };
    }
    const args = m.argsText
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      name: m.name.trim(),
      transport: "stdio",
      command: m.command.trim(),
      args,
      env: kvObj,
      enabled: m.enabled,
    };
  };

  // -------------------------------------------------------------------------
  // Main Render
  // -------------------------------------------------------------------------

  const render = () => {
    if (disposed || signal.aborted) return;

    // Remember focus inside search box or modal inputs across re-renders.
    const activeEl = doc.activeElement;
    const activeKey =
      activeEl?.getAttribute("data-search-input") !== null
        ? { type: "search", pos: activeEl.selectionStart }
        : null;

    const serverCount = state.overview?.servers?.length ?? 0;
    const presetCount = state.overview?.presets?.length ?? 0;
    const backupCount = state.overview?.backups?.length ?? 0;

    root.innerHTML = `
      <div class="mh-shell">
        <header class="mh-header">
          <div class="mh-title-group">
            <div class="mh-brand-mark">${iconSvg("hub", 20)}</div>
            <div>
              <h1 class="mh-title">${escapeHtml(t("title"))}</h1>
              <p class="mh-subtitle">${escapeHtml(t("subtitle"))}</p>
            </div>
          </div>
          <div class="mh-header-actions">
            <button type="button" class="mh-btn mh-btn--primary" data-action="open-add" ${state.loading ? "disabled" : ""}>
              ${iconSvg("plus", 14)}<span>${escapeHtml(t("addServer"))}</span>
            </button>
            <button type="button" class="mh-btn" data-action="open-import" ${state.loading ? "disabled" : ""}>
              ${iconSvg("upload", 14)}<span>${escapeHtml(t("importJson"))}</span>
            </button>
            <button type="button" class="mh-btn" data-action="open-export" ${state.loading || serverCount === 0 ? "disabled" : ""}>
              ${iconSvg("download", 14)}<span>${escapeHtml(t("exportJson"))}</span>
            </button>
            <button type="button" class="mh-btn mh-btn--ghost" data-action="refresh" title="${escapeHtml(t("refresh"))}">
              ${iconSvg("refresh", 14)}
            </button>
          </div>
        </header>

        ${
          state.loading
            ? `<div class="mh-empty"><p>${escapeHtml(t("loading"))}</p></div>`
            : state.error
              ? `<div class="mh-error-banner">${escapeHtml(state.error)}</div>`
              : `
                ${renderHarnessRail()}

                <div class="mh-toolbar">
                  <div class="mh-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected="${state.activeTab === "servers"}" class="mh-tab${state.activeTab === "servers" ? " is-active" : ""}" data-action="switch-tab" data-tab="servers">
                      <span>${escapeHtml(t("tabServers"))}</span>
                      <span class="mh-tab-count">${serverCount}</span>
                    </button>
                    <button type="button" role="tab" aria-selected="${state.activeTab === "presets"}" class="mh-tab${state.activeTab === "presets" ? " is-active" : ""}" data-action="switch-tab" data-tab="presets">
                      <span>${escapeHtml(t("tabPresets"))}</span>
                      <span class="mh-tab-count">${presetCount}</span>
                    </button>
                    <button type="button" role="tab" aria-selected="${state.activeTab === "backups"}" class="mh-tab${state.activeTab === "backups" ? " is-active" : ""}" data-action="switch-tab" data-tab="backups">
                      <span>${escapeHtml(t("tabBackups"))}</span>
                      <span class="mh-tab-count">${backupCount}</span>
                    </button>
                  </div>

                  ${
                    state.activeTab === "servers"
                      ? `
                        <div class="mh-filters">
                          <div class="mh-search">
                            <span class="mh-search-icon">${iconSvg("search", 14)}</span>
                            <input class="mh-input" type="search" data-search-input="true" placeholder="${escapeHtml(t("searchPlaceholder"))}" value="${escapeHtml(state.search)}" />
                          </div>
                          <div class="mh-chip-group">
                            <button type="button" class="mh-chip${state.transportFilter === "all" ? " is-active" : ""}" data-action="filter-transport" data-transport="all">${escapeHtml(t("filterAll"))}</button>
                            <button type="button" class="mh-chip${state.transportFilter === "http" ? " is-active" : ""}" data-action="filter-transport" data-transport="http">${escapeHtml(t("filterHttp"))}</button>
                            <button type="button" class="mh-chip${state.transportFilter === "stdio" ? " is-active" : ""}" data-action="filter-transport" data-transport="stdio">${escapeHtml(t("filterStdio"))}</button>
                            <button type="button" class="mh-chip${state.onlyDrift ? " is-active" : ""}" data-action="filter-drift">${escapeHtml(t("filterDrift"))}</button>
                          </div>
                        </div>
                      `
                      : ""
                  }
                </div>

                ${
                  state.activeTab === "servers"
                    ? renderServersTab()
                    : state.activeTab === "presets"
                      ? renderPresetsTab()
                      : renderBackupsTab()
                }

                <div class="mh-footer-note">
                  ${iconSvg("hub", 14)}
                  <span>${escapeHtml(t("reloadHint"))}</span>
                </div>
              `
        }
      </div>
      ${renderModal()}
    `;

    renderToastOnly();

    if (activeKey?.type === "search") {
      const input = root.querySelector("[data-search-input]");
      if (input) {
        input.focus();
        if (typeof activeKey.pos === "number") {
          input.setSelectionRange(activeKey.pos, activeKey.pos);
        }
      }
    }
  };

  // -------------------------------------------------------------------------
  // Event Delegation (zero inline handlers, strict CSP safe)
  // -------------------------------------------------------------------------

  const onClick = async (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-action");

    if (action === "close-modal-backdrop") {
      if (event.target === target) {
        state.modal = null;
        render();
      }
      return;
    }

    if (action === "close-modal") {
      state.modal = null;
      render();
      return;
    }

    if (action === "refresh") {
      await loadOverview(false);
      return;
    }

    if (action === "open-add") {
      openAddModal();
      return;
    }

    if (action === "open-import") {
      openImportModal();
      return;
    }

    if (action === "open-export") {
      await openExportModal();
      return;
    }

    if (action === "switch-tab") {
      state.activeTab = target.getAttribute("data-tab") ?? "servers";
      render();
      return;
    }

    if (action === "filter-harness") {
      const hid = target.getAttribute("data-harness");
      state.selectedHarness = state.selectedHarness === hid ? null : hid;
      render();
      return;
    }

    if (action === "sync-all") {
      event.stopPropagation();
      const hid = target.getAttribute("data-harness");
      const h = (state.overview?.harnesses ?? []).find((x) => x.id === hid);
      if (!h || h.totalCount === 0) return;
      const win = doc.defaultView;
      if (
        win &&
        !win.confirm(t("syncAllConfirm", { source: h.name, count: h.totalCount }))
      ) {
        return;
      }
      const res = await invokeAndRefresh(
        "server.syncAll",
        { sourceHarnessId: hid },
        t("toastSyncAll", { source: h.name, count: h.totalCount }),
      );
      if (res?.synced) render();
      return;
    }

    if (action === "filter-transport") {
      state.transportFilter = target.getAttribute("data-transport") ?? "all";
      render();
      return;
    }

    if (action === "filter-drift") {
      state.onlyDrift = !state.onlyDrift;
      render();
      return;
    }

    if (action === "toggle-instance") {
      const name = target.getAttribute("data-name");
      const hid = target.getAttribute("data-harness");
      const next = target.getAttribute("data-next") === "true";
      const h = (state.overview?.harnesses ?? []).find((x) => x.id === hid);
      await invokeAndRefresh(
        "server.toggle",
        { name, harnessId: hid, enabled: next },
        t("toastToggled", { name, harness: h?.name ?? hid }),
      );
      return;
    }

    if (action === "quick-sync") {
      const name = target.getAttribute("data-name");
      const source = target.getAttribute("data-source");
      const targetHid = target.getAttribute("data-target");
      const h = (state.overview?.harnesses ?? []).find((x) => x.id === targetHid);
      await invokeAndRefresh(
        "server.sync",
        { name, sourceHarnessId: source, targets: [targetHid] },
        t("toastSynced", { name, targets: h?.name ?? targetHid }),
      );
      return;
    }

    if (action === "probe") {
      const name = target.getAttribute("data-name");
      await runProbe(name, state.selectedHarness);
      return;
    }

    if (action === "close-probe") {
      const name = target.getAttribute("data-name");
      state.expandedProbe.delete(name);
      render();
      return;
    }

    if (action === "open-sync") {
      const name = target.getAttribute("data-name");
      const server = (state.overview?.servers ?? []).find((s) => s.name === name);
      if (server) openSyncModal(server);
      return;
    }

    if (action === "open-edit") {
      const name = target.getAttribute("data-name");
      const server = (state.overview?.servers ?? []).find((s) => s.name === name);
      if (server) openEditModal(server);
      return;
    }

    if (action === "open-delete") {
      const name = target.getAttribute("data-name");
      const server = (state.overview?.servers ?? []).find((s) => s.name === name);
      if (server) openDeleteModal(server);
      return;
    }

    if (action === "use-preset") {
      const presetId = target.getAttribute("data-preset");
      const preset = (state.overview?.presets ?? []).find((p) => p.id === presetId);
      if (preset) {
        openAddModal({
          name: preset.id,
          transport: preset.transport,
          url: preset.url ?? "",
          command: preset.command ?? "npx",
          args: preset.args ?? [],
          headers: preset.headers ?? {},
          env: preset.env ?? {},
          enabled: true,
        });
      }
      return;
    }

    if (action === "restore-backup") {
      const backupId = target.getAttribute("data-backup");
      const harnessName = target.getAttribute("data-harness");
      const win = doc.defaultView;
      if (win && !win.confirm(t("restoreConfirm", { harness: harnessName }))) return;
      await invokeAndRefresh(
        "backups.restore",
        { backupId },
        t("toastRestored", { harness: harnessName }),
      );
      return;
    }

    if (action === "copy-text") {
      const text = target.getAttribute("data-text") ?? "";
      const ok = await copyToClipboard(text, doc).catch(() => false);
      showToast(ok ? t("copied") : "Copy failed", !ok);
      return;
    }

    if (action === "oauth-start") {
      const name = target.getAttribute("data-name");
      const server = (state.overview?.servers ?? []).find((s) => s.name === name);
      if (server) await startOAuth(server);
      return;
    }

    if (action === "oauth-cancel") {
      const name = target.getAttribute("data-name");
      const flow = state.oauthFlows.get(name);
      stopOAuthPolling(name);
      if (flow?.flowId) {
        await bridge.invoke("oauth.cancel", { flowId: flow.flowId }).catch(() => {});
      }
      state.oauthFlows.delete(name);
      render();
      return;
    }

    if (action === "oauth-manual-submit") {
      const name = target.getAttribute("data-name");
      const flow = state.oauthFlows.get(name);
      if (!flow?.flowId) return;
      try {
        const st = await bridge.invoke("oauth.completeManual", {
          flowId: flow.flowId,
          callbackUrlOrCode: flow.manualInput,
        });
        if (disposed || signal.aborted) return;
        state.oauthFlows.set(name, { ...flow, ...st });
        if (st.status !== "pending") stopOAuthPolling(name);
        render();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), true);
      }
      return;
    }

    if (action === "oauth-apply") {
      const name = target.getAttribute("data-name");
      const flow = state.oauthFlows.get(name);
      if (!flow?.flowId) return;
      const res = await invokeAndRefresh(
        "oauth.applyToken",
        { flowId: flow.flowId, serverName: name },
        null,
      );
      if (res) {
        stopOAuthPolling(name);
        state.oauthFlows.delete(name);
        showToast(t("toastOAuthApplied", { count: res.appliedTargets?.length ?? 1 }));
        await runProbe(name);
      }
      return;
    }

    // Modal-specific actions
    if (action === "kv-add" && state.modal?.type === "editor") {
      state.modal.kv.push({ k: "", v: "", reveal: false });
      render();
      return;
    }

    if (action === "kv-del" && state.modal?.type === "editor") {
      const idx = Number(target.getAttribute("data-idx"));
      state.modal.kv.splice(idx, 1);
      if (state.modal.kv.length === 0) state.modal.kv.push({ k: "", v: "", reveal: false });
      render();
      return;
    }

    if (action === "kv-reveal" && state.modal?.type === "editor") {
      const idx = Number(target.getAttribute("data-idx"));
      if (state.modal.kv[idx]) {
        state.modal.kv[idx].reveal = !state.modal.kv[idx].reveal;
        render();
      }
      return;
    }

    if (action === "modal-probe" && state.modal?.type === "editor") {
      state.modal.probing = true;
      state.modal.formError = null;
      render();
      try {
        const payload = buildPayloadFromEditor();
        const data = await bridge.invoke("server.probe", { server: payload });
        if (disposed || signal.aborted || state.modal?.type !== "editor") return;
        state.modal.probing = false;
        state.modal.probeResult = data;
        render();
      } catch (error) {
        if (disposed || signal.aborted || state.modal?.type !== "editor") return;
        state.modal.probing = false;
        state.modal.formError = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }

    if (action === "modal-save" && state.modal?.type === "editor") {
      const targets = [...state.modal.targets];
      if (targets.length === 0) {
        state.modal.formError = "Select at least one target harness";
        render();
        return;
      }
      try {
        const payload = buildPayloadFromEditor();
        const res = await bridge.invoke("server.upsert", { server: payload, targets });
        if (disposed || signal.aborted) return;
        state.overview = { ...state.overview, ...res.overview };
        state.modal = null;
        showToast(t("toastSaved", { count: targets.length }));
        render();
      } catch (error) {
        if (disposed || signal.aborted || state.modal?.type !== "editor") return;
        state.modal.formError = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }

    if (action === "modal-import-submit" && state.modal?.type === "import") {
      const targets = [...state.modal.targets];
      try {
        const res = await bridge.invoke("config.importJson", {
          rawJson: state.modal.rawJson,
          targets,
        });
        if (disposed || signal.aborted) return;
        state.overview = { ...state.overview, ...res.overview };
        state.modal = null;
        showToast(t("toastImported", { count: res.imported?.length ?? 0 }));
        render();
      } catch (error) {
        if (disposed || signal.aborted || state.modal?.type !== "import") return;
        state.modal.formError = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }

    if (action === "modal-sync-submit" && state.modal?.type === "sync") {
      const targets = [...state.modal.targets].filter((id) => id !== state.modal.sourceHarnessId);
      if (targets.length === 0) return;
      const name = state.modal.server.name;
      const sourceHarnessId = state.modal.sourceHarnessId;
      state.modal = null;
      const harnesses = state.overview?.harnesses ?? [];
      const names = targets.map((id) => harnesses.find((x) => x.id === id)?.shortName ?? id).join(", ");
      await invokeAndRefresh(
        "server.sync",
        { name, sourceHarnessId, targets },
        t("toastSynced", { name, targets: names }),
      );
      return;
    }

    if (action === "modal-delete-submit" && state.modal?.type === "delete") {
      const targets = [...state.modal.targets];
      if (targets.length === 0) return;
      const name = state.modal.server.name;
      state.modal = null;
      await invokeAndRefresh("server.delete", { name, targets }, t("toastDeleted", { name }));
    }
  };

  const onInput = (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;

    if (el.hasAttribute("data-search-input")) {
      state.search = el.value;
      render();
      return;
    }

    const oauthManual = el.getAttribute("data-oauth-manual");
    if (oauthManual) {
      const flow = state.oauthFlows.get(oauthManual);
      if (flow) flow.manualInput = el.value;
      return;
    }

    if (!state.modal) return;
    const field = el.getAttribute("data-field");
    if (field) {
      state.modal[field] = el.value;
      if (field === "transport" || field === "sourceHarnessId") {
        if (field === "sourceHarnessId" && state.modal.type === "sync") {
          state.modal.targets.delete(el.value);
        }
        render();
      }
      return;
    }

    const kvKey = el.getAttribute("data-kv-key");
    if (kvKey !== null && state.modal.type === "editor") {
      const idx = Number(kvKey);
      if (state.modal.kv[idx]) state.modal.kv[idx].k = el.value;
      return;
    }

    const kvVal = el.getAttribute("data-kv-val");
    if (kvVal !== null && state.modal.type === "editor") {
      const idx = Number(kvVal);
      if (state.modal.kv[idx]) state.modal.kv[idx].v = el.value;
    }
  };

  const onChange = (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (!state.modal) return;

    const targetId = el.getAttribute("data-modal-target");
    if (targetId && state.modal.targets instanceof Set) {
      if (el.checked) state.modal.targets.add(targetId);
      else state.modal.targets.delete(targetId);
      return;
    }

    const boolField = el.getAttribute("data-field-bool");
    if (boolField) {
      state.modal[boolField] = el.checked;
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape" && state.modal) {
      state.modal = null;
      render();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element) {
      const card = event.target.closest('[data-action="filter-harness"]');
      if (card && event.target === card) {
        event.preventDefault();
        const hid = card.getAttribute("data-harness");
        state.selectedHarness = state.selectedHarness === hid ? null : hid;
        render();
      }
    }
  };

  root.addEventListener("click", onClick, { signal });
  root.addEventListener("input", onInput, { signal });
  root.addEventListener("change", onChange, { signal });
  doc.addEventListener("keydown", onKeyDown, { signal });

  const unsubLocale = bridge.onLocaleChange(() => render());
  const unsubScheme = bridge.onColorSchemeChange((scheme) => {
    root.dataset.mhScheme = scheme === "dark" ? "dark" : "light";
  });

  render();
  void loadOverview(false);

  return () => {
    disposed = true;
    if (toastTimer) clearTimeout(toastTimer);
    for (const name of [...oauthTimers.keys()]) stopOAuthPolling(name);
    unsubLocale?.();
    unsubScheme?.();
    root.remove();
  };
}
