// morning.mjs: the night, read once. The fixture under
// fixtures/nightwatch-state/ is the shape the first real night wrote, trimmed:
// one earlier run (so "reads from the last start line" is tested, not merely
// satisfied), then a run with one BLOCKED outcome, one PASS that landed, and
// one spec still waiting on a dependency.
//
// The fixture's `log` paths are relative to the state dir; production writes
// absolute paths (nightwatch.mjs hands the worker an absolute log dir), and a
// checked-in fixture cannot know its own absolute path. `verify-3.log` is
// deliberately absent, so the missing-evidence rendering is covered.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { report } from "../nightwatch/morning.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "nightwatch-state");
const MORNING = join(HERE, "..", "nightwatch", "morning.mjs");

const RUN = "20260905-225514";
const LANDED_SHA = "45971050f1e2d3c4b5a6978869504132abcdef01";
const BASE_SHA = "e5e2de5aa1b2c3d4e5f60718293a4b5c6d7e8f90";

// A fresh copy per test: --verdict appends to decisions.jsonl and the report
// writes pr-body.md, so the fixture in the repo must stay untouched.
function withState(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nw-morning-"));
  const state = join(dir, "ambient");
  cpSync(FIXTURE, state, { recursive: true });
  try {
    return fn(state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(args, opts = {}) {
  return execFileSync(process.execPath, [MORNING, ...args], { encoding: "utf8", ...opts });
}

test("the report reads the last run and names every outcome in queue order", () => {
  withState((state) => {
    const { text, outcomes } = report(state);
    assert.deepEqual(
      outcomes.map((o) => [o.slug, o.state]),
      [
        ["01-ui-api", "BLOCKED"],
        ["06-live-asr", "PASS"],
        ["07-ui-features", "waiting"],
      ],
    );
    assert.match(text, /run 20260905-225514/);
    assert.match(text, /nightwatch\/2026-09-05/);
    // The earlier run's outcome is named, never folded into tonight's totals.
    assert.match(text, /earlier runs.*00-plumbing/s);
    assert.doesNotMatch(text, /00-plumbing\s+PASS/);
  });
});

test("the passing outcome carries its unit count, cost and landed sha", () => {
  withState((state) => {
    const { text, outcomes } = report(state);
    const live = outcomes.find((o) => o.slug === "06-live-asr");
    assert.equal(live.units, 5);
    assert.equal(live.landedSha, LANDED_SHA);
    assert.ok(Math.abs(live.cost - 24.06555445) < 1e-9, `cost was ${live.cost}`);
    assert.match(text, /06-live-asr/);
    assert.match(text, /5 units/);
    assert.match(text, /\$24\.07/);
    // A low concern from a middle unit is still the morning's business.
    assert.match(text, /low: The readiness channel drops its sender/);
  });
});

test("the blocked outcome carries its reason and its high concern", () => {
  withState((state) => {
    const { text, outcomes } = report(state);
    const ui = outcomes.find((o) => o.slug === "01-ui-api");
    assert.equal(ui.units, 4);
    assert.equal(ui.branch, "nw/2026-09-05/01-ui-api");
    assert.match(ui.blockedReason, /crate-ci\/typos/);
    assert.match(text, /01-ui-api\s+BLOCKED/);
    assert.match(text, /unparseable/);
    assert.match(text, /high: CI will fail on this branch/);
    assert.match(text, /07-ui-features\s+waiting\s+on 03-ui-shell/);
  });
});

test("the pr body quotes the log file, not the result file's tail", () => {
  withState((state) => {
    const { prBody } = report(state);
    assert.match(prBody, /# Live ASR: what a block costs and whether the queue drains/);
    assert.match(prBody, new RegExp(`${BASE_SHA}\\.\\.${LANDED_SHA}`));
    assert.match(prBody, /CHECK OK/);
    assert.match(prBody, /8 passed; 0 failed/);
    // Only the last 10 lines of the log, so the head of a long log is dropped.
    assert.doesNotMatch(prBody, /line 1 of noise/);
    // The third command's log was never written: the gap is shown, not hidden.
    assert.match(prBody, /NO LOG: cargo run --release --bin asrbench/);
    // Nothing that did not land belongs in the pull request body.
    assert.doesNotMatch(prBody, /01-ui-api/);
    assert.match(prBody, /Generated with \[Claude Code\]/);
  });
});

test("the cli writes pr-body.md and prints the push and pr commands with --clone", () => {
  withState((state) => {
    const out = cli([state, "--clone", "/tmp/clone-x"]);
    assert.match(out, /06-live-asr/);
    assert.match(out, /git -C \/tmp\/clone-x push -u origin nightwatch\/2026-09-05/);
    assert.match(out, /gh pr create/);
    const body = readFileSync(join(state, "pr-body.md"), "utf8");
    assert.match(body, /CHECK OK/);
  });
});

test("--verdict resolves the landing and appends one decision line", () => {
  withState((state) => {
    const out = cli([state, "--verdict", "06-live-asr", "merged", "--note", "squashed by hand"]);
    const line = JSON.parse(out.trim().split("\n").pop());
    assert.equal(line.spec, "06-live-asr");
    assert.equal(line.verdict, "merged");
    assert.equal(line.run, RUN);
    assert.equal(line.landedSha, LANDED_SHA);
    assert.equal(line.base, BASE_SHA);
    assert.equal(line.note, "squashed by hand");
    const rows = readFileSync(join(state, "decisions.jsonl"), "utf8").trim().split("\n");
    assert.equal(rows.length, 11);
    assert.deepEqual(JSON.parse(rows[10]), line);
    // A verdict row is not a unit row: the report's arithmetic must not move.
    assert.equal(report(state).outcomes.find((o) => o.slug === "06-live-asr").units, 5);
  });
});

test("--verdict <slug>@<sha> picks that landing, not the latest for the slug", () => {
  withState((state) => {
    const sha = "1111111111111111111111111111111111111111";
    const line = JSON.parse(cli([state, "--verdict", `00-plumbing@${sha}`, "reverted"]).trim());
    assert.equal(line.run, "20260904-220000");
    assert.equal(line.landedSha, sha);
  });
});

test("a bare name resolves to the state dir under HOME, and --clone defaults to the config's", () => {
  withState((state) => {
    // A temp HOME so the real ~/.local/state is never read or written.
    const home = mkdtempSync(join(tmpdir(), "nw-home-"));
    const named = join(home, ".local", "state", "nightwatch", "ambient");
    mkdirSync(dirname(named), { recursive: true });
    cpSync(state, named, { recursive: true });
    writeFileSync(join(named, "config"), "NAME=ambient\nCLONE=/w/clone\nBASE=main\nCHECK=scripts/check\n");

    const text = cli(["ambient"], { env: { ...process.env, HOME: home } });
    assert.match(text, /Nightwatch morning: ambient/);
    assert.match(text, /git -C \/w\/clone push -u origin nightwatch\/2026-09-05/);
    rmSync(home, { recursive: true, force: true });
  });
});

test("--verdict on a slug that never landed exits 1 and names it", () => {
  withState((state) => {
    assert.throws(
      () => cli([state, "--verdict", "01-ui-api", "merged"], { stdio: "pipe" }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /01-ui-api/);
        return true;
      },
    );
  });
});
