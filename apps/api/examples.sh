#!/usr/bin/env bash
# Sync API — HTTP CRUD Examples
#
# Demonstrates the Sync Service REST API: create credentials, create syncs,
# list, get, update, delete — all via curl against localhost:4010.
#
# Usage:
#   bun apps/api/src/index.ts &    # start server
#   bash apps/api/examples.sh      # run smoke test

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-4010}
BASE="http://localhost:$PORT"
STORE_DIR=$(mktemp -d)
export STORE_DIR PORT

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

# ── Start server ─────────────────────────────────────────────────

bun "$DIR/src/index.ts" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$STORE_DIR"' EXIT

# Wait for server to be ready
for i in $(seq 1 30); do
    if curl -s "$BASE/openapi.json" > /dev/null 2>&1; then break; fi
    sleep 0.1
done

cat << 'HEADER'
Sync API Examples (HTTP)
========================

Setup:
  bun apps/api/src/index.ts &
  alias api='curl -s localhost:4010'

┌───┬──────────────────────┬──────────────────────────────────────────────────────────────┐
│ # │ What it demonstrates │ Command                                                      │
├───┼──────────────────────┼──────────────────────────────────────────────────────────────┤
│ 1 │ Create credential    │ api -X POST /credentials -d '{"type":"stripe",...}'           │
│ 2 │ List credentials     │ api /credentials                                             │
│ 3 │ Create sync          │ api -X POST /syncs -d '{...}'                                │
│ 4 │ List syncs           │ api /syncs                                                   │
│ 5 │ Get sync             │ api /syncs/<id>                                              │
│ 6 │ Update sync (pause)  │ api -X PATCH /syncs/<id> -d '{"status":"paused"}'            │
│ 7 │ Delete sync          │ api -X DELETE /syncs/<id>                                    │
└───┴──────────────────────┴──────────────────────────────────────────────────────────────┘

HEADER

# ── 1. Create credentials ───────────────────────────────────────

echo "1. Create credentials"
echo '  $ curl -s -X POST localhost:4010/credentials -H "Content-Type: application/json" -d '"'"'{"type":"stripe","api_key":"sk_test_123"}'"'"''
echo ""

CRED=$(curl -s -X POST "$BASE/credentials" \
    -H "Content-Type: application/json" \
    -d '{"type":"stripe","api_key":"sk_test_123"}')
CRED_ID=$(echo "$CRED" | jq -r '.id')
assert_contains "created stripe credential" '"type":"stripe"' "$CRED"
assert_contains "has cred_ id" 'cred_' "$CRED"

CRED2=$(curl -s -X POST "$BASE/credentials" \
    -H "Content-Type: application/json" \
    -d '{"type":"postgres","host":"localhost","port":5432,"user":"sync","password":"secret","database":"mydb"}')
CRED2_ID=$(echo "$CRED2" | jq -r '.id')
assert_contains "created postgres credential" '"type":"postgres"' "$CRED2"

echo ""

# ── 2. List credentials ─────────────────────────────────────────

echo "2. List credentials"
echo "  \$ curl -s localhost:4010/credentials"
echo ""

OUT=$(curl -s "$BASE/credentials")
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "2 credentials" "2" "$COUNT"

echo ""

# ── 3. Create sync ──────────────────────────────────────────────

echo "3. Create sync"
echo '  $ curl -s -X POST localhost:4010/syncs -H "Content-Type: application/json" -d '"'"'{...}'"'"''
echo ""

SYNC=$(curl -s -X POST "$BASE/syncs" \
    -H "Content-Type: application/json" \
    -d "{\"account_id\":\"acct_abc\",\"status\":\"backfilling\",\"source\":{\"type\":\"stripe-api-core\",\"livemode\":true,\"api_version\":\"2025-04-30.basil\",\"credential_id\":\"$CRED_ID\"},\"destination\":{\"type\":\"postgres\",\"schema_name\":\"stripe\",\"credential_id\":\"$CRED2_ID\"}}")
SYNC_ID=$(echo "$SYNC" | jq -r '.id')
assert_contains "created sync" '"type":"stripe-api-core"' "$SYNC"
assert_contains "has sync_ id" 'sync_' "$SYNC"

echo ""

# ── 4. List syncs ───────────────────────────────────────────────

echo "4. List syncs"
echo "  \$ curl -s localhost:4010/syncs"
echo ""

OUT=$(curl -s "$BASE/syncs")
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "1 sync" "1" "$COUNT"

echo ""

# ── 5. Get sync ─────────────────────────────────────────────────

echo "5. Get sync"
echo "  \$ curl -s localhost:4010/syncs/$SYNC_ID"
echo ""

OUT=$(curl -s "$BASE/syncs/$SYNC_ID")
assert_contains "retrieved sync" "$SYNC_ID" "$OUT"

echo ""

# ── 6. Update sync ──────────────────────────────────────────────

echo "6. Update sync (pause)"
echo "  \$ curl -s -X PATCH localhost:4010/syncs/$SYNC_ID -H 'Content-Type: application/json' -d '{\"status\":\"paused\"}'"
echo ""

OUT=$(curl -s -X PATCH "$BASE/syncs/$SYNC_ID" \
    -H "Content-Type: application/json" \
    -d '{"status":"paused"}')
assert_contains "status updated" '"status":"paused"' "$OUT"

echo ""

# ── 7. Delete sync ──────────────────────────────────────────────

echo "7. Delete sync"
echo "  \$ curl -s -X DELETE localhost:4010/syncs/$SYNC_ID"
echo ""

OUT=$(curl -s -X DELETE "$BASE/syncs/$SYNC_ID")
assert_contains "deleted" '"deleted":true' "$OUT"

OUT=$(curl -s "$BASE/syncs")
COUNT=$(echo "$OUT" | jq '.data | length')
assert_eq "0 syncs after delete" "0" "$COUNT"

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
