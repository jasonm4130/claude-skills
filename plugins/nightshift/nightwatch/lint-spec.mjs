#!/usr/bin/env node
// Lint an outcome spec before it costs a night. Every rule here is a defect
// the first Nightwatch run actually paid for: a missing acceptance command,
// a `cargo run --` with no `--bin` (the wrong binary runs), a `cargo test`
// filter with no pinned count (a trivial assertion stands in for the real
// one), a code span that asserts failure informally instead of naming the
// exit behaviour in prose, an artifact the acceptance mentions without a
// `Writes:` header, and a `Depends:` graph that is broken, self-referential
// or cyclic.
//
//   node lint-spec.mjs --specs-dir <dir> [spec.md]
//
// Lints every spec in <dir> (the dependency graph needs the whole queue).
// With a file given, reports that file's own problems plus any graph
// problem (unknown dependency, cycle) it takes part in. Prints one line per
// problem as `<file>:<line>: <problem>` and exits 1, or `SPEC OK (<n>
// specs)` and exits 0.
//
// `lintSpec(text, { slug, slugs })` returns `string[]` of `"<line>:
// <problem>"` (no filename — the caller knows the file). `slug` is this
// spec's own basename-without-.md, for the self-dependency check; `slugs`
// is every valid slug in the queue, for the unknown-dependency check.
// Cycle detection needs the whole graph, so it lives only in `lintDir`.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const WRITE_EXT_RE = /[~$\w./-]*\.(?:png|json|md|log|wav|mp3|jsonl|csv|svg)\b/g;
// A file the unit edits and commits (docs/, src/, ...) is work, not an artefact;
// the `Writes:` header is for what an acceptance command leaves behind outside
// the committed tree: under the home or cache dirs, or a media/log file anywhere.
const ARTEFACT_RE = /^(?:~|\$|\/|.*(?:^|\/)(?:\.cache|target|node_modules)\/)|\.(?:png|log|wav|mp3|jsonl|csv|svg)$/;
const WRITE_VERB_RE = /\b(?:writes?|written|produces?|creates?|gains?|saves?|emits?)\b/i;
const REQUIRED_HEADINGS = ["## Outcome", "## Acceptance", "## Non-goals", "## Context"];
const ITEM_START_RE = /^\s*(?:\d+\.|[-*])\s/;

function headerEndIndex(lines) {
  const i = lines.findIndex((l) => /^## /.test(l));
  return i === -1 ? lines.length : i;
}

// First line within [0, headerEnd) starting with `<name>:` — mirrors run.sh's
// `spec_field`: `sed -n '1,/^## /p' | sed -n "/^$name:/s/^$name:[[:space:]]*//p" | head -1`.
function headerField(lines, headerEnd, name) {
  const re = new RegExp(`^${name}:`);
  for (let i = 0; i < headerEnd; i++) {
    if (re.test(lines[i])) {
      return { line: i + 1, value: lines[i].replace(re, "").trim() };
    }
  }
  return null;
}

function splitList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Group an Acceptance section's lines into items (a numbered or bulleted
// line starts one; following non-start lines are continuations of it), each
// carrying its starting physical line number and its joined text so a
// sentence-scoped rule sees the whole item even when the source hard-wraps
// mid-sentence.
function acceptanceItems(lines, sectionStart, sectionEnd) {
  const items = [];
  let current = null;
  for (let i = sectionStart; i < sectionEnd; i++) {
    const line = lines[i];
    if (ITEM_START_RE.test(line)) {
      current = { startLine: i + 1, lines: [line] };
      items.push(current);
    } else if (current && line.trim() !== "") {
      current.lines.push(line);
    }
  }
  return items.map((it) => ({ startLine: it.startLine, text: it.lines.join("\n") }));
}

// Physical line number of an offset into an item's joined text.
function lineAt(item, offset) {
  let n = item.startLine;
  for (let i = 0; i < offset; i++) if (item.text[i] === "\n") n++;
  return n;
}

function checkBacktickSpans(item, problems) {
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(item.text))) {
    const cmd = m[1];
    const line = lineAt(item, m.index);
    if (/^cargo run(?: --release)? --/.test(cmd) && !/--bin\b/.test(cmd)) {
      problems.push({ line, msg: `cargo run without --bin: \`${cmd}\`` });
    }
    if (/^cargo test\s+\S+/.test(cmd) && !/^cargo test\s+-/.test(cmd)) {
      const pinned = /\b\d+\s+(?:passed|tests)\b/i.test(item.text) || /\bexactly\b/i.test(item.text);
      if (!pinned) problems.push({ line, msg: `cargo test filter without a pinned count: \`${cmd}\`` });
    }
    if (/--\s*FAILS\b/.test(cmd) || /expected non-zero/i.test(cmd)) {
      problems.push({ line, msg: `code span asserts failure informally instead of in prose: \`${cmd}\`` });
    }
  }
}

