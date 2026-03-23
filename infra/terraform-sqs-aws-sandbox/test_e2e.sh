#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

WEBHOOK_URL=$(terraform output -raw webhook_receiver_url)
SYNC_ENGINE_URL=$(terraform output -raw sync_engine_url)
TEST_ID="test_$(date +%s)"

echo "=== Pipeline streaming test (test_id=$TEST_ID) ==="
echo "=== Sending webhook to $WEBHOOK_URL ==="

curl -sS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$TEST_ID\",\"type\":\"invoice.paid\",\"data\":{\"amount\":4200}}" \
  --max-time 180 > /tmp/webhook_response_$$ 2>&1 &
CURL_PID=$!

echo ""
echo "=== Event log (printing as events arrive) ==="
echo ""

EXPECTED=16
SEEN=0
POLL_START=$(date +%s)
TIMEOUT=120
TMPFILE="/tmp/events_$$"

while [ "$SEEN" -lt "$EXPECTED" ]; do
  ELAPSED=$(( $(date +%s) - POLL_START ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo ""
    echo "FAIL: Timed out after ${TIMEOUT}s — only $SEEN/$EXPECTED stages"
    kill "$CURL_PID" 2>/dev/null || true
    rm -f "$TMPFILE"
    exit 1
  fi

  # Single query — contains matches both "test_xxx" and "evt_test_xxx_0"
  curl -sS "${SYNC_ENGINE_URL}/events?contains=${TEST_ID}" > "$TMPFILE" 2>/dev/null || echo "[]" > "$TMPFILE"

  python3 -c "
import json
rows = json.load(open('${TMPFILE}'))
if not isinstance(rows, list): rows = []
if not rows:
    open('${TMPFILE}_count', 'w').write('0')
    exit()
base = rows[0]['logged_at']
from datetime import datetime
b = datetime.fromisoformat(base.replace('Z', '+00:00'))
for r in rows[${SEEN}:]:
    t = datetime.fromisoformat(r['logged_at'].replace('Z', '+00:00'))
    d = (t - b).total_seconds()
    print(f'  +{d:>7.2f}s  {r[\"event_id\"]:>25}  {r[\"stage\"]}')
open('${TMPFILE}_count', 'w').write(str(len(rows)))
" 2>/dev/null || true

  NEW_COUNT=$(cat "${TMPFILE}_count" 2>/dev/null || echo "$SEEN")
  if [ "$NEW_COUNT" -gt "$SEEN" ]; then
    SEEN=$NEW_COUNT
  fi

  rm -f "${TMPFILE}_count"
  [ "$SEEN" -lt "$EXPECTED" ] && sleep 2
done

wait "$CURL_PID" || true
rm -f /tmp/webhook_response_$$ "$TMPFILE"

echo ""
echo "=== $SEEN/$EXPECTED stages logged — pipeline is streaming end-to-end ==="
echo "=== ALL TESTS PASSED ==="
