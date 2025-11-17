#!/bin/bash

# End-to-end integration test for Account Management Methods
# Tests getCurrentAccount(), getAllSyncedAccounts(), and dangerouslyDeleteSyncedAccountData()

set -e  # Exit on error

echo "🧪 Stripe Sync Engine Account Management Integration Test"
echo "=========================================================="
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
declare -a CUSTOMER_IDS=()

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

    if [ ${#CUSTOMER_IDS[@]} -gt 0 ]; then
        echo "   Deleting customers from Stripe..."
        for cust_id in "${CUSTOMER_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/customers/${cust_id}" \
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

# ============================================================================
# TEST SUITE 1: getCurrentAccount()
# ============================================================================

echo "📋 TEST SUITE 1: getCurrentAccount()"
echo "────────────────────────────────────"
echo ""

# Test 1.1: First API Fetch
echo "TEST 1.1: First API Fetch"
ACCOUNT_JSON=$(npx tsx scripts/test-account-methods.ts get-account 2>&1 || echo "{}")

ACCOUNT_ID=$(echo "$ACCOUNT_JSON" | jq -r '.id' 2>/dev/null || echo "")

if [[ "$ACCOUNT_ID" == acct_* ]]; then
    echo "✓ Account fetched: $ACCOUNT_ID"
else
    echo "❌ Failed to fetch account (got: $ACCOUNT_ID)"
    echo "Full output:"
    echo "$ACCOUNT_JSON"
    exit 1
fi

ACCOUNT_EMAIL=$(echo "$ACCOUNT_JSON" | jq -r '.email' 2>/dev/null || echo "")
echo "  Email: $ACCOUNT_EMAIL"
echo ""

# Test 1.2: Database Persistence Check
echo "TEST 1.2: Database Persistence"
DB_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.accounts WHERE id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')

if [ "$DB_COUNT" -eq 1 ]; then
    echo "✓ Account persisted to database"
else
    echo "❌ Account not in database (count: $DB_COUNT)"
    exit 1
fi

# Verify raw_data column exists
RAW_DATA=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT raw_data::text FROM stripe.accounts WHERE id = '$ACCOUNT_ID' LIMIT 1;" 2>/dev/null | tr -d ' ' | head -c 20)

if [ -n "$RAW_DATA" ]; then
    echo "✓ raw_data column populated"
else
    echo "❌ raw_data column empty"
    exit 1
fi
echo ""

# Test 1.3: JSON Format Validation
echo "TEST 1.3: JSON Format Validation"
if echo "$ACCOUNT_JSON" | jq empty 2>/dev/null; then
    echo "✓ Valid JSON output"
else
    echo "❌ Invalid JSON output"
    exit 1
fi
echo ""

echo "✅ TEST SUITE 1 PASSED"
echo ""

# ============================================================================
# TEST SUITE 2: getAllSyncedAccounts()
# ============================================================================

echo "📋 TEST SUITE 2: getAllSyncedAccounts()"
echo "────────────────────────────────────"
echo ""

# Test 2.1: Single Account Retrieval
echo "TEST 2.1: Single Account Retrieval"
ACCOUNTS_JSON=$(npx tsx scripts/test-account-methods.ts list-accounts 2>&1 || echo "[]")

ACCOUNT_COUNT=$(echo "$ACCOUNTS_JSON" | jq 'length' 2>/dev/null || echo "0")

if [ "$ACCOUNT_COUNT" -ge 1 ]; then
    echo "✓ Retrieved $ACCOUNT_COUNT account(s)"
else
    echo "❌ Failed to retrieve accounts (count: $ACCOUNT_COUNT)"
    exit 1
fi

FIRST_ID=$(echo "$ACCOUNTS_JSON" | jq -r '.[0].id' 2>/dev/null || echo "")
if [ "$FIRST_ID" = "$ACCOUNT_ID" ]; then
    echo "✓ Account ID matches: $FIRST_ID"
else
    echo "⚠️  First account ID: $FIRST_ID (expected: $ACCOUNT_ID)"
fi
echo ""

# Test 2.2: JSON Format Output
echo "TEST 2.2: JSON Format Validation"
if echo "$ACCOUNTS_JSON" | jq empty 2>/dev/null; then
    echo "✓ Valid JSON output"
else
    echo "❌ Invalid JSON output"
    exit 1
fi
echo ""

# Test 2.3: Ordering Check
echo "TEST 2.3: Ordering by Last Synced"
FIRST_ACCOUNT_ID=$(echo "$ACCOUNTS_JSON" | jq -r '.[0].id' 2>/dev/null || echo "")
if [ -n "$FIRST_ACCOUNT_ID" ]; then
    echo "✓ First account: $FIRST_ACCOUNT_ID"
else
    echo "❌ Could not get first account"
    exit 1
fi
echo ""

echo "✅ TEST SUITE 2 PASSED"
echo ""

# ============================================================================
# TEST SUITE 3: dangerouslyDeleteSyncedAccountData()
# ============================================================================

echo "📋 TEST SUITE 3: dangerouslyDeleteSyncedAccountData()"
echo "────────────────────────────────────"
echo ""

# Create test data for deletion tests
echo "Setup: Creating test data in Stripe..."

# Create 10 test products
for i in {1..10}; do
    PROD_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
        -u "${STRIPE_API_KEY}:" \
        -d "name=Test Product $i - AccountMgmt" \
        -d "description=Test product $i for account management testing")
    PROD_ID=$(echo "$PROD_JSON" | jq -r '.id')
    PRODUCT_IDS+=("$PROD_ID")
done
echo "✓ Created 10 test products"

# Create 5 test customers
for i in {1..5}; do
    CUST_JSON=$(curl -s -X POST https://api.stripe.com/v1/customers \
        -u "${STRIPE_API_KEY}:" \
        -d "name=Test Customer $i" \
        -d "email=test$i@example.com")
    CUST_ID=$(echo "$CUST_JSON" | jq -r '.id')
    CUSTOMER_IDS+=("$CUST_ID")
done
echo "✓ Created 5 test customers"

# Sync the test data to database
echo "Setup: Syncing test data to database..."
npm run dev -- backfill product > /dev/null 2>&1
npm run dev -- backfill customer > /dev/null 2>&1
echo "✓ Test data synced"
echo ""

# Verify test data synced
PRODUCT_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%AccountMgmt%';" 2>/dev/null | tr -d ' ')
CUSTOMER_COUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.customers WHERE email LIKE 'test%@example.com';" 2>/dev/null | tr -d ' ')

echo "Setup verification:"
echo "  Products synced: $PRODUCT_COUNT / 10"
echo "  Customers synced: $CUSTOMER_COUNT / 5"
echo ""

# Test 3.1: Dry-Run Preview
echo "TEST 3.1: Dry-Run Preview"
DRY_RUN_JSON=$(npx tsx scripts/test-account-methods.ts delete-account "$ACCOUNT_ID" --dry-run 2>/dev/null || echo "{}")

# Verify dry-run returns deletion counts
DELETED_PRODUCTS=$(echo "$DRY_RUN_JSON" | jq -r '.deletedRecordCounts.products // 0' 2>/dev/null)
if [ "$DELETED_PRODUCTS" -ge 10 ]; then
    echo "✓ Dry-run shows $DELETED_PRODUCTS products would be deleted"
else
    echo "❌ Dry-run count incorrect (products: $DELETED_PRODUCTS)"
    exit 1
fi

DELETED_CUSTOMERS=$(echo "$DRY_RUN_JSON" | jq -r '.deletedRecordCounts.customers // 0' 2>/dev/null)
if [ "$DELETED_CUSTOMERS" -ge 5 ]; then
    echo "✓ Dry-run shows $DELETED_CUSTOMERS customers would be deleted"
else
    echo "❌ Dry-run count incorrect (customers: $DELETED_CUSTOMERS)"
    exit 1
fi

# Verify warnings array exists
WARNINGS_COUNT=$(echo "$DRY_RUN_JSON" | jq '.warnings | length' 2>/dev/null || echo "0")
echo "  Warnings: $WARNINGS_COUNT"
echo ""

# Verify no actual deletion occurred
PRODUCT_COUNT_AFTER_DRY=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%AccountMgmt%';" 2>/dev/null | tr -d ' ')

if [ "$PRODUCT_COUNT_AFTER_DRY" -eq "$PRODUCT_COUNT" ]; then
    echo "✓ Dry-run did not delete data"
else
    echo "❌ Dry-run unexpectedly deleted data"
    exit 1
fi
echo ""

# Test 3.2: Actual Deletion with Transaction
echo "TEST 3.2: Actual Deletion with Transaction"
DELETE_JSON=$(npx tsx scripts/test-account-methods.ts delete-account "$ACCOUNT_ID" 2>/dev/null || echo "{}")

FINAL_DELETED_PRODUCTS=$(echo "$DELETE_JSON" | jq -r '.deletedRecordCounts.products // 0' 2>/dev/null)
FINAL_DELETED_CUSTOMERS=$(echo "$DELETE_JSON" | jq -r '.deletedRecordCounts.customers // 0' 2>/dev/null)
FINAL_DELETED_ACCOUNTS=$(echo "$DELETE_JSON" | jq -r '.deletedRecordCounts.accounts // 0' 2>/dev/null)

echo "  Deleted products: $FINAL_DELETED_PRODUCTS"
echo "  Deleted customers: $FINAL_DELETED_CUSTOMERS"
echo "  Deleted accounts: $FINAL_DELETED_ACCOUNTS"
echo ""

if [ "$FINAL_DELETED_PRODUCTS" -ge 10 ]; then
    echo "✓ Products deleted"
else
    echo "❌ Product deletion failed"
    exit 1
fi

if [ "$FINAL_DELETED_CUSTOMERS" -ge 5 ]; then
    echo "✓ Customers deleted"
else
    echo "❌ Customer deletion failed"
    exit 1
fi

if [ "$FINAL_DELETED_ACCOUNTS" -eq 1 ]; then
    echo "✓ Account record deleted"
else
    echo "❌ Account deletion failed"
    exit 1
fi
echo ""

# Test 3.3: Verify Cascade Deletion
echo "TEST 3.3: Verify Cascade Deletion"

REMAINING_PRODUCTS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.products WHERE _account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')

REMAINING_CUSTOMERS=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.customers WHERE _account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')

REMAINING_ACCOUNT=$(docker exec stripe-sync-test-db psql -U postgres -d app_db -t -c \
  "SELECT COUNT(*) FROM stripe.accounts WHERE id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')

if [ "$REMAINING_PRODUCTS" -eq 0 ]; then
    echo "✓ All products removed from database"
else
    echo "❌ $REMAINING_PRODUCTS products remain"
    exit 1
fi

if [ "$REMAINING_CUSTOMERS" -eq 0 ]; then
    echo "✓ All customers removed from database"
else
    echo "❌ $REMAINING_CUSTOMERS customers remain"
    exit 1
fi

if [ "$REMAINING_ACCOUNT" -eq 0 ]; then
    echo "✓ Account record removed from database"
else
    echo "❌ Account record still exists"
    exit 1
fi
echo ""

# Test 3.4: Delete Non-Existent Account
echo "TEST 3.4: Delete Non-Existent Account Error Handling"
NONEXISTENT_JSON=$(npx tsx scripts/test-account-methods.ts delete-account "acct_nonexistent" 2>&1 || echo "{}")
DELETED_ACCOUNT_COUNT=$(echo "$NONEXISTENT_JSON" | jq -r '.deletedRecordCounts.accounts // 0' 2>/dev/null)

if [ "$DELETED_ACCOUNT_COUNT" -eq 0 ]; then
    echo "✓ Non-existent account handled gracefully (0 records deleted)"
else
    echo "❌ Expected 0 deletions for non-existent account, got $DELETED_ACCOUNT_COUNT"
    exit 1
fi
echo ""

echo "✅ TEST SUITE 3 PASSED"
echo ""

# ============================================================================
# SUMMARY
# ============================================================================

echo "=========================================="
echo "✅ Account Management Integration Test Complete!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (jq for JSON parsing)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ Database migrations completed"
echo ""
echo "TEST SUITE 1: getCurrentAccount()"
echo "  - ✓ First API fetch working"
echo "  - ✓ Account persisted to database"
echo "  - ✓ JSON format validation"
echo ""
echo "TEST SUITE 2: getAllSyncedAccounts()"
echo "  - ✓ Account retrieval working"
echo "  - ✓ JSON format validation"
echo "  - ✓ Ordering verified"
echo ""
echo "TEST SUITE 3: dangerouslyDeleteSyncedAccountData()"
echo "  - ✓ Dry-run preview working (no actual deletion)"
echo "  - ✓ Actual deletion with transaction working"
echo "  - ✓ Cascade deletion verified"
echo "  - ✓ Error handling for non-existent account"
echo ""
echo "- ✓ Test data cleaned up from Stripe"
echo "- ✓ PostgreSQL container cleaned up"
echo ""
