#!/usr/bin/env bash
# End-to-end test: Service (config resolution) → Engine (sync execution)
#
# Tests the same flow that Temporal activities execute:
#   1. Create sync via service API
#   2. GET /syncs/{id}?include_credentials=true → resolved config
#   3. POST /setup, /sync, /teardown on engine with X-Sync-Params
#   4. Verify data in Postgres, verify teardown
#
# Requires:
#   - STRIPE_API_KEY (or .env)
#   - Postgres on localhost:5432 (or POSTGRES_URL)
#   - pnpm build must have been run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present
[ -f .env ] && set -a && source .env && set +a

: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
SCHEMA="temporal_sh_$(date +%Y%m%d%H%M%S)_$$"

SERVICE_PORT=0
ENGINE_PORT=0
SERVICE_PID=""
ENGINE_PID=""

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null && echo "  Stopped service ($SERVICE_PID)"
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null && echo "  Stopped engine ($ENGINE_PID)"
  if [ "${KEEP_TEST_DATA:-}" != "1" ]; then
    psql "$POSTGRES_URL" -c "DROP SCHEMA IF EXISTS \"$SCHEMA\" CASCADE" 2>/dev/null && echo "  Dropped schema $SCHEMA"
  fi
  [ -n "${DATA_DIR:-}" ] && rm -rf "$DATA_DIR" && echo "  Removed $DATA_DIR"
}
trap cleanup EXIT

find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}

wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  for i in $(seq 1 "$timeout"); do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "  $label is up (port $port)"
      return 0
    fi
    sleep 1
  done
  echo "  FAIL: $label not reachable on port $port after ${timeout}s"
  exit 1
}

# --- Start engine (from its package dir so connector bins are findable) ---
ENGINE_PORT=$(find_free_port)
echo "Starting engine on port $ENGINE_PORT ..."
(cd "$ROOT/apps/engine" && PORT=$ENGINE_PORT node dist/api/index.js) &>/dev/null &
ENGINE_PID=$!
wait_for_port "$ENGINE_PORT" "Engine"

# --- Start service (no Temporal — just config CRUD) ---
SERVICE_PORT=$(find_free_port)
DATA_DIR=$(mktemp -d)
echo "Starting service on port $SERVICE_PORT (data: $DATA_DIR) ..."
node "$ROOT/apps/service/dist/bin/cli.js" serve \
  --port "$SERVICE_PORT" \
  --data-dir "$DATA_DIR" &>/dev/null &
SERVICE_PID=$!
wait_for_port "$SERVICE_PORT" "Service"

SERVICE_URL="http://localhost:$SERVICE_PORT"
ENGINE_URL="http://localhost:$ENGINE_PORT"

echo ""
echo "=== Service → Engine E2E Test ==="
echo "  Service:  $SERVICE_URL"
echo "  Engine:   $ENGINE_URL"
echo "  Postgres: $POSTGRES_URL"
echo "  Schema:   $SCHEMA"
echo ""

# --- Create sync ---
echo "--- 1. Create sync ---"
SYNC_RESP=$(curl -sf -X POST "$SERVICE_URL/syncs" \
  -H 'Content-Type: application/json' \
  -d "{
    \"source\": { \"type\": \"stripe\", \"api_key\": \"$STRIPE_API_KEY\", \"backfill_limit\": 5 },
    \"destination\": { \"type\": \"postgres\", \"connection_string\": \"$POSTGRES_URL\", \"schema\": \"$SCHEMA\" },
    \"streams\": [{ \"name\": \"products\" }]
  }")
