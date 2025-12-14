#!/bin/bash

# Quick test script to send an unsupported webhook event and verify 2xx response

set -e

echo "🧪 Testing Unsupported Event Handling"
echo "======================================"
echo ""

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Load environment
load_env_file
check_env_vars DATABASE_URL STRIPE_API_KEY NGROK_AUTH_TOKEN

# Start PostgreSQL
start_postgres "stripe-sync-test-unsupported" "app_db"

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    if [ ! -z "$CLI_PID" ]; then
        kill -TERM $CLI_PID 2>/dev/null || true
        wait $CLI_PID 2>/dev/null || true
    fi
    stop_postgres "stripe-sync-test-unsupported"
    echo "✓ Cleanup complete"
}

trap cleanup EXIT

# Build and migrate
echo "🔨 Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built"

echo "🗄️  Running migrations..."
node dist/cli/index.js migrate > /dev/null 2>&1
echo "✓ Migrations complete"

# Start CLI
echo "🚀 Starting CLI..."
node dist/cli/index.js start > /tmp/unsupported-test.log 2>&1 &
CLI_PID=$!

sleep 10

if ! ps -p $CLI_PID > /dev/null 2>&1; then
    echo "❌ CLI failed to start"
    cat /tmp/unsupported-test.log
    exit 1
fi

echo "✓ CLI started"

# Get webhook URL from database
WEBHOOK_URL=$(docker exec stripe-sync-test-unsupported psql -U postgres -d app_db -t -c "SELECT url FROM stripe._managed_webhooks LIMIT 1;" 2>/dev/null | tr -d ' ')

if [ -z "$WEBHOOK_URL" ]; then
    echo "❌ No webhook URL found"
    exit 1
fi

echo "📡 Webhook URL: $WEBHOOK_URL"
echo ""

# Create unsupported event payload
TIMESTAMP=$(date +%s)
EVENT_PAYLOAD=$(cat <<EOF
{
  "id": "evt_test_unsupported_$(date +%s)",
  "object": "event",
  "api_version": "2020-08-27",
  "created": $TIMESTAMP,
  "type": "balance.available",
  "data": {
    "object": {
      "object": "balance",
      "available": [
        {
          "amount": 1000,
          "currency": "usd"
        }
      ],
      "livemode": false
    }
  }
}
EOF
)

# Get webhook secret
WEBHOOK_SECRET=$(docker exec stripe-sync-test-unsupported psql -U postgres -d app_db -t -c "SELECT secret FROM stripe._managed_webhooks LIMIT 1;" 2>/dev/null | tr -d ' ')

# Create signature
SIGNATURE_PAYLOAD="${TIMESTAMP}.${EVENT_PAYLOAD}"
SIGNATURE=$(echo -n "$SIGNATURE_PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

echo "🎯 Sending unsupported event: balance.available"

# Send webhook
HTTP_STATUS=$(curl -s -o /tmp/webhook-response.txt -w "%{http_code}" \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "Stripe-Signature: t=${TIMESTAMP},v1=${SIGNATURE}" \
    -d "$EVENT_PAYLOAD")

echo "📥 Response HTTP Status: $HTTP_STATUS"
echo "📄 Response Body:"
cat /tmp/webhook-response.txt
echo ""
echo ""

# Verify results
if [ "$HTTP_STATUS" = "200" ]; then
    echo "✅ SUCCESS: Webhook returned 200 for unsupported event"
elif [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
    echo "✅ SUCCESS: Webhook returned ${HTTP_STATUS} (2xx) for unsupported event"
else
    echo "❌ FAIL: Webhook returned ${HTTP_STATUS} (expected 2xx)"
    exit 1
fi

# Check if CLI is still running
if ps -p $CLI_PID > /dev/null 2>&1; then
    echo "✅ SUCCESS: CLI still running (no crash)"
else
    echo "❌ FAIL: CLI crashed"
    exit 1
fi

# Check logs for warning
echo ""
echo "📋 Checking logs for warning message..."
if grep -qi "unhandled\|balance\.available" /tmp/unsupported-test.log; then
    echo "✅ SUCCESS: Warning message found in logs"
    grep -i "unhandled\|balance\.available" /tmp/unsupported-test.log | head -3
else
    echo "⚠️  Warning: Could not find expected warning in logs"
    echo "Last 20 lines of log:"
    tail -20 /tmp/unsupported-test.log
fi

echo ""
echo "=========================================="
echo "✅ Unsupported Event Test Passed!"
echo ""
echo "Summary:"
echo "- ✓ Sent unsupported event (balance.available)"
echo "- ✓ Webhook returned ${HTTP_STATUS} (2xx success)"
echo "- ✓ CLI did not crash"
echo ""
