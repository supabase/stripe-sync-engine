#!/usr/bin/env bash
# Write NDJSON records to Postgres via the connector CLI.
# Reads from stdin, or uses sample data if stdin is a terminal.
#
# Usage:
#   ./scripts/write-to-postgres.sh                              # sample data
#   ./scripts/read-from-stripe.sh | ./scripts/write-to-postgres.sh  # piped
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

if [ -t 0 ]; then
  # No pipe — use sample data
  printf '%s\n' \
    '{"type":"record","stream":"demo","data":{"id":"1","name":"Alice","email":"alice@example.com"},"emitted_at":0}' \
    '{"type":"record","stream":"demo","data":{"id":"2","name":"Bob","email":"bob@example.com"},"emitted_at":0}' \
  | $DEST write --config "$CONFIG" --catalog "$CATALOG"
else
  # Piped — read from stdin
  $DEST write --config "$CONFIG" --catalog "$CATALOG"
fi
