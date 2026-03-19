#!/usr/bin/env bash
# Sync API — CRUD Examples
#
# Demonstrates the SyncAPI: create credentials, create syncs, list, get, update, delete.
# Backed by a JSON file on disk (sync-store.json). Also serves as a smoke test.
#
# Usage:
#   ./docs-architecture/sync/sync-examples.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
SVC="npx tsx $ROOT/scripts/ts-cli.ts $DIR/sync-examples"
STORE="$ROOT/sync-store.json"

PASS=0
FAIL=0

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

# Clean slate
rm -f "$STORE"

cat << 'HEADER'
Sync API Examples
=================

Setup:
  alias svc='npx tsx ./scripts/ts-cli.ts ./docs-architecture/sync/sync-examples'

┌───┬──────────────────────┬──────────────────────────────────────────────────────────────┐
│ # │ What it demonstrates │ Command                                                      │
├───┼──────────────────────┼──────────────────────────────────────────────────────────────┤
│ 1 │ Create credential    │ svc credentials create '{"type":"stripe","api_key":"sk_..."}' │
│ 2 │ List credentials     │ svc credentials list                                         │
│ 3 │ Create sync          │ svc syncs create '{...}'                                     │
│ 4 │ List syncs           │ svc syncs list                                               │
│ 5 │ Get sync             │ svc syncs get <id>                                           │
│ 6 │ Update sync          │ svc syncs update <id> '{"status":"paused"}'                  │
│ 7 │ Delete sync          │ svc syncs delete <id>                                        │
└───┴──────────────────────┴──────────────────────────────────────────────────────────────┘

HEADER

# ── 1. Create credentials ───────────────────────────────────────

echo "1. Create credentials"
echo '  svc credentials create '"'"'{"type":"stripe","api_key":"sk_test_123"}'"'"''
echo ""

CRED=$($SVC credentials create '{"type":"stripe","api_key":"sk_test_123"}')
CRED_ID=$(echo "$CRED" | jq -r '.id')
assert_contains "created stripe credential" '"type":"stripe"' "$CRED"
assert_contains "has cred_ id" 'cred_' "$CRED"

CRED2=$($SVC credentials create '{"type":"postgres","host":"localhost","port":5432,"user":"sync","password":"secret","database":"mydb"}')
CRED2_ID=$(echo "$CRED2" | jq -r '.id')
assert_contains "created postgres credential" '"type":"postgres"' "$CRED2"

# ── 2. List credentials ─────────────────────────────────────────

echo "2. List credentials"
echo "  svc credentials list"
echo ""

OUT=$($SVC credentials list)
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "2 credentials" "2" "$COUNT"

# ── 3. Create sync ──────────────────────────────────────────────

echo "3. Create sync"
echo '  svc syncs create '"'"'{...}'"'"''
echo ""

SYNC=$($SVC syncs create "{\"account_id\":\"acct_abc\",\"status\":\"backfilling\",\"source\":{\"type\":\"stripe-api-core\",\"livemode\":true,\"api_version\":\"2025-04-30.basil\",\"credential_id\":\"$CRED_ID\"},\"destination\":{\"type\":\"postgres\",\"schema_name\":\"stripe\",\"credential_id\":\"$CRED2_ID\"}}")
SYNC_ID=$(echo "$SYNC" | jq -r '.id')
assert_contains "created sync" '"type":"stripe-api-core"' "$SYNC"
assert_contains "has sync_ id" 'sync_' "$SYNC"

# ── 4. List syncs ───────────────────────────────────────────────

echo "4. List syncs"
echo "  svc syncs list"
echo ""

OUT=$($SVC syncs list)
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "1 sync" "1" "$COUNT"

# ── 5. Get sync ─────────────────────────────────────────────────

echo "5. Get sync"
echo "  svc syncs get $SYNC_ID"
echo ""

OUT=$($SVC syncs get "$SYNC_ID")
assert_contains "retrieved sync" "$SYNC_ID" "$OUT"

# ── 6. Update sync ──────────────────────────────────────────────

echo "6. Update sync"
echo "  svc syncs update $SYNC_ID '{\"status\":\"paused\"}'"
echo ""

OUT=$($SVC syncs update "$SYNC_ID" '{"status":"paused"}')
assert_contains "status updated" '"status":"paused"' "$OUT"

# ── 7. Delete sync ──────────────────────────────────────────────

echo "7. Delete sync"
echo "  svc syncs delete $SYNC_ID"
echo ""

OUT=$($SVC syncs delete "$SYNC_ID")
assert_contains "deleted" '"deleted":true' "$OUT"

OUT=$($SVC syncs list)
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "0 syncs after delete" "0" "$COUNT"

# ── Cleanup + Summary ───────────────────────────────────────────

rm -f "$STORE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
