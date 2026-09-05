#!/usr/bin/env node
// The morning after a Nightwatch run, in one command: what each outcome did,
// what it cost, what the eval flagged, and the pull request body written from
// the logs the acceptance commands actually wrote.
//
//   node morning.mjs <state-dir> [--clone <path>]
//   node morning.mjs <state-dir> --verdict <slug>[@<landed-sha>] <merged|reverted|overridden|discarded> [--note "..."]
//
// <state-dir> is ~/.local/state/nightwatch/<name>. `--clone` adds the two
// commands the morning ends with (push the landing branch, open the pull
// request); they are printed, never run. Nothing here shells out or touches
// the network: every fact comes from the state directory.
//
// What it reads, all written by run.sh and nightwatch.mjs:
//   journal.md                          queue order, per-spec outcome, timestamps
//   decisions.jsonl                     one row per unit: run, spec, unit, state, cost, timing
//   landed                              slug, run, base sha, landed sha, spec path
//   outcomes/<slug>/u<n>.result.json    eval concerns, blockedReason, verify results
//   outcomes/<slug>/u<n>.spec.md        the exact contract that unit ran against
//
// The run is the journal's LAST `start:` line and the stamp it names. Only
// rows carrying that stamp are tonight's; anything older is listed by slug
// under "earlier runs" so a stale night is never counted as this one.

import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const VERDICTS = ["merged", "reverted", "overridden", "discarded"];
const FOOTER = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

function money(n) {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// Journal timestamps are local wall clock (`date '+%Y-%m-%d %H:%M:%S'`);
// startedAt/endedAt are ISO 8601 UTC. Both parse to epoch seconds.
const localTs = (s) => (s ? Date.parse(s.replace(" ", "T")) / 1000 : NaN);
const isoTs = (s) => (s ? Date.parse(s) / 1000 : NaN);

// ---------- the journal ----------

// Everything after the last `start:` line: the run's own history. Older lines
// only tell us which slugs belong to earlier nights.
function readJournal(stateDir) {
  const lines = readText(join(stateDir, "journal.md")).split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) if (/^\S+ \S+ start: /.test(lines[i])) startIdx = i;
  const startLine = startIdx === -1 ? "" : lines[startIdx];
  const stampMatch = startLine.match(/\brun (\d{8}-\d{6})/);
  let stamp = stampMatch ? stampMatch[1] : "";
  if (!stamp) {
    // A journal written before run.sh logged the stamp: fall back to the
    // newest runs/ directory, which is the same run.
    const runs = existsSync(join(stateDir, "runs")) ? readdirSync(join(stateDir, "runs")).sort() : [];
    stamp = runs.length ? runs[runs.length - 1] : "";
  }
  const name = (startLine.match(/start: ([^,]+),/) || [, ""])[1];
  const base = (startLine.match(/\bbase (\S+),/) || [, "main"])[1]; // journals before the field predate BASE support
  const tail = startIdx === -1 ? [] : lines.slice(startIdx + 1).filter(Boolean);

  // The landing branch is named when it is cut or resumed, above the start line.
  let landing = "";
  for (let i = 0; i <= startIdx; i++) {
    const m = lines[i].match(/landing branch (\S+) /);
    if (m) landing = m[1];
  }
  for (const line of tail) {
    const m = line.match(/landed on (\S+) at |ahead of origin\/\S+/);
    if (m && m[1]) landing = m[1];
  }
  return { lines, startIdx, startLine, startTs: localTs(startLine.slice(0, 19)), stamp, name, base, tail, landing };
}

