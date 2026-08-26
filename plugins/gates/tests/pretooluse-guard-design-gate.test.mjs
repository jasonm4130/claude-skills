// @ts-check
// Tests for the design-gate PreToolUse hook. Spawns the hook as a child
// process with synthetic stdin and asserts on stdout/exit code — the same contract
// Claude Code uses at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(
  new URL("../scripts/pretooluse-guard-design-gate.mjs", import.meta.url),
);

/**
 * Run the hook with the given stdin payload.
 * @param {object | string} input
 * @returns {{ status: number | null, stdout: string }}
 */
function run(input) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync("node", [HOOK], { input: stdin, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout };
}

/**
 * Wrap a shell command into a Bash tool_input payload.
 * @param {string} command
 */
function bash(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

/**
 * Parse the permission-decision envelope, asserting shape.
 * @param {string} stdout
 */
function parseDecision(stdout) {
  const obj = JSON.parse(stdout);
  return obj.hookSpecificOutput;
}

/**
 * Assert the command triggers an `ask`.
 * @param {string} command
 */
function assertAsks(command) {
  const { status, stdout } = run(bash(command));
  assert.equal(status, 0, `${command}: exit 0`);
  const d = parseDecision(stdout);
  assert.equal(d.hookEventName, "PreToolUse", `${command}: envelope`);
  assert.equal(d.permissionDecision, "ask", `${command}: should ask`);
  assert.match(d.permissionDecisionReason, /design-gate-guard/, `${command}: reason`);
}

/**
 * Assert the command passes silently (allow).
 * @param {string} command
 */
function assertAllows(command) {
  const { status, stdout } = run(bash(command));
  assert.equal(status, 0, `${command}: exit 0`);
  assert.equal(stdout.trim(), "", `${command}: should pass silently`);
}

// ---- scaffold commands → ask ----

const SCAFFOLDS = [
  "npm create vite@latest my-app",
  "npm create vite",
  "npm create svelte@latest",
  "pnpm create vite",
  "yarn create next-app",
  "bun create next my-app",
  "npx create-next-app@latest .",
  "npx create-react-app my-app",
  "npx create-vite my-app",
  "pnpm dlx create-next-app",
  "bunx create-astro",
  "npx @scope/create-thing my-app",
  "create-react-app my-app",
  "npm init vite@latest",
  "npm init @scope/create-thing",
  "cargo new my_crate",
  "cargo init",
  "cargo init --lib",
  "django-admin startproject mysite",
  "django-admin startapp blog",
  "rails new blog",
  "ng new my-app",
  "nest new project",
  "vue create hello-world",
  "expo init MyApp",
  "flutter create myapp",
  "dotnet new webapi -o Api",
  "dotnet new console",
  "mix new my_app",
  "mix phx.new my_app",
  "laravel new blog",
  "composer create-project laravel/laravel blog",
  "gatsby new my-site",
  "hugo new site quickstart",
  "jekyll new my-blog",
];

for (const cmd of SCAFFOLDS) {
  test(`asks before scaffold: ${cmd}`, () => assertAsks(cmd));
}

test("asks when a scaffold hides behind an env-var prefix", () => {
  assertAsks("FOO=bar npm create vite@latest app");
});

test("asks when a scaffold hides behind sudo + env prefix", () => {
  assertAsks("sudo NODE_ENV=production npm create vite app");
});

test("asks when a scaffold is a later segment in a chained command", () => {
  assertAsks("mkdir app && cd app && npm create vite@latest .");
});

// ---- quote-awareness + runner flags (codex diff round 1) ----

test("asks when a create-* runner carries flags before the initializer", () => {
  assertAsks("npx --yes create-vite@latest app");
  assertAsks("npx -y create-next-app my-app");
  assertAsks("pnpm dlx --package=x create-astro");
});

test("asks when a quoted '#' precedes a real scaffold (not a comment)", () => {
  // The `#` is inside a quoted env value — it is NOT a shell comment, so the
  // scaffold after it still runs and must be gated.
  assertAsks('FOO="not # a shell comment" npm create vite@latest app');
});

test("does not fire on a quoted '&&' inside a documentation string", () => {
  // The `&&` is inside quotes, so there is only ONE command (`printf …`) — the
  // quoted `npm create` is literal text being written to a file, not executed.
  assertAllows('printf "%s\\n" "npm install && npm create vite" >> README.md');
  assertAllows('echo "step 1 && npm create vite@latest ." >> NOTES.md');
});

test("does not fire when an escaped quote keeps a scaffold inside the string", () => {
  // `\"` inside "" is a literal quote (bash-verified), so this is ONE echo command
  // and the `; npm create vite` is literal argument text, not a second command.
  assertAllows('echo "quoted \\"; npm create vite"');
});

test("still fires when a real \\\\ closes the quote before a scaffold", () => {
  // Guard against over-correction: `\\` is a literal backslash that DOES close the
  // string, so the `;` is a real separator and `npm create vite` actually runs.
  assertAsks('echo "path\\\\"; npm create vite');
});

test("reason names the brainstorming gate and the ack escape hatch", () => {
  const d = parseDecision(run(bash("npm create vite")).stdout);
  assert.match(d.permissionDecisionReason, /brainstorm/i);
  assert.match(d.permissionDecisionReason, /design-gate:ack/);
});

// ---- non-scaffold commands → allow silently ----

const BENIGN = [
  "npm install",
  "npm i react",
  "npm ci",
  "npm run dev",
  "npm run build",
  "npm test",
  "npm init -y",
  "npm init",
  "npx vitest run",
  "npx tsc --noEmit",
  "npx prettier --write .",
  "cargo build",
  "cargo test",
  "cargo run",
  "git init",
  "git status",
  "docker create nginx",
  "createdb mydb",
  "createuser bob",
  "dotnet new --list",
  "dotnet build",
  "node --test",
  "mkdir new-project && cd new-project",
  "cd frontend && npm run dev",
  "ls -la",
];

for (const cmd of BENIGN) {
  test(`allows benign command: ${cmd}`, () => assertAllows(cmd));
}

test("does not fire on a scaffold name inside a commit message", () => {
  assertAllows('git commit -m "add create-react-app onboarding docs"');
});

test("does not fire on a scaffold command echoed as a string", () => {
  assertAllows('echo "run npm create vite to start"');
});

test("does not fire on a scaffold command inside a printf write to a file", () => {
  assertAllows('printf "First run: npm create vite@latest\\n" >> README.md');
});

// ---- heredoc bodies are literal text, not commands (codex audit) ----

test("does not fire on a scaffold inside a heredoc body (quoted delimiter)", () => {
  assertAllows("cat <<'EOF'\nnpm create vite\nEOF\n");
});

test("does not fire on a scaffold in a heredoc body with an unquoted delimiter + redirect", () => {
  assertAllows("cat <<EOF > README.md\nRun: npm create vite@latest .\nEOF");
});

test("does not fire on a scaffold in a <<- heredoc with a tab-indented terminator", () => {
  assertAllows("cat <<-EOF\n\tnpm create vite\n\tEOF");
});

test("still fires on a real scaffold command AFTER a heredoc terminator", () => {
  // Guard against over-correction: the body ends at EOF; the next line is a real
  // command that actually runs.
  assertAsks("cat <<EOF\nhello world\nEOF\nnpm create vite@latest app");
});

// ---- ack bypass ----

test("allows a scaffold when the design-gate:ack marker is present", () => {
  assertAllows("npm create vite@latest my-app # design-gate:ack");
});

test("allows a scaffold when ack is a shell comment on a chained command", () => {
  assertAllows("cd app && npm create vite  # design-gate:ack");
});

// ---- graceful degradation ----

test("ignores non-Bash tools", () => {
  const { stdout } = run({ tool_name: "Write", tool_input: { file_path: "/x", content: "npm create vite" } });
  assert.equal(stdout.trim(), "");
});

test("exits gracefully on malformed stdin", () => {
  const { status, stdout } = run("not json at all");
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("exits gracefully on an empty command", () => {
  const { status, stdout } = run(bash(""));
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("exits gracefully when tool_input is missing", () => {
  const { status, stdout } = run({ tool_name: "Bash" });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});
