#!/bin/bash

# End-to-end integration test for Stripe Sync Engine Backfill
# Tests backfill command with real Stripe data

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine Backfill Integration Test"
echo "================================================="
echo ""

# Check for required tools
check_required_tools jq

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-test-db" "app_db"

# Array to store created resource IDs for cleanup
declare -a CUSTOMER_IDS=()
declare -a PRODUCT_IDS=()
declare -a PRICE_IDS=()

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete created Stripe resources using API
    if [ ${#PRICE_IDS[@]} -gt 0 ]; then
        echo "   Archiving prices in Stripe..."
        for price_id in "${PRICE_IDS[@]}"; do
            curl -s -X POST "https://api.stripe.com/v1/prices/${price_id}" \
                -u "${STRIPE_API_KEY}:" \
                -d "active=false" > /dev/null 2>&1 || true
        done
    fi

    if [ ${#PRODUCT_IDS[@]} -gt 0 ]; then
        echo "   Deleting products from Stripe..."
        for prod_id in "${PRODUCT_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/products/${prod_id}" \
                -u "${STRIPE_API_KEY}:" > /dev/null 2>&1 || true
        done
    fi

    if [ ${#CUSTOMER_IDS[@]} -gt 0 ]; then
        echo "   Deleting customers from Stripe..."
        for cust_id in "${CUSTOMER_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/customers/${cust_id}" \
                -u "${STRIPE_API_KEY}:" > /dev/null 2>&1 || true
        done
    fi

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
npm run dev migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Step 3: Create test data in Stripe using API
echo "📦 Step 3: Creating test data in Stripe..."
echo ""

# Create customers
echo "   Creating test customers..."
CUST1_JSON=$(curl -s -X POST https://api.stripe.com/v1/customers \
    -u "${STRIPE_API_KEY}:" \
    -d "email=test-backfill-1@example.com" \
    -d "name=Test Customer 1" \
    -d "description=Integration test customer 1")
CUST1_ID=$(echo "$CUST1_JSON" | jq -r '.id')
CUSTOMER_IDS+=("$CUST1_ID")
echo "   ✓ Created customer: $CUST1_ID"

CUST2_JSON=$(curl -s -X POST https://api.stripe.com/v1/customers \
    -u "${STRIPE_API_KEY}:" \
    -d "email=test-backfill-2@example.com" \
    -d "name=Test Customer 2" \
    -d "description=Integration test customer 2")
CUST2_ID=$(echo "$CUST2_JSON" | jq -r '.id')
CUSTOMER_IDS+=("$CUST2_ID")
echo "   ✓ Created customer: $CUST2_ID"

CUST3_JSON=$(curl -s -X POST https://api.stripe.com/v1/customers \
    -u "${STRIPE_API_KEY}:" \
    -d "email=test-backfill-3@example.com" \
    -d "name=Test Customer 3" \
    -d "description=Integration test customer 3")
CUST3_ID=$(echo "$CUST3_JSON" | jq -r '.id')
CUSTOMER_IDS+=("$CUST3_ID")
echo "   ✓ Created customer: $CUST3_ID"

echo ""

# Create products
echo "   Creating test products..."
PROD1_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
    -u "${STRIPE_API_KEY}:" \
    -d "name=Test Product 1 - Backfill" \
    -d "description=Integration test product 1")
PROD1_ID=$(echo "$PROD1_JSON" | jq -r '.id')
PRODUCT_IDS+=("$PROD1_ID")
echo "   ✓ Created product: $PROD1_ID"

PROD2_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
    -u "${STRIPE_API_KEY}:" \
    -d "name=Test Product 2 - Backfill" \
    -d "description=Integration test product 2")
PROD2_ID=$(echo "$PROD2_JSON" | jq -r '.id')
PRODUCT_IDS+=("$PROD2_ID")
echo "   ✓ Created product: $PROD2_ID"

PROD3_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
    -u "${STRIPE_API_KEY}:" \
    -d "name=Test Product 3 - Backfill" \
    -d "description=Integration test product 3")
PROD3_ID=$(echo "$PROD3_JSON" | jq -r '.id')
PRODUCT_IDS+=("$PROD3_ID")
echo "   ✓ Created product: $PROD3_ID"

echo ""

# Create prices
echo "   Creating test prices..."
PRICE1_JSON=$(curl -s -X POST https://api.stripe.com/v1/prices \
    -u "${STRIPE_API_KEY}:" \
    -d "product=${PROD1_ID}" \
    -d "unit_amount=1000" \
    -d "currency=usd" \
    -d "nickname=Test Price 1")
PRICE1_ID=$(echo "$PRICE1_JSON" | jq -r '.id')
PRICE_IDS+=("$PRICE1_ID")
echo "   ✓ Created price: $PRICE1_ID"

PRICE2_JSON=$(curl -s -X POST https://api.stripe.com/v1/prices \
    -u "${STRIPE_API_KEY}:" \
    -d "product=${PROD2_ID}" \
    -d "unit_amount=2000" \
    -d "currency=usd" \
    -d "nickname=Test Price 2")
PRICE2_ID=$(echo "$PRICE2_JSON" | jq -r '.id')
PRICE_IDS+=("$PRICE2_ID")
echo "   ✓ Created price: $PRICE2_ID"

PRICE3_JSON=$(curl -s -X POST https://api.stripe.com/v1/prices \
    -u "${STRIPE_API_KEY}:" \
    -d "product=${PROD3_ID}" \
    -d "unit_amount=3000" \
    -d "currency=usd" \
    -d "recurring[interval]=month" \
    -d "nickname=Test Price 3 (Monthly)")
PRICE3_ID=$(echo "$PRICE3_JSON" | jq -r '.id')
PRICE_IDS+=("$PRICE3_ID")
echo "   ✓ Created price: $PRICE3_ID"

echo ""
echo "✓ Test data created in Stripe"
echo ""

# Step 4: Run backfill command
echo "🔄 Step 4: Running backfill command..."
echo "   Executing: stripe-sync backfill all"
echo ""

npm run dev backfill all

echo ""
echo "✓ Backfill command completed"
echo ""

# Step 5: Verify data in database
echo "🔍 Step 5: Verifying backfilled data in database..."
echo ""

# Check customers table
CUSTOMER_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.customers WHERE email LIKE 'test-backfill-%';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Customers table: $CUSTOMER_COUNT rows (expected: 3)"
if [ "$CUSTOMER_COUNT" -ge 3 ]; then
    echo "   ✓ Customer data successfully backfilled"
    docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, email, name FROM stripe.customers WHERE email LIKE 'test-backfill-%' LIMIT 3;" 2>/dev/null | head -n 7
else
    echo "   ❌ Expected at least 3 customers, found $CUSTOMER_COUNT"
    exit 1
fi

echo ""

# Check products table
PRODUCT_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Backfill%';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Products table: $PRODUCT_COUNT rows (expected: 3)"
if [ "$PRODUCT_COUNT" -ge 3 ]; then
    echo "   ✓ Product data successfully backfilled"
    docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, name, active FROM stripe.products WHERE name LIKE '%Backfill%' LIMIT 3;" 2>/dev/null | head -n 7
else
    echo "   ❌ Expected at least 3 products, found $PRODUCT_COUNT"
    exit 1
fi

echo ""

# Check prices table
PRICE_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.prices WHERE nickname LIKE 'Test Price%';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Prices table: $PRICE_COUNT rows (expected: 3)"
if [ "$PRICE_COUNT" -ge 3 ]; then
    echo "   ✓ Price data successfully backfilled"
    docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, product, currency, unit_amount, nickname FROM stripe.prices WHERE nickname LIKE 'Test Price%' LIMIT 3;" 2>/dev/null | head -n 7
else
    echo "   ❌ Expected at least 3 prices, found $PRICE_COUNT"
    exit 1
fi

echo ""

# Step 6: Test Incremental Sync
echo "🔄 Step 6: Testing incremental sync..."
echo ""
echo "   This verifies that subsequent backfills only fetch new data"
echo "   instead of re-fetching all data from Stripe."
echo ""

# Get the account ID from the database (from synced data)
echo "   Getting account ID..."
ACCOUNT_ID=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT DISTINCT _account_id FROM stripe.products LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ -z "$ACCOUNT_ID" ]; then
    echo "   ❌ Could not determine account ID from synced data"
    exit 1
fi
echo "   ✓ Account ID: $ACCOUNT_ID"

# Check cursor was saved from first backfill
echo "   Checking sync cursor from first backfill..."
CURSOR=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT EXTRACT(EPOCH FROM last_incremental_cursor)::integer FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "0")
CURSOR_DISPLAY=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT last_incremental_cursor FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ "$CURSOR" -gt 0 ]; then
    echo "   ✓ Cursor saved: $CURSOR_DISPLAY (epoch: $CURSOR)"
