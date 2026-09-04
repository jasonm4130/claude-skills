#!/usr/bin/env node
// PreToolUse(Bash) guard: the only way to main is a pull request that CI passed.
//
// Denies, in any permission mode (PreToolUse runs before the permission check,
// so loosening permissions does not get past it):
//   - `gh pr merge` in any form, and any `gh` call carrying `--admin`
//   - `gh workflow …` and `gh variable set|delete …` (the merge machine and its
//     kill switch are not the agent's to touch; an unset switch is a frozen one)
//   - `git push` that forces, or that targets main
//   - `git commit --no-verify` (the pre-commit hook is part of the gate)
//   - `git commit` while `.github/workflows/**` is staged (a pull request runs
//     its own copy of ci.yml, so a worker could weaken the gate in the same PR
//     the gate then approves), or while anything under `.claude/` is staged
//     (these hooks and the allow rules live there)
//   - a writing `gh api` call (`-X`/`--method` other than GET, or `-f`/`-F`/
//     `--field`/`--raw-field`/`--input`): the REST merge endpoint is `gh pr
//     merge` by another name
//
// Everything else passes. Fails open on any error: a guard that blocks by
// accident is worse than one that misses, because the merge gate on GitHub is
// still there behind it.
//
// Repo-agnostic: nothing here names this project. Language-agnostic too.
import { execFileSync } from "node:child_process";
import { readSync } from "node:fs";

function readStdin() {
  const chunks = [];
  let n;
  const buf = Buffer.alloc(65536);
  try {
    while ((n = readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
  } catch (e) {
    if (e.code !== "EAGAIN" && e.code !== "EOF") throw e;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// `git` may be spelled around: `command git`, `exec git`, `env X=y git`,
// `\git`, `"git"`, `/usr/bin/git`; and it may carry global options before
// its subcommand (`git -C dir push`, `git --git-dir=x commit`). GIT matches
// all of those. It is still a textual match: the merge gate on GitHub, not
// this file, is what makes main unreachable.
const GIT = String.raw`(?:^|[\s;&|(\`{])(?:(?:command|exec|builtin)\s+(?:-\w+\s+)*|env\s+(?:\w+=\S*\s+)*|\\|[^\s;&|"']*/)?["']?git["']?\s+(?:(?:-[A-Za-z]|--[\w-]+)(?:[=\s]+[^\s;&|]+)?\s+)*`;
const gitRe = (sub, flags = "") => new RegExp(GIT + sub, flags);

export function judge(command, stagedPaths) {
  const c = String(command || "");
  const reasons = [];
  if (/\bgh\s+pr\s+merge\b/.test(c)) reasons.push("`gh pr merge` is not a route to main; the merge gate is CI plus the repo's merge command");
  if (/\bgh\b[^\n]*\s--admin\b/.test(c)) reasons.push("`--admin` bypasses the checks the gate exists to wait on");
  if (/\bgh\s+workflow\b/.test(c)) reasons.push("`gh workflow` changes the merge machine; that is a human's change");
  if (/\bgh\s+variable\s+(set|delete|remove)\b/.test(c)) reasons.push("`gh variable set`/`delete` is the kill switch; only a human flips it");
  for (const m of c.matchAll(gitRe(String.raw`push\b([^\n;&|]*)`, "g"))) {
    const args = m[1];
    if (/(^|\s)(--force|--force-with-lease|-f|\+\S+)(\s|$)/.test(args) || /\s-\w*f\w*(\s|$)/.test(args)) reasons.push("force push rewrites history the gate already judged");
    const toks = args.trim().split(/\s+/).filter(Boolean);
    if (toks.some((t) => t === "main" || t === "HEAD:main" || t.endsWith(":main") || t === "refs/heads/main" || t.endsWith(":refs/heads/main"))) {
      reasons.push("pushing to main skips the pull request; branch, push, and let CI land it");
    }
  }
  if (gitRe(String.raw`commit\b[^\n]*\s(--no-verify|-n)(\s|$)`).test(c)) reasons.push("`--no-verify` skips the pre-commit hook, which is part of the gate");
  if (gitRe(String.raw`commit\b`).test(c)) {
    const wf = (stagedPaths || []).filter((p) => p.startsWith(".github/workflows/"));
    if (wf.length) reasons.push(`a commit that touches ${wf.join(", ")} can weaken the gate that judges it; a human lands workflow changes`);
    const guards = (stagedPaths || []).filter((p) => p.startsWith(".claude/"));
    if (guards.length) reasons.push(`a commit that touches ${guards.join(", ")} changes the guards this session runs under; a human lands those`);
  }
  // `gh api` reaches every REST endpoint the textual rules above name — the
  // merge endpoint, repository variables, refs. Reads are fine; anything that
  // writes (an explicit non-GET method, or fields/input, which make gh POST)
  // is not the agent's to do.
  for (const m of c.matchAll(/\bgh\s+api\b([^\n;&|]*)/g)) {
    const args = m[1];
    const method = args.match(/(?:^|\s)(?:-X|--method)[\s=]+(\w+)/);
    const writes = (method && method[1].toUpperCase() !== "GET") || /(^|\s)(-f|-F|--field|--raw-field|--input)(\s|=|$)/.test(args);
    if (writes) reasons.push("a writing `gh api` call reaches the merge endpoint, the kill switch and the refs directly; only reads are the agent's");
  }
  return reasons;
}

function staged(cwd, command) {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let paths = out.split("\n").filter(Boolean);
    if (gitRe(String.raw`commit\b[^\n]*\s(-a|--all|-am|-a\w+)(\s|$)`).test(command)) {
      const wt = execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      paths = paths.concat(wt.split("\n").filter(Boolean));
    }
    return paths;
  } catch {
    return [];
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }
  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input && payload.tool_input.command;
  if (!command) return;
  const reasons = judge(command, gitRe(String.raw`commit\b`).test(command) ? staged(payload.cwd || process.cwd(), command) : []);
  if (!reasons.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `no-route-around-ci: ${reasons.join("; ")}.`,
    },
  }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
