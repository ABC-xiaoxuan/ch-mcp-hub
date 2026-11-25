/**
 * Generates a crisp anti-aliased 256x256 PNG extension icon (`assets/icon.png`)
 * using only Node built-ins (`node:zlib`, `node:fs/promises`).
 *
 * Design: Precision Patchbay emblem — rounded obsidian tile with subtle hairline border,
 * central hub ring, and 4 harness nodes (Claude, Antigravity, OpenCode, Codex).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const SIZE = 256;

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function blend(dst, idx, r, g, b, alpha) {
  const a = clamp01(alpha);
  if (a <= 0) return;
  const inv = 1 - a;
  const da = dst[idx + 3] / 255;
  const outA = a + da * inv;
  if (outA <= 0) return;
  dst[idx] = Math.round((r * a + dst[idx] * da * inv) / outA);
  dst[idx + 1] = Math.round((g * a + dst[idx + 1] * da * inv) / outA);
  dst[idx + 2] = Math.round((b * a + dst[idx + 2] * da * inv) / outA);
  dst[idx + 3] = Math.round(outA * 255);
}

function renderIcon() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  const nodes = [
    { x: 74, y: 76, color: [217, 119, 87] }, // Claude terracotta
    { x: 182, y: 76, color: [59, 130, 246] }, // Antigravity blue
    { x: 74, y: 180, color: [16, 185, 129] }, // OpenCode emerald
    { x: 182, y: 180, color: [99, 102, 241] }, // Codex indigo
  ];

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const idx = (y * SIZE + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // 1. Rounded tile backdrop
      const dRect = sdRoundedRect(px, py, cx, cy, 114, 114, 48);
      const tileAlpha = clamp01(0.5 - dRect);
      if (tileAlpha <= 0) continue;

      // Subtle vertical graphite tone shift
      const t = py / SIZE;
      const bgR = 17 + Math.round((1 - t) * 11);
      const bgG = 21 + Math.round((1 - t) * 13);
      const bgB = 29 + Math.round((1 - t) * 16);
      blend(rgba, idx, bgR, bgG, bgB, tileAlpha);

      // Hairline inner border
      const borderAlpha = clamp01(1 - Math.abs(dRect + 2.5) / 1.8) * tileAlpha * 0.24;
      blend(rgba, idx, 226, 232, 240, borderAlpha);

      // Subtle radial glow behind hub
      const distCenter = Math.hypot(px - cx, py - cy);
      if (distCenter < 92) {
        const glow = (1 - distCenter / 92) ** 2 * 0.14 * tileAlpha;
        blend(rgba, idx, 96, 165, 250, glow);
      }

      // 2. Patch lines from center to each harness node
      for (const node of nodes) {
        const dSeg = sdSegment(px, py, cx, cy, node.x, node.y);
        const lineA = clamp01(4.2 - dSeg) * 0.42 * tileAlpha;
        if (lineA > 0) {
          blend(rgba, idx, 148, 163, 184, lineA);
        }
      }

      // 3. Outer ring around center hub
      const ringDist = Math.abs(distCenter - 36);
      const ringA = clamp01(2.2 - ringDist) * 0.28 * tileAlpha;
      if (ringA > 0) blend(rgba, idx, 226, 232, 240, ringA);

      // 4. Four harness nodes with soft halo + crisp core
      for (const node of nodes) {
        const dn = Math.hypot(px - node.x, py - node.y);
        if (dn < 34) {
          const halo = (1 - dn / 34) ** 2 * 0.34 * tileAlpha;
          blend(rgba, idx, node.color[0], node.color[1], node.color[2], halo);
        }
        const outerA = clamp01(18.5 - dn) * tileAlpha;
        if (outerA > 0) {
          blend(rgba, idx, 22, 27, 37, outerA);
        }
        const ringNodeA = clamp01(2.6 - Math.abs(dn - 16)) * tileAlpha;
        if (ringNodeA > 0) {
          blend(rgba, idx, node.color[0], node.color[1], node.color[2], ringNodeA);
        }
        const coreA = clamp01(9.5 - dn) * tileAlpha;
        if (coreA > 0) {
          blend(rgba, idx, node.color[0], node.color[1], node.color[2], coreA);
        }
      }

      // 5. Center precision hub core
      const hubBgA = clamp01(24.5 - distCenter) * tileAlpha;
      if (hubBgA > 0) blend(rgba, idx, 241, 245, 249, hubBgA);
      const hubInnerA = clamp01(12.5 - distCenter) * tileAlpha;
      if (hubInnerA > 0) blend(rgba, idx, 17, 24, 39, hubInnerA);
      const hubDotA = clamp01(5.2 - distCenter) * tileAlpha;
      if (hubDotA > 0) blend(rgba, idx, 96, 165, 250, hubDotA);
    }
  }

  return encodePng(SIZE, SIZE, rgba);
}

const png = renderIcon();
const outPath = path.join(rootDir, "assets", "icon.png");
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, png);
console.log(`Generated ${outPath} (${png.length} bytes)`);
