import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter names the adr skill with a trigger-rich description", () => {
  assert.match(s, /^---\nname: adr\n/);
  assert.match(s, /description:.*adr/i);
});

test("documents the four phases and the ADR document shape", () => {
  assert.match(s, /ground/i);
  assert.match(s, /docs\/adr\/.*<slug>|YYYY-MM-DD-<slug>/);
  assert.match(s, /success criteria/i);
  assert.match(s, /decomposition/i);
  assert.match(s, /### Task N|### Task 1|# Task N/);
});

test("enforces grounding citations and surfaces load-bearing decisions", () => {
  assert.match(s, /cite|citation/i);
  assert.match(s, /new dependency/i);
  assert.match(s, /public[- ]api/i);
  assert.match(s, /schema/i);
});

test("hands off to the subagent-driven-development workflow with the ADR", () => {
  assert.match(s, /subagent-driven-development|sdd\.mjs/i);
  assert.match(s, /adrPath/);
  assert.match(s, /successCriteria/);
  assert.match(s, /subagent-driven-development\/\d+\.\d+\.\d+\/workflows\/sdd\.mjs/);
  assert.match(s, /MISSING: subagent-driven-development/);
  assert.match(s, /parseable|stop and fix|do not hand off/i);
});
