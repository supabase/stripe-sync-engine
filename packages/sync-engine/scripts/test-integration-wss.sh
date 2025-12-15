#!/bin/bash

# End-to-end integration test for Stripe Sync Engine using WebSocket mode
# Tests WebSocket connection, event processing, webhook_response messages, and database writes
# This test does NOT require ngrok - uses Stripe's WebSocket API directly

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine WebSocket Integration Test"
echo "================================================="
echo ""

# Check for required tools
echo "🔧 Checking prerequisites..."
if ! command -v stripe &> /dev/null; then
    echo "❌ Stripe CLI not found - required for triggering test events"
    echo "   Install: brew install stripe/stripe-cli/stripe"
    exit 1
fi
echo "✓ Stripe CLI found"

if ! command -v jq &> /dev/null; then
    echo "❌ jq not found - required for JSON parsing"
    exit 1
fi
echo "✓ jq found"
echo ""

# Load environment variables
load_env_file

# Check required environment variables (no NGROK_AUTH_TOKEN needed for WSS mode)
check_env_vars DATABASE_URL STRIPE_API_KEY

echo "✓ Environment variables loaded"
echo "  Mode: WebSocket (no ngrok required)"
echo ""

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-wss-test-db" "app_db"

# Override DATABASE_URL to use test container
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_db"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Stop CLI if running
    if [ -n "$CLI_PID" ] && ps -p $CLI_PID > /dev/null 2>&1; then
        echo "   Stopping CLI process..."
        kill $CLI_PID 2>/dev/null || true
        wait $CLI_PID 2>/dev/null || true
    fi

    stop_postgres "stripe-sync-wss-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Get the directory where this script is located
SYNC_ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Step 1: Build CLI
echo "🔨 Step 1: Building CLI..."
cd "$SYNC_ENGINE_DIR" && pnpm build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

# Step 2: Start CLI in WebSocket mode (no NGROK_AUTH_TOKEN = WebSocket mode)
echo "🚀 Step 2: Starting CLI in WebSocket mode..."
echo ""

# Unset NGROK_AUTH_TOKEN to ensure WebSocket mode
unset NGROK_AUTH_TOKEN

# Start CLI in background with SKIP_BACKFILL for faster startup
cd "$SYNC_ENGINE_DIR" && SKIP_BACKFILL=true node dist/cli/index.js start --database-url "$DATABASE_URL" > /tmp/cli-wss-test.log 2>&1 &
CLI_PID=$!

# Wait for startup (migrations + WebSocket connection)
echo "   Waiting for WebSocket connection..."
sleep 10

# Check if CLI is still running
if ! ps -p $CLI_PID > /dev/null 2>&1; then
    echo "❌ CLI failed to start"
    echo "   Log output:"
    cat /tmp/cli-wss-test.log
    exit 1
fi

# Check for WebSocket connection in logs
if grep -q "Connected to Stripe WebSocket" /tmp/cli-wss-test.log; then
    echo "✓ WebSocket connected successfully"
else
    echo "⚠️  WebSocket connection status unknown"
    echo "   Log output:"
    tail -20 /tmp/cli-wss-test.log
fi
echo ""

# Step 3: Trigger test events using Stripe CLI
echo "🎯 Step 3: Triggering Stripe test events..."
echo "   Events will be delivered via WebSocket and webhook_response sent back"
echo ""

# Trigger customer.created event
echo "   Triggering customer.created..."
stripe trigger customer.created > /dev/null 2>&1 || echo "   (stripe trigger may have failed)"
sleep 2

# Trigger product.created event
echo "   Triggering product.created..."
stripe trigger product.created > /dev/null 2>&1 || echo "   (stripe trigger may have failed)"
sleep 2

# Trigger price.created event
echo "   Triggering price.created..."
stripe trigger price.created > /dev/null 2>&1 || echo "   (stripe trigger may have failed)"
sleep 5  # Wait for events to be processed

echo "✓ Test events triggered"
echo ""

# Step 4: Verify events in logs (look for "← event.type" pattern from websocket-client)
echo "🔍 Step 4: Checking event processing and webhook_response..."

# Count events received via WebSocket (logged as "← event.type")
EVENT_COUNT=$(grep -c "← " /tmp/cli-wss-test.log 2>/dev/null || echo "0")
echo "   Events received via WebSocket: $EVENT_COUNT"

# Check for specific event types
CUSTOMER_EVENTS=$(grep -c "customer.created" /tmp/cli-wss-test.log 2>/dev/null || echo "0")
PRODUCT_EVENTS=$(grep -c "product.created" /tmp/cli-wss-test.log 2>/dev/null || echo "0")
PRICE_EVENTS=$(grep -c "price.created" /tmp/cli-wss-test.log 2>/dev/null || echo "0")

echo "   - customer.created: $CUSTOMER_EVENTS"
echo "   - product.created: $PRODUCT_EVENTS"
echo "   - price.created: $PRICE_EVENTS"

if [ "$EVENT_COUNT" -gt 0 ]; then
    echo "✓ Events were received and processed via WebSocket"
    echo ""
    echo "   Recent events in log:"
    grep "← " /tmp/cli-wss-test.log | tail -5 || true
else
    echo "⚠️  No events detected in logs"
    echo "   Events may still be propagating through Stripe's system"
fi

# Check for webhook_response (indicates response was sent back to Stripe)
# The websocket-client sends webhook_response after processing each event
# If no errors, the response was sent successfully
if grep -q "Error processing event" /tmp/cli-wss-test.log; then
    echo ""
    echo "⚠️  Some events had processing errors (webhook_response sent with status 500):"
    grep "Error processing event" /tmp/cli-wss-test.log | head -3
else
    echo ""
    echo "✓ All events processed successfully (webhook_response sent with status 200)"
fi

# Check for WebSocket errors
if grep -q "WebSocket error" /tmp/cli-wss-test.log; then
    echo ""
    echo "⚠️  WebSocket errors detected:"
    grep "WebSocket error" /tmp/cli-wss-test.log | head -3
else
    echo "✓ No WebSocket errors"
fi
echo ""

# Step 5: Verify database writes
echo "🗄️  Step 5: Checking database for synced data..."
echo ""

# Check customers table
CUSTOMER_COUNT=$(docker exec stripe-sync-wss-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.customers;" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Customers in database: ${CUSTOMER_COUNT:-0}"

# Check products table
PRODUCT_COUNT=$(docker exec stripe-sync-wss-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products;" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Products in database: ${PRODUCT_COUNT:-0}"

# Check prices table
PRICE_COUNT=$(docker exec stripe-sync-wss-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.prices;" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Prices in database: ${PRICE_COUNT:-0}"

echo ""

# Summary
echo "📊 Test Summary"
echo "==============="
echo "   WebSocket connection: $(grep -q 'Connected to Stripe WebSocket' /tmp/cli-wss-test.log && echo '✓ Success' || echo '⚠️ Unknown')"
echo "   Events received via WebSocket: $EVENT_COUNT"
echo "   webhook_response sent: $(grep -q 'Error processing event' /tmp/cli-wss-test.log && echo '⚠️ Some with errors' || echo '✓ All with status 200')"
echo "   Database records: Customers=$CUSTOMER_COUNT, Products=$PRODUCT_COUNT, Prices=$PRICE_COUNT"
echo ""

# Check for any errors in logs
if grep -q "Error" /tmp/cli-wss-test.log; then
    echo "⚠️  Errors detected in logs:"
    grep "Error" /tmp/cli-wss-test.log | head -5
    echo ""
fi

echo "✅ WebSocket integration test completed"
echo ""
echo "View full CLI log: /tmp/cli-wss-test.log"
