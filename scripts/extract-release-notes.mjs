/**
 * Extract the Markdown release notes for a specific semantic version from `CHANGELOG.md`.
 *
 * Usage:
 *   node scripts/extract-release-notes.mjs 1.3.0
 *   node scripts/extract-release-notes.mjs v1.3.0
 *
 * Exits with non-zero status if `CHANGELOG.md` does not contain a non-empty section
 * for the requested version, ensuring every release includes documented notes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const rawArg = String(process.argv[2] ?? "").trim();
const version = rawArg.replace(/^v/iu, "");
if (!version) {
  console.error("Usage: node scripts/extract-release-notes.mjs <version>");
  process.exit(1);
}

const changelogPath = path.join(rootDir, "CHANGELOG.md");
let content;
try {
  content = readFileSync(changelogPath, "utf8");
} catch (error) {
  console.error(`Failed to read ${changelogPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const headingRe = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s+-\\s+.*)?\\s*$`, "m");
const match = headingRe.exec(content);
if (!match) {
  console.error(`Missing CHANGELOG.md section for version ${version} (expected heading "## [${version}] - YYYY-MM-DD")`);
  process.exit(1);
}

const startIdx = match.index + match[0].length;
const rest = content.slice(startIdx);
const nextHeading = rest.search(/^##\s+/m);
const sectionBody = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();

if (!sectionBody) {
  console.error(`CHANGELOG.md section for version ${version} is empty`);
  process.exit(1);
}

process.stdout.write(`${sectionBody}\n`);
