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
// execute, which is the expected state on Linux CI. The committed binary is a
// macOS universal build, so both Apple Silicon and Intel Macs run these.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * subcommand → [committed binary, the .mjs it replaces]
 * @type {Record<string, [string, string]>}
 */
const IMPLS = {
  "agent-model": [
    join(root, "plugins/gates/bin/ccguard"),
    join(root, "plugins/gates/scripts/pretooluse-guard-agent-model.mjs"),
  ],
  "workflow-model": [
    join(root, "plugins/gates/bin/ccguard"),
    join(root, "plugins/gates/scripts/pretooluse-guard-workflow-model.mjs"),
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
 * @param {NodeJS.ProcessEnv} [env]
 */
const BASE_ENV = (() => {
  const { GATES_DISABLE, ...rest } = process.env;
  return rest;
})();

function run(cmd, args, stdin, env) {
  const res = spawnSync(cmd, args, { input: stdin, encoding: "utf8", env: env ?? BASE_ENV });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/**
 * Assert the two implementations agree on one payload.
 *
 * The binary is invoked exactly as hooks.json invokes it — `ccguard <sub>
 * <guard>.mjs` — because the second argument is load-bearing. Some payloads
 * cannot be decided in Rust at all (a JSON string holding a lone surrogate is
 * legal for `JSON.parse` and unrepresentable in a Rust `String`), and for those
 * the binary spawns that guard and forwards its answer. Run the binary without
 * the argument and it has nothing to delegate to, so it fails open and this
 * comparison would be measuring a configuration nobody ships.
 *
 * Delegation is deliberately invisible here: whether the binary answered or node
 * did, stdout and exit status must match node byte-for-byte. That is the whole
 * property — there is no payload on which the guard is allowed to differ.
 *
 * @param {string} sub
 * @param {string} stdin
 * @param {string} label
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 */
function assertAgrees(sub, stdin, label, opts = {}) {
  const [bin, mjs] = IMPLS[sub];
  const rust = run(bin, [sub, mjs], stdin, opts.env);
  const js = run("node", [mjs], stdin, opts.env);

  const where = `${sub} / ${label}\n  input: ${JSON.stringify(stdin).slice(0, 300)}`;

  assert.equal(
    rust.stdout,
    js.stdout,
    `stdout divergence on ${where}\n  rust: ${JSON.stringify(rust.stdout).slice(0, 300)}\n  js:   ${JSON.stringify(js.stdout).slice(0, 300)}`,
  );
  assert.equal(
    rust.status,
    js.status,
    `exit-status divergence on ${where}: rust ${rust.status}, js ${js.status}`,
  );
}

/** @param {string} command */
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

// ---------------------------------------------------------------------------
// Corpus 1 — transcribed from the existing JS test suites.
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

const haveWorkflow = runnable(IMPLS["agent-model"][0]);

const skipMsg =
  "ccguard binary not present or not executable here — expected on Linux (the committed " +
  "binary is a macOS universal build covering arm64 and x86_64). Build with " +
  "`go build -ldflags=\"-s -w\" -trimpath` in plugins/gates/go/ and copy it into plugins/*/bin/ to run these.";

const haveGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

// This comparison is macOS-only, and not merely by preference. A native `go build`
// on Linux emits an ELF, while the committed artifact is a Mach-O universal binary;
// `lipo` — the only thing that could thin it down to a comparable slice — ships with
// Xcode and does not exist on Linux, so the fallback path compares a fat Mach-O
// against an ELF and can never match. The macOS-only `go-guards` CI job runs this
// same check, so nothing goes unverified by skipping here.
const stalenessSkip = !haveGo
  ? "go toolchain not present — cannot rebuild to compare"
  : process.platform !== "darwin"
    ? `staleness comparison needs macOS (\`lipo\` to thin the universal binary); ran on ${process.platform}. The go-guards job covers this on macos-latest.`
    : false;

test(
  "the committed binary is not stale relative to plugins/gates/go/",
  { skip: stalenessSkip },
  () => {
    // The binary is a build artifact in git, because the marketplace install path
    // is `git clone` + copy with no build step anywhere in it. So "I edited the
    // source" and "the shipped guard changed" are two different events, and only
    // this check ties them together.
    //
    // The Rust version of this test could not compare bytes — Rust builds are not
    // bit-reproducible across toolchain versions or build paths — so it compared an
    // FNV-1a source fingerprint baked in by build.rs. Go with `-trimpath` IS
    // reproducible, so the fingerprint apparatus is gone and we compare the real
    // artifact instead. That is strictly stronger: it catches a stale binary AND a
    // binary built from something other than this source.
    //
    // The committed file is a macOS universal binary, so thin it to this machine's
    // arch before comparing against a native `go build`.
    const goDir = join(root, "plugins", "gates", "go");
    const fresh = join(tmpdir(), `ccguard-fresh-${process.pid}`);
    const built = spawnSync(
      "go",
      ["build", "-buildvcs=false", "-ldflags=-s -w", "-trimpath", "-o", fresh, "."],
      { cwd: goDir, encoding: "utf8" },
    );
    assert.equal(built.status, 0, `go build failed:\n${built.stderr}`);

    for (const bin of new Set(Object.values(IMPLS).map(([b]) => b))) {
      const thin = join(tmpdir(), `ccguard-thin-${process.pid}`);
      const arch = process.arch === "arm64" ? "arm64" : "x86_64";
      const lipo = spawnSync("lipo", [bin, "-thin", arch, "-output", thin], { encoding: "utf8" });
      // A non-universal binary (someone committed a single-arch build) has nothing
      // to thin; compare it directly rather than treating that as an error here —
      // the arch check below is what enforces universality.
      const candidate = lipo.status === 0 ? thin : bin;

      assert.deepEqual(
        readFileSync(candidate),
        readFileSync(fresh),
        `${bin} is stale or was built from different source.\n` +
          `Rebuild and re-copy:\n` +
          `    cd plugins/gates/go\n` +
          `    GOOS=darwin GOARCH=arm64 go build -buildvcs=false -ldflags="-s -w" -trimpath -o /tmp/cc-arm64 .\n` +
          `    GOOS=darwin GOARCH=amd64 go build -buildvcs=false -ldflags="-s -w" -trimpath -o /tmp/cc-amd64 .\n` +
          `    lipo -create -output ../${bin.replace(`${root}/plugins/gates/`, "")} /tmp/cc-arm64 /tmp/cc-amd64`,
      );
    }
  },
);

test(
  "the committed binary covers both macOS architectures",
  { skip: haveWorkflow ? false : skipMsg },
  () => {
    // Shipping arm64 only means every Intel-Mac installer silently falls through to
    // the `|| node` fallback in hooks.json and pays ~21ms of interpreter start per
    // tool call, with nothing anywhere reporting that it happened.
    for (const bin of new Set(Object.values(IMPLS).map(([b]) => b))) {
      const archs = spawnSync("lipo", ["-archs", bin], { encoding: "utf8" }).stdout.trim().split(/\s+/);
      assert.deepEqual(
        [...archs].sort(),
        ["arm64", "x86_64"],
        `${bin} should be a universal binary covering arm64 and x86_64, got: ${archs.join(" ")}`,
      );
    }
  },
);

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

  // scriptPath against REAL files. The inline-script cases above never exercise
  // the file-reading branch, which is where the port's one real divergence lived:
  // `read_to_string` rejects invalid UTF-8, while `readFileSync(path, "utf8")`
  // replaces it and carries on. A fan-out script with one stray byte was denied
  // by node and silently allowed by the binary.
  const tmp = mkdtempSync(join(tmpdir(), "ccguard-diff-"));
  const fanout = "await parallel(xs.map(x => () => agent(x)))";
  /** @type {[string, Buffer][]} */
  const files = [
    ["clean.mjs", Buffer.from(`${fanout}\n`, "utf8")],
    ["invalid-utf8.mjs", Buffer.concat([Buffer.from(`${fanout} // `, "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")])],
    ["lone-surrogate.mjs", Buffer.concat([Buffer.from(`${fanout} // `, "utf8"), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from("\n")])],
    ["empty.mjs", Buffer.alloc(0)],
    ["tiered.mjs", Buffer.from("agent('a', { model: 'sonnet' })\n", "utf8")],
  ];
  for (const [name, bytes] of files) {
    const p = join(tmp, name);
    writeFileSync(p, bytes);
    assertAgrees(
      "workflow-model",
      JSON.stringify({ tool_name: "Workflow", tool_input: { scriptPath: p } }),
      `scriptPath ${name}`,
    );
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

// ---------------------------------------------------------------------------
// Regression corpus — inputs on which the binary and the .mjs guards were found
// to disagree in production. Each was reported by the 2026-08-03 cross-provider
// diff review of 44cb251^..0fd0e5d and reproduced at the console before being
// fixed. They are grouped here, rather than folded into the corpora above,
// because the shared property is provenance: every one of them is a case the
// original corpus was shaped not to think of.
// ---------------------------------------------------------------------------

/**
 * A lone surrogate: legal in JSON and in a JS string, unrepresentable in a Rust
 * `String`. Kept as an escape rather than a literal so the file stays valid
 * UTF-8 on disk.
 */
const LONE_SURROGATE = "\ud800";

test("lone surrogates in the payload do not silently bypass any guard", { skip: haveWorkflow ? false : skipMsg }, () => {
  // The bug: `serde_json` rejects a lone surrogate, the binary treated that as
  // "malformed, nothing to do" and exited 0, and because the hook is
  // `ccguard || node` a zero exit means node never ran. A single unpaired
  // surrogate anywhere in the command switched the guard off. The gate it was
  // found on was design-gate, now retired; the property is not specific to it.
  const scaffold = `npm create vite ${LONE_SURROGATE}`;

  // node ignores a Bash payload, so the binary must either ignore it too or
  // decline — never invent a decision.
  assertAgrees("agent-model", bash(scaffold), "scaffold + lone surrogate");
  assertAgrees("workflow-model", bash(scaffold), "scaffold + lone surrogate");

  // The sharp end, asserted directly: node denies this fan-out, so anything that
  // leaves stdout empty is a silent bypass of the guard.
  const fanOut = JSON.stringify({
    tool_name: "Workflow",
    tool_input: { script: `phase("${LONE_SURROGATE}"); await parallel(items.map(i => () => agent("do " + i)))` },
  });
  const [bin, mjs] = IMPLS["workflow-model"];
  const js = run("node", [mjs], fanOut);
  assert.notEqual(js.stdout, "", "precondition: node must deny this fan-out");
  assert.equal(
    run(bin, ["workflow-model", mjs], fanOut).stdout,
    js.stdout,
    "the production-wired binary must reproduce node's decision on a payload it cannot parse itself",
  );

  // And the trap that shaped the fix, pinned so nobody "simplifies" the argv
  // away: with only the `||` in hooks.json to fall back on, the binary has
  // already drained stdin by the time it declines, the shell cannot rewind a
  // pipe, and node reads zero bytes. The guard goes quiet.
  const viaShellOnly = spawnSync(
    "sh",
    ["-c", `${JSON.stringify(bin)} workflow-model || node ${JSON.stringify(mjs)}`],
    { input: fanOut, encoding: "utf8" },
  );
  assert.equal(
    viaShellOnly.stdout,
    "",
    "expected the shell-only fallback to lose the payload — if this now produces a decision, " +
      "the stdin-draining constraint has changed and hook::delegate can be simplified",
  );

  // Surrogates in fields the guards read but do not gate on, to check the
  // decline path is not swallowing decidable payloads wholesale.
  assertAgrees("workflow-model", bash(`ls ${LONE_SURROGATE}`), "benign + lone surrogate");
  assertAgrees(
    "agent-model",
    JSON.stringify({ tool_name: "Agent", tool_input: { prompt: LONE_SURROGATE, model: "sonnet" } }),
    "tiered dispatch + lone surrogate",
  );
});

test("workflow-model counts agent() calls separated by non-ASCII whitespace", { skip: haveWorkflow ? false : skipMsg }, () => {
  // The bug: `regex-lite`'s `\s` is ASCII-only, JS's is not. `\bagent\s*\(` with
  // a non-breaking space before the paren matched zero times in the binary and
  // four times in node, so a four-agent fan-out was denied by node and allowed by
  // the binary. Cargo.toml called this divergence unreachable on the grounds that
  // the tokenizer consumes exotic whitespace first — true of design_gate, which
  // tokenizes, and false of workflow_model, which regexes raw script text.
  const SPACES = [
    [" ", "no-break space"],
    [" ", "thin space"],
    ["　", "ideographic space"],
    [" ", "narrow no-break space"],
    ["﻿", "zero-width no-break space"],
  ];
  for (const [ws, name] of SPACES) {
    const script = ["a", "b", "c", "d"].map((c) => `await agent${ws}("${c}");`).join("");
    assertAgrees(
      "workflow-model",
      JSON.stringify({ tool_name: "Workflow", tool_input: { script } }),
      `4 agent() calls separated by ${name}`,
    );
  }

  // The loop/fan-out cues use `\s*` too, and are what promote a script to the
  // stricter branch.
  for (const [ws, name] of SPACES) {
    assertAgrees(
      "workflow-model",
      JSON.stringify({ tool_name: "Workflow", tool_input: { script: `while${ws}(x) { await agent("a") }` } }),
      `while-loop with ${name}`,
    );
    assertAgrees(
      "workflow-model",
      JSON.stringify({ tool_name: "Workflow", tool_input: { script: `for${ws}(const x of xs) { await agent(x) }` } }),
      `for-loop with ${name}`,
    );
  }
});

test("agent-model resolves user agent definitions with HOME unset", { skip: haveWorkflow ? false : skipMsg }, () => {
  // The bug: node's `os.homedir()` falls back to the account home from the passwd
  // database when $HOME is absent; the port read `std::env::var_os("HOME")` and
  // gave up, so it never saw `~/.claude/agents/*.md` and denied dispatches that
  // node allows on the strength of a pinned frontmatter model. Fails closed, so
  // it is friction rather than a hole — but it is still a divergence.
  const noHome = { ...BASE_ENV };
  delete noHome.HOME;

  const cases = [
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "Explore" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "does-not-exist" } },
    { tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "Explore" }, cwd: root },
    { tool_name: "Agent", tool_input: { prompt: "x" } },
  ];
  for (const c of cases) {
    assertAgrees("agent-model", JSON.stringify(c), `HOME unset — ${JSON.stringify(c.tool_input)}`, { env: noHome });
  }
});

test("GATES_DISABLE: both implementations go silent on the same guard", { skip: haveWorkflow ? false : skipMsg }, () => {
  // The toggle lives in two places (go/config.go, scripts/lib.mjs) because the
  // binary and the .mjs reference each answer on different machines. Two copies
  // of a parser is exactly the shape this corpus exists to police.
  const PAYLOADS = {
    "agent-model": JSON.stringify({ tool_name: "Agent", tool_input: { prompt: "x" } }),
    "workflow-model": JSON.stringify({
      tool_name: "Workflow",
      tool_input: { script: 'phase("x"); await parallel(items.map(i => () => agent("do " + i)))' },
    }),
  };

  for (const [sub, payload] of Object.entries(PAYLOADS)) {
    // Baseline: with nothing disabled this payload must actually trigger,
    // otherwise every assertion below holds for the wrong reason.
    const [bin, mjs] = IMPLS[sub];
    const live = run(bin, [sub, mjs], payload, BASE_ENV);
    assert.notEqual(live.stdout.trim(), "", `${sub}: baseline payload no longer triggers`);

    for (const raw of [sub, `${sub},docs-sync`, ` ${sub} `, `docs-sync,${sub}`]) {
      assertAgrees(sub, payload, `disabled via ${JSON.stringify(raw)}`, {
        env: { ...BASE_ENV, GATES_DISABLE: raw },
      });
    }

    // Names that must NOT match: near-misses, wrong case, another guard.
    for (const raw of ["", "docs-sync", `${sub}-extra`, sub.toUpperCase(), sub.replace(/-/g, "_")]) {
      assertAgrees(sub, payload, `still live under ${JSON.stringify(raw)}`, {
        env: { ...BASE_ENV, GATES_DISABLE: raw },
      });
    }
  }
});
