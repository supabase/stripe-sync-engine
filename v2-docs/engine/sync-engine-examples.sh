#!/usr/bin/env bash
# Sync Engine — Unix Pipe Examples
#
# Demonstrates composing source → transform → destination via Unix pipes.
# Each step is a separate process speaking NDJSON on stdin/stdout.
#
# Also serves as a smoke test — each example asserts expected output.
# Exits with code 1 on first failure.
#
# Usage:
#   ./docs-architecture/sync-engine/sync-engine-examples.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

# Full path for execution
CLI="npx tsx $ROOT/scripts/ts-cli.ts $DIR/sync-engine-examples"

# Short names for display — match the aliases users set up
SRC="source"
DST="dest"
ORC="orch"

PASS=0
FAIL=0

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  ✓ $label"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $label"
        echo "    expected: $expected"
        echo "    actual:   $actual"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        echo "  ✓ $label"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $label"
        echo "    expected to contain: $needle"
        echo "    actual: $haystack"
        FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    local label="$1" needle="$2" haystack="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        echo "  ✓ $label"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $label"
        echo "    expected NOT to contain: $needle"
        FAIL=$((FAIL + 1))
    fi
}

# ── Header ──────────────────────────────────────────────────────

echo "Sync Engine Examples"
echo "===================="
echo ""
echo "Setup:"
echo "  T='npx tsx scripts/ts-cli.ts ./docs-architecture/sync-engine/sync-engine-examples'"
echo "  alias source=\"\$T source\""
echo "  alias dest=\"\$T destination\""
echo "  alias orch=\"\$T orchestrator\""
echo "  alias forward=\"\$T forward\""
echo "  alias collect=\"\$T collect\""
echo "  alias filterAdmins=\"\$T filterAdmins\""
echo "  alias selectFields=\"\$T selectFields\""
echo ""
cat << 'TABLE'
┌───┬────────────────────────────┬──────────────────────────────────────────────────────────┐
│ # │ What it demonstrates       │ Command                                                  │
├───┼────────────────────────────┼──────────────────────────────────────────────────────────┤
│ 1 │ Source read                │ source read                                              │
│ 2 │ Source + filter            │ source read | filterAdmins                               │
│ 3 │ Source + filter + select   │ source read | filterAdmins | selectFields                │
│ 4 │ Full pipe with jq          │ source read | filterAdmins | selectFields | jq ...       │
│ 5 │ Orchestrator as pipe       │ source read --state "$(orch sync.state)" | forward | ... │
│ 6 │ Orchestrator as supervisor │ orch run                                                 │
└───┴────────────────────────────┴──────────────────────────────────────────────────────────┘
TABLE

# ── Example 1: source read ──────────────────────────────────────

echo "Example 1: source read"
echo "  $SRC read"
echo ""
OUT=$($CLI source read)
RECORD_COUNT=$(echo "$OUT" | grep -c '"type":"record"')
assert_eq "emits 5 records" "5" "$RECORD_COUNT"
assert_contains "includes state message" '"type":"state"' "$OUT"

# ── Example 2: source read | filterAdmins ───────────────────────

echo "Example 2: source | filter"
echo "  $SRC read | filterAdmins"
echo ""
OUT=$($CLI source read | $CLI filterAdmins)
RECORD_COUNT=$(echo "$OUT" | grep -c '"type":"record"')
assert_eq "filters to 3 admin records" "3" "$RECORD_COUNT"
assert_contains "Alice passes filter" '"name":"Alice"' "$OUT"
assert_not_contains "Bob is filtered out" '"name":"Bob"' "$OUT"

# ── Example 3: source read | filterAdmins | selectFields ────────

echo "Example 3: source | filter | select"
echo "  $SRC read | filterAdmins | selectFields"
echo ""
OUT=$($CLI source read | $CLI filterAdmins | $CLI selectFields)
RECORD_COUNT=$(echo "$OUT" | grep -c '"type":"record"')
assert_eq "3 records after filter + select" "3" "$RECORD_COUNT"
assert_not_contains "role field removed" '"role"' "$OUT"

# ── Example 4: Unix pipes with jq ───────────────────────────────

echo "Example 4: source | filter | select | jq"
echo "  $SRC read | filterAdmins | selectFields \\"
echo "      | jq -c 'select(.type == \"record\") | .data'"
echo ""
OUT=$($CLI source read | $CLI filterAdmins | $CLI selectFields | jq -c 'select(.type == "record") | .data')
LINE_COUNT=$(echo "$OUT" | wc -l | tr -d ' ')
assert_eq "jq extracts 3 data objects" "3" "$LINE_COUNT"
assert_contains "only data fields remain" '"email"' "$OUT"

# ── Example 5: Orchestrator as Unix pipe ─────────────────────────

echo "Example 5: orchestrator as pipe"
echo "  $SRC read --config \"\$($ORC sync.source)\" --state \"\$($ORC sync.state)\" \\"
echo "      | forward \\"
echo "      | $DST write --config \"\$($ORC sync.destination)\" \\"
echo "      | collect"
echo ""
rm -f "$ROOT/sync-state.json"

OUT=$($CLI source read 2>/dev/null \
    | $CLI forward 2>/dev/null \
    | $CLI destination write 2>/dev/null \
    | $CLI collect 2>/dev/null)
assert_eq "state file created" "true" "$(test -f "$ROOT/sync-state.json" && echo true || echo false)"
assert_contains "state has offset" '"offset"' "$(cat "$ROOT/sync-state.json")"
rm -f "$ROOT/sync-state.json"

# ── Example 6: Orchestrator as supervisor ────────────────────────

echo "Example 6: orchestrator as supervisor"
echo "  $ORC run"
echo ""
rm -f "$ROOT/sync-state.json"

$CLI orchestrator run >/dev/null 2>&1
assert_eq "state file created" "true" "$(test -f "$ROOT/sync-state.json" && echo true || echo false)"
assert_contains "state has offset" '"offset"' "$(cat "$ROOT/sync-state.json")"

# Second run should resume
OUT2=$($CLI orchestrator run 2>&1)
assert_contains "resumes from saved state" "resuming from" "$OUT2"

rm -f "$ROOT/sync-state.json"

# ── Summary ─────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
