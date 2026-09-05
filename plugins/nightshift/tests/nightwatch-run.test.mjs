// The launcher takes orders: Depends, Units, the control file, and the states
// it is honest about. Every case runs run.sh end to end against a throwaway
// clone with a fake `claude` that writes the unit result the test wants.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CONTINUE_UNIT,
  DIED_UNIT,
  FAILED_UNIT,
  PASS_NO_LOG,
  PASS_NO_RESULTS,
  PASS_UNIT,
  branches,
  nightwatchRepo,
  runNightwatch,
  spec,
  unreachableCommit,
} from "./nightwatch-fixtures.mjs";

test("an unmet Depends waits: no branch, no unit, the queue moves on", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B", "Depends: 03-c") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /02-b: waiting on 03-c/);
  assert.equal(branches(r).some((b) => b.endsWith("/02-b")), false);
  assert.match(out.landed, /^01-a\t/m);
  assert.equal(/02-b u1:/.test(out.journal), false);
});

test("a landed row the landing branch cannot reach does not satisfy Depends", () => {
  const r = nightwatchRepo({ specs: { "02-b.md": spec("B", "Depends: 03-c") } });
  const stale = unreachableCommit(r); // a real commit object, reachable from no ref
  mkdirSync(r.state, { recursive: true });
  writeFileSync(join(r.state, "landed"), `03-c\t20260101-000000\t${stale}\t${stale}\t/x/03-c.md\n`);

  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /02-b: waiting on 03-c/);
  assert.equal(branches(r).some((b) => b.endsWith("/02-b")), false);
});

test("a Depends met earlier in the same run lets the spec proceed", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B", "Depends: 01-a") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.equal(/waiting on/.test(out.journal), false);
  assert.match(out.journal, /02-b u1: PASS/);
  assert.match(out.landed, /^01-a\t/m);
  assert.match(out.landed, /^02-b\t/m);
});

test("Units: 1 caps the spec at one unit", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: CONTINUE_UNIT } });

  assert.match(out.journal, /01-a u1: CONTINUE/);
  assert.equal(/01-a u2:/.test(out.journal), false);
  assert.match(out.journal, /01-a: PARTIAL; branch/);
});

test("requeue appends the spec to the queue and the second pass resumes its branch", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const script = [
    `grep -q requeue "$STATEDIR/control" 2>/dev/null || echo "requeue 01-a" >> "$STATEDIR/control"`,
    FAILED_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.equal((out.journal.match(/01-a u1: FAILED/g) || []).length, 2);
  assert.match(out.journal, /01-a: resuming branch/);
});

test("no result file but a commit on the branch is PARTIAL, not FAILED", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: DIED_UNIT } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /workflow died after 1 commit\(s\)/);
  assert.match(out.journal, /boom: the workflow threw/);
});

test("stop in the control file ends the night after the current unit", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A"), "02-b.md": spec("B") } });
  const script = [`echo stop >> "$STATEDIR/control"`, PASS_UNIT].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /control: stop/);
  assert.match(out.journal, /end: 1 outcome\(s\) landed/);
  assert.equal(/02-b u1:/.test(out.journal), false);
});

test("a PASS whose verify log is missing is downgraded and nothing lands", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_NO_LOG } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /verify evidence missing for bash scripts\/check/);
  assert.equal(out.landed, "");
  assert.match(out.journal, /end: 0 outcome\(s\) landed/);
  assert.equal(branches(r).some((b) => b.endsWith("/01-a")), true);
});

test("a PASS with no verify results at all is downgraded, not landed", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_NO_RESULTS } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /verify evidence missing for \(no verify results in the result file\)/);
  assert.equal(out.landed, "");
  assert.match(out.journal, /end: 0 outcome\(s\) landed/);
});

test("a landed row carries five fields and this run's stamp", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  const stamp = out.journal.match(/start: .*run (\d{8}-\d{6})/)[1];
  const row = out.landed.trim().split("\n")[0].split("\t");
  assert.equal(row.length, 5);
  assert.equal(row[0], "01-a");
  assert.equal(row[1], stamp);
  assert.match(row[2], /^[0-9a-f]{40}$/);
  assert.match(row[3], /^[0-9a-f]{40}$/);
  assert.match(row[4], /01-a\.md$/);
});

test("the control file is consumed by complete lines only, and the offset advances", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 3") } });
  // Unit 1 appends a partial line ("sto"); unit 2 completes it ("p\n"). The
  // launcher must ignore the partial and honour "stop" at the next boundary.
  const script = [
    `case "$UNIT" in 1) printf 'sto' >> "$STATEDIR/control" ;; 2) printf 'p\\n' >> "$STATEDIR/control" ;; esac`,
    CONTINUE_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /01-a u1: CONTINUE/);
  assert.match(out.journal, /01-a u2: CONTINUE/);
  assert.equal(/01-a u3:/.test(out.journal), false, "stop must land before unit 3");
  assert.match(out.journal, /control: stop/);
  assert.equal(/unknown/.test(out.journal), false, "a partial line must not be read as a command");
  const size = statSync(join(r.state, "control")).size;
  assert.equal(Number(out.controlOffset), size);
  assert.equal(readFileSync(join(r.state, "control"), "utf8"), "stop\n");
});

test("the spec is snapshotted per unit and the record line carries wall clock", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  const snap = readFileSync(join(r.state, "outcomes", "01-a", "u1.spec.md"), "utf8");
  assert.match(snap, /^# A$/m);
  const rec = JSON.parse(out.decisions.trim().split("\n")[0]);
  assert.match(rec.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(rec.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof rec.durationS, "number");
});

test("--only takes a comma-separated list", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B"), "03-c.md": spec("C") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT }, args: ["--only", "01-a,03-c"] });

  assert.match(out.journal, /01-a u1: PASS/);
  assert.match(out.journal, /03-c u1: PASS/);
  assert.equal(/02-b u1:/.test(out.journal), false);
});