else
    echo "   ❌ No cursor found in _sync_status table"
    exit 1
fi

# Check sync status is 'complete'
SYNC_STATUS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT status FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "")
if [ "$SYNC_STATUS" = "complete" ]; then
    echo "   ✓ Sync status: $SYNC_STATUS"
else
    echo "   ❌ Expected status 'complete', got '$SYNC_STATUS'"
    exit 1
fi

echo ""

# Create a new product in Stripe AFTER the first backfill
echo "   Creating new product in Stripe (post-backfill)..."
PROD4_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
    -u "${STRIPE_API_KEY}:" \
    -d "name=Test Product 4 - Incremental" \
    -d "description=Integration test product 4 - created after first backfill")
PROD4_ID=$(echo "$PROD4_JSON" | jq -r '.id')
PRODUCT_IDS+=("$PROD4_ID")
echo "   ✓ Created product: $PROD4_ID"

echo ""

# Small delay to ensure different timestamps
sleep 2

echo ""

# Run second backfill (should be incremental)
echo "   Running incremental backfill for products..."
npm run dev backfill product

echo ""
echo "   Verifying incremental sync results..."

# Verify cursor was updated
NEW_CURSOR=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT EXTRACT(EPOCH FROM last_incremental_cursor)::integer FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "0")
NEW_CURSOR_DISPLAY=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT last_incremental_cursor FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ "$NEW_CURSOR" -gt "$CURSOR" ]; then
    echo "   ✓ Cursor advanced: $CURSOR → $NEW_CURSOR (incremental sync working)"
