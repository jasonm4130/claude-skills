// Cross-provider reviewer via the codex CLI. Reuses runCodex + parseEventStream
// from the codex-review plugin (import-safe: that script main-guards its CLI).
// The diff is rendered here with --no-textconv --no-ext-diff and embedded in
// the prompt; codex runs read-only and never touches the worktree.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeSeverity, applyVerdictPolicy } from "../model.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CODEX_MOD = join(HERE, "..", "..", "..", "plugins", "codex-review", "skills", "codex-plan-review", "scripts", "codex-review.mjs");
const { runCodex, parseEventStream } = await import(CODEX_MOD);

export const ADAPTER_ID = "codex";
export const MAX_DIFF_BYTES = 400_000;
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_EFFORT = "medium";

export function buildPrompt({ brief, diffText }) {
  return [
    "You are reviewing a committed code change for defects introduced by the change.",
    "",
    "## Change intent (task brief)",
    brief.trim(),
    "",
    "## Diff",
    "```diff",
    diffText,
    "```",
    "",
    "Report only defects introduced by this change — not pre-existing issues or style.",
    "Zero findings is a valid result if the change is correct.",
    "If you re-derive any diff yourself, use EXACTLY: git diff --no-textconv --no-ext-diff <range> --",
    "(textconv/external-diff drivers execute repo-configured programs; never run an unflagged git diff).",
    "Respond with ONLY a JSON object, no prose, in exactly this shape:",
    '{"findings": [{"file": "path", "line": 1, "severity": "Critical|Important|Minor", "summary": "one sentence", "mechanism": "what goes wrong at runtime and why"}]}',
  ].join("\n");
}

export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function version() {
  // Complete behavior hash: this module (prompt, defaults, extraction,
  // normalization), the shared model code, and the imported codex-review
  // module — a parseEventStream/runCodex fix must invalidate cached cells.
  return createHash("sha256")
    .update(readFileSync(SELF))
    .update(readFileSync(join(HERE, "..", "model.mjs")))
    .update(readFileSync(CODEX_MOD))
    .digest("hex").slice(0, 12);
}

export async function review(
  { worktree, diffRange, brief, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT },
  deps = { runCodex },
) {
  let diffText;
  try {
    diffText = execFileSync("git",
      ["-C", worktree, "diff", "--no-textconv", "--no-ext-diff", diffRange, "--"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { return { status: "error", error: `git diff failed: ${String(e.message).split("\n")[0]}` }; }
  if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
    return { status: "error", error: `diff exceeds ${MAX_DIFF_BYTES} bytes — refusing, not truncating` };
  }
  const prompt = buildPrompt({ brief, diffText });
  const args = ["exec", "--json", "--sandbox", "read-only", "-m", model,
    "-c", `model_reasoning_effort=${effort}`, "--skip-git-repo-check", prompt];
  const t0 = process.hrtime.bigint();
  const res = await deps.runCodex(args, { cwd: worktree, timeoutMs: 600_000 });
  const wallMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  if (res.spawnError) return { status: "error", error: `codex spawn failed: ${res.stderr.slice(0, 200)}` };
  if (res.timedOut) return { status: "error", error: "codex timed out" };
  const stream = parseEventStream(res.stdout);
  if (stream.terminal !== "completed" || !stream.finalMessage) {
    return { status: "error", error: `codex terminal=${stream.terminal}, no final message` };
  }
  const parsed = extractJson(stream.finalMessage);
  if (!parsed || !Array.isArray(parsed.findings)) {
    return { status: "error", error: "codex output had no parseable findings JSON" };
  }
  const validFinding = (f) => f && typeof f.file === "string" && Number.isInteger(f.line)
    && typeof f.summary === "string" && typeof f.mechanism === "string";
  if (!parsed.findings.every(validFinding)) {
    return { status: "error", error: "codex findings failed schema validation (need file, integer line, summary, mechanism)" };
  }
  const findings = parsed.findings.map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
  return {
    status: "ok",
    verdict: applyVerdictPolicy({ findings, threshold: "Critical" }),
    findings,
    tokens: stream.usage
      ? { input: stream.usage.input_tokens ?? 0, output: stream.usage.output_tokens ?? 0 }
      : null,
    wallMs, raw: parsed,
  };
}
