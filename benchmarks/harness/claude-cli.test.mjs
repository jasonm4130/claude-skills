import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, parseClaudeResult } from "./claude-cli.mjs";

test("buildClaudeArgs: schema inline, allowed tools last and only when present", () => {
  const args = buildClaudeArgs({ prompt: "P", model: "sonnet", schema: { type: "object" }, allowedTools: ["Read", "Grep"] });
  assert.deepEqual(args.slice(0, 2), ["-p", "P"]);
  assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "json");
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
  assert.deepEqual(args.slice(-3), ["--allowed-tools", "Read", "Grep"]);
  const noTools = buildClaudeArgs({ prompt: "P", model: "sonnet", schema: {}, allowedTools: [] });
  assert.ok(!noTools.includes("--allowed-tools"));
});

const FIXTURE = JSON.stringify({
  type: "result", subtype: "success", is_error: false, duration_ms: 6372,
  result: '{"answer":"ok"}', total_cost_usd: 0.066,
  usage: { input_tokens: 20, output_tokens: 255 },
  structured_output: { answer: "ok" },
});

test("parseClaudeResult: success extracts structured output, tokens, wall time", () => {
  const r = parseClaudeResult(FIXTURE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { answer: "ok" });
  assert.deepEqual(r.tokens, { input: 20, output: 255 });
  assert.equal(r.wallMs, 6372);
});

test("parseClaudeResult: error and malformed cases", () => {
  assert.equal(parseClaudeResult("not json").ok, false);
  assert.equal(parseClaudeResult(JSON.stringify({ is_error: true, subtype: "error_during_execution" })).ok, false);
  assert.equal(parseClaudeResult(JSON.stringify({ is_error: false })).ok, false); // no structured_output
});
