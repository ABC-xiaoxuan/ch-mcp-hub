/**
 * Shared MCP Hub v1.1 UI controller — mounted by both `web/index.mjs` (Web left sidebar)
 * and `page/index.mjs` (Desktop Settings plugin page & Web Plugin workspace tab).
 *
 * Performance architecture:
 * - Region-based targeted DOM rendering: mounts persistent slots once and patches only the
 *   affected region (header / rail / toolbar / content / footer / drawer / modal / toast).
 * - Persistent `<input data-search-input>` with IME composition guard & 60ms debounce so
 *   searching never drops focus or breaks Chinese/Japanese/Korean input.
 * - Single-card probe & tool-search patching (`patchServerCard`) so inspecting one server or
 *   filtering its tools never re-renders sibling cards.
 * - Optimistic/in-place pending state on matrix pills and plugin switches.
 * - Zero `window.confirm()` dialogs; uses GPU-composited slide-over drawer & custom modals.
 */

import { createTranslator, resolveLocale } from "./i18n.mjs";
import { iconSvg } from "./icons.mjs";

const HARNESS_ORDER = ["claude-code", "antigravity", "opencode", "codex"];
const TOOLS_INITIAL_LIMIT = 12;
const SEARCH_DEBOUNCE_MS = 60;
const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 2500;

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
  return String(p).replace(/^([A-Za-z]:\\Users\\[^\\]+|\/Users\/[^/]+|\/home\/[^/]+)/u, "~");
}

/**
 * Shell-style single-line command tokenizer supporting single quotes, double quotes,
 * and backslash escapes for quick Stdio command paste.
 */
