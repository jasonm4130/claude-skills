// @ts-check
// Differential test: the committed `ccguard` binary must behave identically to
// the `.mjs` guards it replaces.
//
// This is the load-bearing verification for the Rust pilot. The two
// implementations are not line-by-line translations — the tokenizer was rewritten
// against `char`s instead of UTF-16 code units, two negative lookaheads were
// removed because no Rust regex engine has lookaround, and the output JSON is
// assembled by hand rather than by a serializer. Each of those is *argued* to be
// equivalence-preserving in the Rust source. This file checks the argument
// instead of trusting it, by running both binaries over the same inputs and
// comparing stdout byte-for-byte plus exit status.
//
// The corpus has two halves:
//   1. Every case the existing JS test suites assert on, transcribed. If the Rust
//      port breaks a documented behaviour, it breaks here.
//   2. Seeded fuzz over a shell-ish grammar (quotes, escapes, heredocs,
//      separators, comments, env prefixes, non-ASCII). This is the half that can
//      find tokenizer divergence nobody thought to write a case for.
//
// Skips — loudly, never silently — when the binary is absent or refuses to
// execute, which is the expected state on Linux CI and on an Intel Mac, since the
// committed binary is arm64 macOS only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * subcommand → [committed binary, the .mjs it replaces]
 * @type {Record<string, [string, string]>}
 */
const IMPLS = {
  "design-gate": [
    join(root, "plugins/design-gate-guard/bin/ccguard"),
    join(root, "plugins/design-gate-guard/scripts/pretooluse-guard-design-gate.mjs"),
  ],
  "agent-model": [
    join(root, "plugins/workflow-model-guard/bin/ccguard"),
    join(root, "plugins/workflow-model-guard/scripts/pretooluse-guard-agent-model.mjs"),
  ],
  "workflow-model": [
    join(root, "plugins/workflow-model-guard/bin/ccguard"),
    join(root, "plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs"),
  ],
};

/**
 * Is the binary present AND runnable here? An arm64-macOS binary on Linux or
 * Intel exits non-zero from the loader rather than running, so presence alone is
 * not enough to decide.
 * @param {string} bin
 */
