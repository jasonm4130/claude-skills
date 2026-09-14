#!/usr/bin/env bash
# The one definition of how bin/ccguard is built.
#
#   ./build.sh                → macOS universal binary at ../bin/ccguard
#   ./build.sh <out>          → macOS universal binary at <out>
#   ./build.sh <out> native   → this machine's arch only
#
# The flags below were written out in CI, in README.md and in
# scripts/ccguard-differential.test.mjs. Three copies of a build command is three
# chances for the committed binary to stop matching what the checks rebuild, and
# the failure reads as "the binary is stale" rather than "the flags disagree".
#
# `-buildvcs=false` is load-bearing. By default Go stamps the git revision, commit
# time and a dirty flag into the binary, so the bytes change on every commit even
# when no source did, and the byte comparison fails permanently.
#
# `native` exists for the staleness test, which compares a native build against one
# slice of the committed universal binary rather than rebuilding both.
set -euo pipefail
cd "$(dirname "$0")"

flags=(-buildvcs=false "-ldflags=-s -w" -trimpath)
out="${1:-../bin/ccguard}"
mode="${2:-universal}"

if [ "$mode" = native ]; then
  exec go build "${flags[@]}" -o "$out" .
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
GOOS=darwin GOARCH=arm64 go build "${flags[@]}" -o "$tmp/arm64" .
GOOS=darwin GOARCH=amd64 go build "${flags[@]}" -o "$tmp/amd64" .
lipo -create -output "$out" "$tmp/arm64" "$tmp/amd64"
