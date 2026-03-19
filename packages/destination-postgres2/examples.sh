#!/usr/bin/env bash
# destination-postgres2 examples
#
# Prerequisites:
#   pnpm install
#   docker compose up -d          # starts postgres on :54320 + stripe-mock on :12111
#
# All commands run from the monorepo root.
#
# Setup:
#   alias dest-postgres='bun scripts/ts-cli.ts ./packages/destination-postgres2/src/index.ts'
#   alias source-stripe='bun scripts/ts-cli.ts ./packages/source-stripe2/src/index.ts'
#
# Then:
#   dest-postgres spec
#   dest-postgres check --config '{"connection_string":"postgresql://postgres:postgres@localhost:54320/postgres"}'
#   source-stripe read --config '...' --catalog '...' \
#     | dest-postgres write --config '{"connection_string":"..."}' --catalog '{"streams":[...]}'

set -euo pipefail
set -x
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Use bun if available, fall back to npx tsx
if command -v bun &>/dev/null; then
  TS="bun"
else
  TS="npx tsx"
fi

dest_postgres="$TS $ROOT/scripts/ts-cli.ts $ROOT/packages/destination-postgres2/src/index.ts"
source_stripe="$TS $ROOT/scripts/ts-cli.ts $ROOT/packages/source-stripe2/src/index.ts"

# Postgres config
PG_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54320/postgres}"
DEST_CONFIG="{\"connection_string\":\"$PG_URL\",\"schema\":\"public\"}"

# Stripe-mock config
API_KEY="${STRIPE_MOCK_KEY:-sk_test_fake}"
BASE_URL="${STRIPE_BASE_URL:-http://localhost:12111}"
SRC_CONFIG="{\"api_key\":\"$API_KEY\",\"base_url\":\"$BASE_URL\"}"

# Catalog — must match what the source discovers
CATALOG='{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# ── spec: JSON Schema for the connector's config ─────────────────
echo "=== dest-postgres spec ==="
$dest_postgres spec | jq .

# ── check: verify postgres connection works ──────────────────────
echo ""
echo "=== dest-postgres check ==="
$dest_postgres check --config "$DEST_CONFIG"

# ── write: pipe source-stripe → dest-postgres ────────────────────
echo ""
echo "=== source-stripe read | dest-postgres write ==="
$source_stripe read --config "$SRC_CONFIG" --catalog "$CATALOG" \
  | $dest_postgres write --config "$DEST_CONFIG" --catalog "$CATALOG"

# ── verify: query what landed ────────────────────────────────────
echo ""
echo "=== customers ==="
docker exec stripe-db psql -U postgres -d postgres \
  -c "SELECT _pk, data->>'name' AS name FROM customers ORDER BY _pk;"

echo "=== products ==="
docker exec stripe-db psql -U postgres -d postgres \
  -c "SELECT _pk, data->>'name' AS name FROM products ORDER BY _pk;"
