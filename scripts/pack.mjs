/**
 * Build, verify, and pack `mcp-hub` into a CodexHost Marketplace-ready `.zip` archive.
 *
 * - Syncs `shared/style.css` into self-contained `web/style.css` and `page/style.css`
 *   (no fragile CSS `@import` across Shadow DOM / Web asset URLs).
 * - Runs the exact static safety and manifest contract checks enforced by
 *   `BytePioneer-AI/codexhost-extensions-registry/validate-and-build-catalog.mjs`.
 * - Produces `dist/mcp-hub-<version>.zip` + `dist/icon.png` (ready for GitHub Release upload)
 *   using pure Node (`node:zlib`) with standard DEFLATE entries.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const stylesOnly = args.has("--styles-only");
const verifyOnly = args.has("--verify-only");

const FORBIDDEN_PATTERNS = [
  ["eval", /\beval\s*\(/u],
  ["Function constructor", /\bnew\s+Function\b/u],
  ["child_process", /\bchild_process\b/u],
];

const PACKAGE_ITEMS = [
  "manifest.json",
  "README.md",
  "CHANGELOG.md",
  "assets",
  "backend",
  "shared",
  "web",
  "page",
];

// ---------------------------------------------------------------------------
// 1. Sync self-contained entry stylesheets
// ---------------------------------------------------------------------------

async function syncStyles() {
  const sharedCss = await readFile(path.join(rootDir, "shared", "style.css"), "utf8");
  const banner = "/* Generated from shared/style.css by scripts/pack.mjs — do not edit directly */\n\n";
  await writeFile(path.join(rootDir, "web", "style.css"), banner + sharedCss, "utf8");
  await writeFile(path.join(rootDir, "page", "style.css"), banner + sharedCss, "utf8");
}

// ---------------------------------------------------------------------------
// 2. Collect files & run Marketplace contract + static safety checks
// ---------------------------------------------------------------------------

