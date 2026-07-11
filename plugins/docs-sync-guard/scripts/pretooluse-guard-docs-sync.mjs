#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Bash): gate `git commit` on docs staying in sync with
// plugin code. Docs drift is the classic silent failure — code lands, README/CLAUDE.md
// go stale, and by the next session nobody remembers what changed. Research (2026-07)
// says the working designs block at the commit boundary (turn-end nudges never reach
// the model: Stop-hook stdout isn't injected into context) and carry an explicit
// what-NOT-to-flag list so the gate doesn't become noise people ack reflexively.
//
// Decision table (plugins/ monorepo layout only — silent anywhere else):
//   - command isn't a `git commit`            → allow silently.
//   - command contains `docs-sync:ack`        → allow (deliberate no-doc-impact call;
//                                               the marker lands in the commit message,
//                                               so the judgment is auditable later).
//   - staged/added executable plugin code (scripts|hooks|agents|workflows) without a
//     staged README.md or CLAUDE.md in the SAME plugin → deny with the plugin names.
//   - tests, version bumps (plugin.json/marketplace.json), and skills/commands
//     markdown (self-documenting prompt files) never trigger the gate.
//
// "Staged" is a union of: `git diff --cached`, paths named in `git add` segments of
// the same compound command (they aren't staged yet when the hook runs), and — for
// `commit -a` — modified tracked files. Pathspecs passed directly to `git commit`
// are NOT parsed (rare in agent usage); any git error fails open.

import process from "node:process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {string} [cwd]
 * @property {{ command?: string }} [tool_input]
 */

/** Executable plugin surface — changes here are what docs describe. */
const CODE_RE = /^plugins\/([^/]+)\/(scripts|hooks|agents|workflows)\//;
/** Never-flag list: tests and test fixtures inside those dirs. */
const TEST_RE = /(^|\/)tests?\/|\.test\.[a-z]+$/;

/**
 * Run a git command in `cwd`, returning stdout lines or null on any failure.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string[] | null}
 */
function git(cwd, args) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Extract paths named in `git add …` segments of a compound command — they aren't
 * in the index yet when the hook inspects it. Flags are skipped; quotes stripped.
 * @param {string} command
 * @returns {string[]}
 */
function pathsFromGitAdd(command) {
  const paths = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const m = /\bgit\s+(?:-C\s+\S+\s+)?add\s+(.*)$/.exec(segment.trim());
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue;
      paths.push(tok.replace(/^["']|["']$/g, ""));
    }
  }
  return paths;
}

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

if (!payload || payload.tool_name !== "Bash") process.exit(0);

const command =
  typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";

// Only gate commits; `git -C x commit` counts, `git commitish-tool` doesn't.
if (!/\bgit\b[^;&|]*\bcommit\b/.test(command)) process.exit(0);

// Explicit no-doc-impact ack — ends up in the commit message, auditable later.
if (command.includes("docs-sync:ack")) process.exit(0);

let cwd = typeof payload.cwd === "string" && payload.cwd.length ? payload.cwd : process.cwd();
// git prints the REAL toplevel path; symlinked cwds (macOS /var → /private/var)
// would otherwise break the relative-path computation for `git add` unions.
try {
  cwd = realpathSync(cwd);
} catch {
  /* keep as-is; git() fails open below if it's truly unusable */
}

const rootLines = git(cwd, ["rev-parse", "--show-toplevel"]);
if (!rootLines || !rootLines[0]) process.exit(0); // not a git repo → fail open.
const root = rootLines[0];

// Union of what this commit will contain (repo-relative paths).
const staged = new Set(git(root, ["diff", "--cached", "--name-only"]) || []);
if (/\bcommit\b[^;&|]*(\s-\w*a|\s--all\b)/.test(command)) {
  for (const f of git(root, ["diff", "--name-only"]) || []) staged.add(f);
}
for (const p of pathsFromGitAdd(command)) {
  const rel = path.relative(root, path.resolve(cwd, p));
  if (rel && !rel.startsWith("..")) staged.add(rel);
}

// Which plugins have executable-code changes, and which have doc changes?
const codePlugins = new Set();
const docPlugins = new Set();
for (const f of staged) {
  const code = CODE_RE.exec(f);
  if (code && !TEST_RE.test(f)) codePlugins.add(code[1]);
  const doc = /^plugins\/([^/]+)\/(README\.md|CLAUDE\.md)$/.exec(f);
  if (doc) docPlugins.add(doc[1]);
}

const violating = [...codePlugins].filter((p) => !docPlugins.has(p)).sort();
if (!violating.length) process.exit(0);

const reason =
  `docs-sync-guard: this commit changes executable code in plugin${violating.length === 1 ? "" : "s"} ` +
  `${violating.map((p) => `"${p}"`).join(", ")} without staging that plugin's README.md or ` +
  "CLAUDE.md. If behavior, structure, or usage changed, update and stage the docs in the " +
  "same commit. If this change genuinely has no doc impact (pure refactor, comment fix), " +
  'add "docs-sync:ack" to the commit message and re-run.';

emitPermissionDecision("deny", reason);
process.exit(0);
