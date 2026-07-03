import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter: name, user-invoked only, trigger-rich description", () => {
  assert.match(s, /^---\nname: adversarial-agents\n/);
  assert.match(s, /disable-model-invocation: true/);
  assert.match(s, /description:.*grill me/i);
});

test("core mechanics are documented", () => {
  assert.match(s, /panel/i);
  assert.match(s, /persona/i);
  assert.match(s, /pre-commit|pre-commitment/i);
  assert.match(s, /artefact|artifact/i);
});
