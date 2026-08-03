import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");
const deepening = readFileSync(join(here, "DEEPENING.md"), "utf8");
const twice = readFileSync(join(here, "DESIGN-IT-TWICE.md"), "utf8");

test("frontmatter names the skill with a when-to-use description and negative scope", () => {
  assert.match(s, /^---\nname: codebase-design\n/);
  assert.match(s, /description: Use when/);
  assert.match(s, /Do NOT use for/i);
});

test("defines the deep-module glossary and the deletion test", () => {
  for (const term of ["Module", "Interface", "Seam", "Depth", "Adapter", "Leverage", "Locality"]) {
    assert.match(s, new RegExp(`\\*\\*${term}\\*\\*`), `glossary defines ${term}`);
  }
  assert.match(s, /deletion test/i);
  assert.match(s, /One adapter means a hypothetical seam/i);
});

test("keeps architecture vocabulary distinct from domain vocabulary", () => {
  assert.match(s, /distinct from \*domain\* vocabulary/);
});

test("deepening doc classifies dependencies and mandates replace-don't-layer", () => {
  assert.match(deepening, /In-process/i);
  assert.match(deepening, /Ports & Adapters|port/i);
  assert.match(deepening, /replace, don't layer/i);
});

test("design-it-twice REQUIRES an explicit model tier on every sub-agent dispatch", () => {
  assert.match(twice, /model:\s*['"]sonnet['"]/);
  assert.match(twice, /workflow-model-guard/);
  assert.match(twice, /REQUIRED|must set|never omit/i);
  // sub-agents run in parallel, orchestrator keeps the comparison
  assert.match(twice, /single message|in parallel|concurrently/i);
});

test("design-it-twice clarifies the ports & adapters agent applies to injected-port deps (categories 3 and 4)", () => {
  assert.match(twice, /Category 3/i);
  assert.match(twice, /Category 4/i);
  assert.match(twice, /injected port/i);
});
