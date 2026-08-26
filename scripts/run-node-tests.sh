#!/usr/bin/env bash
# Run every plugin node:test file in one process.
#
# Uses an explicit find-built file list rather than `node --test <dir>` or a
# `**` glob, because Node 24 (LTS):
#   - regressed bare-directory invocation (`node --test tests/` → MODULE_NOT_FOUND), and
#   - its built-in `**` glob skips dot-directories, so `.claude-plugin/*.test.mjs`
#     (the manifest tests) are silently missed.
# `find` catches everything and feeds an explicit list, which works on 20 and 24.
#
# No `mapfile` (macOS ships bash 3.2). Portable while-read array instead.
set -euo pipefail
cd "$(dirname "$0")/.."

files=()
while IFS= read -r f; do files+=("$f"); done < <(find plugins scripts -name '*.test.mjs' | sort)

if [ ${#files[@]} -eq 0 ]; then
  echo "no *.test.mjs files found under plugins/" >&2
  exit 1
fi

echo "Running ${#files[@]} node test files on $(node --version)…"
# Isolate spawned git from the host's global/system config: tests create temp
# repos, and a host with commit.gpgsign=true (e.g. 1Password op-ssh-sign) makes
# every test commit block on signing authorization — an environment hang that
# reads as a red suite.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
node --test "${files[@]}"
