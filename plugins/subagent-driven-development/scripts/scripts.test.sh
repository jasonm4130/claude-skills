#!/usr/bin/env bash
# Smoke test for the SDD bash helpers.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q && git config user.email t@t && git config user.name t

# sdd-workspace creates a self-ignoring workspace
ws=$("$dir/sdd-workspace")
[ -d "$ws" ] || { echo "FAIL: workspace dir missing"; exit 1; }
[ "$(cat "$ws/.gitignore")" = "*" ] || { echo "FAIL: gitignore not self-ignoring"; exit 1; }

# task-brief extracts a single Task block
printf '# Task 1\nalpha\n\n# Task 2\nbeta\n' > plan.md
out=$("$dir/task-brief" plan.md 2 | sed 's/^wrote //; s/:.*//')
grep -q beta "$out" || { echo "FAIL: brief missing task 2 body"; exit 1; }
grep -q alpha "$out" && { echo "FAIL: brief leaked task 1"; exit 1; }

# review-package builds a 2-commit range package
echo a > f && git add f && git commit -qm a
base=$(git rev-parse HEAD)
echo b >> f && git commit -qam b
head=$(git rev-parse HEAD)
pkg=$("$dir/review-package" "$base" "$head" | sed 's/^wrote //; s/:.*//')
grep -q "## Diff" "$pkg" || { echo "FAIL: package missing diff section"; exit 1; }
echo "OK"
