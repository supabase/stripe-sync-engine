#!/usr/bin/env bash
# Step 2: dest only — reads NDJSON from stdin, writes to Postgres
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; source "$(dirname "$0")/_common.sh"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
SCHEMA="demo_$(date +%s)"

CATALOG='{"streams":[{"stream":{"name":"products"},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
DST_CONFIG='{"connection_string":"'"$POSTGRES_URL"'","schema":"'"$SCHEMA"'"}'

dest-postgres setup --config "$DST_CONFIG" --catalog "$CATALOG"
echo '{"type":"record","stream":"products","data":{"id":"prod_1","name":"Widget"},"emitted_at":"2024-01-01T00:00:00.000Z"}' \
  | dest-postgres write --config "$DST_CONFIG" --catalog "$CATALOG"

psql "$POSTGRES_URL" -c "SELECT id, _raw_data->>'name' AS name FROM \"$SCHEMA\".products"
