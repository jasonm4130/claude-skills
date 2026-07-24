import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter: name, model-invocable, trigger-rich description", () => {
  assert.match(s, /^---\nname: adversarial-agents\n/);
  // No inbound routing exists (grep -rn "adversarial-agents" plugins/*/skills/*/SKILL.md
  // hits only this file), and the panel is already cost-gated internally (triage +
  // pre-commitment gate), so — mirroring deep-dive's identical fix (commit 7c39408) —
  // model-invocation is restored: the description's own natural-language triggers
  // ("red-team a plan", "grill me", ...) must actually be reachable.
  assert.doesNotMatch(s, /disable-model-invocation/);
  assert.match(s, /description:.*grill me/i);
});

test("core mechanics are documented", () => {
  assert.match(s, /panel/i);
  assert.match(s, /persona/i);
  assert.match(s, /pre-commit|pre-commitment/i);
  assert.match(s, /artefact|artifact/i);
});
