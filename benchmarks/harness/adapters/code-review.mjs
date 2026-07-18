// Reviewer adapter over the actual /code-review skill, invoked headless.
// Task 7's probe (recorded in .sdd/task-7-report.md) confirmed the skill
// loads under `claude -p "/code-review low" --output-format json
// --json-schema ...` and returns grounded findings (real files, real lines) —
// so this is the SKILL PATH: ADAPTER_ID stays "code-review", and the prompt
// leads with the real slash-command invocation rather than a rephrased one.
// The trailing scope/license lines reinforce (they don't replace) the
// skill's own instructions and mirror the Gap #3 clean-pass calibration
// shared with the other reviewer adapters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { FINDINGS_SCHEMA, normalizeSeverity, applyVerdictPolicy } from "../model.mjs";
import { buildClaudeArgs, runClaude } from "../claude-cli.mjs";

export const ADAPTER_ID = "code-review";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

export function buildPrompt({ brief, diffRange }) {
  return [
    "/code-review low",
    "",
    "## Change intent (task brief)",
    brief.trim(),
    "",
    `Review the committed change \`${diffRange}\`. Inspect it with ` +
      `\`git diff --no-textconv --no-ext-diff ${diffRange} --\` and read surrounding code as needed.`,
    "Report only defects introduced by this change — not pre-existing issues, style preferences, or hypotheticals.",
    "Zero findings is a valid and respected result: if the change is correct, return an empty list.",
  ].join("\n");
}

let cachedCliVersion;
export function claudeCliVersion() {
  // The /code-review skill this adapter measures is BUILT INTO the Claude
  // Code CLI — its content isn't a file we own, so the CLI version string is
  // the honest proxy: a CLI upgrade must invalidate cached cells.
  if (cachedCliVersion === undefined) {
    try {
      cachedCliVersion = execFileSync("claude", ["--version"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      cachedCliVersion = "cli-unavailable"; // cells can't run either; value never caches real results
    }
  }
  return cachedCliVersion;
}

export function version() {
  // Hash the COMPLETE behavior: this module (prompt template, tools,
  // normalization), the shared model + CLI wrapper code it depends on, and
  // the installed CLI (carrier of the built-in /code-review skill) — a
  // change to any of them must invalidate cached cells.
  return createHash("sha256")
    .update(readFileSync(SELF))
    .update(readFileSync(join(HERE, "..", "model.mjs")))
    .update(readFileSync(join(HERE, "..", "claude-cli.mjs")))
    .update(claudeCliVersion())
    .digest("hex").slice(0, 12);
}

export async function review({ worktree, diffRange, brief, model = "sonnet" }, deps = { runClaude }) {
  const args = buildClaudeArgs({
    prompt: buildPrompt({ brief, diffRange }), model,
    schema: FINDINGS_SCHEMA, allowedTools: ALLOWED_TOOLS,
  });
  const res = await deps.runClaude(args, { cwd: worktree });
  if (!res.ok) return { status: "error", error: res.error };
  const findings = (res.structured.findings ?? []).map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
  return {
    status: "ok",
    verdict: applyVerdictPolicy({ findings, threshold: "Critical" }),
    findings, tokens: res.tokens, wallMs: res.wallMs, raw: res.structured,
  };
}
