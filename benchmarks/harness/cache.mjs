// Content-addressed result cache. The key is a sha256 of canonical JSON, so
// any change to an input (item content, adapter version, model, trial) misses
// cleanly, and unchanged Codex cells never re-spend quota.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function cacheKey(parts) {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

export class CellCache {
  constructor(root) { this.root = root; }
  #path(key) { return join(this.root, key.slice(0, 2), `${key}.json`); }
  get(key) {
    try { return JSON.parse(readFileSync(this.#path(key), "utf8")); } catch { return null; }
  }
  put(key, value) {
    const p = this.#path(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, p);
  }
}
