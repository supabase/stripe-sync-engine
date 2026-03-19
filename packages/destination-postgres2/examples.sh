#!/usr/bin/env bash
# destination-postgres2 examples
#
# Prerequisites:
#   pnpm install
#   docker compose up -d postgres   # starts postgres on :54320
#
# All commands run from the monorepo root.
#
# Setup:
#   alias dest-postgres='bun scripts/ts-cli.ts ./packages/destination-postgres2/src/index.ts'
#
# Then:
#   dest-postgres spec
#   dest-postgres check --config '{"connection_string":"postgresql://postgres:postgres@localhost:54320/postgres"}'
#   echo '{"type":"record",...}' | dest-postgres write --config '...' --catalog '...'

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

# Postgres config
PG_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54320/postgres}"
CONFIG="{\"connection_string\":\"$PG_URL\",\"schema\":\"public\"}"

CATALOG='{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# ── spec: JSON Schema for the connector's config ─────────────────
echo "=== dest-postgres spec ==="
$dest_postgres spec | jq .

# ── check: verify postgres connection works ──────────────────────
echo ""
echo "=== dest-postgres check ==="
$dest_postgres check --config "$CONFIG"

# ── write: pipe hard-coded NDJSON → dest-postgres ────────────────
echo ""
echo "=== dest-postgres write ==="
NOW=$(date +%s000)
printf '%s\n' \
  "{\"type\":\"record\",\"stream\":\"customers\",\"data\":{\"id\":\"cus_1\",\"name\":\"Alice\",\"email\":\"alice@example.com\"},\"emitted_at\":$NOW}" \
  "{\"type\":\"record\",\"stream\":\"customers\",\"data\":{\"id\":\"cus_2\",\"name\":\"Bob\",\"email\":\"bob@example.com\"},\"emitted_at\":$NOW}" \
  "{\"type\":\"state\",\"stream\":\"customers\",\"data\":{\"after\":\"cus_2\"}}" \
  "{\"type\":\"record\",\"stream\":\"products\",\"data\":{\"id\":\"prod_1\",\"name\":\"T-shirt\",\"price\":2500},\"emitted_at\":$NOW}" \
  "{\"type\":\"record\",\"stream\":\"products\",\"data\":{\"id\":\"prod_2\",\"name\":\"Hoodie\",\"price\":5500},\"emitted_at\":$NOW}" \
  "{\"type\":\"state\",\"stream\":\"products\",\"data\":{\"after\":\"prod_2\"}}" \
  "{\"type\":\"record\",\"stream\":\"customers\",\"data\":{\"id\":\"cus_1\",\"name\":\"Alice Smith\",\"email\":\"alice@example.com\"},\"emitted_at\":$NOW}" \
  "{\"type\":\"state\",\"stream\":\"customers\",\"data\":{\"after\":\"cus_1\",\"phase\":\"update\"}}" \
  | $dest_postgres write --config "$CONFIG" --catalog "$CATALOG"

# ── verify: query what landed ────────────────────────────────────
echo ""
echo "=== customers ==="
docker exec stripe-db psql -U postgres -d postgres \
  -c "SELECT _pk, data->>'name' AS name, data->>'email' AS email FROM customers ORDER BY _pk;"

echo "=== products ==="
docker exec stripe-db psql -U postgres -d postgres \
  -c "SELECT _pk, data->>'name' AS name, data->>'price' AS price FROM products ORDER BY _pk;"
