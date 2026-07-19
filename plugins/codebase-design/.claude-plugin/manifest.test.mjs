import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

test("plugin.json is valid and names the plugin", () => {
  const p = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
  assert.equal(p.name, "codebase-design");
  assert.ok(p.description && p.description.length > 20);
  assert.ok(Array.isArray(p.keywords) && p.keywords.includes("deep-modules"));
});

test("marketplace.json registers the plugin", () => {
  const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = m.plugins.find((x) => x.name === "codebase-design");
  assert.ok(entry, "marketplace entry exists");
  assert.equal(entry.source, "./plugins/codebase-design");
});
