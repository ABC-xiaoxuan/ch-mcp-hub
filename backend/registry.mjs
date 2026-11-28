/**
 * Live Official MCP Registry Search & Smart Address Resolver (pure Node fetch, zero subprocesses).
 *
 * Inspired by Magpie's MCP Market:
 * - Searches the official Model Context Protocol Registry (`registry.modelcontextprotocol.io`)
 *   with bounded TTL caching and graceful offline degradation.
 * - Directly resolves pasted remote MCP URLs (`https://...`), npm packages (`@scope/pkg` or
 *   `npmjs.com/package/...`), PyPI packages (`pypi.org/project/...`), or GitHub repositories
 *   (`https://github.com/owner/repo` or `owner/repo`) into ready-to-install MCP server configs.
 */

const OFFICIAL_REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_500;

const searchCache = new Map();

const NPM_PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:@([a-z0-9._~^+-]+))?$/iu;
const OWNER_REPO_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)$/u;

const GENERIC_SLUGS = new Set(["mcp", "mcp-server", "server", "agent-toolkit", "toolkit", "cli"]);

function slugifyServerId(raw) {
  const str = String(raw ?? "").trim().toLowerCase();
  let candidate = str;

  // Preserve scope/owner when the package or repo suffix is generic (e.g. `@stripe/mcp`, `io.github.stripe/agent-toolkit`).
  const scopedMatch = /^@([a-z0-9._-]+)\/([a-z0-9._-]+)$/u.exec(str);
  if (scopedMatch) {
    const [, scope, pkg] = scopedMatch;
    const strippedPkg = pkg.replace(/^mcp-server-/u, "").replace(/^server-/u, "").replace(/-mcp$/u, "");
    candidate = !strippedPkg || GENERIC_SLUGS.has(pkg) || GENERIC_SLUGS.has(strippedPkg) ? scope : strippedPkg;
  } else {
    const nsMatch = /^(?:io\.github\.|com\.|org\.)([a-z0-9._-]+)\/([a-z0-9._-]+)$/u.exec(str);
    if (nsMatch) {
      const [, owner, repo] = nsMatch;
      const strippedRepo = repo.replace(/^mcp-server-/u, "").replace(/^server-/u, "").replace(/-mcp$/u, "");
      candidate = !strippedRepo || GENERIC_SLUGS.has(repo) || GENERIC_SLUGS.has(strippedRepo) ? owner : strippedRepo;
    } else {
      candidate = str
        .replace(/^@[^/]+\//u, "")
        .replace(/^io\.github\.[^/]+\//u, "")
        .replace(/^com\.[^/]+\//u, "")
        .replace(/^mcp-server-/u, "")
        .replace(/^server-/u, "")
        .replace(/-mcp$/u, "");
    }
  }

  const cleaned = candidate.replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (cleaned || "mcp-server").slice(0, 64);
}

function titleFromId(id) {
  return String(id ?? "")
    .split(/[-_./]+/u)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function extractEnvHints(list) {
  const env = {};
  if (!Array.isArray(list)) return env;
  for (const item of list) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    env[name] = item?.default ? String(item.default) : `\${${name}}`;
  }
  return env;
}

function extractHeaderHints(list) {
  const headers = {};
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const rawVal = item?.value ?? item?.default ?? "";
    headers[name] = rawVal ? String(rawVal) : `\${${name.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}}`;
  }
  return headers;
}

/**
 * Normalize one server entry from the official MCP Registry v0 payload into a
 * uniform installable preset object.
 */
export function normalizeRegistryEntry(rawItem) {
  const srv = rawItem?.server && typeof rawItem.server === "object" ? rawItem.server : rawItem;
  if (!srv || typeof srv !== "object") return null;

  const fullName = String(srv.name ?? srv.id ?? "").trim();
  if (!fullName) return null;

  const baseId = slugifyServerId(fullName);
  const displayName =
    (typeof srv.title === "string" && srv.title.trim()) ||
    titleFromId(baseId);
  const description = typeof srv.description === "string" ? srv.description.trim().slice(0, 220) : "";
  const repoUrl =
    typeof srv.repository?.url === "string" ? srv.repository.url.trim() : "";
  const websiteUrl = typeof srv.websiteUrl === "string" ? srv.websiteUrl.trim() : "";
  const version = typeof srv.version === "string" ? srv.version.trim() : "";

  // 1. Prefer Streamable HTTP / SSE remote endpoints when advertised.
  const remotes = Array.isArray(srv.remotes) ? srv.remotes : [];
  const httpRemote =
    remotes.find((r) => typeof r?.url === "string" && (r.type === "streamable-http" || r.type === "http")) ??
    remotes.find((r) => typeof r?.url === "string" && r.type === "sse") ??
    remotes.find((r) => typeof r?.url === "string" && /^https?:\/\//iu.test(r.url));

  if (httpRemote?.url && /^https?:\/\//iu.test(httpRemote.url)) {
    const transport = httpRemote.type === "sse" ? "sse" : "http";
    const headers = extractHeaderHints(httpRemote.headers);
    return {
      id: baseId,
      registryName: fullName,
      name: displayName,
      source: "registry",
      category: "registry",
      transport,
      url: httpRemote.url.trim(),
      headers,
      oauthHint:
        /oauth/iu.test(description) ||
        Object.keys(headers).some((k) => /authorization/iu.test(k)),
      description: {
        en: description || `Official MCP Registry remote server (${fullName})`,
        "zh-CN": description || `官方 MCP Registry 远程服务（${fullName}）`,
      },
      ...(version ? { version } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
    };
  }

  // 2. Otherwise inspect runnable packages (npm -> npx, pypi -> uvx, oci -> safe docker).
  const packages = Array.isArray(srv.packages) ? srv.packages : [];
  const npmPkg = packages.find((p) => (p?.registryType ?? p?.registry_type ?? p?.registry_name) === "npm");
  const pypiPkg = packages.find((p) => (p?.registryType ?? p?.registry_type ?? p?.registry_name) === "pypi");
  const ociPkg = packages.find((p) => {
    const rt = p?.registryType ?? p?.registry_type ?? p?.registry_name;
    return rt === "oci" || rt === "docker";
  });

  const pkg = npmPkg ?? pypiPkg ?? ociPkg;
  if (!pkg) return null;

  const pkgId = String(pkg.identifier ?? pkg.name ?? "").trim();
  if (!pkgId) return null;
  const regType = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
  const env = extractEnvHints(pkg.environmentVariables ?? pkg.environment_variables);

  const extraArgs = [];
  for (const a of Array.isArray(pkg.packageArguments ?? pkg.package_arguments)
    ? (pkg.packageArguments ?? pkg.package_arguments)
    : []) {
    if (typeof a?.value === "string" && a.value.trim()) {
      extraArgs.push(a.value.trim());
    } else if (typeof a?.default === "string" && a.default.trim()) {
      if (a.type === "named" && a.name) extraArgs.push(a.name, a.default.trim());
      else extraArgs.push(a.default.trim());
    }
  }

  let command = "";
  let args = [];
  if (regType === "npm") {
    command = "npx";
    args = ["-y", pkgId, ...extraArgs];
  } else if (regType === "pypi") {
    command = "uvx";
    args = [pkgId, ...extraArgs];
  } else if (regType === "oci" || regType === "docker") {
    // Only emit safe containerized flags (never mount arbitrary host directories).
    command = "docker";
    args = ["run", "-i", "--rm", pkgId, ...extraArgs];
  } else {
    return null;
  }

  return {
    id: baseId,
    registryName: fullName,
    name: displayName,
    source: "registry",
    category: "local",
    transport: "stdio",
    command,
    args,
    env,
    description: {
      en: description || `MCP Registry ${regType} package (${pkgId})`,
      "zh-CN": description || `官方 MCP Registry ${regType} 包（${pkgId}）`,
    },
    ...(version ? { version } : {}),
    ...(repoUrl ? { repoUrl } : {}),
  };
}

/**
 * Resolve a directly pasted URL, npm package, PyPI link, or GitHub repo into an
 * instant installable MCP entry (inspired by Magpie's `market_addr.go` / `market_repo.go`).
 */
export function resolveSmartInput(rawQuery) {
  const q = String(rawQuery ?? "").trim();
  if (!q || q.includes(" ")) return null;

  // 1. Direct URL handling (GitHub repo, npmjs, pypi, or Remote MCP endpoint)
  if (/^https?:\/\//iu.test(q)) {
    let u;
    try {
      u = new URL(q);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./u, "");
    const parts = u.pathname.split("/").filter(Boolean);

    if (host === "npmjs.com" && parts[0] === "package" && parts.length >= 2) {
      const pkgName = parts[1].startsWith("@") && parts[2] ? `${parts[1]}/${parts[2]}` : parts[1];
      const id = slugifyServerId(pkgName);
      return {
        id,
        name: titleFromId(id),
        source: "smart",
        category: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", pkgName],
        env: {},
        description: {
          en: `Detected npm MCP package: npx -y ${pkgName}`,
          "zh-CN": `识别到 npm MCP 包：npx -y ${pkgName}`,
        },
      };
    }

    if (host === "pypi.org" && parts[0] === "project" && parts[1]) {
      const pkgName = parts[1];
      const id = slugifyServerId(pkgName);
      return {
        id,
        name: titleFromId(id),
        source: "smart",
        category: "local",
        transport: "stdio",
        command: "uvx",
        args: [pkgName],
        env: {},
        description: {
          en: `Detected PyPI MCP package: uvx ${pkgName}`,
          "zh-CN": `识别到 PyPI MCP 包：uvx ${pkgName}`,
        },
      };
    }

    if (host === "github.com" && parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/iu, "");
      const id = slugifyServerId(repo);
      const subIdx = parts.indexOf("tree");
      const subdir =
        subIdx >= 0 && parts.length > subIdx + 2 ? parts.slice(subIdx + 2).join("/") : "";
      const gitSpec = `git+https://github.com/${owner}/${repo}${subdir ? `#subdirectory=${subdir}` : ""}`;
      return {
        id,
        name: titleFromId(id),
        source: "smart",
        category: "local",
        transport: "stdio",
        command: "uvx",
        args: ["--from", gitSpec, repo],
        env: {},
        repoUrl: `https://github.com/${owner}/${repo}`,
        description: {
          en: `Detected GitHub repo ${owner}/${repo} (editable in drawer)`,
          "zh-CN": `识别到 GitHub 仓库 ${owner}/${repo}（可在抽屉中调整启动命令）`,
        },
      };
    }

    // Any other http(s) URL -> treat as a direct Remote Streamable HTTP MCP endpoint!
    const hostSlug = slugifyServerId(host.replace(/^mcp\./u, "").split(".")[0] || host);
    return {
      id: hostSlug,
      name: titleFromId(hostSlug),
      source: "smart",
      category: "registry",
      transport: "http",
      url: u.href,
      headers: {},
      oauthHint: true,
      description: {
        en: `Direct Remote HTTP MCP endpoint (${u.host})`,
        "zh-CN": `直接接入远程 Streamable HTTP MCP 端点（${u.host}）`,
      },
    };
  }

  // 2. Scoped npm package (`@playwright/mcp` or `@modelcontextprotocol/server-postgres`)
  const npmMatch = q.match(NPM_PKG_RE);
  if (npmMatch) {
    const pkgSpec = q;
    const id = slugifyServerId(npmMatch[1]);
    return {
      id,
      name: titleFromId(id),
      source: "smart",
      category: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", pkgSpec],
      env: {},
      description: {
        en: `Install scoped npm MCP package via npx -y ${pkgSpec}`,
        "zh-CN": `通过 npx -y ${pkgSpec} 快速接入 npm MCP 包`,
      },
    };
  }

  // 3. GitHub `owner/repo` shorthand
  const ghMatch = q.match(OWNER_REPO_RE);
  if (ghMatch && !q.startsWith("@")) {
    const [, owner, rawRepo] = ghMatch;
    const repo = rawRepo.replace(/\.git$/iu, "");
    const id = slugifyServerId(repo);
    return {
      id,
      name: titleFromId(id),
      source: "smart",
      category: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", `github:${owner}/${repo}`],
      env: {},
      repoUrl: `https://github.com/${owner}/${repo}`,
      description: {
        en: `GitHub repository ${owner}/${repo} (customize npx/uvx in drawer)`,
        "zh-CN": `识别到 GitHub 仓库 ${owner}/${repo}（可在抽屉切换 npx / uvx）`,
      },
    };
  }

  return null;
}

/**
 * Search the official MCP Registry with in-memory TTL cache + smart address detection.
 */
export async function searchMcpRegistry(
  query,
  { limit = 20, fetchImpl = fetch, baseUrl = OFFICIAL_REGISTRY_BASE } = {},
) {
  const q = String(query ?? "").trim();
  const smart = resolveSmartInput(q);

  const cacheKey = `${baseUrl}|${q.toLowerCase()}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  let items = [];
  let offline = false;
  let errorMessage = "";

  try {
    const url = new URL(baseUrl);
    if (q && !smart) {
      url.searchParams.set("search", q);
    } else if (q && smart?.repoUrl) {
      // Also query registry by repo slug so official metadata surfaces alongside smart entry.
      url.searchParams.set("search", smart.id);
    }
    url.searchParams.set("limit", String(Math.min(Math.max(1, limit), 40)));

    const res = await fetchImpl(url.href, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "codexhost-mcp-hub/1.3.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Registry HTTP ${res.status}`);
    }
    const json = await res.json();
    const rawList = Array.isArray(json?.servers)
      ? json.servers
      : Array.isArray(json?.items)
        ? json.items
        : Array.isArray(json)
          ? json
          : [];

    const seenIds = new Set();
    for (const raw of rawList) {
      const normalized = normalizeRegistryEntry(raw);
      if (!normalized) continue;
      const dedupeKey = `${normalized.id}:${normalized.url ?? normalized.command ?? ""}`;
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      items.push(normalized);
    }
  } catch (error) {
    offline = true;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const payload = {
    query: q,
    smartMatch: smart,
    items,
    offline,
    ...(errorMessage ? { errorMessage } : {}),
  };

  if (!offline) {
    searchCache.set(cacheKey, { data: payload, at: Date.now() });
    if (searchCache.size > 40) {
      const oldestKey = searchCache.keys().next().value;
      searchCache.delete(oldestKey);
    }
  }

  return { ...payload, cached: false };
}

export function clearRegistryCache() {
  searchCache.clear();
}
