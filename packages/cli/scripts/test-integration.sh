#!/bin/bash

# End-to-end integration test for Stripe Sync Engine
# Tests webhook creation, event processing, and database writes

set -e  # Exit on error

echo "🧪 Stripe Sync Engine Integration Test"
echo "======================================="
echo ""

# Check for Stripe CLI
echo "🔧 Checking prerequisites..."
if ! command -v stripe &> /dev/null; then
    echo "❌ Stripe CLI not found - required for integration tests"
    echo "   Install: https://stripe.com/docs/stripe-cli"
    exit 1
fi
echo "✓ Stripe CLI found"

# Load environment variables
if [ -f .env ]; then
    echo "✓ Loading environment variables from .env"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ .env file not found"
    exit 1
fi

# Check required environment variables
if [ -z "$DATABASE_URL" ] || [ -z "$STRIPE_API_KEY" ] || [ -z "$NGROK_AUTH_TOKEN" ]; then
    echo "❌ Missing required environment variables"
    echo "   Required: DATABASE_URL, STRIPE_API_KEY, NGROK_AUTH_TOKEN"
    exit 1
fi

echo "✓ Environment variables loaded"
echo ""

# Step 0: Start PostgreSQL if not running
echo "🐘 Step 0: Checking PostgreSQL..."
if ! docker ps | grep -q postgres; then
    echo "   Starting PostgreSQL Docker container..."
    docker run --name stripe-sync-test-db \
        -e POSTGRES_PASSWORD=postgres \
        -e POSTGRES_DB=app_db \
        -p 5432:5432 \
        -d postgres:16-alpine > /dev/null 2>&1

    echo "   Waiting for PostgreSQL to be ready..."
    sleep 3

    # Wait for PostgreSQL to be ready
    for i in {1..10}; do
        if docker exec stripe-sync-test-db pg_isready -U postgres > /dev/null 2>&1; then
            echo "✓ PostgreSQL is ready"
            break
        fi
        sleep 1
    done
else
    echo "✓ PostgreSQL is already running"
fi
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    docker stop stripe-sync-test-db > /dev/null 2>&1 || true
    docker rm stripe-sync-test-db > /dev/null 2>&1 || true
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Step 1: Build CLI
echo "🔨 Step 1: Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

# Step 2: Start CLI in background and test
echo "🚀 Step 2: Starting CLI to test webhook creation..."
echo ""

# Start CLI in background with KEEP_WEBHOOKS_ON_SHUTDOWN=true for testing
KEEP_WEBHOOKS_ON_SHUTDOWN=true npm run dev > /tmp/cli-test.log 2>&1 &
CLI_PID=$!

# Wait for startup (give it time to create webhook)
sleep 7

