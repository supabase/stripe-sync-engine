#!/bin/bash

# Check Sigma sync functionality

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine Sigma Integration Test"
echo "=============================================="
echo ""

# Check for required tools
check_required_tools jq

# Load environment variables
load_env_file

# Check required environment variables (use STRIPE_API_KEY_3 for sigma tests)
check_env_vars DATABASE_URL STRIPE_API_KEY_3

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-test-db" "app_db"

# Track created resources for cleanup
declare -a PRODUCT_IDS=()

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete created Stripe resources
    if [ ${#PRODUCT_IDS[@]} -gt 0 ]; then
        echo "   Deleting test products from Stripe..."
        for prod_id in "${PRODUCT_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/products/${prod_id}" \
                -u "${STRIPE_API_KEY_3}:" > /dev/null 2>&1 || true
        done
    fi

    stop_postgres "stripe-sync-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

echo "Step 1: Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

echo "Step 2: Running database migrations..."
STRIPE_API_KEY="$STRIPE_API_KEY_3" node dist/cli/index.js migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Create a test product first (so backfill all has something to sync)
echo "Step 3: Creating test product in Stripe..."
PROD_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
    -u "${STRIPE_API_KEY_3}:" \
    -d "name=Sigma Test Product" \
    -d "description=Integration test product for sigma test")
PROD_ID=$(echo "$PROD_JSON" | jq -r '.id')
PRODUCT_IDS+=("$PROD_ID")
echo "   ✓ Created product: $PROD_ID"
echo ""

echo "Step 4: Running backfill all (syncs both sigma and non-sigma entities)..."
echo "   Executing: stripe-sync backfill all"
echo ""

STRIPE_API_KEY="$STRIPE_API_KEY_3" ENABLE_SIGMA=true node dist/cli/index.js backfill all

echo ""
echo "✓ Backfill all completed"
echo ""

# Step 5: Verify data in database
echo "Step 5: Verifying synced data in database..."
echo ""

# Check subscription_item_change_events_v2_beta table (sigma)
SICE_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.subscription_item_change_events_v2_beta;" 2>/dev/null | tr -d ' ' || echo "0")
echo "   subscription_item_change_events_v2_beta table: $SICE_COUNT rows"
if [ "$SICE_COUNT" -gt 0 ]; then
    echo "   ✓ Subscription item change events data successfully synced (sigma)"
else
    echo "   ❌ Expected at least 1 row in subscription_item_change_events_v2_beta, found $SICE_COUNT"
    exit 1
fi

echo ""

# Check exchange_rates_from_usd table (sigma)
EXCHANGE_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.exchange_rates_from_usd;" 2>/dev/null | tr -d ' ' || echo "0")
echo "   exchange_rates_from_usd table: $EXCHANGE_COUNT rows"
if [ "$EXCHANGE_COUNT" -gt 0 ]; then
    echo "   ✓ Exchange rates data successfully synced (sigma)"
else
    echo "   ❌ Expected at least 1 row in exchange_rates_from_usd, found $EXCHANGE_COUNT"
    exit 1
fi

echo ""

# Check products table (non-sigma)
PRODUCT_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE id = '$PROD_ID';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   products table: checking test product $PROD_ID"
if [ "$PRODUCT_COUNT" -eq 1 ]; then
    echo "   ✓ Product data successfully synced (non-sigma)"
else
    echo "   ❌ Test product not found in database"
    exit 1
fi

echo ""

echo "Step 6: Verifying sync status..."
echo ""

# Get the account ID
ACCOUNT_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT DISTINCT _account_id FROM stripe.subscription_item_change_events_v2_beta LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ -z "$ACCOUNT_ID" ]; then
    # Try getting from exchange_rates table if the first one is empty
    ACCOUNT_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT DISTINCT _account_id FROM stripe.exchange_rates_from_usd LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
fi

if [ -n "$ACCOUNT_ID" ]; then
    echo "   ✓ Account ID: $ACCOUNT_ID"
    
    # Check sync status for subscription_item_change_events_v2_beta
    SICE_STATUS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT o.status FROM stripe._sync_obj_runs o JOIN stripe._sync_runs r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'subscription_item_change_events_v2_beta' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
    if [ "$SICE_STATUS" = "complete" ]; then
        echo "subscription_item_change_events_v2_beta sync status: $SICE_STATUS"
    else
        echo "subscription_item_change_events_v2_beta sync status: $SICE_STATUS (expected: complete)"
    fi
    
    # Check sync status for exchange_rates_from_usd
    EXCHANGE_STATUS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT o.status FROM stripe._sync_obj_runs o JOIN stripe._sync_runs r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'exchange_rates_from_usd' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
    if [ "$EXCHANGE_STATUS" = "complete" ]; then
        echo "   ✓ exchange_rates_from_usd sync status: $EXCHANGE_STATUS"
    else
        echo "   ⚠ exchange_rates_from_usd sync status: $EXCHANGE_STATUS (expected: complete)"
    fi
else
    echo "   ⚠ Could not determine account ID from synced data"
fi

echo ""
echo "=========================================="
echo "Sigma Integration Test Completed!"
echo "- ✓ backfill all synced both sigma and non-sigma entities"
echo "- ✓ subscription_item_change_events_v2_beta: $SICE_COUNT rows (sigma)"
echo "- ✓ exchange_rates_from_usd: $EXCHANGE_COUNT rows (sigma)"
echo "- ✓ products: test product synced (non-sigma)"
echo ""