// Splits item text into clauses on sentence-ending `.` or `;` so the
// write-verb gate scopes to the clause that actually names the write, not
// the whole (often multi-assertion) item — "leaves session.json unchanged"
// and "a written artifact" should not share a verdict just because they
// share an item. A `.` counts as a boundary only when followed by
// whitespace or end-of-text, so it does not split a filename's own
// extension dot (`uicheck.png`).
function clausesOf(text) {
  const clauses = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if ((c === "." || c === ";") && (next === undefined || /\s/.test(next))) {
      clauses.push({ text: text.slice(start, i + 1), start });
      start = i + 1;
    }
  }
  if (start < text.length) clauses.push({ text: text.slice(start), start });
  return clauses;
}

function checkWrittenArtifacts(item, writes, problems) {
  for (const clause of clausesOf(item.text)) {
    if (!WRITE_VERB_RE.test(clause.text)) continue;
    WRITE_EXT_RE.lastIndex = 0;
    let m;
    while ((m = WRITE_EXT_RE.exec(clause.text))) {
      const path = m[0];
      if (!ARTEFACT_RE.test(path)) continue;
      const line = lineAt(item, clause.start + m.index);
      if (!writes.some((w) => w === path || w.endsWith(`/${path}`) || path.endsWith(`/${w}`))) {
        problems.push({ line, msg: `mentions ${path} without a Writes: header entry` });
      }
    }
  }
}

export function lintSpec(text, { slug, slugs } = {}) {
  const lines = text.split("\n");
  const problems = [];

  if (!/^# \S/.test(lines[0] || "")) problems.push({ line: 1, msg: 'missing "# title" line' });

  const headerEnd = headerEndIndex(lines);
  if (!headerField(lines, headerEnd, "Repo")) problems.push({ line: 1, msg: "missing Repo: header" });

  for (const heading of REQUIRED_HEADINGS) {
    if (!lines.some((l) => l.trim() === heading)) problems.push({ line: 1, msg: `missing ${heading} heading` });
  }

  const depends = headerField(lines, headerEnd, "Depends");
  if (depends) {
    for (const dep of splitList(depends.value)) {
      if (slug && dep === slug) problems.push({ line: depends.line, msg: `Depends: names itself (${dep})` });
      else if (slugs && !slugs.includes(dep)) problems.push({ line: depends.line, msg: `Depends: names unknown spec ${dep}` });
    }
  }

  const units = headerField(lines, headerEnd, "Units");
  if (units && !/^[1-9]\d*$/.test(units.value)) {
    problems.push({ line: units.line, msg: `Units: not a positive integer (${units.value})` });
  }

  const writesHeader = headerField(lines, headerEnd, "Writes");
  const writes = writesHeader ? splitList(writesHeader.value) : [];

  const accIdx = lines.findIndex((l) => l.trim() === "## Acceptance");
  if (accIdx !== -1) {
    let sectionEnd = lines.length;
    for (let i = accIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) { sectionEnd = i; break; }
    }
    const sectionText = lines.slice(accIdx, sectionEnd).join("\n");
    if (!(/scripts\/check/.test(sectionText) && /CHECK OK/.test(sectionText))) {
      problems.push({ line: accIdx + 1, msg: "Acceptance has no scripts/check line naming CHECK OK" });
    }
    for (const item of acceptanceItems(lines, accIdx + 1, sectionEnd)) {
      checkBacktickSpans(item, problems);
      checkWrittenArtifacts(item, writes, problems);
    }
  }

  problems.sort((a, b) => a.line - b.line);
  return problems.map((p) => `${p.line}: ${p.msg}`);
}

