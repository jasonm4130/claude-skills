// claude -p invocation: argv builder, spawn wrapper, result parser.
// Structured output arrives pre-parsed in `structured_output` (verified against
// the installed CLI); --json-schema takes INLINE JSON, not a file path.
import { spawn } from "node:child_process";

export function buildClaudeArgs({ prompt, model, schema, allowedTools = [] }) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", model,
  ];
  if (allowedTools.length) args.push("--allowed-tools", ...allowedTools); // variadic: keep last
  return args;
}

export function parseClaudeResult(stdoutText) {
  let obj;
  try { obj = JSON.parse(stdoutText); } catch { return { ok: false, error: "unparseable claude output" }; }
  if (obj.is_error) return { ok: false, error: `claude error: ${obj.subtype ?? "unknown"}` };
  if (!obj.structured_output) return { ok: false, error: "missing structured_output" };
  return {
    ok: true,
    structured: obj.structured_output,
    tokens: { input: obj.usage?.input_tokens ?? 0, output: obj.usage?.output_tokens ?? 0 },
    costUsd: obj.total_cost_usd ?? null,
    wallMs: obj.duration_ms ?? null,
  };
}

export function runClaude(args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolveP) => {
    let child;
    try { child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolveP({ ok: false, error: String(e.message) }); }
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, error: String(e.message) }); });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) return resolveP({ ok: false, error: `claude timed out after ${timeoutMs}ms` });
      const parsed = parseClaudeResult(stdout);
      resolveP(parsed.ok ? parsed : { ...parsed, error: `${parsed.error}; stderr: ${stderr.slice(0, 400)}` });
    });
  });
}
