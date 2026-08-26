#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Agent): make ad-hoc subagent dispatches pick a model tier
// deliberately. An Agent call with no `model` param inherits the session's main-loop
// model — on a frontier-tier session (Opus/Fable) that silently runs searches and
// mechanical work at the most expensive tier. Measured before this guard existed:
// 73% of 477 dispatches omitted `model`; the built-in Explore agent inherited in 71/75.
//
// Decision table:
//   - `model` present (any tier, even fable) → allow. Setting it IS the ack — the
//     point is a deliberate per-dispatch choice, not a cheap-only policy.
//   - subagent_type "fork"                   → allow. Forks always inherit by design;
//     the model param is ignored for them, so a deny could never be resolved.
//   - subagent_type resolves to a custom agent definition (project .claude/agents/
//     over ~/.claude/agents/) whose frontmatter pins `model:` (≠ inherit) → allow.
//     Claude Code's own resolution will apply that pinned tier.
//   - otherwise → deny with the tier calculus; Claude re-dispatches with a model.
//
// Verified on Claude Code 2.1.246 (probes re-run 2026-08-26; first run on 2.1.206,
// 2026-07-11): PreToolUse fires on Agent dispatch, tool_input carries
// subagent_type/model, and deny is enforced. See RESEARCH_delegation_model_tiering.md
// at the repo root.

import process from "node:process";
import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {string} [cwd]
 * @property {{ subagent_type?: string, model?: string }} [tool_input]
 */

/**
 * Parse `name:` and `model:` out of a markdown agent definition's frontmatter.
 * @param {string} text
 * @returns {{ name?: string, model?: string } | null}
 */
function parseFrontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return null;
  const name = /^name:\s*(.+)$/m.exec(block[1])?.[1]?.trim();
  const model = /^model:\s*(.+)$/m.exec(block[1])?.[1]?.trim();
  return { name, model };
}

/**
 * Find the agent definition for `type` in `dir` (a .claude/agents directory).
 * Matches frontmatter `name:` first (the authoritative identifier), then filename.
 * @param {string} dir
 * @param {string} type
 * @returns {{ model?: string } | null}
 */
function findDefinition(dir, type) {
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return null; // dir missing/unreadable → no definitions here.
  }
  /** @type {{ model?: string } | null} */
  let byFilename = null;
  for (const f of files) {
    /** @type {string} */
    let text;
    try {
      text = readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    if (fm.name === type) return fm;
    if (path.basename(f, ".md") === type) byFilename = fm;
  }
  return byFilename;
}

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

// Only guard the Agent tool. (The legacy "Task" matcher also fires for Agent calls,
// so hooks.json registers this script under "Agent" only — never both.)
if (!payload || payload.tool_name !== "Agent") process.exit(0);

const input = payload.tool_input || {};

// Explicit tier — any value, including opus/fable — means the choice was deliberate.
if (typeof input.model === "string" && input.model.length) process.exit(0);

const type = typeof input.subagent_type === "string" ? input.subagent_type : "";

// Forks always inherit the parent model; the model param is ignored for them.
if (type === "fork") process.exit(0);

// A custom definition with pinned frontmatter model resolves cheap on its own.
// Precedence mirrors Claude Code's: project .claude/agents beats ~/.claude/agents.
if (type) {
  const dirs = [];
  if (typeof payload.cwd === "string" && payload.cwd.length) {
    dirs.push(path.join(payload.cwd, ".claude", "agents"));
  }
  dirs.push(path.join(os.homedir(), ".claude", "agents"));
  for (const dir of dirs) {
    const fm = findDefinition(dir, type);
    if (fm) {
      if (fm.model && fm.model !== "inherit") process.exit(0);
      break; // first resolving definition decides; it inherits → fall through to deny.
    }
  }
}

const reason =
  `agent-model-guard: this Agent dispatch${type ? ` (${type})` : ""} sets no model, ` +
  "so the subagent inherits the session's main-loop model — an expensive default on a " +
  "frontier-tier session. Re-dispatch with an explicit tier: model:'sonnet' for " +
  "search/reads/mechanical implementation/verification, model:'haiku' for pure " +
  "enumeration, or model:'opus'/'fable' deliberately if the task genuinely needs " +
  "frontier reasoning. An explicit model always passes this guard.";

emitPermissionDecision("deny", reason);
process.exit(0);