// Parses just the Depends: header, for graph building across a whole dir.
function parseDepends(text) {
  const lines = text.split("\n");
  const headerEnd = headerEndIndex(lines);
  const depends = headerField(lines, headerEnd, "Depends");
  return depends ? { line: depends.line, deps: splitList(depends.value) } : { line: null, deps: [] };
}

function findCycles(graph) {
  // Returns one entry per distinct cycle: { members: string[] in cycle order, path: string[] for the message }.
  const cycles = [];
  const seen = new Set();
  const slugs = Object.keys(graph).sort();
  for (const start of slugs) {
    const stack = [start];
    const onStack = new Set([start]);
    const visit = (node) => {
      for (const dep of graph[node] || []) {
        if (dep === start) {
          const members = [...stack].sort();
          const key = members.join(",");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ members, path: [...stack, start] });
          }
          continue;
        }
        if (onStack.has(dep) || !graph[dep]) continue;
        stack.push(dep);
        onStack.add(dep);
        visit(dep);
        stack.pop();
        onStack.delete(dep);
      }
    };
    visit(start);
  }
  return cycles;
}

export function lintDir(dir, { file } = {}) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const slugs = files.map((f) => f.slice(0, -3));
  const texts = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

  const allProblems = [];
  for (const f of files) {
    const slug = f.slice(0, -3);
    for (const p of lintSpec(texts.get(f), { slug, slugs })) {
      const [line, ...rest] = p.split(": ");
      allProblems.push({ file: f, line: Number(line), msg: rest.join(": ") });
    }
  }

  const graph = {};
  const dependsLine = {};
  for (const f of files) {
    const slug = f.slice(0, -3);
    const { line, deps } = parseDepends(texts.get(f));
    graph[slug] = deps.filter((d) => slugs.includes(d) && d !== slug); // unknown/self already reported per-file
    dependsLine[slug] = line;
  }
  for (const cycle of findCycles(graph)) {
    const owner = cycle.members[0]; // alphabetically first participant
    const ownerFile = `${owner}.md`;
    allProblems.push({
      file: ownerFile,
      line: dependsLine[owner] || 1,
      msg: `Depends: cycle ${cycle.path.join(" -> ")}`,
      cycleMembers: cycle.members,
    });
  }

  allProblems.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const targetSlug = file ? basename(file, ".md") : null;
  const visible = file
    ? allProblems.filter((p) => p.file === file || (p.cycleMembers && p.cycleMembers.includes(targetSlug)))
    : allProblems;

  return { lines: visible.map((p) => `${p.file}:${p.line}: ${p.msg}`), specCount: files.length };
}

function main() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--specs-dir");
  if (idx === -1 || !argv[idx + 1]) {
    console.error("usage: lint-spec.mjs --specs-dir <dir> [spec.md]");
    process.exit(64);
  }
  const specsDir = argv[idx + 1];
  const rest = argv.filter((_, i) => i !== idx && i !== idx + 1);
  const file = rest[0] ? basename(rest[0]) : undefined;

  const { lines, specCount } = lintDir(specsDir, { file });
  if (lines.length) {
    for (const l of lines) console.log(l);
    process.exit(1);
  }
  console.log(`SPEC OK (${specCount} specs)`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
