#!/usr/bin/env bash
# Step 4: source | filter | dest — jq as a filter stage; protocol is just NDJSON
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; source "$(dirname "$0")/_common.sh"
: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
SCHEMA="demo_$(date +%s)"

CATALOG='{"streams":[{"stream":{"name":"products"},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
SRC_CONFIG='{"api_key":"'"$STRIPE_API_KEY"'","backfill_limit":5}'
DST_CONFIG='{"connection_string":"'"$POSTGRES_URL"'","schema":"'"$SCHEMA"'"}'

dest-postgres setup --config "$DST_CONFIG" --catalog "$CATALOG"
source-stripe read --config "$SRC_CONFIG" --catalog "$CATALOG" \
  | jq -c 'if .type == "record" then .data |= {id, name} else . end' \
  | dest-postgres write --config "$DST_CONFIG" --catalog "$CATALOG"

psql "$POSTGRES_URL" -c "SELECT id, _raw_data->>'name' AS name FROM \"$SCHEMA\".products LIMIT 5"
