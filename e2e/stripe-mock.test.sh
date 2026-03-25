#!/usr/bin/env bash
set -euo pipefail

MOCK_URL="${STRIPE_MOCK_URL:-http://localhost:12111}"
API_KEY="sk_test_fake123"

echo "Waiting for stripe-mock at $MOCK_URL ..."
for i in $(seq 1 30); do
  if curl -sf -H "Authorization: Bearer $API_KEY" "$MOCK_URL/v1/customers" >/dev/null 2>&1; then
    echo "stripe-mock is up"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: stripe-mock not reachable after 30s"
    exit 1
  fi
  sleep 1
done

echo ""
echo "--- GET /v1/customers ---"
resp=$(curl -sf -w "\n%{http_code}" \
  -H "Authorization: Bearer $API_KEY" \
  "$MOCK_URL/v1/customers")
code=$(echo "$resp" | tail -1)
body=$(echo "$resp" | sed '$d')
echo "HTTP $code"
echo "$body" | head -5
[ "$code" = "200" ] || { echo "FAIL: expected 200, got $code"; exit 1; }

echo ""
echo "--- POST /v1/customers ---"
resp=$(curl -sf -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -d "email=test@example.com" \
  "$MOCK_URL/v1/customers")
code=$(echo "$resp" | tail -1)
body=$(echo "$resp" | sed '$d')
echo "HTTP $code"
echo "$body" | head -5
[ "$code" = "200" ] || { echo "FAIL: expected 200, got $code"; exit 1; }

echo ""
echo "--- GET /v1/events ---"
resp=$(curl -sf -w "\n%{http_code}" \
  -H "Authorization: Bearer $API_KEY" \
  "$MOCK_URL/v1/events")
code=$(echo "$resp" | tail -1)
echo "HTTP $code"
[ "$code" = "200" ] || { echo "FAIL: expected 200, got $code"; exit 1; }

echo ""
echo "All checks passed. stripe-mock is working."
