// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/posttoolusefailure-signing-nudge.mjs", import.meta.url));

/** @param {object} payload @param {Record<string, string>} [env] */
function run(payload, env = {}) {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout };
}

const fail = (error) => ({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "git commit -m x" }, error });

for (const error of [
  'Exit code 128\nsign_and_send_pubkey: signing failed for ED25519 "GitHub SSH" from agent: agent refused operation',
  "Exit code 128\nerror: 1Password: Could not connect to socket. Is the agent running?\nfatal: failed to write commit object",
  "Exit code 128\nerror: 1Password: failed to fill whole buffer\nfatal: failed to write commit object",
]) {
  test(`nudges on: ${error.split("\n")[1].slice(0, 40)}`, () => {
    const { status, stdout } = run(fail(error));
    assert.equal(status, 0);
    const out = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PostToolUseFailure");
    assert.match(out.additionalContext, /unlock 1Password/);
  });
}

test("silent on unrelated failures, other tools, bad input, and when disabled", () => {
  assert.deepEqual(run(fail("Exit code 1\nnpm ERR! missing script")), { status: 0, stdout: "" });
  assert.deepEqual(run({ ...fail("error: 1Password: failed to fill whole buffer"), tool_name: "Read" }), { status: 0, stdout: "" });
  assert.deepEqual(run(fail("error: 1Password: failed to fill whole buffer"), { GATES_DISABLE: "signing-nudge" }), { status: 0, stdout: "" });
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
  assert.deepEqual([r.status, r.stdout], [0, ""]);
});
