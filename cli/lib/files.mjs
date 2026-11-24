import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** A missing or empty config is {}; anything unparseable stops the caller before it changes a thing. */
export function parseJsonConfig(file, text) {
  if (!text.trim()) return {};
  let parsed;
  try {
    // A leading byte-order mark is not JSON, but Windows editors and some tools write one (OpenCode's own
    // opencode.jsonc had one on the fleet PC). It carries no data, so it is dropped rather than refused.
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it first, nothing was changed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object; fix it first, nothing was changed.`);
  }
  return parsed;
}

/** Writes only when the content changed, keeping the previous file as <file>.bak-<timestamp>.
 * New files are created owner-only because client configs carry the agent key. */
export function writeWithBackup(file, before, after) {
  if (after === before) return { changed: false, backup: null };
  mkdirSync(dirname(file), { recursive: true });
  let backup = null;
  if (before) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, after, { mode: 0o600 });
  return { changed: true, backup };
}
