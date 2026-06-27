import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter has name and a trigger-rich description", () => {
  assert.match(s, /^---\nname: subagent-driven-development\n/);
  assert.match(s, /description:.*plan/i);
});

test("documents the controller flow and the hand-off contract", () => {
  assert.match(s, /pre-flight|conflict scan/i);
  assert.match(s, /worktree/i);
  assert.match(s, /go-ahead|wait for.*go/i);
  assert.match(s, /Workflow\(/);
  assert.match(s, /pluginDir/);
  assert.match(s, /finishing|merge\/PR/i);
});

test("warns about path resolution and the plan-heading dependency", () => {
  assert.match(s, /sort -V \| tail -1|glob/i);
  assert.match(s, /# Task N|## Task/);
});
