import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter names the claude-design skill with a trigger-rich, negatively-scoped description", () => {
  assert.match(s, /^---\nname: claude-design\n/);
  assert.match(s, /description:.*Claude Design/);
  assert.match(s, /claude\.ai\/design/);
  assert.match(s, /Do NOT use for/);
  assert.match(s, /frontend-design/); // negative scope points back to the light-path skill
});

test("codifies Anthropic's official goal/layout/content/audience prompt framework", () => {
  assert.match(s, /\*\*Goal\*\*/);
  assert.match(s, /\*\*Audience\*\*/);
  assert.match(s, /\*\*Layout \/ screens\*\*/);
  assert.match(s, /\*\*Content\*\*/);
  assert.match(s, /start simple, then layer in complexity/);
});

test("emits the paste-ready Claude Design brief template with the extended fields", () => {
  assert.match(s, /# Claude Design brief: <what you're building>/);
  assert.match(s, /\*\*Visual direction\*\*/);
  assert.match(s, /\*\*Constraints\*\*/);
  assert.match(s, /\*\*Assets to attach\*\*/);
});

test("documents both modes: browser brief and driving from Claude Code", () => {
  assert.match(s, /Two ways to run it/);
  assert.match(s, /In the browser/);
  assert.match(s, /From Claude Code/);
});

test("gives the exact Claude Code integration commands verbatim", () => {
  assert.match(
    s,
    /claude mcp add --scope user --transport http claude-design https:\/\/api\.anthropic\.com\/v1\/design\/mcp/,
  );
  assert.match(s, /\/design-login/);
  assert.match(s, /`\/design`/);
  assert.match(s, /`\/design-sync`/);
  assert.match(s, /Handoff bundle/);
});

test("maps iteration changes to the right channel", () => {
  assert.match(s, /Chat/);
  assert.match(s, /Inline comment/);
  assert.match(s, /Sliders \/ knobs/);
  assert.match(s, /variations/i);
});

test("states where Claude Design stops (limits) so a brief targets the right tool", () => {
  assert.match(s, /pixel-perfect/);
  assert.match(s, /front-end only/);
  assert.match(s, /Known quirks/);
});
