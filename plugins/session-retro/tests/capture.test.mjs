// @ts-check
// capture.mjs, driven through the real hook command with a temp HOME and data dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
const today = () => new Date().toISOString().slice(0, 10);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----"; // split so secret scanners pass

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sr-cap-"));
  const git = join(dir, "home", ".local/share/chezmoi/.git");
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(git, "packed-refs"), "# pack-refs\nfeedfacefeedfacefeedfacefeedfacefeedface refs/heads/main\n");
  const env = {
    PATH: process.env.PATH, HOME: join(dir, "home"), CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_DATA: join(dir, "data"), CLAUDE_PID: String(process.pid),
    CLAUDE_CODE_EXECPATH: "/x/claude/versions/2.1.284",
  };
  /** @param {any} payload */
  const run = (payload) => {
    const cmd = HOOKS[payload.hook_event_name][0].hooks[0].command.replace("${CLAUDE_PLUGIN_ROOT}", ROOT);
    const r = spawnSync("/bin/sh", ["-c", cmd], { input: JSON.stringify(payload), env, encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  };
  const recs = (sid = "s1") => {
    const f = join(env.CLAUDE_PLUGIN_DATA, "v3", "events", today(), `${sid}.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  return { env, run, recs };
}

test("one dispatcher for every registered event, 2 s timeout, no matcher", () => {
  assert.deepEqual(Object.keys(HOOKS).sort(),
    ["PermissionDenied", "PostToolBatch", "PostToolUse", "PostToolUseFailure", "SessionStart", "StopFailure"]);
  for (const [ev, groups] of Object.entries(HOOKS)) {
    assert.equal(groups.length, 1, ev);
    assert.equal(groups[0].matcher, undefined, ev);
    assert.equal(groups[0].hooks[0].timeout, 2, ev);
    assert.match(groups[0].hooks[0].command, /scripts\/capture\.mjs"$/);
  }
});

test("session start caches context from packed-refs; tool events copy it", () => {
  const { run, recs } = setup();
  run({ hook_event_name: "SessionStart", session_id: "s1", source: "startup", model: "claude-opus-5-5", cwd: "/w/repo" });
  run({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "t1", duration_ms: 5,
    tool_input: { command: "A=1 /usr/bin/git -C /private/dir push origin main" }, tool_response: { stdout: "x" } });
  const [s, t] = recs();
  assert.deepEqual([s.outcome, s.ok, s.src, s.proj, s.harness], ["session", null, "startup", "repo", "feedfacefeed+1.0.0"]);
  assert.deepEqual([t.ok, t.verb, t.model, t.cc, t.harness], [true, "git", "claude-opus-5-5", "2.1.284", s.harness]);
});

test("verb keeps at most the subcommand; arguments and odd tokens never stored", () => {
  const { run, recs } = setup();
  const cmds = { a: "sudo pnpm exec vitest run secretfile", b: "claude \"prompt text\"", c: "./scripts/check --all", d: "$(evil) x" };
  for (const [id, command] of Object.entries(cmds))
    run({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
  assert.deepEqual(recs().map((r) => r.verb), ["pnpm exec", "claude ?", "check", "?"]);
});

test("error keeps a redacted first line with paths scrubbed", () => {
  const { run, recs } = setup();
  const fails = [
    ["e1", "Read", "File does not exist: /Users/me/secret-project/a.ts"],
    ["e2", "Bash", "token=abc123 ghp_" + "x".repeat(30) + "\nsecond line"],
    ["e3", "Bash", `${PEM} x`],
  ];
  for (const [id, tool, error] of fails)
    run({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_name: tool, tool_use_id: id, error,
      tool_input: { file_path: "/Users/me/secret-project/a.ts", command: "x" } });
  const r = recs();
  assert.deepEqual(r.map((x) => x.err), ["File does not exist: <path>", "[REDACTED] [REDACTED]", "[REDACTED]"]);
  assert.equal(r[0].target, ".ts");
  assert.ok(!JSON.stringify(r).includes("secret-project"));
});

test("PostToolBatch records only calls no per-tool hook saw, classified", () => {
  const { run, recs } = setup();
  run({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Read", tool_use_id: "seen", tool_input: {} });
  run({ hook_event_name: "PostToolBatch", session_id: "s1", tool_calls: [
    { tool_name: "Read", tool_use_id: "seen", tool_response: "ok" },
    { tool_name: "Bash", tool_use_id: "r", tool_response: "Permission to use Bash with command rm -rf x has been denied." },
    { tool_name: "Bash", tool_use_id: "u", tool_response: [{ type: "text", text: "The user doesn't want to proceed with this tool use." }] },
  ] });
  const r = recs().slice(1);
  assert.deepEqual(r.map((x) => [x.id, x.outcome, x.code, x.err]), [
    ["r", "denied_or_invalid", "rule_deny", "Permission to use Bash"],
    ["u", "denied_or_invalid", "user_reject", undefined],
  ]);
});

test("batch rows never store tool output; hook denials keep only the hook name", () => {
  const { run, recs } = setup();
  run({ hook_event_name: "PostToolBatch", session_id: "s1", tool_calls: [
    { tool_name: "Read", tool_use_id: "o", tool_response: "Customer: Jane Roe, jane@example.com, 0400 000 000" },
    { tool_name: "Bash", tool_use_id: "h1", tool_response: "PreToolUse:Bash hook error: [lsp-first] use LSP for AcmeSecretThing" },
    { tool_name: "Bash", tool_use_id: "h2", tool_response: "PreToolUse:Bash hook error: docs-sync-guard: AcmeSecretThing changed" },
    { tool_name: "mcp__claude_ai_Gmail__get_thread", tool_use_id: "m", tool_response: "whatever" },
  ] });
  const r = recs();
  assert.deepEqual(r.map((x) => [x.id, x.code, x.err]), [
    ["o", "other", undefined],
    ["h1", "hook_deny", "PreToolUse:Bash hook error: [lsp-first]"],
    ["h2", "hook_deny", "PreToolUse:Bash hook error: docs-sync-guard"],
    ["m", "other", undefined],
  ]);
  assert.equal(r[3].mcp_server, "claude_ai_Gmail");
  const all = JSON.stringify(r);
  for (const leak of ["Jane", "example.com", "AcmeSecretThing"]) assert.ok(!all.includes(leak), leak);
});

test("verb skips cd prefixes and quoted assignments; cc only when version-shaped", () => {
  const { env, run, recs } = setup();
  const cmds = {
    q: 'MSG="deploy the secretproject now" git commit -m x',
    s: "K='a b' pnpm test",
    c: 'cd "/Users/me/secret dir" && cargo build',
    u: 'X="never closed git push',
  };
  env.CLAUDE_CODE_EXECPATH = "/opt/homebrew/bin/node";
  for (const [id, command] of Object.entries(cmds))
    run({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: id, tool_input: { command } });
  const r = recs();
  assert.deepEqual(r.map((x) => x.verb), ["git commit", "pnpm test", "cargo build", "?"]);
  assert.equal(r[0].cc, undefined);
  assert.ok(!JSON.stringify(r).includes("secret"));
});

test("redaction covers quoted passwords, mysql -p, stripe keys and session cookies", () => {
  const { run, recs } = setup();
  const errs = [
    'password="hunter two" rejected',
    "mysql -u root -phunter2 failed",
    "bad key sk_" + "live_" + "abc123def456",
    "Cookie rejected: sessionid=abcdef123",
  ];
  errs.forEach((error, i) => run({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_name: "Bash", tool_use_id: `r${i}`, error }));
  const all = JSON.stringify(recs());
  for (const leak of ["hunter", "abc123def456", "abcdef123"]) assert.ok(!all.includes(leak), leak);
});

test("canary heartbeat writes a record but no ctx file; bad input writes nothing", () => {
  const { env, run, recs } = setup();
  const sid = `canary-${today()}`;
  run({ hook_event_name: "SessionStart", session_id: sid, source: "canary" });
  assert.equal(recs(sid)[0].src, "canary");
  assert.ok(!existsSync(join(env.CLAUDE_PLUGIN_DATA, "v3", "ctx", `${sid}.json`)));
  run({ hook_event_name: "PostToolUse", session_id: "../escape", tool_name: "Bash" });
  run({ hook_event_name: "PostToolUse", tool_name: "Bash" });
  assert.deepEqual(readdirSync(join(env.CLAUDE_PLUGIN_DATA, "v3", "events", today())), [`${sid}.jsonl`]);
});
