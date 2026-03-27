#!/usr/bin/env bash
# Step 5: engine — createEngine() composes the full pipeline automatically
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; source "$(dirname "$0")/_common.sh"
: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
SCHEMA="demo_$(date +%s)"
PORT=3099
trap "kill \$ENGINE_PID 2>/dev/null || true" EXIT

kill $(lsof -ti:$PORT 2>/dev/null) 2>/dev/null || true
(cd "$ROOT/apps/engine" && PORT=$PORT node dist/api/index.js) &>/dev/null & ENGINE_PID=$!
until nc -z 127.0.0.1 $PORT 2>/dev/null; do sleep 0.3; done

PARAMS='{"source":{"name":"stripe","api_key":"'"$STRIPE_API_KEY"'","backfill_limit":5},"destination":{"name":"postgres","connection_string":"'"$POSTGRES_URL"'","schema":"'"$SCHEMA"'"},"streams":[{"name":"products","fields":["id","name"]}]}'

curl -sf -X POST "http://localhost:$PORT/sync" -H "X-Sync-Params: $PARAMS" | jq .

psql "$POSTGRES_URL" -c "SELECT id, _raw_data->>'name' AS name FROM \"$SCHEMA\".products LIMIT 5"
