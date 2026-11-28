/**
 * Surgical, comment-preserving TOML reader and section patcher for Codex `~/.codex/config.toml`.
 *
 * Reads `[mcp_servers.<id>]` (plus `.env` and `.http_headers` sub-tables) and patches ONLY the
 * target server's line spans so every unrelated setting, comment, and blank line stays intact.
 */

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/u;

export function formatTomlKey(key) {
  return BARE_KEY_RE.test(key) ? key : JSON.stringify(String(key));
}

export function formatTomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([k, v]) => `${formatTomlKey(k)} = ${formatTomlValue(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return '""';
}

function stripInlineComment(raw) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function parseDottedHeader(headerContent) {
  const segments = [];
  let i = 0;
  const len = headerContent.length;
  while (i < len) {
    while (i < len && /\s/u.test(headerContent[i])) i += 1;
    if (i >= len) break;
    const ch = headerContent[i];
    if (ch === '"') {
      let end = i + 1;
      let escaped = false;
      while (end < len) {
        if (escaped) {
          escaped = false;
        } else if (headerContent[end] === "\\") {
          escaped = true;
        } else if (headerContent[end] === '"') {
          break;
        }
        end += 1;
      }
      if (end >= len) return null;
      try {
        segments.push(JSON.parse(headerContent.slice(i, end + 1)));
      } catch {
        return null;
      }
      i = end + 1;
    } else if (ch === "'") {
      const end = headerContent.indexOf("'", i + 1);
      if (end < 0) return null;
      segments.push(headerContent.slice(i + 1, end));
      i = end + 1;
    } else {
      let end = i;
      while (end < len && headerContent[end] !== "." && !/\s/u.test(headerContent[end])) {
        end += 1;
      }
      const part = headerContent.slice(i, end);
      if (!part) return null;
      segments.push(part);
      i = end;
    }
    while (i < len && /\s/u.test(headerContent[i])) i += 1;
    if (i < len) {
      if (headerContent[i] !== ".") return null;
      i += 1;
    }
  }
  return segments.length > 0 ? segments : null;
}

function parseTableHeaderLine(line) {
  const cleaned = stripInlineComment(line);
  if (!cleaned.startsWith("[") || !cleaned.endsWith("]") || cleaned.startsWith("[[")) {
    return null;
  }
  const inner = cleaned.slice(1, -1).trim();
  return parseDottedHeader(inner);
}

function splitTopLevel(str, delimiter) {
  const parts = [];
  let start = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket -= 1;
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace -= 1;
    else if (ch === delimiter && depthBracket === 0 && depthBrace === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

function parseScalarOrCompound(raw) {
  const s = raw.trim();
  if (!s) return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^[+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?$/u.test(s)) {
    const n = Number(s.replaceAll("_", ""));
    if (Number.isFinite(n)) return n;
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => parseScalarOrCompound(item));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const part of splitTopLevel(inner, ",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = findAssignmentIndex(trimmed);
      if (eq < 0) continue;
      const keyParts = parseDottedHeader(trimmed.slice(0, eq).trim());
      if (!keyParts || keyParts.length === 0) continue;
      const val = parseScalarOrCompound(trimmed.slice(eq + 1));
      let cur = obj;
      for (let idx = 0; idx < keyParts.length - 1; idx += 1) {
        if (!cur[keyParts[idx]] || typeof cur[keyParts[idx]] !== "object") {
          cur[keyParts[idx]] = {};
        }
        cur = cur[keyParts[idx]];
      }
      cur[keyParts[keyParts.length - 1]] = val;
    }
    return obj;
  }
  return s;
}

function findAssignmentIndex(line) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "=") return i;
  }
  return -1;
}

function isBalancedValue(raw) {
  let depthBracket = 0;
  let depthBrace = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket -= 1;
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace -= 1;
  }
  return !inDouble && !inSingle && depthBracket <= 0 && depthBrace <= 0;
}

/**
 * Parse `[mcp_servers.<name>]` entries and their line ranges from Codex `config.toml`.
 */
export function parseCodexMcpToml(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length === 0 ? [] : content.split(/\r?\n/u);
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const header = parseTableHeaderLine(lines[i]);
    if (header) {
      if (current) current.end = i;
      current = { header, start: i, end: lines.length };
      sections.push(current);
    }
  }

  const servers = new Map();

  for (const section of sections) {
    if (section.header[0] !== "mcp_servers" || section.header.length < 2) continue;
    const serverName = section.header[1];
    const subPath = section.header.slice(2);
    if (!servers.has(serverName)) {
      servers.set(serverName, { raw: {}, sections: [] });
    }
    const entry = servers.get(serverName);
    entry.sections.push(section);

    let target = entry.raw;
    for (const seg of subPath) {
      if (!target[seg] || typeof target[seg] !== "object" || Array.isArray(target[seg])) {
        target[seg] = {};
      }
      target = target[seg];
    }

    let i = section.start + 1;
    while (i < section.end) {
      const cleaned = stripInlineComment(lines[i]);
      if (!cleaned) {
        i += 1;
        continue;
      }
      const eq = findAssignmentIndex(cleaned);
      if (eq < 0) {
        i += 1;
        continue;
      }
      const keyParts = parseDottedHeader(cleaned.slice(0, eq).trim());
      if (!keyParts || keyParts.length === 0) {
        i += 1;
        continue;
      }
      let valueStr = cleaned.slice(eq + 1).trim();
      while (!isBalancedValue(valueStr) && i + 1 < section.end) {
        i += 1;
        valueStr += " " + stripInlineComment(lines[i]);
      }
      const parsedVal = parseScalarOrCompound(valueStr);
      let cursor = target;
      for (let k = 0; k < keyParts.length - 1; k += 1) {
        if (!cursor[keyParts[k]] || typeof cursor[keyParts[k]] !== "object") {
          cursor[keyParts[k]] = {};
        }
        cursor = cursor[keyParts[k]];
      }
      cursor[keyParts[keyParts.length - 1]] = parsedVal;
      i += 1;
    }
  }

  const result = {};
  for (const [name, { raw }] of servers.entries()) {
    result[name] = raw;
  }
  return { servers: result, sections, lines, eol };
}

/**
 * Serialize one `[mcp_servers.<name>]` block (+ optional `.env` / `.http_headers` sub-tables).
 */
export function renderCodexMcpServerBlock(name, rawEntry, eol = "\n") {
  const safeName = formatTomlKey(name);
  const out = [`[mcp_servers.${safeName}]`];

  const scalarKeys = [
    "type",
    "command",
    "args",
    "url",
    "enabled",
    "disabled_tools",
    "bearer_token_env_var",
    "env_vars",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "cwd",
  ];
  const emitted = new Set();

  for (const key of scalarKeys) {
    if (Object.hasOwn(rawEntry, key) && rawEntry[key] !== undefined) {
      out.push(`${formatTomlKey(key)} = ${formatTomlValue(rawEntry[key])}`);
      emitted.add(key);
    }
  }

  // Emit any preserved extra scalar/array fields before sub-tables.
  const subTables = [];
  for (const [key, value] of Object.entries(rawEntry)) {
    if (emitted.has(key) || value === undefined) continue;
    if (key === "env" || key === "http_headers" || (value && typeof value === "object" && !Array.isArray(value))) {
      if (value && typeof value === "object" && Object.keys(value).length > 0) {
        subTables.push([key, value]);
      }
    } else {
      out.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
    }
  }

  for (const [subKey, tableObj] of subTables) {
    out.push("");
    out.push(`[mcp_servers.${safeName}.${formatTomlKey(subKey)}]`);
    for (const [k, v] of Object.entries(tableObj)) {
      if (v === undefined) continue;
      out.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`);
    }
  }

  return out.join(eol);
}