else
    echo "   ❌ Cursor did not advance (got: $NEW_CURSOR, expected > $CURSOR)"
    exit 1
fi

# Verify sync status is still 'complete'
NEW_SYNC_STATUS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT status FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "")
if [ "$NEW_SYNC_STATUS" = "complete" ]; then
    echo "   ✓ Sync status after incremental sync: $NEW_SYNC_STATUS"
else
    echo "   ❌ Expected status 'complete', got '$NEW_SYNC_STATUS'"
    exit 1
fi

# Verify last_synced_at was updated
LAST_SYNCED=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT last_synced_at FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ -n "$LAST_SYNCED" ]; then
    echo "   ✓ Last synced timestamp updated: $LAST_SYNCED"
else
    echo "   ❌ Last synced timestamp not found"
    exit 1
fi

echo ""

# Verify new product was synced
PROD4_IN_DB=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE id = '$PROD4_ID';" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$PROD4_IN_DB" -eq 1 ]; then
    echo "   ✓ New product synced incrementally"
    docker exec stripe-sync-test-db psql -U postgres -d app_db -c "SELECT id, name FROM stripe.products WHERE id = '$PROD4_ID';" 2>/dev/null | head -n 5
else
    echo "   ❌ New product not found in database"
    exit 1
fi

echo ""

# Note: Using created: { gte: cursor } means products with created == cursor
# may be re-fetched to ensure no data is missed. This is expected behavior
# and ensures data consistency even if multiple products share the same timestamp.

echo ""

# Verify all test products exist in DB
TOTAL_TEST_PRODUCTS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE id IN ('$PROD1_ID', '$PROD2_ID', '$PROD3_ID', '$PROD4_ID');" 2>/dev/null | tr -d ' ' || echo "0")
echo "   Test products in DB: $TOTAL_TEST_PRODUCTS (expected: 4)"
if [ "$TOTAL_TEST_PRODUCTS" -eq 4 ]; then
    echo "   ✓ All test products synced successfully"
else
    echo "   ❌ Expected 4 test products, found $TOTAL_TEST_PRODUCTS"
    exit 1
fi

echo ""
echo "✅ Step 6: Incremental sync test passed!"
echo ""

echo "=========================================="
echo "✅ Backfill Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (jq for Stripe API JSON parsing)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ Database migrations completed"
echo "- ✓ Test data created in Stripe (3 customers, 3 products, 3 prices)"
echo "- ✓ Backfill 'all' command executed"
echo "- ✓ Data verified in database ($CUSTOMER_COUNT customers, $PRODUCT_COUNT products, $PRICE_COUNT prices)"
echo "- ✓ Incremental sync cursor saved and updated correctly"
echo "- ✓ New product created and synced incrementally"
echo "- ✓ Cursor advanced from $CURSOR to $NEW_CURSOR"
echo "- ✓ Test data cleaned up from Stripe (4 products)"
echo ""
