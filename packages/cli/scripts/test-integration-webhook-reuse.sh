#!/bin/bash

# Integration test for webhook reuse functionality
# Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
# and cleans up orphaned webhooks

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
check_env_vars DATABASE_URL STRIPE_API_KEY

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

npx tsx scripts/verify-webhook-reuse.ts

echo ""
echo "=========================================="
echo "✅ Webhook Reuse Verification Test Completed!"
echo ""
