#!/usr/bin/env bash
# destination-postgres2 examples
#
# Prerequisites:
#   pnpm install
#   docker compose up -d postgres   # starts postgres on :54320
#
# All commands run from the monorepo root.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Use bun if available, fall back to npx tsx
if command -v bun &>/dev/null; then
  TS="bun"
else
  TS="npx tsx"
fi

dest_postgres="$TS $ROOT/scripts/ts-cli.ts $ROOT/packages/destination-postgres2/src/index.ts"

# Postgres config
PG_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54320/postgres}"
CONFIG="{\"connection_string\":\"$PG_URL\",\"schema\":\"public\"}"

CATALOG='{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# ─────────────────────────────────────────────────────────────────
echo "To use interactively, add this alias:"
echo ""
echo "  alias dest-postgres='$TS scripts/ts-cli.ts ./packages/destination-postgres2/src/index.ts'"
echo ""

# ── spec ─────────────────────────────────────────────────────────
echo "$ dest-postgres spec"
$dest_postgres spec | jq .
echo ""

# ── check ────────────────────────────────────────────────────────
echo "$ dest-postgres check --config '$CONFIG'"
$dest_postgres check --config "$CONFIG" | jq .
echo ""

# ── write ────────────────────────────────────────────────────────
NOW=$(date +%s000)
NDJSON_BODY=$(cat <<EOF
{"type":"record","stream":"customers","data":{"id":"cus_1","name":"Alice","email":"alice@example.com"},"emitted_at":$NOW}
{"type":"record","stream":"customers","data":{"id":"cus_2","name":"Bob","email":"bob@example.com"},"emitted_at":$NOW}
{"type":"state","stream":"customers","data":{"after":"cus_2"}}
{"type":"record","stream":"products","data":{"id":"prod_1","name":"T-shirt","price":2500},"emitted_at":$NOW}
{"type":"record","stream":"products","data":{"id":"prod_2","name":"Hoodie","price":5500},"emitted_at":$NOW}
{"type":"state","stream":"products","data":{"after":"prod_2"}}
{"type":"record","stream":"customers","data":{"id":"cus_1","name":"Alice Smith","email":"alice@example.com"},"emitted_at":$NOW}
{"type":"state","stream":"customers","data":{"after":"cus_1","phase":"update"}}
EOF
)
cat <<COMMAND
$ cat <<NDJSON | dest-postgres write \\
    --config '$CONFIG' \\
    --catalog '$CATALOG'
$NDJSON_BODY
NDJSON
COMMAND
echo ""
echo "$NDJSON_BODY" | $dest_postgres write --config "$CONFIG" --catalog "$CATALOG" | jq -c '{type, stream}'
echo ""

# ── verify ───────────────────────────────────────────────────────
echo "$ psql: SELECT from customers (cus_1 upserted: Alice → Alice Smith)"
docker exec stripe-db psql -U postgres -d postgres --quiet --tuples-only --no-align --field-separator=' | ' \
  -c "SELECT _pk, data->>'name', data->>'email' FROM customers ORDER BY _pk;"
echo ""

echo "$ psql: SELECT from products"
docker exec stripe-db psql -U postgres -d postgres --quiet --tuples-only --no-align --field-separator=' | ' \
  -c "SELECT _pk, data->>'name', data->>'price' FROM products ORDER BY _pk;"