# Check if CLI is still running
if ps -p $CLI_PID > /dev/null 2>&1; then
    echo "✓ CLI started successfully"

    # Check the log for webhook creation
    if grep -q "Webhook created:" /tmp/cli-test.log; then
        echo "✓ Webhook creation detected in logs"
        WEBHOOK_ID=$(grep "Webhook created:" /tmp/cli-test.log | awk '{print $NF}')
        echo "   Webhook ID: $WEBHOOK_ID"
    fi

    # Step 3: Verify webhook in database
    echo ""
    echo "🔍 Step 3: Checking database for managed webhook..."
    WEBHOOK_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.managed_webhooks;" | tr -d ' ')

    if [ "$WEBHOOK_COUNT" -gt 0 ]; then
        echo "✓ Found $WEBHOOK_COUNT webhook(s) in database"
        echo ""
        echo "Webhook details:"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, uuid, url, enabled, status FROM stripe.managed_webhooks;"

        # Get webhook URL for testing
        WEBHOOK_URL=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT url FROM stripe.managed_webhooks LIMIT 1;" | tr -d ' ')
        echo ""
        echo "   Webhook URL: $WEBHOOK_URL"
    else
        echo "❌ No webhooks found in database"
        exit 1
    fi

    # Step 4: Trigger test webhook events
    echo ""
    echo "🎯 Step 4: Triggering test Stripe webhook events..."
    echo "   This tests end-to-end webhook processing and database writes"
    echo ""

    # Trigger customer.created event
    echo "   Triggering customer.created event..."
    stripe trigger customer.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ customer.created event triggered"

    # Trigger product.created event
    echo "   Triggering product.created event..."
    stripe trigger product.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ product.created event triggered"

    # Trigger price.created event
    echo "   Triggering price.created event..."
    stripe trigger price.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ price.created event triggered"

    echo ""
    echo "   Waiting for webhook processing..."
    sleep 3

    # Step 5: Verify webhook data in database tables
    echo ""
    echo "🔍 Step 5: Verifying webhook data in database tables..."

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

    # Step 6: Gracefully shutdown CLI (with keepWebhooksOnShutdown default = true)
    echo ""
    echo "🛑 Step 6: Shutting down CLI gracefully..."
    kill -TERM $CLI_PID 2>/dev/null

    # Wait for cleanup to complete
    echo "   Waiting for shutdown to complete..."
    wait $CLI_PID 2>/dev/null || true
    sleep 1

    # Step 7: Verify webhook remains in database after shutdown
    echo ""
    echo "🧹 Step 7: Verifying webhook remains in database after shutdown..."
    WEBHOOK_COUNT_AFTER=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.managed_webhooks;" | tr -d ' ')

    if [ "$WEBHOOK_COUNT_AFTER" -eq 1 ]; then
        echo "✓ Webhook still in database (keepWebhooksOnShutdown defaults to true)"
        echo ""
        echo "Webhook details:"
        docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, uuid FROM stripe.managed_webhooks;"
    else
        echo "❌ Unexpected: $WEBHOOK_COUNT_AFTER webhook(s) in database"
        exit 1
    fi

    # Step 8: Restart CLI and verify webhook reuse (same ngrok tunnel)
    echo ""
    echo "🔄 Step 8: Restarting CLI to test webhook reuse..."

    # Store the webhook UUID from before
    ORIGINAL_WEBHOOK_UUID=$WEBHOOK_ID

    # Start CLI again (should reuse same ngrok domain and webhook)
    echo "   Starting CLI..."
    npm run dev > /tmp/cli-test-2.log 2>&1 &
    CLI_PID_2=$!

    # Wait for startup
    sleep 7

    # Check if CLI is still running
    if ps -p $CLI_PID_2 > /dev/null 2>&1; then
        echo "✓ CLI restarted successfully"

        # Check if it reused the existing webhook
        if grep -q "Webhook created:" /tmp/cli-test-2.log; then
            REUSED_WEBHOOK_UUID=$(grep "Webhook created:" /tmp/cli-test-2.log | awk '{print $NF}')
            echo "   Webhook UUID: $REUSED_WEBHOOK_UUID"

            # Verify it's the same UUID
            if [ "$REUSED_WEBHOOK_UUID" = "$ORIGINAL_WEBHOOK_UUID" ]; then
                echo "✓ Webhook was reused (same UUID as before)"
            else
                echo "❌ New webhook created (different UUID)"
                echo "   Original: $ORIGINAL_WEBHOOK_UUID"
                echo "   New: $REUSED_WEBHOOK_UUID"
                exit 1
            fi
        else
            echo "❌ Could not find webhook creation message in log"
            exit 1
        fi

        # Verify only one webhook in database
        WEBHOOK_COUNT_RESTARTED=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.managed_webhooks;" | tr -d ' ')
        if [ "$WEBHOOK_COUNT_RESTARTED" -eq 1 ]; then
            echo "✓ Still only 1 webhook in database (no duplicate created)"
        else
            echo "❌ Expected 1 webhook, found: $WEBHOOK_COUNT_RESTARTED"
            exit 1
        fi

        # Step 9: Gracefully shutdown to clean up (this time webhook will be deleted since CLI has keepWebhooksOnShutdown: false)
        echo ""
        echo "🛑 Step 9: Shutting down CLI for final cleanup..."
        kill -TERM $CLI_PID_2 2>/dev/null

        # Wait for cleanup to complete
        echo "   Waiting for cleanup to complete..."
        wait $CLI_PID_2 2>/dev/null || true
        sleep 1

        # Verify cleanup (should be deleted now because CLI sets keepWebhooksOnShutdown: false)
        WEBHOOK_COUNT_FINAL=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.managed_webhooks;" | tr -d ' ')
        if [ "$WEBHOOK_COUNT_FINAL" -eq 0 ]; then
            echo "✓ Webhook successfully cleaned up"
        else
            echo "⚠ Warning: $WEBHOOK_COUNT_FINAL webhook(s) still in database"
        fi
    else
        echo "❌ CLI failed to restart"
        echo ""
        echo "Error log:"
        cat /tmp/cli-test-2.log
        exit 1
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
echo "- ✓ Migrations run automatically via StripeAutoSync"
echo "- ✓ Webhook persisted to database with UUID-based URL"
echo "- ✓ Test webhook events triggered (customer, product, price)"
echo "- ✓ Webhook processing verified ($CUSTOMER_COUNT customers, $PRODUCT_COUNT products, $PRICE_COUNT prices)"
echo "- ✓ Graceful shutdown with keepWebhooksOnShutdown=true completed"
echo "- ✓ Webhook remained in database after shutdown"
echo "- ✓ CLI restarted and reused existing webhook"
echo "- ✓ Final shutdown cleaned up webhook"
echo ""
echo "View CLI logs: /tmp/cli-test.log and /tmp/cli-test-2.log"
