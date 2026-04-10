#!/usr/bin/env bash
# Write NDJSON records to Postgres via the connector CLI.
# Reads from stdin, or uses sample data if stdin is a terminal.
#
# Usage:
#   ./scripts/write-to-postgres.sh                                    # sample data
#   ./scripts/read-from-stripe.sh | ./scripts/write-to-postgres.sh    # piped
#
# Env: DATABASE_URL
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-node --import tsx}"

echo "Postgres: $DATABASE_URL" >&2

DEST="$RUN packages/destination-postgres/src/bin.ts"
CONFIG="{\"connection_string\": \"$DATABASE_URL\", \"schema\": \"public\"}"

if [ -t 0 ]; then
  # No pipe — use sample data
  CATALOG='{"streams":[{"stream":{"name":"demo","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
  $DEST setup --config "$CONFIG" --catalog "$CATALOG"
  printf '%s\n' \
    '{"type":"record","stream":"demo","data":{"id":"1","name":"Alice","email":"alice@example.com"},"emitted_at":"2024-01-01T00:00:00.000Z"}' \
    '{"type":"record","stream":"demo","data":{"id":"2","name":"Bob","email":"bob@example.com"},"emitted_at":"2024-01-01T00:00:00.000Z"}' \
  | $DEST write --config "$CONFIG" --catalog "$CATALOG"
else
  # Piped — buffer stdin, extract stream names, setup, then write
  DATA=$(cat)
  STREAMS=$(echo "$DATA" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const names=[...new Set(d.split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(m=>m.type==='record').map(m=>m.stream))];
      const catalog={streams:names.map(n=>({stream:{name:n,primary_key:[['id']]},sync_mode:'full_refresh',destination_sync_mode:'append'}))};
      console.log(JSON.stringify(catalog));
    })")
  echo "Streams: $(echo "$STREAMS" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).streams.map(s=>s.stream.name).join(', ')))")" >&2
  $DEST setup --config "$CONFIG" --catalog "$STREAMS"
  echo "$DATA" | $DEST write --config "$CONFIG" --catalog "$STREAMS"
fi
