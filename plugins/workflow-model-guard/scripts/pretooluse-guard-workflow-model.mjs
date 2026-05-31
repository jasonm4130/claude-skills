#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Workflow): nudge Claude to tier models in high-fan-out
// Workflow scripts. The Workflow tool spawns sub-agents that inherit the main-loop
// model (Opus 4.8) unless each agent() call sets opts.model. A big fan-out with no
// model overrides silently runs every worker on Opus and burns usage limits.
//
// This hook denies such a call and feeds a reason back to Claude, which then revises
// the script to give workers cheaper models — or adds an ack marker to assert that
// all-Opus is intended. Scale-gated: small/cheap workflows pass silently so the hook
// doesn't fight the tool's own "omit model by default" guidance.

import process from "node:process";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {{ script?: string }} [tool_input]
 */

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

// Only guard the Workflow tool. Anything else → proceed normally.
if (!payload || payload.tool_name !== "Workflow") process.exit(0);

// Inline `script` is the only inspectable form. A scriptPath/name re-run has no
// script to read, so allow it (named/saved workflows are presumed vetted).
const script = payload.tool_input?.script;
if (typeof script !== "string" || script.length === 0) process.exit(0);

// Bypass 1: any `model:` means Claude already weighed tiers (even one override counts).
// Bypass 2: explicit ack that all-Opus is intended — prevents an infinite deny loop.
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

const fanoutNote = fanout ? ", parallel/pipeline fan-out" : "";
const reason =
  `workflow-model-guard: ~${agentCount} agent() call${agentCount === 1 ? "" : "s"}${fanoutNote} ` +
  "and no per-agent model: override — every spawned agent defaults to the main-loop " +
  "model (Opus 4.8), which burns usage limits fast. Add model:'claude-sonnet-4-6' (or " +
  "'claude-haiku-4-5') to worker agents that don't need Opus. If Opus is genuinely " +
  "required for all of them, add a `// model-guard:ack` comment to the script and re-run.";

emitPermissionDecision("deny", reason);
process.exit(0);
