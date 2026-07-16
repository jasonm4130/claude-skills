import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HOOK = new URL("../hooks/session-start", import.meta.url).pathname;
const HOOKS_JSON = new URL("../hooks/hooks.json", import.meta.url).pathname;

test("hook emits valid JSON with non-empty additionalContext", () => {
  const out = execFileSync(HOOK, { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" } });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(parsed.hookSpecificOutput.additionalContext.length > 200);
  assert.match(parsed.hookSpecificOutput.additionalContext, /specificity/i);
});

test("matcher covers all four SessionStart sources", () => {
  const cfg = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  assert.equal(cfg.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
});
