// init.mjs against a throwaway git repo: files land, settings merge is a
// union and idempotent, the stamp classifies local edits and template bumps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { main, mergeSettings, ciJobNames, classify, render, fill, xml } from "../scripts/init.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function repo(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-init-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false"); // a global signing key would prompt and hang the test
  // No origin on purpose: probeMergeMode must fall back to wait without gh.
  if (opts.node) writeFileSync(join(dir, "package.json"), '{"name":"x","scripts":{"test":"node --test"}}\n');
  if (opts.workflows) {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), opts.workflows);
  }
  if (opts.settings) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), opts.settings);
  }
  writeFileSync(join(dir, "README.md"), "# x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

const quiet = () => {};

test("a fresh node repo gets the loop, the guards, a verifier, docs, a smoke plan and merged settings", () => {
  const dir = repo({ node: true, workflows: "jobs:\n  test:\n    runs-on: x\n  gate:\n    needs: test\n" });
  try {
    assert.equal(main(["--repo", dir], quiet), 0);
    for (const f of ["loop/land.sh", "loop/config", "loop/PROMPT.md", "loop/SKEPTIC.md", "loop/task-brief", "loop/merge-pr.sh", "loop/launchd.plist", "loop/.nightshift",
      ".claude/hooks/no-route-around-ci.mjs", ".claude/hooks/tests-are-readonly.mjs", ".claude/hooks/hooks.test.mjs", "scripts/check", "docs/nightshift.md"]) {
      assert.ok(existsSync(join(dir, f)), `${f} exists`);
    }
    for (const x of ["loop/land.sh", "loop/task-brief", "loop/merge-pr.sh", "scripts/check"]) assert.ok(statSync(join(dir, x)).mode & 0o111, `${x} is executable`);
    const cfg = readFileSync(join(dir, "loop", "config"), "utf8");
    assert.match(cfg, /PLAN:=docs\/plans\/\d{4}-\d{2}-\d{2}-nightshift-smoke\.md/);
    assert.match(cfg, /EXPECTED_CHECKS:=gate\}/);
    assert.match(cfg, /MERGE_MODE:=wait\}/);
    assert.doesNotMatch(cfg, /\{\{/, "no unfilled placeholder");
    const plan = cfg.match(/PLAN:=(\S+)\}/)[1];
    assert.match(readFileSync(join(dir, plan), "utf8"), /^# Task 1:/m);
    assert.match(readFileSync(join(dir, "scripts", "check"), "utf8"), /npm test/);
    const plist = readFileSync(join(dir, "loop", "launchd.plist"), "utf8");
    assert.ok(plist.includes(`${dir}/loop/land.sh`) || plist.includes("/loop/land.sh"), "plist names the repo's land.sh");
    assert.doesNotMatch(plist, /__REPO__|__NAME__|__HOME__|__PATH__/);
    const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(s.permissions.allow.includes("Bash(npm:*)"));
    assert.ok(s.permissions.allow.includes("Bash(gh:*)"));
    assert.equal(s.permissions.deny, undefined, "no deny rules unless asked");
    const cmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes("no-route-around-ci.mjs")));
    assert.ok(cmds.some((c) => c.includes("tests-are-readonly.mjs")));
    const docs = readFileSync(join(dir, "docs", "nightshift.md"), "utf8");
    assert.doesNotMatch(docs, /\{\{NAME\}\}|ambient/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("existing settings are kept, init is idempotent, --deny-rules adds the deny list", () => {
  const dir = repo({ settings: '{"permissions":{"allow":["Bash(make:*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node mine.mjs"}]}]},"other":true}\n' });
  try {
    assert.equal(main(["--repo", dir], quiet), 0);
    const once = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    assert.equal(main(["--repo", dir], quiet), 0);
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf8"), once, "second init changes nothing");
    const s = JSON.parse(once);
    assert.ok(s.other);
    assert.ok(s.permissions.allow.includes("Bash(make:*)"));
    assert.equal(s.hooks.PreToolUse.length, 2, "our entry appended after theirs");
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "node mine.mjs");
    assert.equal(main(["--repo", dir, "--deny-rules"], quiet), 0);
    assert.ok(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).permissions.deny.includes("Bash(gh pr merge:*)"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unparseable settings.json stops init before it writes anything", () => {
  const dir = repo({ settings: "{ not json" });
  try {
    assert.throws(() => main(["--repo", dir], quiet), /does not parse/);
    assert.ok(!existsSync(join(dir, "loop", ".nightshift")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--check: unchanged, then modified locally, then template newer; --update takes only the latter", () => {
  const dir = repo();
  try {
    assert.equal(main(["--repo", dir, "--plan", "docs/plans/p.md"], quiet), 0);
    const lines = [];
    assert.equal(main(["--repo", dir, "--check"], (l) => lines.push(l)), 0, lines.join("\n"));
    assert.ok(lines.every((l) => !/modified locally|template newer/.test(l)), lines.join("\n"));
    // A local edit to the config
    writeFileSync(join(dir, "loop", "config"), readFileSync(join(dir, "loop", "config"), "utf8") + "\n: \"${MAX:=1}\"\n");
    lines.length = 0;
    assert.equal(main(["--repo", dir, "--check"], (l) => lines.push(l)), 1);
    assert.ok(lines.some((l) => /modified locally\s+loop\/config/.test(l)), lines.join("\n"));
    // A template bump: simulate by editing the stamp of an untouched file
    const stampPath = join(dir, "loop", ".nightshift");
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    stamp.files["loop/SKEPTIC.md"] = "0".repeat(64);
    writeFileSync(join(dir, "loop", "SKEPTIC.md"), "old template content\n");
    writeFileSync(stampPath, JSON.stringify(stamp));
    // Make SKEPTIC.md's current hash equal the (fake) stamped hash so it reads as "template newer"
    const { createHash } = await_import_crypto();
    stamp.files["loop/SKEPTIC.md"] = createHash("sha256").update("old template content\n").digest("hex");
    writeFileSync(stampPath, JSON.stringify(stamp));
    lines.length = 0;
    assert.equal(main(["--repo", dir, "--check"], (l) => lines.push(l)), 1);
    assert.ok(lines.some((l) => /template newer\s+loop\/SKEPTIC\.md/.test(l)), lines.join("\n"));
    assert.equal(main(["--repo", dir, "--update"], quiet), 0);
    assert.match(readFileSync(join(dir, "loop", "SKEPTIC.md"), "utf8"), /VERDICT: OK/, "template newer → overwritten");
    assert.match(readFileSync(join(dir, "loop", "config"), "utf8"), /MAX:=1/, "modified locally → kept");
    assert.ok(!existsSync(join(dir, "docs", "plans")), "--plan given → no smoke plan scaffolded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function await_import_crypto() { return { createHash: (a) => cryptoMod.createHash(a) }; }
import * as cryptoMod from "node:crypto";

test("--check after init --base release compares against release, not main", () => {
  const dir = repo();
  try {
    assert.equal(main(["--repo", dir, "--plan", "docs/plans/p.md", "--base", "release"], quiet), 0);
    assert.match(readFileSync(join(dir, "loop", "config"), "utf8"), /BASE:=release\}/);
    const lines = [];
    assert.equal(main(["--repo", dir, "--check"], (l) => lines.push(l)), 0, lines.join("\n"));
    assert.equal(main(["--repo", dir, "--update"], quiet), 0);
    assert.match(readFileSync(join(dir, "loop", "config"), "utf8"), /BASE:=release\}/, "--update keeps the configured base");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ciJobNames: a gate job wins; matrix job ids are returned as ids, which is why init only pre-fills gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-ci-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: CI\njobs:\n  node-tests:\n    strategy:\n      matrix:\n        os: [a, b]\n  bash-tests:\n    runs-on: x\n");
    assert.deepEqual(ciJobNames(dir).sort(), ["bash-tests", "node-tests"]);
    assert.equal(render(dir, { stack: "generic", base: "main", plan: "p.md", mergeMode: "wait" }).vars.EXPECTED_CHECKS, "", "no gate → left for a human");
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "jobs:\n  a:\n    runs-on: x\n  gate:\n    needs: [a]\n");
    assert.deepEqual(ciJobNames(dir), ["gate"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mergeSettings never removes and never duplicates", () => {
  const s = mergeSettings({ permissions: { allow: ["Bash(gh:*)"], deny: ["Bash(rm -rf:*)"] } }, { stack: "cargo", denyRules: true });
  assert.equal(s.permissions.allow.filter((r) => r === "Bash(gh:*)").length, 1);
  assert.ok(s.permissions.allow.includes("Bash(cargo:*)"));
  assert.ok(s.permissions.deny.includes("Bash(rm -rf:*)"));
  assert.equal(s.hooks.PreToolUse.length, 1);
  const again = mergeSettings(JSON.parse(JSON.stringify(s)), { stack: "cargo", denyRules: true });
  assert.deepEqual(again, s);
});

test("PROMPT.md and SKEPTIC.md keep their {{PLAN}}/{{BASE}} placeholders for land.sh to fill at run time", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-prompt-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const { files } = render(dir, { stack: "generic", base: "release", plan: "docs/plans/p.md", mergeMode: "wait" });
    assert.match(files["loop/PROMPT.md"], /\{\{PLAN\}\}/);
    assert.match(files["loop/PROMPT.md"], /origin\/\{\{BASE\}\}/);
    assert.doesNotMatch(files["loop/PROMPT.md"], /docs\/plans\/p\.md|origin\/release/);
    assert.match(files["loop/config"], /BASE:=release\}/, "config, by contrast, is filled");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a repo path with & renders a plist that still parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-R&D-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const { files } = render(dir, { stack: "generic", base: "main", plan: "p.md", mergeMode: "wait" });
    const plist = files["loop/launchd.plist"];
    assert.ok(plist.includes("R&amp;D"), "ampersand escaped");
    assert.doesNotMatch(plist, /R&D/);
    assert.equal(xml("a<b>&c"), "a&lt;b&gt;&amp;c");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fill leaves unknown placeholders alone and classify reports a missing file", () => {
  assert.equal(fill("a {{X}} {{Y}}", { X: "1" }), "a 1 {{Y}}");
  assert.deepEqual(classify(here, { "nope.txt": "x" }, null), [{ path: "nope.txt", state: "missing" }]);
});
