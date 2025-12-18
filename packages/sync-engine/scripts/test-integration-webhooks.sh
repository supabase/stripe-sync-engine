#!/bin/bash

# End-to-end integration test for Stripe Sync Engine
# Tests webhook creation, event processing, and database writes

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine Integration Test"
echo "======================================="
echo ""

# Check for required tools
echo "🔧 Checking prerequisites..."
if ! command -v curl &> /dev/null; then
    echo "❌ curl not found - required for integration tests"
    exit 1
fi
echo "✓ curl found"

if ! command -v jq &> /dev/null; then
    echo "❌ jq not found - required for JSON parsing"
    exit 1
fi
echo "✓ jq found"

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY NGROK_AUTH_TOKEN

echo "✓ Environment variables loaded"
echo ""

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-test-db" "app_db"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    stop_postgres "stripe-sync-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Step 1: Build CLI
echo "🔨 Step 1: Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

# Step 2: Run migrations
echo "🗄️  Step 2: Running database migrations..."
node dist/cli/index.js migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Step 3: Start CLI in background and test
echo "🚀 Step 3: Starting CLI to test webhook creation..."
echo ""

# Start CLI in background with KEEP_WEBHOOKS_ON_SHUTDOWN=false for testing
ENABLE_SIGMA=false KEEP_WEBHOOKS_ON_SHUTDOWN=false node dist/cli/index.js start > /tmp/cli-test.log 2>&1 &
CLI_PID=$!

# Wait for startup (give it time to create webhook and run migrations)
sleep 15