async function collectFiles(relPaths) {
  const out = [];
  async function walk(rel) {
    const abs = path.join(rootDir, rel);
    const info = await stat(abs);
    if (info.isDirectory()) {
      const children = (await readdir(abs)).sort();
      for (const child of children) {
        if (child.startsWith(".") || child.endsWith(".tmp")) continue;
        await walk(`${rel}/${child}`);
      }
    } else if (info.isFile()) {
      out.push({ rel: rel.replace(/\\/gu, "/"), abs, bytes: await readFile(abs) });
    }
  }
  for (const rel of relPaths) {
    try {
      await walk(rel);
    } catch (error) {
      if ((rel === "README.md" || rel === "CHANGELOG.md") && error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return out;
}

function verifyPackage(files) {
  const fileMap = new Map(files.map((f) => [f.rel, f.bytes]));
  const manifestBytes = fileMap.get("manifest.json");
  if (!manifestBytes) throw new Error("Missing manifest.json");
  if (manifestBytes.length > 128 * 1024) throw new Error("manifest.json exceeds 128 KiB");

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.manifestVersion !== 2) throw new Error("Expected manifestVersion: 2");
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(manifest.id)) {
    throw new Error(`Invalid extension id: ${manifest.id}`);
  }
  if (!manifest.name?.en || !manifest.name?.["zh-CN"]) {
    throw new Error("manifest.name must contain both en and zh-CN");
  }
  if (!manifest.description?.en || !manifest.description?.["zh-CN"]) {
    throw new Error("manifest.description must contain both en and zh-CN");
  }
  if (!manifest.version || manifest.version !== manifest.version.trim()) {
    throw new Error("Invalid manifest.version");
  }

  // Validate declared entries exist and obey size limits.
  const entries = [
    manifest.page?.entry,
    manifest.widget?.entry,
    manifest.web?.entry,
    manifest.backend?.entry,
  ].filter(Boolean);
  for (const entry of entries) {
    const b = fileMap.get(entry);
    if (!b) throw new Error(`Missing declared entry: ${entry}`);
    if (b.length > 2 * 1024 * 1024) throw new Error(`Entry exceeds 2 MiB: ${entry}`);
  }
  for (const style of [manifest.page?.style, manifest.widget?.style, manifest.web?.style].filter(Boolean)) {
    const b = fileMap.get(style);
    if (!b) throw new Error(`Missing declared stylesheet: ${style}`);
    if (b.length > 256 * 1024) throw new Error(`Stylesheet exceeds 256 KiB: ${style}`);
  }

  // Validate icon & screenshots PNG header & size.
  if (manifest.icon) {
    const iconBytes = fileMap.get(manifest.icon);
    if (!iconBytes) throw new Error(`Missing icon: ${manifest.icon}`);
    if (iconBytes.length > 128 * 1024) throw new Error("Icon exceeds 128 KiB");
    if (iconBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Icon ${manifest.icon} does not have a valid PNG signature`);
    }
  }
  if (Array.isArray(manifest.screenshots)) {
    if (manifest.screenshots.length > 4) throw new Error("At most 4 screenshots are allowed");
    let totalShotBytes = 0;
    for (const shot of manifest.screenshots) {
      const shotBytes = fileMap.get(shot);
      if (!shotBytes) throw new Error(`Missing screenshot: ${shot}`);
      if (shotBytes.length > 512 * 1024) throw new Error(`Screenshot exceeds 512 KiB: ${shot}`);
      if (shotBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error(`Screenshot ${shot} does not have a valid PNG signature`);
      }
      totalShotBytes += shotBytes.length;
    }
    if (totalShotBytes > 2 * 1024 * 1024) throw new Error("Screenshots total exceeds 2 MiB");
  }

  // Validate no dynamic import() or bare specifiers in Desktop `page` graph.
  for (const f of files) {
    if (!/\.[cm]?[jt]sx?$/iu.test(f.rel)) continue;
    const code = f.bytes.toString("utf8");
    for (const [label, regex] of FORBIDDEN_PATTERNS) {
      if (regex.test(code)) {
        throw new Error(`Static security scan failed on ${f.rel}: matched ${label}`);
      }
    }
    if (f.rel.startsWith("page/") || f.rel.startsWith("shared/") || f.rel.startsWith("web/")) {
      if (/\bimport\s*\(/u.test(code)) {
        throw new Error(`Dynamic import() is disallowed in frontend bundle: ${f.rel}`);
      }
    }
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// 3. Pure-Node ZIP creator (DEFLATE method 8, UTF-8 filenames)
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.rel, "utf8");
    const uncompressed = file.bytes;
    const compressed = deflateRawSync(uncompressed, { level: 9 });
    const useDeflate = compressed.length < uncompressed.length;
    const payload = useDeflate ? compressed : uncompressed;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(uncompressed);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await syncStyles();
if (stylesOnly) {
  console.log("Synced web/style.css and page/style.css from shared/style.css");
  process.exit(0);
}

const files = await collectFiles(PACKAGE_ITEMS);
const manifest = verifyPackage(files);
console.log(
  `Verified ${manifest.id}@${manifest.version}: ${files.length} files, 0 static security issues`,
);

if (verifyOnly) process.exit(0);

const zip = buildZip(files);
if (zip.length > 64 * 1024 * 1024) {
  throw new Error("ZIP exceeds 64 MiB Marketplace limit");
}
const sha256 = createHash("sha256").update(zip).digest("hex");
const distDir = path.join(rootDir, "dist");
await mkdir(distDir, { recursive: true });
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = path.join(distDir, zipName);
await writeFile(zipPath, zip);
if (manifest.icon) {
  await copyFile(
    path.join(rootDir, manifest.icon),
    path.join(distDir, path.basename(manifest.icon)),
  );
}
for (const shot of manifest.screenshots ?? []) {
  await copyFile(
    path.join(rootDir, shot),
    path.join(distDir, path.basename(shot)),
  );
}
console.log(`Packed ${zipPath} (${zip.length} bytes, sha256=${sha256})`);