export function tokenizeCommandLine(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [];
  const tokens = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      // Preserve Windows drive/path backslashes unless escaping whitespace or quotes.
      const next = input[i + 1];
      if (next && (next === '"' || next === "'" || next === " " || next === "\\")) {
        escaped = true;
        continue;
      }
      cur += ch;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
        hasToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

function formatDiffValue(val) {
  if (Array.isArray(val)) return val.length ? val.join(" ") : "—";
  if (val === "" || val === null || val === undefined) return "—";
  return String(val);
}

function matchPresetCategory(preset, category) {
  if (category === "all") return true;
  if (category === "oauth") return Boolean(preset.oauthHint);
  if (category === "local") return preset.transport === "stdio";
  if (category === "dev") {
    return ["devtools", "docs", "browser", "data", "workflow"].includes(preset.category);
  }
  if (category === "knowledge") {
    return ["knowledge", "reasoning", "design"].includes(preset.category);
  }
  return true;
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

  // Mount persistent region skeleton once — never rebuild this outer structure.
  root.innerHTML = `
    <div class="mh-shell">
      <div data-region="header"></div>
      <div data-region="rail"></div>
      <div class="mh-toolbar" data-region="toolbar">
        <div class="mh-tabs" role="tablist" data-region="tabs"></div>
        <div class="mh-filters" data-region="filters">
          <div class="mh-search">
            <span class="mh-search-icon">${iconSvg("search", 14)}</span>
            <input class="mh-input" type="search" data-search-input aria-label="Search" />
          </div>
          <div class="mh-chip-group" data-region="chips"></div>
        </div>
      </div>
      <div data-region="content"></div>
      <div data-region="footer"></div>
    </div>
    <div data-region="drawer"></div>
    <div data-region="modal"></div>
    <div data-region="toast"></div>
  `;
  container.replaceChildren(root);

  const slots = {
    header: root.querySelector('[data-region="header"]'),
    rail: root.querySelector('[data-region="rail"]'),
    toolbar: root.querySelector('[data-region="toolbar"]'),
    tabs: root.querySelector('[data-region="tabs"]'),
    filters: root.querySelector('[data-region="filters"]'),
    searchInput: root.querySelector("[data-search-input]"),
    chips: root.querySelector('[data-region="chips"]'),
    content: root.querySelector('[data-region="content"]'),
    footer: root.querySelector('[data-region="footer"]'),
    drawer: root.querySelector('[data-region="drawer"]'),
    modal: root.querySelector('[data-region="modal"]'),
    toast: root.querySelector('[data-region="toast"]'),
  };

  const state = {
    loading: true,
    refreshing: false,
    probingAll: false,
    busy: false,
    error: null,
    overview: null,
    activeTab: "servers", // servers | scoped | presets | backups
    selectedHarness: null,
    transportFilter: "all", // all | http | stdio
    onlyDrift: false,
    presetCategory: "all", // all | oauth | local | dev | knowledge
    search: "",
    probes: new Map(), // serverName -> { loading, data }
    expandedProbe: new Set(),
    toolSearch: new Map(), // serverName -> query string
    toolsExpanded: new Set(), // serverName -> expanded past TOOLS_INITIAL_LIMIT
    oauthFlows: new Map(),
    drawer: null, // editor slide-over state
    modal: null, // sync | delete | import | export | confirm
    toast: null,
  };

  let toastTimer = null;
  let searchDebounceTimer = null;
  let isComposingSearch = false;
  let lastRefreshAt = 0;
  let previewSeq = 0;
  const oauthTimers = new Map();
  let disposed = false;

  const stopOAuthPolling = (serverName) => {
    const timer = oauthTimers.get(serverName);
    if (timer) {
      clearInterval(timer);
      oauthTimers.delete(serverName);
    }
  };

  const findServer = (name) => (state.overview?.servers ?? []).find((s) => s.name === name) ?? null;

  const findCardEl = (serverName) => {
    const cards = slots.content.querySelectorAll(".mh-server-card[data-server]");
    for (const card of cards) {
      if (card.dataset.server === serverName) return card;
    }
    return null;
  };

  const hydrateCachedProbes = (cachedProbes) => {
    if (!cachedProbes || typeof cachedProbes !== "object") return;
    for (const [name, data] of Object.entries(cachedProbes)) {
      const existing = state.probes.get(name);
      if (!existing || (!existing.loading && (!existing.data?.probedAt || (data.probedAt ?? 0) >= existing.data.probedAt))) {
        state.probes.set(name, { loading: false, data });
      }
    }
  };

  const showToast = (text, isError = false) => {
    state.toast = { text, isError };
    if (toastTimer) clearTimeout(toastTimer);
    renderToast();
    toastTimer = setTimeout(() => {
      state.toast = null;
      renderToast();
    }, 3400);
  };

  // -------------------------------------------------------------------------
  // Data Actions
  // -------------------------------------------------------------------------

  const invoke = (method, params) => {
    const clean = (val) => {
      if (val === undefined) return null;
      if (val === null || typeof val !== "object") return val;
      if (Array.isArray(val)) return val.map((item) => clean(item));
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        if (v !== undefined) out[k] = clean(v);
      }
      return out;
    };
    return params === undefined ? bridge.invoke(method) : bridge.invoke(method, clean(params));
  };

  const indexSearchHaystacks = (overview) => {
    if (!overview) return;
    for (const s of overview.servers ?? []) {
      s._hay = `${s.name} ${s.url ?? ""} ${s.command ?? ""} ${(s.args ?? []).join(" ")}`.toLowerCase();
    }
    for (const p of overview.presets ?? []) {
      const en = p.description?.en ?? "";
      const zh = p.description?.["zh-CN"] ?? "";
      p._hay = `${p.id} ${p.name} ${en} ${zh} ${p.url ?? ""} ${p.command ?? ""} ${(p.args ?? []).join(" ")}`.toLowerCase();
    }
  };

  const loadOverview = async (silent = false) => {
    if (!silent) {
      state.loading = true;
      state.error = null;
      renderAll();
    } else {
      state.refreshing = true;
      renderHeader();
    }
    try {
      const data = await invoke("overview.get");
      if (disposed || signal.aborted) return;
      indexSearchHaystacks(data);
      state.overview = data;
      hydrateCachedProbes(data?.cachedProbes);
      state.loading = false;
      state.refreshing = false;
      state.error = null;
      lastRefreshAt = Date.now();
      renderAll();
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.loading = false;
      state.refreshing = false;
      if (!silent || !state.overview) {
        state.error = error instanceof Error ? error.message : String(error);
      }
      renderAll();
    }
  };

  const applyOverviewUpdate = (nextOverview) => {
    if (!nextOverview) return;
    indexSearchHaystacks(nextOverview);
    state.overview = {
      ...state.overview,
      ...nextOverview,
    };
    hydrateCachedProbes(nextOverview.cachedProbes);
    lastRefreshAt = Date.now();
  };

  const invokeWithOverview = async (
    method,
    params,
    successMsg,
    { lockGlobal = true, patchRow = null } = {},
  ) => {
    if (lockGlobal) {
      state.busy = true;
      renderHeader();
      if (state.drawer) renderDrawer();
      if (state.modal) renderModal();
    }
    try {
      const res = await invoke(method, params);
      if (disposed || signal.aborted) return res;
      if (res?.overview) applyOverviewUpdate(res.overview);
      if (lockGlobal) state.busy = false;
      if (successMsg) showToast(successMsg);
      renderHeader();
      renderRail();
      renderToolbar();
      // Fast O(1) single-row DOM patch when toggling a pill or quick-syncing (0 sibling rebuilds).
      const patched =
        patchRow &&
        state.activeTab === "servers" &&
        !state.selectedHarness &&
        !state.onlyDrift &&
        patchServerMatrixRow(patchRow);
      if (!patched) renderContent();
      renderFooter();
      return res;
    } catch (error) {
      if (disposed || signal.aborted) return null;
      if (lockGlobal) state.busy = false;
      showToast(error instanceof Error ? error.message : String(error), true);
      renderHeader();
      if (state.drawer) renderDrawer();
      if (state.modal) renderModal();
      return null;
    }
  };

  const runProbe = async (serverName, { harnessId = null, force = true } = {}) => {
    state.expandedProbe.add(serverName);
    state.probes.set(serverName, { loading: true, data: null });
    patchServerCard(serverName);
    try {
      const data = await invoke("server.probe", { name: serverName, harnessId, force });
      if (disposed || signal.aborted) return;
      state.probes.set(serverName, { loading: false, data });
      patchServerCard(serverName);
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.probes.set(serverName, {
        loading: false,
        data: { status: "error", message: error instanceof Error ? error.message : String(error) },
      });
      patchServerCard(serverName);
    }
  };

  const runProbeAll = async () => {
    if (state.probingAll) return;
    const servers = state.overview?.servers ?? [];
    if (servers.length === 0) return;
    state.probingAll = true;
    renderHeader();
    try {
      const res = await invoke("server.probeAll", { force: true });
      if (disposed || signal.aborted) return;
      const results = res?.results ?? {};
      let count = 0;
      for (const [name, data] of Object.entries(results)) {
        state.probes.set(name, { loading: false, data });
        count += 1;
        patchServerCard(name);
      }
      state.probingAll = false;
      renderHeader();
      showToast(t("toastProbedAll", { count }));
    } catch (error) {
      if (disposed || signal.aborted) return;
      state.probingAll = false;
      renderHeader();
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const startOAuth = async (server) => {
    stopOAuthPolling(server.name);
    state.oauthFlows.set(server.name, { starting: true, status: "starting" });
    patchServerCard(server.name);
    try {
      const started = await invoke("oauth.start", {
        serverName: server.name,
        url: server.url,
      });
      if (disposed || signal.aborted) return;
      state.oauthFlows.set(server.name, {
        ...started,
        status: "pending",
        hasToken: false,
        error: null,
        manualInput: "",
      });
      patchServerCard(server.name);

      const timer = setInterval(async () => {
        if (disposed || signal.aborted) {
          stopOAuthPolling(server.name);
          return;
        }
        try {
          const st = await invoke("oauth.status", { flowId: started.flowId });
          if (disposed || signal.aborted) return;
          const prev = state.oauthFlows.get(server.name);
          if (!prev || prev.flowId !== started.flowId) {
            stopOAuthPolling(server.name);
            return;
          }
          if (st.status !== prev.status || st.hasToken !== prev.hasToken || st.error !== prev.error) {
            state.oauthFlows.set(server.name, { ...prev, ...st });
            if (st.status !== "pending") stopOAuthPolling(server.name);
            patchServerCard(server.name);
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
      patchServerCard(server.name);
    }
  };

  // -------------------------------------------------------------------------
  // Filtering Helpers
  // -------------------------------------------------------------------------

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
      if (q && !(item._hay ?? "").includes(q)) return false;
      return true;
    });
  };

  const filteredPresets = () => {
    const presets = state.overview?.presets ?? [];
    const q = state.search.trim().toLowerCase();
    return presets.filter((preset) => {
      if (!matchPresetCategory(preset, state.presetCategory)) return false;
      if (q && !(preset._hay ?? "").includes(q)) return false;
      return true;
    });
  };

  // -------------------------------------------------------------------------
  // Drawer & Modal Openers
  // -------------------------------------------------------------------------

  const buildDrawerPayload = (d) => {
    const kvObj = {};
    for (const row of d.kv) {
      const k = row.k.trim();
      if (k) kvObj[k] = row.v;
    }
    if (d.transport === "http" || d.transport === "sse") {
      const bearer = d.bearerTokenEnvVar.trim();
      return {
        name: d.name.trim(),
        transport: d.transport,
        url: d.url.trim(),
        headers: kvObj,
        ...(bearer ? { bearerTokenEnvVar: bearer } : {}),
        enabled: d.enabled,
      };
    }
    return {
      name: d.name.trim(),
      transport: "stdio",
      command: d.command.trim(),
      args: d.argsText
        .split(/\r?\n/u)
        .map((s) => s.trim())
        .filter(Boolean),
      env: kvObj,
      enabled: d.enabled,
    };
  };

  const refreshDrawerPreview = async () => {
    const d = state.drawer;
    if (!d || d.activeTab !== "preview") return;
    const seq = ++previewSeq;
    const targets = [...d.targets];
    if (targets.length === 0) {
      d.previewLoading = false;
      d.previews = null;
      d.previewError = t("previewEmptyHint");
      renderDrawer();
      return;
    }
    d.previewLoading = true;
    d.previewError = null;
    renderDrawer();
    try {
      const res = await invoke("server.previewNative", {
        server: buildDrawerPayload(d),
        targets,
      });
      if (disposed || signal.aborted || seq !== previewSeq || !state.drawer) return;
      state.drawer.previewLoading = false;
      state.drawer.previews = res?.previews ?? {};
      state.drawer.previewError = null;
      renderDrawer();
    } catch (error) {
      if (disposed || signal.aborted || seq !== previewSeq || !state.drawer) return;
      state.drawer.previewLoading = false;
      state.drawer.previews = null;
      state.drawer.previewError = error instanceof Error ? error.message : String(error);
      renderDrawer();
    }
  };

  const loadDrawerInstanceValues = (d, inst) => {
    const transport = inst.transport ?? "http";
    const kvEntries =
      transport === "stdio"
        ? Object.entries(inst.env ?? {})
        : Object.entries(inst.headers ?? {});
    d.transport = transport;
    d.url = inst.url ?? "";
    d.command = inst.command ?? "npx";
    d.argsText = Array.isArray(inst.args) ? inst.args.join("\n") : "";
    d.bearerTokenEnvVar = inst.bearerTokenEnvVar ?? "";
    d.enabled = inst.enabled !== false;
    d.kv =
      kvEntries.length > 0
        ? kvEntries.map(([k, v]) => ({ k, v, reveal: false }))
        : [{ k: "", v: "", reveal: false }];
    d.quickCmd = "";
    d.probeResult = null;
    d.formError = null;
  };

  const openEditorDrawer = (prefill = null, { editServer = null } = {}) => {
    const sourceHarnessId = editServer
      ? state.selectedHarness && editServer.instances[state.selectedHarness]
        ? state.selectedHarness
        : editServer.primaryHarnessId
      : null;

    const base = editServer
      ? { ...editServer.instances[sourceHarnessId], name: editServer.name }
      : prefill ?? {
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

    const defaultTargets = editServer
      ? Object.keys(editServer.instances)
      : prefill?._targets
        ? prefill._targets
        : (state.overview?.harnesses ?? []).filter((h) => h.exists).map((h) => h.id);

    const targets = new Set(defaultTargets.length > 0 ? defaultTargets : HARNESS_ORDER);

    const drawerState = {
      isEdit: Boolean(editServer),
      editServer,
      sourceHarnessId,
      activeTab: "form", // form | preview
      name: base.name ?? "",
      transport: base.transport ?? "http",
      url: "",
      command: "npx",
      argsText: "",
      quickCmd: "",
      bearerTokenEnvVar: "",
      enabled: true,
      kv: [{ k: "", v: "", reveal: false }],
      targets,
      probeResult: null,
      probing: false,
      formError: null,
      previewLoading: false,
      previews: null,
      previewError: null,
    };
    loadDrawerInstanceValues(drawerState, base);
    state.drawer = drawerState;
    renderDrawer();
  };

  const openSyncModal = (server) => {
    const configured = Object.keys(server.instances);
    const source =
      state.selectedHarness && server.instances[state.selectedHarness]
        ? state.selectedHarness
        : configured[0];
    const missing = HARNESS_ORDER.filter((id) => id !== source && !server.instances[id]);
    state.modal = {
      type: "sync",
      server,
      sourceHarnessId: source,
      targets: new Set(missing.length > 0 ? missing : HARNESS_ORDER.filter((id) => id !== source)),
    };
    renderModal();
  };

  const openDeleteModal = (server) => {
    state.modal = {
      type: "delete",
      server,
      targets: new Set(Object.keys(server.instances)),
    };
    renderModal();
  };

  const openImportModal = () => {
    const existingHarnesses = (state.overview?.harnesses ?? []).filter((h) => h.exists).map((h) => h.id);
    state.modal = {
      type: "import",
      rawJson: "",
      targets: new Set(existingHarnesses.length > 0 ? existingHarnesses : HARNESS_ORDER),
      formError: null,
    };
    renderModal();
  };

  const openExportModal = async () => {
    try {
      const res = await invoke("config.exportJson", {
        harnessId: state.selectedHarness,
      });
      if (disposed || signal.aborted) return;
      state.modal = {
        type: "export",
        json: res.json,
      };
      renderModal();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const openConfirmModal = ({ title, message, confirmLabel = null, danger = false, onConfirm }) => {
    state.modal = {
      type: "confirm",
      title,
      message,
      confirmLabel: confirmLabel ?? t("confirm"),
      danger,
      onConfirm,
    };
    renderModal();
  };

  // -------------------------------------------------------------------------
  // Region Renderers
  // -------------------------------------------------------------------------

  const renderToast = () => {
    if (!state.toast) {
      slots.toast.innerHTML = "";
      return;
    }
    slots.toast.innerHTML = `
      <div class="mh-toast${state.toast.isError ? " is-error" : ""}" role="status">
        ${iconSvg(state.toast.isError ? "warning" : "check", 15)}
        <span>${escapeHtml(state.toast.text)}</span>
      </div>
    `;
  };

  const renderHeader = () => {
    const hasServers = (state.overview?.servers?.length ?? 0) > 0;
    slots.header.innerHTML = `
      <header class="mh-header">
        <div class="mh-title-group">
          <div class="mh-brand-mark">${iconSvg("hub", 20)}</div>
          <div>
            <h1 class="mh-title">${escapeHtml(t("title"))}</h1>
            <p class="mh-subtitle">${escapeHtml(t("subtitle"))}</p>
          </div>
        </div>
        <div class="mh-header-actions">
          <button type="button" class="mh-btn mh-btn--primary" data-action="open-add" ${state.busy ? "disabled" : ""}>
            ${iconSvg("plus", 14)}<span>${escapeHtml(t("addServer"))}</span>
          </button>
          <button type="button" class="mh-btn${state.probingAll ? " mh-spin" : ""}" data-action="probe-all" ${state.busy || state.probingAll || !hasServers ? "disabled" : ""}>
            ${iconSvg("radar", 14)}<span>${escapeHtml(t(state.probingAll ? "probingAll" : "probeAll"))}</span>
          </button>
          <button type="button" class="mh-btn" data-action="open-import" ${state.busy ? "disabled" : ""}>
            ${iconSvg("upload", 14)}<span>${escapeHtml(t("importJson"))}</span>
          </button>
          <button type="button" class="mh-btn" data-action="open-export" ${state.busy ? "disabled" : ""}>
            ${iconSvg("download", 14)}<span>${escapeHtml(t("exportJson"))}</span>
          </button>
          <button type="button" class="mh-btn mh-btn--ghost${state.refreshing ? " mh-spin" : ""}" data-action="refresh" title="${escapeHtml(t("refresh"))}" aria-label="${escapeHtml(t("refresh"))}" ${state.busy ? "disabled" : ""}>
            ${iconSvg("refresh", 15)}
          </button>
        </div>
      </header>
    `;
  };

  const renderRail = () => {
    const harnesses = state.overview?.harnesses ?? [];
    if (harnesses.length === 0) {
      slots.rail.innerHTML = "";
      return;
    }
    slots.rail.innerHTML = `
      <section class="mh-harness-rail" aria-label="Harnesses">
        ${harnesses
          .map((h) => {
            const selected = state.selectedHarness === h.id;
            const pathLabel = h.exists ? shortenPath(h.configPath) : t("notCreatedYet");
            return `
              <div
                class="mh-harness-card${selected ? " is-selected" : ""}"
                style="--card-accent:${escapeHtml(h.accent)}"
                data-action="filter-harness"
                data-harness="${escapeHtml(h.id)}"
                role="button"
                tabindex="0"
                aria-pressed="${selected ? "true" : "false"}"
              >
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

  const renderToolbar = () => {
    const hasOverview = Boolean(state.overview);
    slots.toolbar.hidden = !hasOverview;
    if (!hasOverview) return;

    const serverCount = state.overview.servers?.length ?? 0;
    const scopedCount =
      (state.overview.nativePlugins?.length ?? 0) + (state.overview.scopedServers?.length ?? 0);
    const presetCount = state.overview.presets?.length ?? 0;
    const backupCount = state.overview.backups?.length ?? 0;

    slots.tabs.innerHTML = `
      <button type="button" role="tab" aria-selected="${state.activeTab === "servers"}" class="mh-tab${state.activeTab === "servers" ? " is-active" : ""}" data-action="switch-tab" data-tab="servers">
        ${escapeHtml(t("tabServers"))} <span class="mh-tab-count">${serverCount}</span>
      </button>
      <button type="button" role="tab" aria-selected="${state.activeTab === "scoped"}" class="mh-tab${state.activeTab === "scoped" ? " is-active" : ""}" data-action="switch-tab" data-tab="scoped">
        ${escapeHtml(t("tabScoped"))} <span class="mh-tab-count">${scopedCount}</span>
      </button>
      <button type="button" role="tab" aria-selected="${state.activeTab === "presets"}" class="mh-tab${state.activeTab === "presets" ? " is-active" : ""}" data-action="switch-tab" data-tab="presets">
        ${escapeHtml(t("tabPresets"))} <span class="mh-tab-count">${presetCount}</span>
      </button>
      <button type="button" role="tab" aria-selected="${state.activeTab === "backups"}" class="mh-tab${state.activeTab === "backups" ? " is-active" : ""}" data-action="switch-tab" data-tab="backups">
        ${escapeHtml(t("tabBackups"))} <span class="mh-tab-count">${backupCount}</span>
      </button>
    `;

    const showFilters = state.activeTab === "servers" || state.activeTab === "presets";
    slots.filters.hidden = !showFilters;
    if (!showFilters) return;

    // Update search placeholder in place without touching DOM node or focus!
    const nextPlaceholder =
      state.activeTab === "presets" ? t("presetSearchPlaceholder") : t("searchPlaceholder");
    if (slots.searchInput.placeholder !== nextPlaceholder) {
      slots.searchInput.placeholder = nextPlaceholder;
    }
    if (slots.searchInput.value !== state.search && doc.activeElement !== slots.searchInput) {
      slots.searchInput.value = state.search;
    }

    if (state.activeTab === "servers") {
      slots.chips.innerHTML = `
        <button type="button" class="mh-chip${state.transportFilter === "all" && !state.onlyDrift ? " is-active" : ""}" data-action="filter-transport" data-value="all">${escapeHtml(t("filterAll"))}</button>
        <button type="button" class="mh-chip${state.transportFilter === "http" ? " is-active" : ""}" data-action="filter-transport" data-value="http">${escapeHtml(t("filterHttp"))}</button>
        <button type="button" class="mh-chip${state.transportFilter === "stdio" ? " is-active" : ""}" data-action="filter-transport" data-value="stdio">${escapeHtml(t("filterStdio"))}</button>
        <button type="button" class="mh-chip${state.onlyDrift ? " is-active" : ""}" data-action="toggle-drift">${escapeHtml(t("filterDrift"))}</button>
      `;
    } else {
      const cats = [
        ["all", "presetCatAll"],
        ["oauth", "presetCatOAuth"],
        ["local", "presetCatLocal"],
        ["dev", "presetCatDev"],
        ["knowledge", "presetCatKnowledge"],
      ];
      slots.chips.innerHTML = cats
        .map(
          ([val, key]) =>
            `<button type="button" class="mh-chip${state.presetCategory === val ? " is-active" : ""}" data-action="filter-preset-cat" data-value="${val}">${escapeHtml(t(key))}</button>`,
        )
        .join("");
    }
  };

  // -------------------------------------------------------------------------
  // Probe & Tools Builders (supports targeted single-card & tools-only patch)
  // -------------------------------------------------------------------------

  const renderHealthMeta = (serverName) => {
    const probeState = state.probes.get(serverName);
    const status = probeState?.data?.status;
    let dotCls = "";
    let badgeHtml = "";
    if (status === "ok") {
      dotCls = " is-ok";
      badgeHtml = `<span class="mh-badge mh-badge--ok">${
        probeState.data.toolCount !== undefined ? `${probeState.data.toolCount} tools` : "OK"
      }</span>`;
    } else if (status === "auth_required") {
      dotCls = " is-auth";
      badgeHtml = `<span class="mh-badge mh-badge--warn">OAuth</span>`;
    } else if (status === "error") {
      dotCls = " is-error";
      badgeHtml = `<span class="mh-badge mh-badge--err">ERR</span>`;
    }
    return { dotCls, badgeHtml };
  };

  const renderToolsGridHtml = (serverName, tools) => {
    const q = (state.toolSearch.get(serverName) ?? "").trim().toLowerCase();
    const filtered = q
      ? tools.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            (item.description && item.description.toLowerCase().includes(q)),
        )
      : tools;

    if (filtered.length === 0) {
      return `<p class="mh-hint">${escapeHtml(t("noMatchTitle"))}</p>`;
    }

    const isExpanded = state.toolsExpanded.has(serverName) || Boolean(q);
    const visible = isExpanded ? filtered : filtered.slice(0, TOOLS_INITIAL_LIMIT);
    const hiddenCount = filtered.length - visible.length;

    return `
      <div class="mh-tools-grid">
        ${visible
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
      ${
        !q && filtered.length > TOOLS_INITIAL_LIMIT
          ? `
            <div style="margin-top:8px">
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="toggle-tools-expand" data-name="${escapeHtml(serverName)}">
                ${escapeHtml(isExpanded ? t("probeToolsCollapse") : t("probeToolsShowMore", { count: hiddenCount }))}
              </button>
            </div>
          `
          : ""
      }
    `;
  };

  const renderProbePanelHtml = (server) => {
    if (!state.expandedProbe.has(server.name)) return "";
    const probeState = state.probes.get(server.name);
    const oauthState = state.oauthFlows.get(server.name);
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));

    if (!probeState || probeState.loading) {
      return `
        <div class="mh-probe-panel">
          <div class="mh-probe-status mh-spin">${iconSvg("radar", 15)}<span>${escapeHtml(t("probing"))}</span></div>
        </div>
      `;
    }

    const res = probeState.data ?? { status: "error", message: "No probe data" };
    const cachedBadge = res.cached
      ? `<span class="mh-badge">${escapeHtml(t("probeCachedTag"))}</span>`
      : "";
    const headerButtons = `
      <div style="display:inline-flex;align-items:center;gap:4px">
        <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="reprobe" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("refresh"))}">${iconSvg("refresh", 13)}</button>
        <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-probe" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("close"))}">${iconSvg("close", 13)}</button>
      </div>
    `;

    let body = "";
    if (res.status === "ok") {
      if (server.transport === "stdio") {
        body = `
          <div class="mh-probe-header">
            <div class="mh-probe-status is-ok">
              ${iconSvg("check", 15)}
              <span>${escapeHtml(t("probeOkStdio", { path: res.resolvedCommand ?? server.command }))}</span>
              ${cachedBadge}
            </div>
            ${headerButtons}
          </div>
        `;
      } else {
        const tools = Array.isArray(res.tools) ? res.tools : [];
        const toolQuery = state.toolSearch.get(server.name) ?? "";
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
              ${cachedBadge}
            </div>
            ${headerButtons}
          </div>
          ${
            tools.length > 0
              ? `
                <div class="mh-tools-bar">
                  <div class="mh-label">${escapeHtml(t("probeToolsHeading", { count: tools.length }))}</div>
                  ${
                    tools.length > 6
                      ? `<input class="mh-input" type="search" data-tool-search="${escapeHtml(server.name)}" value="${escapeHtml(toolQuery)}" placeholder="${escapeHtml(t("probeToolsSearch"))}" />`
                      : ""
                  }
                </div>
                <div class="mh-tools-slot">${renderToolsGridHtml(server.name, tools)}</div>
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
            ${cachedBadge}
          </div>
          ${headerButtons}
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
                  <button type="button" class="mh-btn mh-btn--sm" data-action="copy-text" data-text="${escapeHtml(cmd)}" aria-label="${escapeHtml(t("copy"))}">${iconSvg("copy", 13)}</button>
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
          ${headerButtons}
        </div>
      `;
    }

    return `<div class="mh-probe-panel">${body}</div>`;
  };

  /**
   * Targeted single-card update — patches ONLY the affected card's health dot,
   * probe badge, and inline probe panel without touching any sibling server cards.
   */
  const patchServerCard = (serverName) => {
    if (state.activeTab !== "servers") return;
    const card = findCardEl(serverName);
    const server = findServer(serverName);
    if (!card || !server) return;

    const { dotCls, badgeHtml } = renderHealthMeta(serverName);
    const dotEl = card.querySelector("[data-health-dot]");
    if (dotEl) dotEl.className = `mh-health-dot${dotCls}`;
    const badgeSlot = card.querySelector("[data-probe-badge-slot]");
    if (badgeSlot) badgeSlot.innerHTML = badgeHtml;
    const probeSlot = card.querySelector("[data-probe-slot]");
    if (probeSlot) probeSlot.innerHTML = renderProbePanelHtml(server);
  };

  const patchServerToolsOnly = (serverName) => {
    const card = findCardEl(serverName);
    if (!card) return;
    const toolsSlot = card.querySelector(".mh-tools-slot");
    const tools = state.probes.get(serverName)?.data?.tools;
    if (toolsSlot && Array.isArray(tools)) {
      toolsSlot.innerHTML = renderToolsGridHtml(serverName, tools);
    }
  };

  const renderDriftBadgeHtml = (server) =>
    server.hasDrift
      ? `<button type="button" class="mh-badge mh-badge--warn mh-badge--btn" data-action="open-sync" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("driftClickHint"))}">${escapeHtml(t("driftBadge"))}</button>`
      : "";

  const renderMatrixPillsHtml = (server, harnessMap) =>
    HARNESS_ORDER.map((hid) => {
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
    }).join("");

  const patchServerMatrixRow = (serverName) => {
    const card = findCardEl(serverName);
    const server = findServer(serverName);
    if (!card || !server) return false;
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));
    const matrixSlot = card.querySelector("[data-matrix-slot]");
    const driftSlot = card.querySelector("[data-drift-slot]");
    if (!matrixSlot) return false;
    matrixSlot.innerHTML = renderMatrixPillsHtml(server, harnessMap);
    if (driftSlot) driftSlot.innerHTML = renderDriftBadgeHtml(server);
    return true;
  };

  // -------------------------------------------------------------------------
  // Content Tab Renderers
  // -------------------------------------------------------------------------

  const renderServersTabHtml = () => {
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
            const { dotCls, badgeHtml } = renderHealthMeta(server.name);

            return `
              <article class="mh-server-card" data-server="${escapeHtml(server.name)}">
                <div class="mh-server-row">
                  <div class="mh-server-meta">
                    <div class="mh-server-head">
                      <span class="mh-health-dot${dotCls}" data-health-dot></span>
                      <span class="mh-server-name">${escapeHtml(server.name)}</span>
                      <span class="mh-badge${isRemote ? " mh-badge--http" : ""}">${iconSvg(isRemote ? "globe" : "terminal", 11)}${escapeHtml(server.transport)}</span>
                      <span data-drift-slot>${renderDriftBadgeHtml(server)}</span>
                      <span data-probe-badge-slot>${badgeHtml}</span>
                    </div>
                    <div class="mh-server-endpoint" data-action="copy-text" data-text="${escapeHtml(endpoint)}" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</div>
                  </div>

                  <div class="mh-matrix" data-matrix-slot aria-label="Harness presence">
                    ${renderMatrixPillsHtml(server, harnessMap)}
                  </div>

                  <div class="mh-row-actions">
                    <button type="button" class="mh-btn mh-btn--sm" data-action="probe" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("probe"))}">
                      ${iconSvg("radar", 13)}<span>${escapeHtml(t("probe"))}</span>
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-sync" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("sync"))}" aria-label="${escapeHtml(t("sync"))}">
                      ${iconSvg("sync", 14)}
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-edit" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("edit"))}" aria-label="${escapeHtml(t("edit"))}">
                      ${iconSvg("edit", 14)}
                    </button>
                    <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="open-delete" data-name="${escapeHtml(server.name)}" title="${escapeHtml(t("remove"))}" aria-label="${escapeHtml(t("remove"))}">
                      ${iconSvg("trash", 14)}
                    </button>
                  </div>
                </div>
                <div data-probe-slot>${renderProbePanelHtml(server)}</div>
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderScopedTabHtml = () => {
    const plugins = state.overview?.nativePlugins ?? [];
    const scoped = state.overview?.scopedServers ?? [];
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));

    const pluginsHtml =
      plugins.length === 0
        ? `<div class="mh-empty">${iconSvg("layers", 24)}<p>${escapeHtml(t("scopedPluginsEmpty"))}</p></div>`
        : `
          <div class="mh-plugin-grid">
            ${plugins
              .map((p) => {
                const h = harnessMap[p.harnessId];
                return `
                  <div class="mh-plugin-card">
                    <div class="mh-plugin-meta">
                      <div class="mh-server-head">
                        <span class="mh-dot" style="background:${escapeHtml(h?.accent ?? "#3b82f6")}"></span>
                        <span class="mh-server-name">${escapeHtml(p.name)}</span>
                        <span class="mh-badge">${escapeHtml(h?.shortName ?? p.harnessId)}</span>
                        ${
                          p.bundledMcps?.length
                            ? `<span class="mh-badge mh-badge--http">${p.bundledMcps.length} MCP</span>`
                            : ""
                        }
                      </div>
                      <div class="mh-harness-path" title="${escapeHtml(p.id)}">${escapeHtml(p.id)}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked="${p.enabled ? "true" : "false"}"
                      aria-label="${escapeHtml(p.name)}"
                      class="mh-switch${p.enabled ? " is-on" : ""}"
                      data-action="toggle-plugin"
                      data-harness="${escapeHtml(p.harnessId)}"
                      data-plugin-id="${escapeHtml(p.id)}"
                      data-plugin-name="${escapeHtml(p.name)}"
                      data-next="${p.enabled ? "false" : "true"}"
                    ></button>
                  </div>
                `;
              })
              .join("")}
          </div>
        `;

    const scopedHtml =
      scoped.length === 0
        ? `<div class="mh-empty">${iconSvg("hub", 24)}<p>${escapeHtml(t("scopedMcpsEmpty"))}</p></div>`
        : `
          <div class="mh-list">
            ${scoped
              .map((entry, idx) => {
                const h = harnessMap[entry.harnessId];
                const isRemote = entry.transport === "http" || entry.transport === "sse";
                const ep = endpointSummary(entry);
                const scopeTag = entry.scope === "plugin" ? t("scopePlugin") : t("scopeProject");
                return `
                  <div class="mh-backup-row">
                    <div class="mh-backup-info">
                      <div class="mh-backup-title">
                        <span class="mh-dot" style="background:${escapeHtml(h?.accent ?? "#64748b")}"></span>
                        <span>${escapeHtml(entry.name)}</span>
                        <span class="mh-badge">${escapeHtml(h?.shortName ?? entry.harnessId)}</span>
                        <span class="mh-badge${entry.scope === "plugin" ? " mh-badge--http" : ""}">${escapeHtml(scopeTag)}</span>
                        <span class="mh-badge${isRemote ? " mh-badge--http" : ""}">${escapeHtml(entry.transport)}</span>
                      </div>
                      <div class="mh-backup-sub">${escapeHtml(shortenPath(entry.scopeLabel))} · ${escapeHtml(ep)}</div>
                    </div>
                    <button type="button" class="mh-btn mh-btn--sm" data-action="promote-scoped" data-scoped-idx="${idx}">
                      ${iconSvg("bolt", 13)}<span>${escapeHtml(t("promoteToGlobal"))}</span>
                    </button>
                  </div>
                `;
              })
              .join("")}
          </div>
        `;

    return `
      <div style="display:flex;flex-direction:column;gap:22px">
        <section class="mh-section">
          <div class="mh-section-head">
            <h2 class="mh-section-title">${escapeHtml(t("scopedPluginsTitle"))}</h2>
            <p class="mh-hint">${escapeHtml(t("scopedPluginsHint"))}</p>
          </div>
          ${pluginsHtml}
        </section>
        <section class="mh-section">
          <div class="mh-section-head">
            <h2 class="mh-section-title">${escapeHtml(t("scopedMcpsTitle"))}</h2>
            <p class="mh-hint">${escapeHtml(t("scopedMcpsHint"))}</p>
          </div>
          ${scopedHtml}
        </section>
      </div>
    `;
  };

  const renderPresetsTabHtml = () => {
    const presets = filteredPresets();
    const configured = new Set((state.overview?.servers ?? []).map((s) => s.name));
    const lang = resolveLocale(bridge.getLocale());

    if (presets.length === 0) {
      return `
        <div class="mh-empty">
          ${iconSvg("search", 24)}
          <h3>${escapeHtml(t("noMatchTitle"))}</h3>
          <p>${escapeHtml(t("noMatchHint"))}</p>
        </div>
      `;
    }

    return `
      <p class="mh-hint" style="margin-bottom:10px">${escapeHtml(t("presetsHint"))}</p>
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
                <div class="mh-server-endpoint" data-action="copy-text" data-text="${escapeHtml(targetPreview)}" title="${escapeHtml(targetPreview)}">${escapeHtml(targetPreview)}</div>
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

  const renderBackupsTabHtml = () => {
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
      <p class="mh-hint" style="margin-bottom:10px">${escapeHtml(t("backupsHint"))}</p>
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
                  <div class="mh-backup-sub">${escapeHtml(shortenPath(b.configPath))}</div>
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

  const renderContent = () => {
    const prevScroll = root.scrollTop;
    if (state.loading && !state.overview) {
      slots.content.innerHTML = `<div class="mh-empty"><p>${escapeHtml(t("loading"))}</p></div>`;
    } else if (state.error && !state.overview) {
      slots.content.innerHTML = `<div class="mh-error-banner">${escapeHtml(state.error)}</div>`;
    } else if (state.activeTab === "servers") {
      slots.content.innerHTML = renderServersTabHtml();
    } else if (state.activeTab === "scoped") {
      slots.content.innerHTML = renderScopedTabHtml();
    } else if (state.activeTab === "presets") {
      slots.content.innerHTML = renderPresetsTabHtml();
    } else {
      slots.content.innerHTML = renderBackupsTabHtml();
    }
    root.scrollTop = prevScroll;
  };

  const renderFooter = () => {
    if (!state.overview) {
      slots.footer.innerHTML = "";
      return;
    }
    const perf = state.overview.perf;
    const perfHtml = perf
      ? `<span class="mh-perf-badge">${escapeHtml(
          t("perfTag", {
            ms: perf.readMs,
            hits: perf.cacheHits,
            total: perf.harnessTotal,
          }),
        )}</span>`
      : "";
    slots.footer.innerHTML = `
      <div class="mh-footer-note">
        <span class="mh-footer-left">${iconSvg("check", 14)}<span>${escapeHtml(t("reloadHint"))}</span></span>
        ${perfHtml}
      </div>
    `;
  };

  // -------------------------------------------------------------------------
  // Slide-over Editor Drawer Renderer
  // -------------------------------------------------------------------------

  const renderDrawer = () => {
    const d = state.drawer;
    if (!d) {
      slots.drawer.innerHTML = "";
      return;
    }
    const prevBodyScroll = slots.drawer.querySelector(".mh-modal-body")?.scrollTop ?? 0;
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));
    const isRemote = d.transport === "http" || d.transport === "sse";
    const configuredSources = d.editServer ? Object.keys(d.editServer.instances) : [];

    let bodyHtml = "";
    if (d.activeTab === "preview") {
      if (d.previewLoading) {
        bodyHtml = `<div class="mh-empty"><p>${escapeHtml(t("loading"))}</p></div>`;
      } else if (d.previewError) {
        bodyHtml = `<div class="mh-error-banner">${escapeHtml(d.previewError)}</div>`;
      } else if (!d.previews || Object.keys(d.previews).length === 0) {
        bodyHtml = `<div class="mh-empty"><p>${escapeHtml(t("previewEmptyHint"))}</p></div>`;
      } else {
        bodyHtml = Object.entries(d.previews)
          .map(([hid, item]) => {
            const h = harnessMap[hid];
            return `
              <div class="mh-code-block">
                <div class="mh-code-head">
                  <span style="display:inline-flex;align-items:center;gap:7px">
                    <span class="mh-dot" style="background:${escapeHtml(h?.accent ?? "#3b82f6")}"></span>
                    <span>${escapeHtml(h?.name ?? hid)}</span>
                    <span class="mh-format-tag">${escapeHtml(item.format)}</span>
                  </span>
                  <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="copy-text" data-text="${escapeHtml(item.snippet)}">
                    ${iconSvg("copy", 13)}<span>${escapeHtml(t("copy"))}</span>
                  </button>
                </div>
                <pre class="mh-code-pre">${escapeHtml(item.snippet)}</pre>
              </div>
            `;
          })
          .join("");
      }
    } else {
      bodyHtml = `
        ${d.formError ? `<div class="mh-error-banner">${escapeHtml(d.formError)}</div>` : ""}
        <div class="mh-field">
          <label class="mh-label" for="mh-f-name">${escapeHtml(t("fieldName"))}</label>
          <input id="mh-f-name" class="mh-input" data-drawer-field="name" value="${escapeHtml(d.name)}" placeholder="${escapeHtml(t("fieldNamePlaceholder"))}" ${d.isEdit ? "readonly" : ""} />
        </div>
        <div class="mh-field">
          <label class="mh-label" for="mh-f-transport">${escapeHtml(t("fieldTransport"))}</label>
          <select id="mh-f-transport" class="mh-select" data-drawer-field="transport">
            <option value="http"${d.transport === "http" ? " selected" : ""}>${escapeHtml(t("transportHttp"))}</option>
            <option value="sse"${d.transport === "sse" ? " selected" : ""}>${escapeHtml(t("transportSse"))}</option>
            <option value="stdio"${d.transport === "stdio" ? " selected" : ""}>${escapeHtml(t("transportStdio"))}</option>
          </select>
        </div>
        ${
          isRemote
            ? `
              <div class="mh-field">
                <label class="mh-label" for="mh-f-url">${escapeHtml(t("fieldUrl"))}</label>
                <input id="mh-f-url" class="mh-input" data-drawer-field="url" value="${escapeHtml(d.url)}" placeholder="${escapeHtml(t("fieldUrlPlaceholder"))}" />
              </div>
              <div class="mh-field">
                <label class="mh-label" for="mh-f-bearer">${escapeHtml(t("fieldBearerEnv"))}</label>
                <input id="mh-f-bearer" class="mh-input" data-drawer-field="bearerTokenEnvVar" value="${escapeHtml(d.bearerTokenEnvVar)}" placeholder="${escapeHtml(t("fieldBearerEnvPlaceholder"))}" />
              </div>
            `
            : `
              <div class="mh-field">
                <label class="mh-label" for="mh-f-quickcmd">${escapeHtml(t("fieldQuickCmd"))}</label>
                <div class="mh-inline-row">
                  <input id="mh-f-quickcmd" class="mh-input" data-drawer-field="quickCmd" value="${escapeHtml(d.quickCmd)}" placeholder="${escapeHtml(t("fieldQuickCmdPlaceholder"))}" />
                  <button type="button" class="mh-btn mh-btn--sm" data-action="drawer-apply-quick-cmd">${iconSvg("bolt", 13)}<span>${escapeHtml(t("quickCmdApply"))}</span></button>
                </div>
              </div>
              <div class="mh-field">
                <label class="mh-label" for="mh-f-cmd">${escapeHtml(t("fieldCommand"))}</label>
                <input id="mh-f-cmd" class="mh-input" data-drawer-field="command" value="${escapeHtml(d.command)}" placeholder="${escapeHtml(t("fieldCommandPlaceholder"))}" />
              </div>
              <div class="mh-field">
                <label class="mh-label" for="mh-f-args">${escapeHtml(t("fieldArgs"))}</label>
                <textarea id="mh-f-args" class="mh-textarea" data-drawer-field="argsText" placeholder="${escapeHtml(t("fieldArgsPlaceholder"))}">${escapeHtml(d.argsText)}</textarea>
              </div>
            `
        }
        <div class="mh-field">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span class="mh-label">${escapeHtml(t(isRemote ? "fieldHeaders" : "fieldEnv"))}</span>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="drawer-kv-add">${iconSvg("plus", 12)}<span>${escapeHtml(t("addRow"))}</span></button>
          </div>
          <div class="mh-kv-list">
            ${d.kv
              .map(
                (row, idx) => `
                  <div class="mh-kv-row">
                    <input class="mh-input" data-kv-key="${idx}" value="${escapeHtml(row.k)}" placeholder="${escapeHtml(t("keyPlaceholder"))}" />
                    <input class="mh-input" type="${row.reveal ? "text" : "password"}" data-kv-val="${idx}" value="${escapeHtml(row.v)}" placeholder="${escapeHtml(t("valuePlaceholder"))}" />
                    <div style="display:inline-flex;gap:3px">
                      <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="drawer-kv-reveal" data-idx="${idx}" title="${escapeHtml(t("toggleSecret"))}" aria-label="${escapeHtml(t("toggleSecret"))}">${iconSvg("eye", 13)}</button>
                      <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="drawer-kv-del" data-idx="${idx}" title="${escapeHtml(t("remove"))}" aria-label="${escapeHtml(t("remove"))}">${iconSvg("close", 13)}</button>
                    </div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
        <div class="mh-field">
          <span class="mh-label">${escapeHtml(t("fieldTargets"))}</span>
          <div class="mh-check-grid">
            ${harnesses
              .map(
                (h) => `
                  <label class="mh-check-item">
                    <input type="checkbox" data-drawer-target="${escapeHtml(h.id)}" ${d.targets.has(h.id) ? "checked" : ""} />
                    <span class="mh-dot" style="background:${escapeHtml(h.accent)}"></span>
                    <span>${escapeHtml(h.name)}</span>
                  </label>
                `,
              )
              .join("")}
          </div>
        </div>
        <label class="mh-check-item" style="width:fit-content">
          <input type="checkbox" data-drawer-field="enabled" ${d.enabled ? "checked" : ""} />
          <span>${escapeHtml(t("fieldEnabled"))}</span>
        </label>
        ${
          d.probeResult
            ? `<div class="${d.probeResult.status === "ok" ? "mh-footer-note" : "mh-error-banner"}">${escapeHtml(
                d.probeResult.status === "ok"
                  ? isRemote
                    ? t("probeOkRemote", { latency: d.probeResult.latencyMs ?? 0, version: d.probeResult.protocolVersion ?? "2025-03-26" }) +
                      ` · ${d.probeResult.toolCount ?? 0} tools`
                    : t("probeOkStdio", { path: d.probeResult.resolvedCommand ?? d.command })
                  : d.probeResult.message ?? "Probe failed",
              )}</div>`
            : ""
        }
      `;
    }

    slots.drawer.innerHTML = `
      <div class="mh-drawer-backdrop" data-action="close-drawer-backdrop">
        <aside class="mh-drawer" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(d.isEdit ? "drawerEditTitle" : "drawerAddTitle"))}">
          <div class="mh-modal-head">
            <h2 class="mh-modal-title">${escapeHtml(t(d.isEdit ? "drawerEditTitle" : "drawerAddTitle"))}${d.isEdit && d.name ? ` · ${escapeHtml(d.name)}` : ""}</h2>
            <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-drawer" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
          </div>
          <div class="mh-drawer-subbar">
            <div class="mh-tabs" role="tablist">
              <button type="button" role="tab" aria-selected="${d.activeTab === "form"}" class="mh-tab${d.activeTab === "form" ? " is-active" : ""}" data-action="drawer-tab" data-tab="form">
                ${iconSvg("edit", 13)}<span>${escapeHtml(t("drawerTabForm"))}</span>
              </button>
              <button type="button" role="tab" aria-selected="${d.activeTab === "preview"}" class="mh-tab${d.activeTab === "preview" ? " is-active" : ""}" data-action="drawer-tab" data-tab="preview">
                ${iconSvg("code", 13)}<span>${escapeHtml(t("drawerTabPreview"))}</span>
              </button>
            </div>
            ${
              configuredSources.length > 1
                ? `
                  <div class="mh-inline-row" style="gap:6px">
                    <span class="mh-hint">${escapeHtml(t("drawerSourceSwitch"))}</span>
                    <select class="mh-select" style="width:auto;min-height:28px;font-size:12px;padding:2px 8px" data-drawer-source>
                      ${configuredSources
                        .map(
                          (hid) =>
                            `<option value="${escapeHtml(hid)}"${d.sourceHarnessId === hid ? " selected" : ""}>${escapeHtml(harnessMap[hid]?.shortName ?? hid)}</option>`,
                        )
                        .join("")}
                    </select>
                  </div>
                `
                : ""
            }
          </div>
          <div class="mh-modal-body">${bodyHtml}</div>
          <div class="mh-modal-foot">
            <button type="button" class="mh-btn mh-btn--sm" data-action="drawer-test" ${d.probing ? "disabled" : ""}>
              ${iconSvg("radar", 13)}<span>${escapeHtml(d.probing ? t("probing") : t("testConnection"))}</span>
            </button>
            <div class="mh-modal-foot-right">
              <button type="button" class="mh-btn" data-action="close-drawer">${escapeHtml(t("cancel"))}</button>
              <button type="button" class="mh-btn mh-btn--primary" data-action="drawer-save" ${state.busy ? "disabled" : ""}>
                ${iconSvg("check", 14)}<span>${escapeHtml(state.busy ? t("saving") : t("save"))}</span>
              </button>
            </div>
          </div>
        </aside>
      </div>
    `;

    const nextBody = slots.drawer.querySelector(".mh-modal-body");
    if (nextBody) nextBody.scrollTop = prevBodyScroll;
  };

  // -------------------------------------------------------------------------
  // Modal Renderer (Sync + Drift Diff, Delete, Import, Export, Confirm)
  // -------------------------------------------------------------------------

  const renderModal = () => {
    const m = state.modal;
    if (!m) {
      slots.modal.innerHTML = "";
      return;
    }
    const harnesses = state.overview?.harnesses ?? [];
    const harnessMap = Object.fromEntries(harnesses.map((h) => [h.id, h]));

    if (m.type === "sync") {
      const configured = Object.keys(m.server.instances);
      const driftFields = m.server.driftFields ?? [];
      slots.modal.innerHTML = `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("modalSyncTitle", { name: m.server.name }))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalSyncTitle", { name: m.server.name }))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("modalSyncHint"))}</p>
              ${
                driftFields.length > 0
                  ? `
                    <div class="mh-field">
                      <span class="mh-label">${escapeHtml(t("driftSectionTitle"))}</span>
                      <div class="mh-diff-list">
                        ${driftFields
                          .map(
                            (df) => `
                              <div class="mh-diff-item">
                                <span class="mh-diff-field">${escapeHtml(df.field)}</span>
                                ${Object.entries(df.values)
                                  .map(
                                    ([hid, val]) => `
                                      <div class="mh-diff-val-row">
                                        <span class="mh-hint" style="font-weight:600">${escapeHtml(harnessMap[hid]?.shortName ?? hid)}</span>
                                        <code class="mh-diff-code">${escapeHtml(formatDiffValue(val))}</code>
                                      </div>
                                    `,
                                  )
                                  .join("")}
                              </div>
                            `,
                          )
                          .join("")}
                      </div>
                    </div>
                  `
                  : ""
              }
              <div class="mh-field">
                <label class="mh-label" for="mh-sync-src">${escapeHtml(t("syncSource"))}</label>
                <select id="mh-sync-src" class="mh-select" data-modal-field="sourceHarnessId">
                  ${configured
                    .map(
                      (hid) =>
                        `<option value="${escapeHtml(hid)}"${m.sourceHarnessId === hid ? " selected" : ""}>${escapeHtml(harnessMap[hid]?.name ?? hid)}</option>`,
                    )
                    .join("")}
                </select>
              </div>
              <div class="mh-field">
                <span class="mh-label">${escapeHtml(t("syncTargets"))}</span>
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
                <button type="button" class="mh-btn" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="submit-sync" ${state.busy ? "disabled" : ""}>${iconSvg("sync", 14)}<span>${escapeHtml(t("syncSubmit"))}</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
      return;
    }

    if (m.type === "delete") {
      const configured = Object.keys(m.server.instances);
      slots.modal.innerHTML = `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("deleteConfirmTitle", { name: m.server.name }))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("deleteConfirmTitle", { name: m.server.name }))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("deleteConfirmHint"))}</p>
              <div class="mh-check-grid">
                ${configured
                  .map((hid) => {
                    const h = harnessMap[hid];
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
                <button type="button" class="mh-btn" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--danger" data-action="submit-delete" ${state.busy ? "disabled" : ""}>${iconSvg("trash", 14)}<span>${escapeHtml(t("deleteSubmit"))}</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
      return;
    }

    if (m.type === "import") {
      slots.modal.innerHTML = `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("modalImportTitle"))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalImportTitle"))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("modalImportHint"))}</p>
              ${m.formError ? `<div class="mh-error-banner">${escapeHtml(m.formError)}</div>` : ""}
              <textarea class="mh-textarea" style="min-height:170px" data-modal-field="rawJson" placeholder='{\n  "mcpServers": {\n    "notion": { "url": "https://mcp.notion.com/mcp" }\n  }\n}'>${escapeHtml(m.rawJson)}</textarea>
              <div class="mh-field">
                <span class="mh-label">${escapeHtml(t("fieldTargets"))}</span>
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
                <button type="button" class="mh-btn" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="submit-import" ${state.busy ? "disabled" : ""}>${iconSvg("upload", 14)}<span>${escapeHtml(t("importSubmit"))}</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
      return;
    }

    if (m.type === "export") {
      slots.modal.innerHTML = `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("modalExportTitle"))}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(t("modalExportTitle"))}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint">${escapeHtml(t("modalExportHint"))}</p>
              <textarea class="mh-textarea" style="min-height:260px" readonly>${escapeHtml(m.json)}</textarea>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn" data-action="close-modal">${escapeHtml(t("close"))}</button>
                <button type="button" class="mh-btn mh-btn--primary" data-action="copy-text" data-text="${escapeHtml(m.json)}">${iconSvg("copy", 14)}<span>${escapeHtml(t("copy"))} JSON</span></button>
              </div>
            </div>
          </div>
        </div>
      `;
      return;
    }

    if (m.type === "confirm") {
      slots.modal.innerHTML = `
        <div class="mh-backdrop" data-action="close-modal-backdrop">
          <div class="mh-modal" style="max-width:460px" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(m.title)}">
            <div class="mh-modal-head">
              <h2 class="mh-modal-title">${escapeHtml(m.title)}</h2>
              <button type="button" class="mh-btn mh-btn--ghost mh-btn--sm" data-action="close-modal" aria-label="${escapeHtml(t("close"))}">${iconSvg("close", 15)}</button>
            </div>
            <div class="mh-modal-body">
              <p class="mh-hint" style="color:var(--mh-text);font-size:13px">${escapeHtml(m.message)}</p>
            </div>
            <div class="mh-modal-foot">
              <div class="mh-modal-foot-right">
                <button type="button" class="mh-btn" data-action="close-modal">${escapeHtml(t("cancel"))}</button>
                <button type="button" class="mh-btn ${m.danger ? "mh-btn--danger" : "mh-btn--primary"}" data-action="submit-confirm" ${state.busy ? "disabled" : ""}>${escapeHtml(m.confirmLabel)}</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }
  };

  const renderAll = () => {
    renderHeader();
    renderRail();
    renderToolbar();
    renderContent();
    renderFooter();
    renderDrawer();
    renderModal();
    renderToast();
  };

  // -------------------------------------------------------------------------
  // Persistent Search Input Listeners (IME-safe + Debounced)
  // -------------------------------------------------------------------------

  const scheduleSearchRender = () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      if (!disposed) renderContent();
    }, SEARCH_DEBOUNCE_MS);
  };

  slots.searchInput.addEventListener(
    "compositionstart",
    () => {
      isComposingSearch = true;
    },
    { signal },
  );

  slots.searchInput.addEventListener(
    "compositionend",
    () => {
      isComposingSearch = false;
      state.search = slots.searchInput.value;
      renderContent();
    },
    { signal },
  );

  slots.searchInput.addEventListener(
    "input",
    () => {
      state.search = slots.searchInput.value;
      if (!isComposingSearch) scheduleSearchRender();
    },
    { signal },
  );

  // -------------------------------------------------------------------------
  // Delegated Event Handlers (Zero Inline Handlers)
  // -------------------------------------------------------------------------

  root.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (!(target instanceof doc.defaultView.HTMLElement)) return;
      if (target === slots.searchInput) return;

      if (target.dataset.toolSearch) {
        const name = target.dataset.toolSearch;
        state.toolSearch.set(name, target.value);
        patchServerToolsOnly(name);
        return;
      }

      if (target.dataset.oauthManual) {
        const prev = state.oauthFlows.get(target.dataset.oauthManual);
        if (prev) prev.manualInput = target.value;
        return;
      }

      if (state.drawer) {
        if (target.dataset.drawerField && target.type !== "checkbox" && target.tagName !== "SELECT") {
          state.drawer[target.dataset.drawerField] = target.value;
          return;
        }
        if (target.dataset.kvKey !== undefined) {
          const idx = Number(target.dataset.kvKey);
          if (state.drawer.kv[idx]) state.drawer.kv[idx].k = target.value;
          return;
        }
        if (target.dataset.kvVal !== undefined) {
          const idx = Number(target.dataset.kvVal);
          if (state.drawer.kv[idx]) state.drawer.kv[idx].v = target.value;
          return;
        }
      }

      if (state.modal && target.dataset.modalField && target.tagName !== "SELECT") {
        state.modal[target.dataset.modalField] = target.value;
      }
    },
    { signal },
  );

  root.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (!(target instanceof doc.defaultView.HTMLElement)) return;

      if (state.drawer) {
        if (target.hasAttribute("data-drawer-source")) {
          const hid = target.value;
          const inst = state.drawer.editServer?.instances?.[hid];
          if (inst) {
            state.drawer.sourceHarnessId = hid;
            loadDrawerInstanceValues(state.drawer, inst);
            if (state.drawer.activeTab === "preview") {
              refreshDrawerPreview();
            } else {
              renderDrawer();
            }
          }
          return;
        }

        if (target.dataset.drawerField === "transport") {
          state.drawer.transport = target.value;
          renderDrawer();
          return;
        }

        if (target.dataset.drawerField === "enabled") {
          state.drawer.enabled = Boolean(target.checked);
          return;
        }

        if (target.dataset.drawerTarget) {
          const hid = target.dataset.drawerTarget;
          if (target.checked) state.drawer.targets.add(hid);
          else state.drawer.targets.delete(hid);
          return;
        }
      }

      if (state.modal) {
        if (target.dataset.modalField === "sourceHarnessId") {
          state.modal.sourceHarnessId = target.value;
          state.modal.targets = new Set(HARNESS_ORDER.filter((id) => id !== target.value));
          renderModal();
          return;
        }
        if (target.dataset.modalTarget) {
          const hid = target.dataset.modalTarget;
          if (target.checked) state.modal.targets.add(hid);
          else state.modal.targets.delete(hid);
        }
      }
    },
    { signal },
  );

  // Global Escape handler on document so closing drawer/modal works even after inner DOM updates.
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (state.modal) {
        event.preventDefault();
        state.modal = null;
        renderModal();
      } else if (state.drawer) {
        event.preventDefault();
        state.drawer = null;
        renderDrawer();
      }
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!(target instanceof doc.defaultView.HTMLElement)) return;

      if (event.key === "Enter" && target.dataset.drawerField === "quickCmd" && state.drawer) {
        event.preventDefault();
        const tokens = tokenizeCommandLine(state.drawer.quickCmd);
        if (tokens.length > 0) {
          state.drawer.command = tokens[0];
          state.drawer.argsText = tokens.slice(1).join("\n");
          state.drawer.quickCmd = "";
          renderDrawer();
        }
        return;
      }

      if ((event.key === "Enter" || event.key === " ") && target.dataset.action === "filter-harness") {
        event.preventDefault();
        const hid = target.dataset.harness;
        state.selectedHarness = state.selectedHarness === hid ? null : hid;
        renderRail();
        if (state.activeTab === "servers") renderContent();
      }
    },
    { signal },
  );

  root.addEventListener(
    "click",
    async (event) => {
      const origin = event.target;
      if (!(origin instanceof doc.defaultView.Element)) return;
      const el = origin.closest("[data-action]");
      if (!el) return;

      const action = el.dataset.action;

      if (action === "close-modal-backdrop") {
        if (origin === el) {
          state.modal = null;
          renderModal();
        }
        return;
      }

      if (action === "close-drawer-backdrop") {
        if (origin === el) {
          state.drawer = null;
          renderDrawer();
        }
        return;
      }

      if (action === "close-modal") {
        state.modal = null;
        renderModal();
        return;
      }

      if (action === "close-drawer") {
        state.drawer = null;
        renderDrawer();
        return;
      }

      if (action === "refresh") {
        await loadOverview(true);
        return;
      }

      if (action === "probe-all") {
        await runProbeAll();
        return;
      }

      if (action === "switch-tab") {
        const nextTab = el.dataset.tab;
        if (nextTab && nextTab !== state.activeTab) {
          state.activeTab = nextTab;
          renderToolbar();
          renderContent();
        }
        return;
      }

      if (action === "filter-harness") {
        const hid = el.dataset.harness;
        state.selectedHarness = state.selectedHarness === hid ? null : hid;
        renderRail();
        if (state.activeTab === "servers") renderContent();
        return;
      }

      if (action === "filter-transport") {
        state.transportFilter = el.dataset.value;
        if (state.transportFilter === "all") state.onlyDrift = false;
        renderToolbar();
        renderContent();
        return;
      }

      if (action === "toggle-drift") {
        state.onlyDrift = !state.onlyDrift;
        renderToolbar();
        renderContent();
        return;
      }

      if (action === "filter-preset-cat") {
        state.presetCategory = el.dataset.value;
        renderToolbar();
        renderContent();
        return;
      }

      if (action === "open-add") {
        openEditorDrawer(null);
        return;
      }

      if (action === "open-edit") {
        const server = findServer(el.dataset.name);
        if (server) openEditorDrawer(null, { editServer: server });
        return;
      }

      if (action === "open-sync") {
        const server = findServer(el.dataset.name);
        if (server) openSyncModal(server);
        return;
      }

      if (action === "open-delete") {
        const server = findServer(el.dataset.name);
        if (server) openDeleteModal(server);
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

      if (action === "use-preset") {
        const preset = (state.overview?.presets ?? []).find((p) => p.id === el.dataset.preset);
        if (preset) {
          openEditorDrawer({
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

      if (action === "promote-scoped") {
        const idx = Number(el.dataset.scopedIdx);
        const entry = state.overview?.scopedServers?.[idx];
        if (entry) {
          openEditorDrawer({
            name: entry.name,
            transport: entry.transport,
            url: entry.url ?? "",
            command: entry.command ?? "npx",
            args: entry.args ?? [],
            headers: entry.headers ?? {},
            env: entry.env ?? {},
            enabled: true,
          });
        }
        return;
      }

      if (action === "toggle-instance") {
        const name = el.dataset.name;
        const harnessId = el.dataset.harness;
        const nextEnabled = el.dataset.next === "true";
        const hName = (state.overview?.harnesses ?? []).find((h) => h.id === harnessId)?.name ?? harnessId;
        el.classList.add("is-pending");
        await invokeWithOverview(
          "server.toggle",
          { name, harnessId, enabled: nextEnabled },
          t("toastToggled", { name, harness: hName }),
          { lockGlobal: false, patchRow: name },
        );
        return;
      }

      if (action === "quick-sync") {
        const name = el.dataset.name;
        const sourceHarnessId = el.dataset.source;
        const target = el.dataset.target;
        const hName = (state.overview?.harnesses ?? []).find((h) => h.id === target)?.name ?? target;
        el.classList.add("is-pending");
        await invokeWithOverview(
          "server.sync",
          { name, sourceHarnessId, targets: [target] },
          t("toastSynced", { name, targets: hName }),
          { lockGlobal: false, patchRow: name },
        );
        return;
      }

      if (action === "toggle-plugin") {
        const harnessId = el.dataset.harness;
        const pluginId = el.dataset.pluginId;
        const pluginName = el.dataset.pluginName || pluginId;
        const nextEnabled = el.dataset.next === "true";
        const hName = (state.overview?.harnesses ?? []).find((h) => h.id === harnessId)?.name ?? harnessId;
        el.classList.toggle("is-on", nextEnabled);
        el.setAttribute("disabled", "true");
        await invokeWithOverview(
          "plugin.toggle",
          { harnessId, pluginId, enabled: nextEnabled },
          t("toastPluginToggled", { harness: hName, name: pluginName }),
          { lockGlobal: false },
        );
        return;
      }

      if (action === "sync-all") {
        event.stopPropagation();
        const hid = el.dataset.harness;
        const h = (state.overview?.harnesses ?? []).find((x) => x.id === hid);
        if (!h) return;
        const targets = HARNESS_ORDER.filter((id) => id !== hid);
        openConfirmModal({
          title: t("syncAllTitle", { source: h.name }),
          message: t("syncAllConfirm", { source: h.name, count: h.totalCount }),
          onConfirm: async () => {
            state.modal = null;
            renderModal();
            await invokeWithOverview(
              "server.syncAll",
              { sourceHarnessId: hid, targets },
              t("toastSyncAll", { source: h.name, count: h.totalCount }),
            );
          },
        });
        return;
      }

      if (action === "probe") {
        const name = el.dataset.name;
        if (state.expandedProbe.has(name) && state.probes.get(name) && !state.probes.get(name).loading) {
          state.expandedProbe.delete(name);
          patchServerCard(name);
          return;
        }
        const cached = state.probes.get(name)?.data;
        if (cached && cached.cached) {
          state.expandedProbe.add(name);
          patchServerCard(name);
          return;
        }
        await runProbe(name, { harnessId: state.selectedHarness, force: true });
        return;
      }

      if (action === "reprobe") {
        await runProbe(el.dataset.name, { harnessId: state.selectedHarness, force: true });
        return;
      }

      if (action === "close-probe") {
        const name = el.dataset.name;
        state.expandedProbe.delete(name);
        patchServerCard(name);
        return;
      }

      if (action === "toggle-tools-expand") {
        const name = el.dataset.name;
        if (state.toolsExpanded.has(name)) state.toolsExpanded.delete(name);
        else state.toolsExpanded.add(name);
        patchServerToolsOnly(name);
        return;
      }

      if (action === "oauth-start") {
        const server = findServer(el.dataset.name);
        if (server) await startOAuth(server);
        return;
      }

      if (action === "oauth-cancel") {
        const name = el.dataset.name;
        const flow = state.oauthFlows.get(name);
        stopOAuthPolling(name);
        state.oauthFlows.delete(name);
        if (flow?.flowId) {
          invoke("oauth.cancel", { flowId: flow.flowId }).catch(() => {});
        }
        patchServerCard(name);
        return;
      }

      if (action === "oauth-manual-submit") {
        const name = el.dataset.name;
        const flow = state.oauthFlows.get(name);
        if (!flow?.flowId) return;
        try {
          const res = await invoke("oauth.completeManual", {
            flowId: flow.flowId,
            callbackUrlOrCode: flow.manualInput,
          });
          if (disposed || signal.aborted) return;
          stopOAuthPolling(name);
          state.oauthFlows.set(name, { ...flow, status: "completed", hasToken: Boolean(res?.hasToken), error: null });
          patchServerCard(name);
        } catch (error) {
          state.oauthFlows.set(name, {
            ...flow,
            error: error instanceof Error ? error.message : String(error),
          });
          patchServerCard(name);
        }
        return;
      }

      if (action === "oauth-apply") {
        const name = el.dataset.name;
        const flow = state.oauthFlows.get(name);
        const server = findServer(name);
        if (!flow?.flowId || !server) return;
        const targets = Object.keys(server.instances);
        const res = await invokeWithOverview(
          "oauth.applyToken",
          { flowId: flow.flowId, serverName: name, targets },
          t("toastOAuthApplied", { count: targets.length }),
        );
        if (res) {
          state.oauthFlows.delete(name);
          await runProbe(name, { force: true });
        }
        return;
      }

      if (action === "copy-text") {
        const text = el.dataset.text ?? "";
        if (!text) return;
        const ok = await copyToClipboard(text, doc).catch(() => false);
        showToast(ok ? t("copied") : "Copy failed", !ok);
        return;
      }

      // Drawer actions
      if (state.drawer) {
        if (action === "drawer-tab") {
          const nextTab = el.dataset.tab;
          if (nextTab && nextTab !== state.drawer.activeTab) {
            state.drawer.activeTab = nextTab;
            if (nextTab === "preview") {
              await refreshDrawerPreview();
            } else {
              renderDrawer();
            }
          }
          return;
        }

        if (action === "drawer-apply-quick-cmd") {
          const tokens = tokenizeCommandLine(state.drawer.quickCmd);
          if (tokens.length > 0) {
            state.drawer.command = tokens[0];
            state.drawer.argsText = tokens.slice(1).join("\n");
            state.drawer.quickCmd = "";
            renderDrawer();
          }
          return;
        }

        if (action === "drawer-kv-add") {
          state.drawer.kv.push({ k: "", v: "", reveal: false });
          renderDrawer();
          return;
        }

        if (action === "drawer-kv-del") {
          const idx = Number(el.dataset.idx);
          state.drawer.kv.splice(idx, 1);
          if (state.drawer.kv.length === 0) state.drawer.kv.push({ k: "", v: "", reveal: false });
          renderDrawer();
          return;
        }

        if (action === "drawer-kv-reveal") {
          const idx = Number(el.dataset.idx);
          if (state.drawer.kv[idx]) {
            state.drawer.kv[idx].reveal = !state.drawer.kv[idx].reveal;
            renderDrawer();
          }
          return;
        }

        if (action === "drawer-test") {
          state.drawer.probing = true;
          state.drawer.probeResult = null;
          state.drawer.formError = null;
          renderDrawer();
          try {
            const payload = buildDrawerPayload(state.drawer);
            const res = await invoke("server.probe", { server: payload, force: true });
            if (disposed || signal.aborted || !state.drawer) return;
            state.drawer.probing = false;
            state.drawer.probeResult = res;
            renderDrawer();
          } catch (error) {
            if (disposed || signal.aborted || !state.drawer) return;
            state.drawer.probing = false;
            state.drawer.probeResult = {
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            };
            renderDrawer();
          }
          return;
        }

        if (action === "drawer-save") {
          const targets = [...state.drawer.targets];
          if (targets.length === 0) {
            state.drawer.formError = "Please select at least one target harness.";
            state.drawer.activeTab = "form";
            renderDrawer();
            return;
          }
          const payload = buildDrawerPayload(state.drawer);
          try {
            state.busy = true;
            renderHeader();
            renderDrawer();
            const res = await invoke("server.upsert", { server: payload, targets });
            if (disposed || signal.aborted) return;
            state.busy = false;
            if (res?.overview) applyOverviewUpdate(res.overview);
            state.drawer = null;
            showToast(t("toastSaved", { count: targets.length }));
            renderAll();
          } catch (error) {
            if (disposed || signal.aborted) return;
            state.busy = false;
            if (state.drawer) {
              state.drawer.formError = error instanceof Error ? error.message : String(error);
              state.drawer.activeTab = "form";
            }
            renderHeader();
            renderDrawer();
          }
          return;
        }
      }

      // Modal actions
      if (state.modal) {
        if (action === "submit-confirm" && state.modal.type === "confirm") {
          const fn = state.modal.onConfirm;
          if (typeof fn === "function") await fn();
          return;
        }

        if (action === "submit-sync" && state.modal.type === "sync") {
          const targets = [...state.modal.targets];
          const name = state.modal.server.name;
          const sourceHarnessId = state.modal.sourceHarnessId;
          state.modal = null;
          renderModal();
          const targetLabels = targets
            .map((id) => (state.overview?.harnesses ?? []).find((h) => h.id === id)?.shortName ?? id)
            .join(", ");
          await invokeWithOverview(
            "server.sync",
            { name, sourceHarnessId, targets },
            t("toastSynced", { name, targets: targetLabels }),
          );
          return;
        }

        if (action === "submit-delete" && state.modal.type === "delete") {
          const targets = [...state.modal.targets];
          const name = state.modal.server.name;
          state.modal = null;
          renderModal();
          await invokeWithOverview(
            "server.delete",
            { name, targets },
            t("toastDeleted", { name }),
          );
          return;
        }

        if (action === "submit-import" && state.modal.type === "import") {
          const targets = [...state.modal.targets];
          try {
            state.busy = true;
            renderModal();
            const res = await invoke("config.importJson", {
              rawJson: state.modal.rawJson,
              targets,
            });
            if (disposed || signal.aborted) return;
            state.busy = false;
            if (res?.overview) applyOverviewUpdate(res.overview);
            state.modal = null;
            showToast(t("toastImported", { count: res?.imported?.length ?? 0 }));
            renderAll();
          } catch (error) {
            if (disposed || signal.aborted) return;
            state.busy = false;
            if (state.modal) {
              state.modal.formError = error instanceof Error ? error.message : String(error);
            }
            renderModal();
          }
          return;
        }
      }

      if (action === "restore-backup") {
        const backupId = el.dataset.backup;
        const harnessName = el.dataset.harness;
        openConfirmModal({
          title: t("restoreTitle"),
          message: t("restoreConfirm", { harness: harnessName }),
          onConfirm: async () => {
            state.modal = null;
            renderModal();
            await invokeWithOverview(
              "backups.restore",
              { backupId },
              t("toastRestored", { harness: harnessName }),
            );
          },
        });
      }
    },
    { signal },
  );

  // Silent foreground auto-refresh when tab becomes visible (stat-cached on backend).
  doc.addEventListener(
    "visibilitychange",
    () => {
      if (
        disposed ||
        signal.aborted ||
        doc.visibilityState !== "visible" ||
        state.drawer ||
        state.modal ||
        state.probingAll ||
        Date.now() - lastRefreshAt < VISIBILITY_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }
      loadOverview(true);
    },
    { signal },
  );

  const offLocale = bridge.onLocaleChange?.(() => renderAll());
  const offScheme = bridge.onColorSchemeChange?.((scheme) => {
    root.dataset.mhScheme = scheme === "dark" ? "dark" : "light";
  });

  renderAll();
  loadOverview(false);

  return () => {
    disposed = true;
    if (toastTimer) clearTimeout(toastTimer);
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    for (const key of [...oauthTimers.keys()]) stopOAuthPolling(key);
    offLocale?.();
    offScheme?.();
    root.remove();
  };
}
