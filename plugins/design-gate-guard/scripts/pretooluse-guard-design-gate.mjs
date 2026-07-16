#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Bash): the brainstorming HARD-GATE, enforced.
//
// The brainstorming skill says: "Do NOT ... write any code, scaffold any project,
// or take any implementation action until you have presented a design and the user
// has approved it." That gate is prose — nothing intercepts the model when it jumps
// straight to `npm create vite` on autopilot (the documented failure this plugin
// exists to catch).
//
// A PreToolUse hook cannot see the conversation, so it cannot know whether a design
// was approved (the session model / "approval" is NOT in stdin or env — same
// constraint the workflow-model-guard documents). So this hook does NOT try to gate
// arbitrary edits on hidden state. It gates the ONE action that is both high-signal
// and rare — a new-project *scaffold* command — and emits `ask`, routing the
// checkpoint to the human, who CAN see whether a design happened. Stateless,
// fail-open, no flag files: the same philosophy as the sibling guard plugins, and
// `ask` (not `deny`) for the same reason workflow-model-guard asks on un-editable
// named workflows — a deny the model can't resolve from hidden state would dead-end.
//
// Escape hatch: `design-gate:ack` anywhere in the command bypasses (self-documents
// in shell history) — for a scaffold run legitimately after design approval.

import process from "node:process";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {{ command?: string }} [tool_input]
 */

// New-project scaffolders, anchored to the START of a cleaned command segment so a
// match means "this command scaffolds", not "this string mentions a scaffolder".
// Rare + distinctive by design: an `ask` false-positive is one cheap confirmation.
const SCAFFOLD_PATTERNS = [
  // JS/TS package-manager scaffolders: `npm|pnpm|yarn|bun create <initializer>`.
  /^(?:npm|pnpm|yarn|bun)\s+create\b/i,
  // `npm init <initializer>` (a template name, NOT a flag and NOT bare `npm init`).
  /^npm\s+init\s+(?!-)[@\w]/i,
  // `npx|bunx|pnpm dlx|yarn dlx create-<x>` (optionally @scope/create-<x>).
  /^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:@[\w.-]+\/)?create-[\w-]+/i,
  // A create-* binary invoked directly: `create-next-app my-app`.
  /^create-[\w-]+/i,
  // Other ecosystems' project generators.
  /^cargo\s+(?:new|init)\b/i,
  /^django-admin\s+start(?:project|app)\b/i,
  /^rails\s+new\b/i,
  /^ng\s+new\b/i,
  /^nest\s+new\b/i,
  /^vue\s+create\b/i,
  /^expo\s+(?:init|create)\b/i,
  /^flutter\s+create\b/i,
  /^dotnet\s+new\s+(?!-)/i, // `dotnet new console`, not `dotnet new --list`.
  /^mix\s+(?:new|phx\.new)\b/i,
  /^laravel\s+new\b/i,
  /^composer\s+create-project\b/i,
  /^gatsby\s+new\b/i,
  /^hugo\s+new\s+site\b/i,
  /^jekyll\s+new\b/i,
];

/**
 * Strip a shell comment (` # ...`) so an appended `# design-gate:ack` (and other
 * trailing comments) don't leak into segment matching. Only strips a `#` that
 * starts a token (preceded by whitespace or string start), never a `#` inside a
 * word like an anchor or a fragment.
 * @param {string} s
 */
function stripComment(s) {
  return s.replace(/(^|\s)#.*$/, "$1");
}

/**
 * Strip leading env-assignments and a `sudo` so `FOO=bar sudo npm create ...`
 * still matches at the command head.
 * @param {string} s
 */
function stripLeadingNoise(s) {
  let out = s.replace(/^\s+/, "");
  const envAssign = /^[A-Za-z_]\w*=\S*\s+/;
  while (envAssign.test(out)) out = out.replace(envAssign, "");
  out = out.replace(/^sudo\s+/, "");
  while (envAssign.test(out)) out = out.replace(envAssign, "");
  return out;
}

/**
 * Does this command start (in any of its shell segments) with a scaffold command?
 * Splits on shell separators so a scaffolder anywhere in a chain is caught, while
 * a scaffold name inside a quoted commit message / echo string is not (that
 * segment starts with `git`/`echo`, not the scaffolder).
 * @param {string} command
 * @returns {boolean}
 */
function isScaffold(command) {
  // Split on && || ; | and newlines (|| is consumed before a bare |).
  const segments = command.split(/&&|\|\||[;\n|]/);
  for (const seg of segments) {
    const cleaned = stripLeadingNoise(stripComment(seg));
    if (SCAFFOLD_PATTERNS.some((re) => re.test(cleaned))) return true;
  }
  return false;
}

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

// Only guard the Bash tool. Anything else → proceed normally.
if (!payload || payload.tool_name !== "Bash") process.exit(0);

const command =
  typeof payload.tool_input?.command === "string"
    ? payload.tool_input.command
    : "";
if (!command.trim()) process.exit(0);

// Escape hatch: an explicit ack (scaffold run legitimately after design approval).
if (command.includes("design-gate:ack")) process.exit(0);

if (!isScaffold(command)) process.exit(0);

const shown = command.length > 80 ? command.slice(0, 77) + "…" : command;
const reason =
  `design-gate-guard: "${shown}" looks like a new-project scaffold. Per the ` +
  "brainstorming HARD-GATE, don't scaffold or implement until a design has been " +
  "presented and the user has approved it. If you haven't brainstormed a design " +
  "yet, run the brainstorming skill first. If the design was already approved (or " +
  "this isn't a fresh project), add `design-gate:ack` to the command to proceed.";

emitPermissionDecision("ask", reason);
process.exit(0);