function runnable(bin) {
  if (!existsSync(bin)) return false;
  const probe = spawnSync(bin, ["--probe"], { input: "{}", encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} stdin
 */
function run(cmd, args, stdin) {
  const res = spawnSync(cmd, args, { input: stdin, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/**
 * Assert both implementations agree on one payload.
 * @param {string} sub
 * @param {string} stdin
 * @param {string} label
 */
function assertAgrees(sub, stdin, label) {
  const [bin, mjs] = IMPLS[sub];
  const rust = run(bin, [sub], stdin);
  const js = run("node", [mjs], stdin);

  assert.equal(
    rust.stdout,
    js.stdout,
    `stdout divergence on ${sub} / ${label}\n  input: ${JSON.stringify(stdin).slice(0, 300)}\n  rust: ${JSON.stringify(rust.stdout).slice(0, 300)}\n  js:   ${JSON.stringify(js.stdout).slice(0, 300)}`,
  );
  assert.equal(
    rust.status,
    js.status,
    `exit-status divergence on ${sub} / ${label}: rust ${rust.status}, js ${js.status}`,
  );
}

/** @param {string} command */
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

// ---------------------------------------------------------------------------
// Corpus 1 — transcribed from the existing JS test suites.
// ---------------------------------------------------------------------------

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
  "FOO=bar npm create vite@latest app",
  "sudo NODE_ENV=production npm create vite app",
  "mkdir app && cd app && npm create vite@latest .",
  "npx --yes create-vite@latest app",
  "npx -y create-next-app my-app",
  "pnpm dlx --package=x create-astro",
  'FOO="not # a shell comment" npm create vite@latest app',
  'echo "path\\\\"; npm create vite',
  "cat <<EOF\nhello world\nEOF\nnpm create vite@latest app",
];

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
  'git commit -m "add create-react-app onboarding docs"',
  'echo "run npm create vite to start"',
  'printf "First run: npm create vite@latest\\n" >> README.md',
  'printf "%s\\n" "npm install && npm create vite" >> README.md',
  'echo "step 1 && npm create vite@latest ." >> NOTES.md',
  'echo "quoted \\"; npm create vite"',
  "cat <<'EOF'\nnpm create vite\nEOF\n",
  "cat <<EOF > README.md\nRun: npm create vite@latest .\nEOF",
  "cat <<-EOF\n\tnpm create vite\n\tEOF",
  "npm create vite@latest my-app # design-gate:ack",
  "cd app && npm create vite  # design-gate:ack",
  "",
];

/** Malformed / edge payloads that must degrade identically. */
const RAW_PAYLOADS = [
  "not json at all",
  "",
  "[1,2,3]",
  "null",
  '"a string"',
  "7",
  "{}",
  '{"tool_name":"Bash"}',
  '{"tool_name":"Write","tool_input":{"file_path":"/x","content":"npm create vite"}}',
  '{"tool_name":"Bash","tool_input":{"command":null}}',
  '{"tool_name":"Bash","tool_input":{"command":123}}',
];

// ---------------------------------------------------------------------------
// Corpus 2 — seeded fuzz.
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32) so a failure is reproducible from the seed
 * printed in the assertion message. `Math.random` would make a divergence
 * un-rerunnable, which is the one thing a fuzz corpus must not be.
 * @param {number} seed
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "npm create vite",
  "cargo new x",
  "create-next-app",
  "dotnet new console",
  "ls",
  "echo hi",
  "git commit",
  "sudo",
  "FOO=bar",
  "BAZ=",
  "#",
  "# comment",
  '"',
  "'",
  "\\",
  '\\"',
  "&&",
  "||",
  ";",
  "|",
  "\n",
  "\t",
  "  ",
  "<<EOF",
  "<<-EOF",
  "<<'EOF'",
  'EOF',
  ">> file.md",
  "$((1<<2))",
  "…",
  "😀",
  "café",
  "-y",
  "--package=x",
  "@scope/create-thing",
  "phx.new",
];

/**
 * Build a random command by concatenating fragments with random spacing.
 * @param {() => number} rand
 */
function fuzzCommand(rand) {
  const n = 1 + Math.floor(rand() * 8);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
    out += rand() < 0.7 ? " " : "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const haveDesignGate = runnable(IMPLS["design-gate"][0]);
const haveWorkflow = runnable(IMPLS["agent-model"][0]);

const skipMsg =
  "ccguard binary not present or not executable here — expected on Linux and Intel macOS " +
  "(the committed binary is arm64 macOS only). Build with `cargo build --release` in rust/ " +
  "and copy it into plugins/*/bin/ to run these.";

test("committed binaries are not stale relative to rust/src", { skip: haveDesignGate ? false : skipMsg }, () => {
  // The binary is a build artifact in git, so "I edited the source" and "the
  // shipped guard changed" are two different events. build.rs bakes a fingerprint
  // of rust/src/*.rs into the binary; this recomputes it the same way and
  // compares. CI does the same check by building fresh — this is the local copy
  // so the mistake is caught before it is pushed.
  const srcDir = join(root, "rust", "src");
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".rs")).sort();

  // FNV-1a over (filename, contents) per file, mirroring rust/build.rs exactly.
  let hash = 0xcbf29ce484222325n;
  const MASK = (1n << 64n) - 1n;
  const fold = (/** @type {Buffer} */ bytes) => {
    for (const b of bytes) {
      hash ^= BigInt(b);
      hash = (hash * 0x100000001b3n) & MASK;
    }
  };
  for (const f of files) {
    fold(Buffer.from(f, "utf8"));
    fold(readFileSync(join(srcDir, f)));
  }
  const expected = hash.toString(16).padStart(16, "0");

  for (const bin of new Set(Object.values(IMPLS).map(([b]) => b))) {
    const got = run(bin, ["--source-fingerprint"], "").stdout.trim();
    assert.equal(
      got,
      expected,
      `${bin} is stale.\n  binary was built from: ${got}\n  rust/src is now:       ${expected}\n` +
        `Rebuild and re-copy:\n    cargo build --release --manifest-path rust/Cargo.toml\n` +
        `    cp "$(cargo metadata --format-version 1 --no-deps --manifest-path rust/Cargo.toml | ` +
        `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')/release/ccguard" ` +
        `plugins/design-gate-guard/bin/ccguard`,
    );
  }
});