/**
 * Surgically upsert or delete a single `[mcp_servers.<name>]` entry inside Codex `config.toml`
 * while preserving all unrelated sections, keys, and comments byte-for-byte.
 */
export function patchCodexMcpToml(content, serverName, nextRawEntry) {
  const parsed = parseCodexMcpToml(content);
  const { lines, sections, eol } = parsed;
  const matching = sections.filter(
    (s) => s.header[0] === "mcp_servers" && s.header[1] === serverName,
  );

  // Remove all existing spans for this server (main section + .env / .http_headers sub-tables).
  const keepLine = new Array(lines.length).fill(true);
  let insertAt = -1;
  for (const sec of matching) {
    if (insertAt < 0) insertAt = sec.start;
    for (let i = sec.start; i < sec.end; i += 1) {
      keepLine[i] = false;
    }
  }

  // Build resulting lines.
  const nextBlockLines =
    nextRawEntry !== null ? renderCodexMcpServerBlock(serverName, nextRawEntry, eol).split(eol) : null;

  if (matching.length > 0) {
    const out = [];
    let inserted = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (i === insertAt && nextBlockLines && !inserted) {
        if (out.length > 0 && out[out.length - 1].trim() !== "") {
          out.push("");
        }
        out.push(...nextBlockLines);
        out.push("");
        inserted = true;
      }
      if (keepLine[i]) {
        out.push(lines[i]);
      }
    }
    if (nextBlockLines && !inserted) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      out.push(...nextBlockLines);
    }
    return collapseExcessBlankLines(out).join(eol).replace(/\r?\n*$/u, "") + eol;
  }

  if (!nextBlockLines) {
    return content;
  }

  // Appending a new server cleanly at the end of the file.
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") {
    out.pop();
  }
  if (out.length > 0) {
    out.push("");
  }
  out.push(...nextBlockLines);
  return out.join(eol) + eol;
}

function collapseExcessBlankLines(lines) {
  const out = [];
  let blankStreak = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankStreak += 1;
      if (blankStreak <= 1) out.push("");
    } else {
      blankStreak = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out;
}
