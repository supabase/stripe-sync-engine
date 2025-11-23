#!/bin/bash

# Integration test for webhook reuse functionality
# Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
# and cleans up orphaned webhooks
#
# Environment Variables:
#   DATABASE_URL           - Required: PostgreSQL connection string
#   STRIPE_API_KEY       - Required: Primary Stripe API key for testing (legacy: STRIPE_API_KEY)
#   STRIPE_API_KEY_2       - Required: Secondary Stripe account API key for multi-account tests
#                                     (Account IDs are automatically detected from the API keys)

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Webhook Reuse Verification Test"
echo "==================================="
echo ""

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY STRIPE_API_KEY_2

# Start PostgreSQL
start_postgres "webhook-test-db" "app_db"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    stop_postgres "webhook-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Run the webhook verification test
echo "🔄 Running webhook reuse verification test..."
echo ""

# Check if multi-account testing is enabled
if [ -n "$STRIPE_API_KEY_2" ]; then
    echo "ℹ️  Multi-account testing enabled (STRIPE_API_KEY_2 detected)"
    echo ""
fi

npx tsx scripts/verify-webhook-reuse.ts

echo ""
echo "=========================================="
echo "✅ Webhook Reuse Verification Test Completed!"
echo ""
