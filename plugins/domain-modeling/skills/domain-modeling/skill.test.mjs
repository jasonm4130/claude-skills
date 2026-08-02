import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");
const fmt = readFileSync(join(here, "CONTEXT-FORMAT.md"), "utf8");

test("frontmatter names the skill with a trigger-rich, when-to-use description", () => {
  assert.match(s, /^---\nname: domain-modeling\n/);
  assert.match(s, /description: Use when/);
  assert.match(s, /ubiquitous language|glossary/i);
});

test("description carries a negative scope and routes decisions to adr", () => {
  assert.match(s, /Do NOT use for/i);
  assert.match(s, /adr/);
});

test("keeps CONTEXT.md a glossary only — no implementation details or ADR format", () => {
  assert.match(s, /CONTEXT\.md/);
  assert.match(s, /glossary and nothing else|devoid of implementation/i);
  // ADR recording is delegated, not re-defined here.
  assert.match(s, /adr` skill|adr skill/i);
  assert.doesNotMatch(s, /0001-.*\.md/); // no numbered-ADR convention copied from upstream
});

test("documents the active behaviours and lazy, inline capture", () => {
  assert.match(s, /Challenge against the glossary/i);
  assert.match(s, /Sharpen fuzzy language/i);
  assert.match(s, /scenario/i);
  assert.match(s, /Cross-reference with code/i);
  assert.match(s, /lazily/i);
});

test("flags collisions between domain terms and general-programming terms", () => {
  assert.match(s, /Flag collisions with technical terms/i);
  assert.match(s, /rollback/i);
});

test("format doc covers single and multi-context repos", () => {
  assert.match(fmt, /CONTEXT-MAP\.md/);
  assert.match(fmt, /_Avoid_/);
  assert.match(fmt, /Single vs multi-context/i);
});
