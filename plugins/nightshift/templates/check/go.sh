#!/usr/bin/env bash
# The quiet verifier: the CI job's steps, run locally, with output that is one
# line per step on success and the whole log on the first failure.
#
#   scripts/check            # prints "✓ <step>" per step, then CHECK OK
#
# Why quiet: a verifier that prints thousands of lines on success eats the
# context of whatever reads it. The unattended landing loop (loop/land.sh) runs
# this before every commit and again after, and greps for the last line. On
# failure the line is "ERROR <step>" followed by that step's full output, so
# grep finds the failure and the log explains it.
#
# Deliberately narrower than CI: keep at least one check that only runs on the
# pull request. That gap is the cheap version of a holdout suite.
set -uo pipefail
cd "$(dirname "$0")/.."
log=$(mktemp)
trap 'rm -f "$log"' EXIT

run() {
  if "$@" >"$log" 2>&1; then
    echo "✓ $*"
  else
    echo "ERROR $*"
    cat "$log"
    exit 1
  fi
}

fmt_clean() { [ -z "$(gofmt -l .)" ]; }
run fmt_clean
run go vet ./...
run go test ./...
echo "CHECK OK"
