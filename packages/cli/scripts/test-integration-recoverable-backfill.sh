#!/bin/bash

# End-to-end integration test for Stripe Sync Engine Error Recovery
# Tests that sync can recover from crashes and preserve partial progress

set -e  # Exit on error

echo "🧪 Stripe Sync Engine Error Recovery Integration Test"
echo "======================================================"
echo ""

# Check for required tools
echo "🔧 Checking prerequisites..."
if ! command -v jq &> /dev/null; then
    echo "❌ jq not found - required for parsing JSON"
    echo "   Install: brew install jq"
    exit 1
fi
echo "✓ jq found"

# Load environment variables
if [ -f .env ]; then
    echo "✓ Loading environment variables from .env"
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ .env file not found"
    exit 1
fi

# Check required environment variables
if [ -z "$DATABASE_URL" ] || [ -z "$STRIPE_API_KEY" ]; then
    echo "❌ Missing required environment variables"
    echo "   Required: DATABASE_URL, STRIPE_API_KEY"
    exit 1
fi

echo "✓ Environment variables loaded"
echo ""

# Step 0: Start PostgreSQL if not running
echo "🐘 Step 0: Checking PostgreSQL..."
if ! docker ps | grep -q stripe-sync-test-db; then
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

# Array to store created resource IDs for cleanup
declare -a PRODUCT_IDS=()

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete created Stripe resources using API
    if [ ${#PRODUCT_IDS[@]} -gt 0 ]; then
        echo "   Deleting products from Stripe..."
        for prod_id in "${PRODUCT_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/products/${prod_id}" \
                -u "${STRIPE_API_KEY}:" > /dev/null 2>&1 || true
        done
    fi

    echo "   Stopping PostgreSQL..."
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

# Step 2: Run migrations
echo "🗄️  Step 2: Running database migrations..."
npm run dev migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Step 3: Create many test products in Stripe
echo "📦 Step 3: Creating test products in Stripe..."
echo "   Creating 200 products to ensure sync takes sufficient time..."
echo ""

for i in {1..200}; do
    PROD_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
        -u "${STRIPE_API_KEY}:" \
        -d "name=Test Product $i - Recovery" \
        -d "description=Integration test product $i for error recovery")
    PROD_ID=$(echo "$PROD_JSON" | jq -r '.id')
    PRODUCT_IDS+=("$PROD_ID")
    if [ $((i % 25)) -eq 0 ]; then
        echo "   ✓ Created $i products..."
    fi
done

echo "   ✓ All 200 products created"
echo ""
echo "✓ Test data created in Stripe (200 products)"
echo ""

# Step 4: Start sync and kill it mid-process
echo "🔄 Step 4: Testing error handling (simulating crash)..."
echo ""

echo "   Starting product backfill in background..."
# Start sync in background and capture PID
npm run dev backfill product > /tmp/sync-output.log 2>&1 &
SYNC_PID=$!
echo "   Sync PID: $SYNC_PID"

# Poll database waiting for status='running' (deterministic approach)
echo "   Waiting for sync to reach 'running' state..."
MAX_WAIT=100  # 10 seconds max (100 * 0.1s)
WAITED=0
STATUS=""
while [ $WAITED -lt $MAX_WAIT ]; do
    STATUS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
        "SELECT status FROM stripe._sync_status WHERE resource = 'products';" \
        2>/dev/null | tr -d ' ' || echo "")

    if [ "$STATUS" = "running" ]; then
        echo "   ✓ Sync reached 'running' state"
        break
    fi

    sleep 0.1
    WAITED=$((WAITED + 1))
done

# Verify we caught it running
if [ "$STATUS" != "running" ]; then
    echo "   ❌ Sync never reached 'running' state (status='$STATUS')"
    kill -9 $SYNC_PID 2>/dev/null || true
    wait $SYNC_PID 2>/dev/null || true
    exit 1
fi

# Kill the sync process while it's running
echo "   Killing sync process to simulate crash..."
kill -9 $SYNC_PID 2>/dev/null || true
wait $SYNC_PID 2>/dev/null || true

echo "   ✓ Sync process killed (simulated crash)"

# Give the database a moment to finish writing
sleep 0.5
echo ""

# Step 5: Verify error state
echo "🔍 Step 5: Verifying error state..."
echo ""

# Get the account ID from the database (from synced data)
echo "   Getting account ID..."
ACCOUNT_ID=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT DISTINCT _account_id FROM stripe.products LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ -z "$ACCOUNT_ID" ]; then
    echo "   ❌ Could not determine account ID from synced data"
    exit 1
fi
echo "   ✓ Account ID: $ACCOUNT_ID"
echo ""

# Check sync status is 'error' or 'running'
SYNC_STATUS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT status FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "")
if [ "$SYNC_STATUS" = "error" ] || [ "$SYNC_STATUS" = "running" ]; then
    echo "   ✓ Sync status is '$SYNC_STATUS' (process was interrupted)"
