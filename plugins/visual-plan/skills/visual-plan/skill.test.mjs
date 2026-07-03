import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter: name and trigger-rich description", () => {
  assert.match(s, /^---\nname: visual-plan\n/);
  assert.match(s, /description:.*ADR/);
  assert.match(s, /Triggers:/);
});

test("markdown-canonical contract is documented", () => {
  assert.match(s, /Markdown canonical/i);
  assert.match(s, /plan\.html/);
  assert.match(s, /mermaid/i);
});