SYNC_ID=$(echo "$SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Sync: $SYNC_ID"

# --- Resolve config ---
echo ""
echo "--- 2. Resolve config (include_credentials=true) ---"
RESOLVED=$(curl -sf "$SERVICE_URL/syncs/$SYNC_ID?include_credentials=true")
SRC_TYPE=$(echo "$RESOLVED" | python3 -c "import sys,json; print(json.load(sys.stdin)['source']['type'])")
HAS_KEY=$(echo "$RESOLVED" | python3 -c "import sys,json; print('api_key' in json.load(sys.stdin)['source'])")
echo "  source.type: $SRC_TYPE"
echo "  has api_key: $HAS_KEY"
[ "$HAS_KEY" = "True" ] || { echo "FAIL: expected api_key in resolved config"; exit 1; }

# Build X-Sync-Params (same as what activities do)
PARAMS=$(echo "$RESOLVED" | python3 -c "
import sys, json
c = json.load(sys.stdin)
src = {k:v for k,v in c['source'].items() if k != 'type'}
dst = {k:v for k,v in c['destination'].items() if k != 'type'}
print(json.dumps({
  'source_name': c['source']['type'],
  'source_config': src,
  'destination_name': c['destination']['type'],
  'destination_config': dst,
  'streams': c.get('streams', [])
}))
")
echo "  X-Sync-Params built ($(echo "$PARAMS" | wc -c | tr -d ' ') bytes)"

# --- Setup ---
echo ""
echo "--- 3. Engine: setup ---"
SETUP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$ENGINE_URL/setup" \
  -H "X-Sync-Params: $PARAMS")
echo "  HTTP $SETUP_STATUS"
[ "$SETUP_STATUS" = "204" ] || { echo "FAIL: expected 204, got $SETUP_STATUS"; exit 1; }

# --- Sync ---
echo ""
echo "--- 4. Engine: sync ---"
SYNC_OUTPUT=$(curl -sf -X POST "$ENGINE_URL/sync" -H "X-Sync-Params: $PARAMS")
LINE_COUNT=$(echo "$SYNC_OUTPUT" | wc -l | tr -d ' ')
echo "  NDJSON lines: $LINE_COUNT"

ERROR_COUNT=$(echo "$SYNC_OUTPUT" | python3 -c "
import sys, json
errors = 0
for line in sys.stdin:
  line = line.strip()
  if not line: continue
  msg = json.loads(line)
  if msg.get('type') == 'error':
    errors += 1
    print(f'  ERROR: {msg.get(\"message\", \"unknown\")}', file=sys.stderr)
print(errors)
")
echo "  Errors: $ERROR_COUNT"

# --- Verify Postgres ---
echo ""
echo "--- 5. Verify Postgres ---"
ROW_COUNT=$(psql "$POSTGRES_URL" -t -c "SELECT count(*) FROM \"$SCHEMA\".\"products\"" | tr -d ' ')
echo "  products: $ROW_COUNT rows"
[ "$ROW_COUNT" -gt 0 ] || { echo "FAIL: expected > 0 rows"; exit 1; }

SAMPLE=$(psql "$POSTGRES_URL" -t -c "SELECT id FROM \"$SCHEMA\".\"products\" LIMIT 1" | tr -d ' ')
echo "  sample: $SAMPLE"
[[ "$SAMPLE" == prod_* ]] || { echo "FAIL: expected prod_ prefix, got $SAMPLE"; exit 1; }

# --- Teardown ---
echo ""
echo "--- 6. Engine: teardown ---"
TEARDOWN_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$ENGINE_URL/teardown" \
  -H "X-Sync-Params: $PARAMS")
echo "  HTTP $TEARDOWN_STATUS"
[ "$TEARDOWN_STATUS" = "204" ] || { echo "FAIL: expected 204, got $TEARDOWN_STATUS"; exit 1; }

TABLE_COUNT=$(psql "$POSTGRES_URL" -t -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$SCHEMA'" | tr -d ' ')
echo "  Tables remaining: $TABLE_COUNT"
[ "$TABLE_COUNT" -eq 0 ] || { echo "FAIL: expected 0 tables after teardown"; exit 1; }

echo ""
echo "=== All checks passed ==="