// One record per slug, in the order the journal first mentions it: the queue
// order, including the specs that never cut a branch (waiting, skipped).
function walkJournal(tail) {
  const byslug = new Map();
  const touch = (slug, ts) => {
    if (!byslug.has(slug)) byslug.set(slug, { slug, state: "", branch: "", detail: "", firstTs: ts, lastTs: ts });
    const o = byslug.get(slug);
    if (Number.isFinite(ts)) o.lastTs = ts;
    return o;
  };
  let endTs = NaN;
  for (const line of tail) {
    const ts = localTs(line.slice(0, 19));
    const rest = line.slice(20);
    if (/^end: /.test(rest)) {
      endTs = ts;
      continue;
    }
    let m;
    if ((m = rest.match(/^\s{2}(\S+) u(\d+): /))) {
      touch(m[1], ts);
    } else if ((m = rest.match(/^(\S+): (?:branch|resuming branch) (\S+)/))) {
      touch(m[1], ts).branch = m[2];
    } else if ((m = rest.match(/^(\S+): waiting on (\S+)/))) {
      const o = touch(m[1], ts);
      o.state = "waiting";
      o.detail = `on ${m[2]}`;
    } else if ((m = rest.match(/^(\S+): skipped/))) {
      touch(m[1], ts).state = "skipped";
    } else if ((m = rest.match(/^(\S+): PASS, landed on \S+ at (\S+)/))) {
      touch(m[1], ts).state = "PASS";
    } else if ((m = rest.match(/^(\S+): PASS but fast-forward onto (\S+) failed/))) {
      // A PASS with no landing: it has no `landed` row and no place in the
      // pull request body, and it is the state a human has to act on.
      const o = touch(m[1], ts);
      o.state = "PASS";
      o.detail = `fast-forward onto ${m[2]} failed; branch kept`;
    } else if ((m = rest.match(/^(\S+): (PARTIAL|BLOCKED|FAILED|DRYRUN|KILLED)[;,]/))) {
      touch(m[1], ts).state = m[2];
    } else if ((m = rest.match(/^(\S+): dry run complete/))) {
      touch(m[1], ts).state = "DRYRUN";
    } else if ((m = rest.match(/^STOP: kill switch during (\S+)/))) {
      touch(m[1], ts).state = "KILLED";
    }
  }
  return { byslug, endTs };
}

// ---------- the other three files ----------

