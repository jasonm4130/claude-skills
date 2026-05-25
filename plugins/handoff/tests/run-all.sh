#!/usr/bin/env bash
# Run all tests in tests/, print PASS/FAIL per file, exit non-zero on any failure.
set -uo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED=()
for t in "$TESTS_DIR"/test_*.sh; do
    [ -f "$t" ] || continue
    name=$(basename "$t" .sh)
    if bash "$t" >/dev/null 2>&1; then
        echo "PASS  $name"
        PASS=$((PASS + 1))
    else
        echo "FAIL  $name"
        FAILED+=("$name")
        FAIL=$((FAIL + 1))
    fi
done
echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
    echo "Failed tests (re-run individually to see output):"
    for f in "${FAILED[@]}"; do echo "  bash tests/${f}.sh"; done
    exit 1
fi
