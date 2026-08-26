#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Workflow): nudge Claude to tier models in high-fan-out
// Workflow scripts. The Workflow tool spawns sub-agents that inherit the session's
// main-loop model (typically a frontier-tier model) unless each agent() call sets
// opts.model. A big fan-out with no model overrides silently runs every worker on
// that model and burns usage limits.
//
// Three invocation forms, three responses:
//   - inline `script`  → inspect it; deny if it fans out untiered (Claude revises + re-runs).
//   - `scriptPath`     → read the file and inspect the same way (Claude edits the file + re-runs).
//   - `name`           → can't read or rewrite a built-in/saved workflow. If it's a known
//                        high-fan-out one (NAME_DENYLIST), ASK the user (deny-to-Claude can't be
//                        resolved — Claude can't edit a built-in, so it would dead-end).
// Scale-gated: small/cheap inline/scriptPath workflows pass silently so the hook doesn't
// fight the tool's own "omit model by default" guidance.

import process from "node:process";
import { readFileSync } from "node:fs";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

// Named workflows that fan out widely, inherit the session model for every spawned
// agent (no per-agent model: override), and that Claude cannot edit — e.g. the built-in
// `deep-research` harness. Inheriting is not the same as pinning a tier: on a Sonnet
// session these are cheap, and the `ask` is a per-run cost speed-bump, not a claim
// about which model they run. We can't rewrite them, so we ASK rather than deny.
const NAME_DENYLIST = ["deep-research"];

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {{ script?: string, scriptPath?: string, name?: string }} [tool_input]
 */

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

// Only guard the Workflow tool. Anything else → proceed normally.
if (!payload || payload.tool_name !== "Workflow") process.exit(0);

const input = payload.tool_input || {};

// Resolve the inspectable script: inline first, then read scriptPath off disk.
let script =
  typeof input.script === "string" && input.script.length ? input.script : null;

if (!script && typeof input.scriptPath === "string" && input.scriptPath.length) {
  try {
    script = readFileSync(input.scriptPath, "utf8");
  } catch {
    process.exit(0); // unreadable path → don't guess, allow.
  }
}

// No inspectable script (a `name:` invocation). Ask the user only for known
// high-fan-out named workflows; leave every other named/saved workflow alone.
if (!script) {
  const name = typeof input.name === "string" ? input.name : "";
  if (name && NAME_DENYLIST.includes(name)) {
    emitPermissionDecision(
      "ask",
      `workflow-model-guard: the "${name}" workflow sets no per-agent model: override, so ` +
        "every agent it spawns inherits this session's model — on a frontier-tier session " +
        "that is an expensive default, and it can't be tiered from here (it's not an " +
        "editable script). Cheaper: switch this session to Sonnet " +
        "(/model sonnet) before running it, or run a model-tiered workflow instead. Proceed anyway?",
    );
  }
  process.exit(0);
}

// Bypass 1: any `model:` means Claude already weighed tiers (even one override counts).
// Bypass 2: explicit ack that the inherited tier is intended — prevents an infinite deny loop.
if (/\bmodel\s*:/.test(script) || script.includes("model-guard:ack")) process.exit(0);

// Static fan-out signals. agentCount is a lower bound — loops and .map() over items
// mean the real spawn count is higher, so presence of fan-out/loop is the stronger cue.
const agentCount = (script.match(/\bagent\s*\(/g) || []).length;
const fanout = script.includes("parallel(") || script.includes("pipeline(");
const loopy =
  /\bwhile\s*\(/.test(script) ||
  /\bfor\s*\(/.test(script) ||
  script.includes("budget.remaining");

const expensive = agentCount >= 4 || fanout || (loopy && agentCount >= 1);
if (!expensive) process.exit(0);

// Name only the signals that actually fired, so the reason never reads "~0 agent() calls".
const signals = [];
if (agentCount >= 1) {
  signals.push(`~${agentCount} agent() call${agentCount === 1 ? "" : "s"}`);
}
if (fanout) signals.push("parallel/pipeline fan-out");
if (loopy) signals.push("a spawn loop");
const what = signals.join(" + ");

const reason =
  `workflow-model-guard: this workflow has ${what} and no per-agent model: override — ` +
  "every spawned agent defaults to the main-loop model, which burns usage limits fast " +
  "on frontier-tier sessions. Add model:'sonnet' (or 'haiku') to worker agents that " +
  "don't need the top tier. If the top tier is genuinely required for all of them, add a " +
  "`// model-guard:ack` comment to the script and re-run.";

emitPermissionDecision("deny", reason);
process.exit(0);
