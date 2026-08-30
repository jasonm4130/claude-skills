#!/usr/bin/env node

/**
 * JSON Config Guard
 *
 * PostToolUse hook on Edit/Write/MultiEdit/Bash. When an edited file is one of
 * Claude Code's JSON config files, re-parse it and report a syntax error back
 * to the model immediately.
 *
 * Bash is covered because a `sed -i`, a heredoc redirect, a `tee`, a `cp` or an
 * `mv` rewrites a config file without the write tools ever being involved — and
 * a guard that only watches Edit/Write is simply off for those sessions.
 *
 * Why this exists: Claude Code does not error on a malformed settings.json —
 * it drops the block it cannot parse and carries on. A stray comma in the
 * hooks object silently disables every guard in this repo, and the failure
 * surfaces a session later as "the hook stopped firing", with no error to
 * trace it back to. The edit that caused it is the cheapest place to catch it.
 *
 * PostToolUse runs after the write, so this cannot deny — it exits 2 with the
 * parse error on stderr, which Claude Code feeds back to the model as
 * something to fix now.
 *
 * This is an ADVISORY hook and fails OPEN: an unreadable stdin, an unparseable
 * payload, or a missing file exits 0. The guard exists to surface a mistake the
 * model just made, not to wedge the session when the harness surprises it. The
 * one thing it must never do is stay silent about genuinely broken JSON.
 */

import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Config files whose corruption fails silently in the harness. */
const GUARDED = new Set(['settings.json', 'settings.local.json', '.mcp.json']);

/** Absolute path for a guarded file named in a shell token, or null. */
function resolveGuarded(token, cwd) {
  let t = token;
  if (t.startsWith('~/')) t = homedir() + t.slice(1);
  else if (t.startsWith('$HOME/')) t = homedir() + t.slice(5);
  return isAbsolute(t) ? t : resolve(cwd || process.cwd(), t);
}

/** The single candidate from an Edit/Write/MultiEdit payload. */
function editCandidate(filePath) {
  if (typeof filePath !== 'string' || !GUARDED.has(basename(filePath))) return [];
  return [filePath];
}

/**
 * Every guarded path merely MENTIONED in a Bash command.
 *
 * Deliberately no shell parsing: redirections, heredocs and `sed -i` are not
 * inspected to work out which of these paths was actually written. Working that
 * out correctly means implementing a shell, and getting it subtly wrong means
 * the guard goes quiet exactly when it matters. Re-validating a file that was
 * only read costs one JSON.parse and exits 0, so matching on the basename is
 * the intended design — do not "improve" this into a redirect parser.
 */
function bashCandidates(command, cwd) {
  if (typeof command !== 'string') return [];
  const out = new Set();
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^["']/, '').replace(/["']$/, '');
    if (!token || !GUARDED.has(basename(token))) continue;
    out.add(resolveGuarded(token, cwd));
  }
  return [...out];
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open — not our payload to police
  }

  const candidates = payload?.tool_name === 'Bash'
    ? bashCandidates(payload?.tool_input?.command, payload?.cwd)
    : editCandidate(payload?.tool_input?.file_path);

  const broken = [];
  for (const filePath of candidates) {
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      continue; // never written, deleted, or moved between write and hook — not a syntax problem
    }

    // An empty file is valid state for a config Claude Code creates lazily.
    if (!contents.trim()) continue;

    try {
      JSON.parse(contents);
    } catch (err) {
      broken.push(`${filePath} is no longer valid JSON: ${err.message}`);
    }
  }

  if (broken.length) {
    process.stderr.write(
      `${broken.join('\n')}\n\n` +
      `Claude Code does not report this — it silently drops the config it cannot ` +
      `parse, so hooks and permissions defined in this file stop applying. Fix the ` +
      `syntax before continuing.\n`
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
