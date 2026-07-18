import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, cacheKey, CellCache } from "./cache.mjs";

test("canonicalJson is key-order independent, arrays ordered", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("cacheKey changes when any part changes", () => {
  const base = { item: "abc", arm: "seeded", adapter: "sdd", version: "v1", trial: 0 };
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, trial: 1 }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, version: "v2" }));
});

test("CellCache round-trips, shards, and returns null for corrupt entries", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-cache-"));
  const cache = new CellCache(root);
  const key = cacheKey({ x: 1 });
  assert.equal(cache.get(key), null);
  cache.put(key, { hello: "world" });
  assert.deepEqual(cache.get(key), { hello: "world" });
  assert.deepEqual(readdirSync(root), [key.slice(0, 2)]);
  writeFileSync(join(root, key.slice(0, 2), `${key}.json`), "{corrupt");
  assert.equal(cache.get(key), null);
  rmSync(root, { recursive: true, force: true });
});
