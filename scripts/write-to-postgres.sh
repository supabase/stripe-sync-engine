#!/usr/bin/env bash
# Pipe NDJSON records into Postgres via the connector CLI.
#
# Env: DATABASE_URL
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Postgres: $DATABASE_URL" >&2

DEST="node packages/destination-postgres/dist/bin.js"
CONFIG="{\"connection_string\": \"$DATABASE_URL\", \"schema\": \"public\"}"
CATALOG='{"streams":[{"stream":{"name":"demo","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# Setup (creates the table if needed)
$DEST setup --config "$CONFIG" --catalog "$CATALOG"

# Write
printf '%s\n' \
  '{"type":"record","stream":"demo","data":{"id":"1","name":"Alice","email":"alice@example.com"},"emitted_at":0}' \
  '{"type":"record","stream":"demo","data":{"id":"2","name":"Bob","email":"bob@example.com"},"emitted_at":0}' \
| $DEST write --config "$CONFIG" --catalog "$CATALOG"