// A `--verdict` row lands in the same file as the unit rows; only a row with a
// numeric `unit` is a unit, or the second morning folds verdicts into totals.
function readDecisions(stateDir) {
  return readText(join(stateDir, "decisions.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const unitRows = (rows) => rows.filter((r) => typeof r.unit === "number" && r.state);

function readLanded(stateDir) {
  return readText(join(stateDir, "landed"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [slug, run, base, sha, spec] = l.split("\t");
      return { slug, run, base, sha, spec };
    })
    .filter((r) => r.slug && r.sha);
}

// nightwatch.mjs hands the worker an absolute log dir, so a production `log`
// is absolute. A relative one is resolved against the state dir (that is how
// the checked-in fixture can carry logs at all). A path that resolves to
// nothing is reported as a gap, never silently replaced with another file.
function logPath(stateDir, log) {
  if (!log) return "";
  return isAbsolute(log) ? log : join(stateDir, log);
}

// Per-outcome files live under outcomes/<slug>/ since the first-night fix; the
// launcher that ran that night wrote them under runs/<stamp>/<slug>/. Read the
// new place first and fall back to the old, so the first night stays readable.
function outcomeFile(stateDir, stamp, slug, name) {
  const now = join(stateDir, "outcomes", slug, name);
  if (existsSync(now)) return now;
  const then = join(stateDir, "runs", stamp, slug, name);
  return existsSync(then) ? then : now;
}

// ---------- the report ----------

export function report(stateDir, opts = {}) {
  const j = readJournal(stateDir);
  const { byslug, endTs } = walkJournal(j.tail);
  const rows = readDecisions(stateDir);
  const units = unitRows(rows).filter((r) => r.run === j.stamp);
  const landed = readLanded(stateDir);

  for (const r of units) if (!byslug.has(r.spec)) byslug.set(r.spec, { slug: r.spec, state: "", branch: "", detail: "", firstTs: NaN, lastTs: NaN });

  const outcomes = [];
  for (const o of byslug.values()) {
    const mine = units.filter((r) => r.spec === o.slug).sort((a, b) => a.unit - b.unit);
    const cost = mine.reduce((n, r) => n + (Number(r.cost) || 0), 0);
    const last = mine.length ? mine[mine.length - 1] : null;
    let state = o.state;
    if (!state && last) state = last.state === "CONTINUE" ? "PARTIAL" : last.state;
    if (!state) state = "unknown";

    const started = mine.map((r) => isoTs(r.startedAt)).filter(Number.isFinite);
    const ended = mine.map((r) => isoTs(r.endedAt)).filter(Number.isFinite);
    const wall =
      started.length && ended.length
        ? Math.max(...ended) - Math.min(...started)
        : Number.isFinite(o.firstTs) && Number.isFinite(o.lastTs)
          ? o.lastTs - o.firstTs
          : NaN;

    // Only the units this run actually ran: outcomes/<slug>/ is not run-scoped,
    // so an earlier night's u3 must not be read as tonight's.
    const results = mine.map((r) => ({ unit: r.unit, result: readJson(outcomeFile(stateDir, j.stamp, o.slug, `u${r.unit}.result.json`)) }));
    const concerns = [];
    for (const { unit, result } of results)
      for (const c of result?.eval?.concerns || []) concerns.push({ unit, ...c });
    const blockedReason = [...results].reverse().map(({ result }) => result?.blockedReason).find(Boolean) || "";
    const row = landed.find((l) => l.slug === o.slug && l.run === j.stamp);
    const pass = mine.find((r) => r.state === "PASS");

    outcomes.push({
      slug: o.slug,
      state,
      detail: o.detail,
      branch: o.branch || last?.branch || "",
      units: mine.length,
      cost,
      wall,
      specPath: row?.spec || "",
      concerns,
      blockedReason,
      passUnit: pass ? pass.unit : null,
      landedSha: row ? row.sha : null,
      baseSha: row ? row.base : null,
    });
  }

  const earlier = [...new Set([...landed.filter((l) => l.run !== j.stamp).map((l) => l.slug), ...unitRows(rows).filter((r) => r.run !== j.stamp).map((r) => r.spec)])];
  const prBody = buildPrBody(stateDir, j, outcomes);
  const text = buildText(stateDir, j, outcomes, earlier, endTs, opts);
  return { text, prBody, outcomes, run: j.stamp, landing: j.landing };
}

function buildText(stateDir, j, outcomes, earlier, endTs, opts) {
  const out = [];
  out.push(`Nightwatch morning: ${j.name || "run"}, run ${j.stamp}`);
  out.push(`landing branch ${j.landing || "(unknown)"}, started ${j.startLine.slice(0, 19)}`);
  out.push("");
  for (const o of outcomes) {
    const bits = [o.slug.padEnd(16), o.state.padEnd(8)];
    if (o.state === "waiting" || o.state === "skipped") bits.push(o.detail);
    else {
      bits.push(`${o.units} units`, money(o.cost), duration(o.wall));
      if (o.landedSha) bits.push(`landed ${o.landedSha.slice(0, 7)}`);
      else if (o.branch) bits.push(o.branch);
      if (o.detail) bits.push(o.detail);
    }
    out.push(bits.filter(Boolean).join("  "));
    if (o.state === "BLOCKED" && o.blockedReason) out.push(`    blocked: ${o.blockedReason}`);
    for (const c of o.concerns) out.push(`    u${c.unit} ${c.severity}: ${c.what}${c.where ? ` (${c.where})` : ""}`);
  }
  out.push("");
  const ran = outcomes.filter((o) => o.units > 0);
  const totalCost = ran.reduce((n, o) => n + o.cost, 0);
  const totalUnits = ran.reduce((n, o) => n + o.units, 0);
  const landedCount = outcomes.filter((o) => o.landedSha).length;
  out.push(
    `totals: ${ran.length} spec(s) attempted, ${landedCount} landed, ${totalUnits} unit(s), ${money(totalCost)}` +
      (Number.isFinite(endTs) && Number.isFinite(j.startTs) ? `, ${duration(endTs - j.startTs)} wall clock` : ""),
  );
  if (earlier.length) out.push(`earlier runs: ${earlier.join(", ")}`);
  out.push("");
  out.push(`pr body: ${join(stateDir, "pr-body.md")}`);
  if (opts.clone && j.landing) {
    out.push("");
    out.push("next:");
    out.push(`  git -C ${opts.clone} push -u origin ${j.landing}`);
    out.push(
      `  gh pr create --base ${j.base} --head ${j.landing} --title "${prTitle(j, outcomes)}" --body-file ${join(stateDir, "pr-body.md")}`,
    );
  } else if (!opts.clone) {
    out.push("pass --clone <path> for the push and pull-request commands");
  }
  out.push("");
  return out.join("\n");
}

function prTitle(j, outcomes) {
  const n = outcomes.filter((o) => o.landedSha).length;
  const date = (j.landing.match(/(\d{4}-\d\d-\d\d)/) || [, j.stamp])[1];
  return `Nightwatch ${date}: ${n} outcome${n === 1 ? "" : "s"}`;
}

// The pull request body is written from the log files, not from the result
// file's own `tail`: the point of the logs is that a summary cannot be checked.
function buildPrBody(stateDir, j, outcomes) {
  const out = [`# ${prTitle(j, outcomes)}`, "", `Landing branch \`${j.landing}\`, run \`${j.stamp}\`.`, ""];
  for (const o of outcomes) {
    if (!o.landedSha || o.passUnit === null) continue;
    // The unit's own snapshot of the spec, else the path the landed row names.
    const spec = readText(outcomeFile(stateDir, j.stamp, o.slug, `u${o.passUnit}.spec.md`)) || readText(o.specPath || "");
    const title = (spec.match(/^# (.+)$/m) || [, o.slug])[1];
    out.push(`## ${title}`, "");
    out.push(`\`${o.slug}\`, commits \`${o.baseSha}..${o.landedSha}\` on \`${o.branch || j.landing}\`.`, "");
    out.push("Acceptance, as the passing unit ran it:", "");
    const result = readJson(outcomeFile(stateDir, j.stamp, o.slug, `u${o.passUnit}.result.json`));
    for (const r of result?.verify?.results || []) {
      const p = logPath(stateDir, r.log);
      const text = p ? readText(p) : "";
      if (!text.trim()) {
        out.push(`NO LOG: ${r.command}`, "");
        continue;
      }
      const lines = text.replace(/\n$/, "").split("\n");
      out.push(`\`${r.command}\` — exit ${r.exit}`, "", "```", ...lines.slice(-10), "```", "");
    }
  }
  out.push(FOOTER, "");
  return out.join("\n");
}

// ---------- the verdict ----------

// A slug can land twice, so `<slug>@<sha>` picks a landing; a bare slug takes
// the latest row for that slug. A slug with no landing is an error: there is
// nothing for the verdict to be about.
export function recordVerdict(stateDir, target, verdict, note) {
  if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}, got "${verdict}"`);
  const [slug, sha] = target.split("@");
  const rows = readLanded(stateDir).filter((r) => r.slug === slug);
  const row = sha ? rows.find((r) => r.sha === sha) : rows[rows.length - 1];
  if (!row) throw new Error(`${slug}${sha ? `@${sha}` : ""} has no row in ${join(stateDir, "landed")}: it never landed`);
  const line = {
    ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    spec: row.slug,
    verdict,
    run: row.run,
    base: row.base,
    landedSha: row.sha,
    note: note || "",
  };
  appendFileSync(join(stateDir, "decisions.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

// ---------- cli ----------

function main(argv) {
  const stateDir = argv[0];
  if (!stateDir || stateDir.startsWith("--")) {
    process.stderr.write("usage: morning.mjs <state-dir> [--clone <path>] [--verdict <slug>[@<sha>] <verdict> [--note ...]]\n");
    return 64;
  }
  if (!existsSync(join(stateDir, "journal.md"))) {
    process.stderr.write(`no journal at ${join(stateDir, "journal.md")}\n`);
    return 1;
  }
  let clone = "";
  let verdict = null;
  let note = "";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--clone") clone = argv[++i];
    else if (argv[i] === "--note") note = argv[++i];
    else if (argv[i] === "--verdict") verdict = { target: argv[++i], verdict: argv[++i] };
    else {
      process.stderr.write(`unknown argument ${argv[i]}\n`);
      return 64;
    }
  }
  if (verdict) {
    try {
      process.stdout.write(`${JSON.stringify(recordVerdict(stateDir, verdict.target, verdict.verdict, note))}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  const { text, prBody } = report(stateDir, { clone });
  writeFileSync(join(stateDir, "pr-body.md"), prBody);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
