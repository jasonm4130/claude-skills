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
  // `npx|bunx|pnpm dlx|yarn dlx [flags…] create-<x>` (optionally @scope/create-<x>).
  // Flags like `--yes`, `-y`, `--package=x` may sit between the runner and the
  // initializer — skip them so `npx --yes create-vite` still matches.
  /^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:@[\w.-]+\/)?create-[\w-]+/i,
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

const ENV_ASSIGN = /^[A-Za-z_]\w*=/;

/**
 * Quote-aware shell tokenizer. Splits `command` into segments at UNQUOTED shell
 * separators (`&&`, `||`, `;`, `|`, newline); each segment is an array of tokens
 * with quote characters removed and whitespace collapsed. An unquoted `#` at a
 * token boundary starts a comment to end of line. This is what makes the gate
 * quote-correct: a separator or `#` inside quotes is literal text, not structure —
 * so `printf "a && npm create b"` is ONE `printf` command, and `FOO="x # y" npm
 * create …` keeps its `#` as data, not a comment.
 * @param {string} command
 * @returns {string[][]}
 */
function parseSegments(command) {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[]} */
  let tokens = [];
  let cur = "";
  let started = false; // a token is in progress (may be an empty quoted "")
  /** @type {string | null} */
  let quote = null;
  const endTok = () => {
    if (started) {
      tokens.push(cur);
      cur = "";
      started = false;
    }
  };
  const endSeg = () => {
    endTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        cur += c;
        started = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < command.length) {
        cur += command[i + 1];
        started = true;
        i++;
      }
      continue;
    }
    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      i--; // let the loop re-see the newline as a separator
      continue;
    }
    if (c === "\n" || c === ";") {
      endSeg();
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      endSeg();
      i++;
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      endSeg();
      i++;
      continue;
    }
    if (c === "|") {
      endSeg();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endTok();
      continue;
    }
    cur += c;
    started = true;
  }
  endSeg();
  return segments;
}

/**
 * Does any command segment start with a scaffold command? For each segment we drop
 * leading env-assignments (`FOO=bar`) and `sudo`, then test the remaining head
 * against the anchored scaffold patterns. Because matching is anchored to the
 * segment head, a scaffolder appearing later in a quoted string (a commit message,
 * an echo/printf argument) never matches — that segment's head is `git`/`echo`/etc.
 * @param {string} command
 * @returns {boolean}
 */
function isScaffold(command) {
  for (const tokens of parseSegments(command)) {
    let i = 0;
    while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || tokens[i] === "sudo")) i++;
    if (i >= tokens.length) continue;
    const head = tokens.slice(i).join(" ");
    if (SCAFFOLD_PATTERNS.some((re) => re.test(head))) return true;
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
