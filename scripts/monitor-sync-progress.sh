#!/usr/bin/env bash
set -euo pipefail

# Monitor Stripe database sync progress by polling status and row counts.
# Required env: DB_STRING, DB_ID

: "${DB_STRING:?DB_STRING is required}"
: "${DB_ID:?DB_ID is required}"

STRIPE_FLAGS="--api-base ${STRIPE_API_BASE:?STRIPE_API_BASE is required}"

POLL_INTERVAL=15
MAX_POLLS=240
PREV_TOTAL=0
PREV_TIME=$(date +%s)
START_TIME=$PREV_TIME

for i in $(seq 1 $MAX_POLLS); do
  STATUS=$(stripe databases retrieve "$DB_ID" $STRIPE_FLAGS 2>&1 | grep -oE 'backfilling|ready|error|failed' | head -1)

  SUM_EXPR=$(psql "$DB_STRING" -t -A -c "
    SELECT COALESCE(
      string_agg('(SELECT count(*) FROM public.' || quote_ident(table_name) || ')', ' + '),
      '0'
    ) FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  " 2>/dev/null || echo "0")
  TOTAL=$(psql "$DB_STRING" -t -A -c "SELECT $SUM_EXPR" 2>/dev/null || echo "0")

  NOW=$(date +%s)
  ELAPSED=$((NOW - PREV_TIME))
  if [ "$ELAPSED" -gt 0 ] && [ "$PREV_TOTAL" -gt 0 ]; then
    DELTA=$((TOTAL - PREV_TOTAL))
    RPS=$((DELTA / ELAPSED))
    echo "[poll $i] status=$STATUS  total_rows=$TOTAL  delta=$DELTA  rows_per_sec=$RPS"
  else
    echo "[poll $i] status=$STATUS  total_rows=$TOTAL  (baseline)"
  fi

  if [ "$STATUS" = "ready" ]; then
    TOTAL_ELAPSED=$(( NOW - START_TIME ))
    echo ""
    echo "Sync complete in ${TOTAL_ELAPSED}s"
    break
  fi
  # TODO: Once selective sync is available in the CLI/API, error should be a hard failure.
  # For now databases without selective sync may error on unsupported resources.
  if [ "$STATUS" = "error" ] || [ "$STATUS" = "failed" ]; then
    TOTAL_ELAPSED=$(( NOW - START_TIME ))
    echo ""
    echo "::warning::Database entered $STATUS state after ${TOTAL_ELAPSED}s (accepted until selective sync is available)"
    break
  fi

  PREV_TOTAL=$TOTAL
  PREV_TIME=$NOW
  sleep $POLL_INTERVAL
done

if [ "$STATUS" != "ready" ] && [ "$STATUS" != "error" ] && [ "$STATUS" != "failed" ]; then
  echo "::error::Timed out waiting for sync to complete"
  exit 1
fi

echo ""
echo "=== Final table breakdown ==="
psql "$DB_STRING" -c "
  SELECT relname AS table_name, n_live_tup AS row_count
  FROM pg_stat_user_tables
  WHERE schemaname = 'public'
  ORDER BY n_live_tup DESC;
"