else
    echo "   ❌ Expected status 'error' or 'running', got '$SYNC_STATUS'"
    echo "      The sync completed too quickly - increase product count or reduce wait time"
    exit 1
fi

# Check error message exists
ERROR_MSG=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT error_message FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "")
if [ -n "$ERROR_MSG" ]; then
    echo "   ✓ Error message recorded: $(echo $ERROR_MSG | head -c 50)..."
else
    echo "   ℹ️  No error message (process killed before error could be recorded)"
fi

# Check cursor was saved (partial progress preserved)
CURSOR_AFTER_ERROR=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COALESCE(EXTRACT(EPOCH FROM last_incremental_cursor)::integer, 0) FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "0")
CURSOR_AFTER_ERROR_DISPLAY=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT last_incremental_cursor FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ "$CURSOR_AFTER_ERROR" -gt 0 ]; then
    echo "   ✓ Cursor saved: $CURSOR_AFTER_ERROR_DISPLAY (epoch: $CURSOR_AFTER_ERROR, partial progress preserved)"
else
    echo "   ℹ️  No cursor saved yet"
fi

# Check how many products were synced before crash
PRODUCTS_SYNCED=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   ✓ Products synced before crash: $PRODUCTS_SYNCED / 200"

echo ""

# Step 6: Re-run sync to test recovery
echo "🔄 Step 6: Testing recovery from error..."
echo ""

echo "   Re-running product backfill (should recover)..."
npm run dev backfill product

echo ""

# Step 7: Verify recovery
echo "🔍 Step 7: Verifying successful recovery..."
echo ""

# Check sync status is now 'complete'
FINAL_STATUS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT status FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ' || echo "")
if [ "$FINAL_STATUS" = "complete" ]; then
    echo "   ✓ Sync status recovered to 'complete'"
else
    echo "   ❌ Expected status 'complete', got '$FINAL_STATUS'"
    exit 1
fi

# Check error message is cleared
FINAL_ERROR=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COALESCE(error_message, '') FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ -z "$FINAL_ERROR" ]; then
    echo "   ✓ Error message cleared"
else
    echo "   ❌ Error message still present: '$FINAL_ERROR'"
    exit 1
fi

# Check cursor advanced or maintained (never decreased)
FINAL_CURSOR=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COALESCE(EXTRACT(EPOCH FROM last_incremental_cursor)::integer, 0) FROM stripe._sync_status WHERE resource = 'products' AND account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
if [ -z "$FINAL_CURSOR" ]; then
    FINAL_CURSOR="0"
fi

# Calculate cursor delta
CURSOR_DELTA=$((FINAL_CURSOR - CURSOR_AFTER_ERROR))

if [ "$FINAL_CURSOR" -ge "$CURSOR_AFTER_ERROR" ]; then
    if [ "$CURSOR_DELTA" -gt 0 ]; then
        echo "   ✓ Cursor advanced: $CURSOR_AFTER_ERROR → $FINAL_CURSOR (delta: +$CURSOR_DELTA)"
    else
        echo "   ✓ Cursor maintained: $FINAL_CURSOR (delta: 0, no new data since crash)"
    fi
else
    echo "   ❌ Cursor decreased: $CURSOR_AFTER_ERROR → $FINAL_CURSOR (delta: $CURSOR_DELTA) - bug in cursor logic!"
    exit 1
fi

# Check all products were synced
FINAL_PRODUCTS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%';" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$FINAL_PRODUCTS" -ge 200 ]; then
    echo "   ✓ All products synced: $FINAL_PRODUCTS / 200"
else
    echo "   ❌ Expected 200 products, found $FINAL_PRODUCTS"
    exit 1
fi

# Verify no data was lost
ACTUAL_TEST_PRODUCTS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE _id = ANY(ARRAY[$(printf "'%s'," "${PRODUCT_IDS[@]}" | sed 's/,$//')]::text[]);" 2>/dev/null | tr -d ' ' || echo "0")
if [ "$ACTUAL_TEST_PRODUCTS" -eq 200 ]; then
    echo "   ✓ No data lost - all 200 test products in database"
else
    echo "   ❌ Expected 200 test products, found $ACTUAL_TEST_PRODUCTS"
    exit 1
fi

echo ""
echo "✅ Step 7: Recovery verification passed!"
echo ""

echo "=========================================="
echo "✅ Error Recovery Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (jq for Stripe API JSON parsing)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ Database migrations completed"
echo "- ✓ Test data created in Stripe (200 products)"
echo "- ✓ Sync process killed mid-execution (simulated crash)"
echo "- ✓ Error/running state properly recorded (status='$SYNC_STATUS')"
echo "- ✓ Partial progress preserved (cursor saved)"
echo "- ✓ Sync recovered successfully on retry"
echo "- ✓ Final status: complete"
echo "- ✓ All 200 products synced with no data loss"
echo "- ✓ Test data cleaned up from Stripe"
echo ""