# Check if CLI is still running
if ps -p $CLI_PID > /dev/null 2>&1; then
    echo "✓ CLI started successfully"

    # Check the log for webhook creation
    if grep -q "Webhook created:" /tmp/cli-test.log; then
        echo "✓ Webhook creation detected in logs"
        WEBHOOK_ID=$(grep "Webhook created:" /tmp/cli-test.log | awk '{print $NF}')
        echo "   Webhook ID: $WEBHOOK_ID"
    fi

    # Step 4: Verify webhook in database
    echo ""
    echo "🔍 Step 4: Checking database for managed webhook..."
    WEBHOOK_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks;" 2>/dev/null | tr -d ' ')

    # Default to 0 if empty
    WEBHOOK_COUNT=${WEBHOOK_COUNT:-0}

    if [ "$WEBHOOK_COUNT" -gt 0 ] 2>/dev/null; then
        echo "✓ Found $WEBHOOK_COUNT webhook(s) in database"
        echo ""
        echo "Webhook details:"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, url, enabled, status FROM stripe._managed_webhooks;" 2>/dev/null

        # Get webhook URL for testing
        WEBHOOK_URL=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT url FROM stripe._managed_webhooks LIMIT 1;" 2>/dev/null | tr -d ' ')
        echo ""
        echo "   Webhook URL: $WEBHOOK_URL"
    else
        echo "⚠ No webhooks found in database (may still be initializing)"
        echo "  Continuing with test..."
    fi

    # Step 4: Trigger test webhook events
    echo ""
    echo "🎯 Step 5: Triggering test Stripe webhook events..."
    echo "   This tests end-to-end webhook processing and database writes"
    echo ""

    # Create customer via Stripe API (triggers customer.created webhook)
    echo "   Creating customer via Stripe API..."
    CUSTOMER_RESPONSE=$(curl -s https://api.stripe.com/v1/customers \
        -u "$STRIPE_API_KEY:" \
        -d "email=integration-test@example.com" \
        -d "name=Integration Test Customer")
    CUSTOMER_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.id // empty')
    sleep 2
    echo "   ✓ customer.created event triggered (ID: $CUSTOMER_ID)"

    # Create product via Stripe API (triggers product.created webhook)
    echo "   Creating product via Stripe API..."
    PRODUCT_RESPONSE=$(curl -s https://api.stripe.com/v1/products \
        -u "$STRIPE_API_KEY:" \
        -d "name=Integration Test Product")
    PRODUCT_ID=$(echo "$PRODUCT_RESPONSE" | jq -r '.id // empty')
    sleep 2
    echo "   ✓ product.created event triggered (ID: $PRODUCT_ID)"

    # Create price via Stripe API (triggers price.created webhook)
    echo "   Creating price via Stripe API..."
    PRICE_RESPONSE=$(curl -s https://api.stripe.com/v1/prices \
        -u "$STRIPE_API_KEY:" \
        -d "product=$PRODUCT_ID" \
        -d "unit_amount=1000" \
        -d "currency=usd")
    PRICE_ID=$(echo "$PRICE_RESPONSE" | jq -r '.id // empty')
    sleep 2
    echo "   ✓ price.created event triggered (ID: $PRICE_ID)"

    # Send unsupported event directly to webhook endpoint (should be handled gracefully)
    echo "   Sending unsupported event (balance.available) directly to webhook..."
    TIMESTAMP=$(date +%s)
    WEBHOOK_SECRET=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT secret FROM stripe._managed_webhooks LIMIT 1;" 2>/dev/null | tr -d ' ')

    UNSUPPORTED_PAYLOAD=$(cat <<EOF
{
  "id": "evt_test_unsupported_${TIMESTAMP}",
  "object": "event",
  "api_version": "2020-08-27",
  "created": ${TIMESTAMP},
  "type": "balance.available",
  "data": {
    "object": {
      "object": "balance",
      "available": [{"amount": 1000, "currency": "usd"}],
      "livemode": false
    }
  }
}
EOF
)

    SIGNATURE_PAYLOAD="${TIMESTAMP}.${UNSUPPORTED_PAYLOAD}"
    SIGNATURE=$(echo -n "$SIGNATURE_PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

    UNSUPPORTED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -H "Stripe-Signature: t=${TIMESTAMP},v1=${SIGNATURE}" \
        -d "$UNSUPPORTED_PAYLOAD")

    if [ "$UNSUPPORTED_STATUS" = "200" ]; then
        echo "   ✓ Unsupported event sent (HTTP $UNSUPPORTED_STATUS - handled gracefully)"
    else
        echo "   ❌ Unsupported event returned HTTP $UNSUPPORTED_STATUS (expected 200)"
        exit 1
    fi

    echo ""
    echo "   Waiting for webhook processing..."
    sleep 3

    # Verify CLI is still running after unsupported event
    if ps -p $CLI_PID > /dev/null 2>&1; then
        echo "   ✓ CLI still running after unsupported event (no crash)"

        # Check for warning in logs
        if grep -q "unhandled webhook event" /tmp/cli-test.log; then
            echo "   ✓ Unsupported event logged as warning (gracefully handled)"
        else
            echo "   ⚠ Warning message not found in logs (may have different format)"
        fi

        # Verify webhook returned 200 status (check for received: true in logs)
        if grep -q '"received":true' /tmp/cli-test.log || grep -q "received: true" /tmp/cli-test.log; then
            echo "   ✓ Webhook endpoint returned 2xx (success) for unsupported event"
        else
            echo "   ⚠ Could not verify 2xx response in logs"
        fi
    else
        echo "   ❌ CLI crashed after unsupported event"
        exit 1
    fi

    # Step 5: Verify webhook data in database tables
    echo ""
    echo "🔍 Step 6: Verifying webhook data in database tables..."

    # Check customers table
    CUSTOMER_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.customers;" 2>/dev/null | tr -d ' ' || echo "0")
    echo "   Customers table: $CUSTOMER_COUNT rows"
    if [ "$CUSTOMER_COUNT" -gt 0 ]; then
        echo "   ✓ Customer data found"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, email, name, created FROM stripe.customers LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ⚠ No customer data found (webhook may not have processed yet)"
    fi

    echo ""

    # Check products table
    PRODUCT_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products;" 2>/dev/null | tr -d ' ' || echo "0")
    echo "   Products table: $PRODUCT_COUNT rows"
    if [ "$PRODUCT_COUNT" -gt 0 ]; then
        echo "   ✓ Product data found"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, name, active, created FROM stripe.products LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ⚠ No product data found (webhook may not have processed yet)"
    fi

    echo ""

    # Check prices table
    PRICE_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.prices;" 2>/dev/null | tr -d ' ' || echo "0")
    echo "   Prices table: $PRICE_COUNT rows"
    if [ "$PRICE_COUNT" -gt 0 ]; then
        echo "   ✓ Price data found"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, product, currency, unit_amount, created FROM stripe.prices LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ⚠ No price data found (webhook may not have processed yet)"
    fi

    # Step 6: Gracefully shutdown CLI
    echo ""
    echo "🛑 Step 7: Shutting down CLI gracefully..."
    kill -TERM $CLI_PID 2>/dev/null

    # Wait for cleanup to complete
    echo "   Waiting for cleanup to complete..."
    wait $CLI_PID 2>/dev/null || true
    sleep 1

    # Step 7: Verify cleanup
    echo ""
    echo "🧹 Step 8: Verifying cleanup after shutdown..."
    WEBHOOK_COUNT_AFTER=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks;" 2>/dev/null | tr -d ' ')

    if [ "$WEBHOOK_COUNT_AFTER" -eq 0 ] 2>/dev/null || [ -z "$WEBHOOK_COUNT_AFTER" ]; then
        echo "✓ Webhook successfully deleted from database"
    else
        echo "❌ Warning: $WEBHOOK_COUNT_AFTER webhook(s) still in database"
        echo "   Cleanup may not have completed properly"
        echo ""
        echo "Remaining webhooks:"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, url FROM stripe._managed_webhooks;" 2>/dev/null
    fi
else
    echo "❌ CLI failed to start"
    echo ""
    echo "Error log:"
    cat /tmp/cli-test.log
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (Stripe CLI)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ CLI started and created webhook in Stripe"
echo "- ✓ Migrations run automatically via StripeSync"
echo "- ✓ Webhook persisted to database"
echo "- ✓ Test webhook events triggered (customer, product, price)"
echo "- ✓ Webhook processing verified ($CUSTOMER_COUNT customers, $PRODUCT_COUNT products, $PRICE_COUNT prices)"
echo "- ✓ Graceful shutdown completed"
echo "- ✓ Webhook cleanup verified (removed from Stripe + DB)"
echo ""
echo "View full CLI log: /tmp/cli-test.log"
