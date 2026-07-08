#!/usr/bin/env bash
# Smoke test for the SDD bash helpers.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/repo" && cd "$tmp/repo"
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

# sdd-worktree: fresh create on the sdd/tN branch
repo=$(pwd -P)
base=$(git rev-parse HEAD)
wt=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$wt" = "${repo}-t7" ] || { echo "FAIL: unexpected worktree path: $wt"; exit 1; }
[ -d "$wt" ] || { echo "FAIL: worktree missing"; exit 1; }
[ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "sdd/t7" ] || { echo "FAIL: wrong branch"; exit 1; }
[ "$(git -C "$wt" rev-parse HEAD)" = "$base" ] || { echo "FAIL: not at base"; exit 1; }

# sdd-worktree: reuse when the tip descends from base (escalation re-entry)
echo x > "$wt/x" && git -C "$wt" add x && git -C "$wt" commit -qm x
tip=$(git -C "$wt" rev-parse HEAD)
wt2=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$(git -C "$wt2" rev-parse HEAD)" = "$tip" ] || { echo "FAIL: reuse lost commits"; exit 1; }

# sdd-worktree: stale worktree (tip does not descend from new base) is recreated
echo c >> f && git commit -qam c
nb=$(git rev-parse HEAD)
wt3=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt3" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: stale worktree not recreated"; exit 1; }

# sdd-worktree: branch survives worktree removal -> re-added from the branch
git worktree remove --force "$wt3"
wt4=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt4" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: branch-only re-add failed"; exit 1; }
echo "OK"