test("design-gate: agrees on every scaffold the JS suite asserts", { skip: haveDesignGate ? false : skipMsg }, () => {
  for (const cmd of SCAFFOLDS) assertAgrees("design-gate", bash(cmd), cmd);
});

test("design-gate: agrees on every benign command the JS suite asserts", { skip: haveDesignGate ? false : skipMsg }, () => {
  for (const cmd of BENIGN) assertAgrees("design-gate", bash(cmd), cmd);
});

test("design-gate: agrees on malformed and edge payloads", { skip: haveDesignGate ? false : skipMsg }, () => {
  for (const raw of RAW_PAYLOADS) assertAgrees("design-gate", raw, raw.slice(0, 60));
});

test("design-gate: agrees across 400 fuzzed commands", { skip: haveDesignGate ? false : skipMsg }, () => {
  const rand = rng(0xc0ffee);
  for (let i = 0; i < 400; i++) {
    const cmd = fuzzCommand(rand);
    assertAgrees("design-gate", bash(cmd), `fuzz#${i} seed=0xc0ffee`);
  }
});

test("agent-model: agrees on dispatch shapes", { skip: haveWorkflow ? false : skipMsg }, () => {
  const cases = [
    { tool_name: "Agent", tool_input: { prompt: "x" } },
    { tool_name: "Agent", tool_input: { prompt: "x", model: "sonnet" } },
    { tool_name: "Agent", tool_input: { prompt: "x", model: "" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "fork" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "Explore" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "does-not-exist" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "Explore" }, cwd: root },
    { tool_name: "Agent", tool_input: {} },
    { tool_name: "Bash", tool_input: { command: "ls" } },
  ];
  for (const c of cases) assertAgrees("agent-model", JSON.stringify(c), JSON.stringify(c.tool_input));
  for (const raw of RAW_PAYLOADS) assertAgrees("agent-model", raw, raw.slice(0, 60));
});

test("workflow-model: agrees on script shapes", { skip: haveWorkflow ? false : skipMsg }, () => {
  const scripts = [
    "const x = 1",
    "await agent('a')",
    "await agent('a'); await agent('b'); await agent('c'); await agent('d')",
    "await parallel(xs.map(x => () => agent(x)))",
    "await pipeline(xs, f)",
    "while (x) { await agent('a') }",
    "for (const x of xs) { await agent(x) }",
    "budget.remaining(); agent('a')",
    "agent('a', { model: 'sonnet' })",
    "// model-guard:ack\nawait parallel(xs)",
    "subagent('a')",
    "agent ('spaced')",
  ];
  for (const script of scripts) {
    assertAgrees("workflow-model", JSON.stringify({ tool_name: "Workflow", tool_input: { script } }), script);
  }

  const others = [
    { tool_name: "Workflow", tool_input: { name: "deep-research" } },
    { tool_name: "Workflow", tool_input: { name: "something-else" } },
    { tool_name: "Workflow", tool_input: { scriptPath: "/nonexistent/path.mjs" } },
    { tool_name: "Workflow", tool_input: {} },
  ];
  for (const c of others) assertAgrees("workflow-model", JSON.stringify(c), JSON.stringify(c.tool_input));
  for (const raw of RAW_PAYLOADS) assertAgrees("workflow-model", raw, raw.slice(0, 60));
});
