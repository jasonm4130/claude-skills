// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "check-shipgate-flag.mjs");

test("consumes flag and emits agent-directed additionalContext", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  const flag = path.join(dataDir, "shipgate-nudge-dev.flag");
  writeFileSync(flag, "2 commit(s) on 'feature-x' not pushed to upstream");
  const out = execSync(`echo '{"session_id":"dev"}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /\[ship-gate\]/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /code-review/);
  assert.ok(!existsSync(flag), "flag consumed");
});

test("no flag → no output", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  const out = execSync(`echo '{"session_id":"dev"}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "");
});
