import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter names the frontend-design skill with a trigger-rich, negatively-scoped description", () => {
  assert.match(s, /^---\nname: frontend-design\n/);
  assert.match(s, /description:.*design/i);
  assert.match(s, /Do NOT use for/);
  assert.match(s, /backend\/API\/data-model/);
});

test("documents the light/heavy scope gate and the light-path loop", () => {
  assert.match(s, /Light — design inline/);
  assert.match(s, /Heavy — hand off to the browser/);
  assert.match(s, /Ground it in the subject/);
  assert.match(s, /Design principles/);
  assert.match(s, /### Explore/);
  assert.match(s, /Self-critique/);
});

test("heavy path points to the dedicated claude-design skill for the best-in-class brief", () => {
  assert.match(s, /claude-design/); // the sibling skill name (lowercase-hyphen), not just the product name
});

test("heavy path routes to Claude Design and emits the exact paste-ready brief template", () => {
  assert.match(s, /Claude Design/);
  assert.match(s, /# Design brief: <feature>/);
  assert.match(s, /\*\*Goal \/ job-to-be-done:\*\*/);
  assert.match(s, /\*\*Users & context:\*\*/);
  assert.match(s, /\*\*Constraints:\*\*/);
  assert.match(s, /\*\*Screens \/ components:\*\*/);
  assert.match(s, /\*\*Existing patterns to match:\*\*/);
  assert.match(s, /\*\*References \/ inspiration:\*\*/);
});
