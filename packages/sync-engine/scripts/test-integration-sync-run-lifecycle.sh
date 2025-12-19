#!/bin/bash

# Integration test for sync run lifecycle
# Verifies sync_runs view and _sync_runs table stay in sync
# Tests that object runs are created upfront to prevent premature close

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine - Sync Run Lifecycle Test"
echo "================================================"
echo ""

# Check for required tools
check_required_tools jq

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-lifecycle-test" "app_db"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    stop_postgres "stripe-sync-lifecycle-test"
    rm -f /tmp/test-sync-lifecycle.js 2>/dev/null || true
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
if ! node dist/cli/index.js migrate 2>&1; then
    echo "❌ Migrations failed"
    exit 1
fi
echo "✓ Migrations completed"
echo ""

# Step 3: Create test script
echo "🧪 Step 3: Testing sync run lifecycle..."
cat > /tmp/test-sync-lifecycle.js << 'EOJS'
const path = require('path');
const { StripeSync } = require(path.join(process.cwd(), 'dist/index.js'));

async function testSyncRunLifecycle() {
  const sync = new StripeSync({
    databaseUrl: process.env.DATABASE_URL,
    stripeSecretKey: process.env.STRIPE_API_KEY,
  });

  try {
    console.log('Test: Sync run lifecycle and object run creation');
    console.log('================================================');
    console.log('');

    // Test 1: Join or create sync run
    console.log('Test 1: Create sync run via joinOrCreateSyncRun');
    const { runKey, objects } = await sync.joinOrCreateSyncRun('test');
    console.log(`✓ Run created with ${objects.length} objects to sync`);
    console.log('');

    // Test 2: Check object runs were created upfront to prevent premature close
    console.log('Test 2: Verify object runs created upfront (prevents premature close)');
    const objectRunsResult = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const objectRunCount = parseInt(objectRunsResult.rows[0].count);

    if (objectRunCount !== objects.length) {
      console.error(`❌ FAILED: Expected ${objects.length} object runs, found ${objectRunCount}`);
      console.error('   Object runs were not created upfront');
      console.error('   This causes PREMATURE CLOSE BUG during backfill:');
      console.error('   - Worker calls joinOrCreateSyncRun, gets list of objects');
      console.error('   - If object runs created on-demand (bug), only 1 exists after first completes');
      console.error('   - areAllObjectsComplete() returns true (only sees that 1 object)');
      console.error('   - Run auto-closes even though 16 objects still need syncing');
      console.error('   - UI shows "All up to date" but backfill incomplete');
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ All ${objectRunCount} object runs created upfront`);
    console.log('  This prevents premature close during backfill');
    console.log('');

    // Test 3: Check sync_runs view matches _sync_runs table and getActiveSyncRun
    console.log('Test 3: Verify sync_runs view matches _sync_runs table');

    // Use StripeSync method to get active run
    const activeRun = await sync.postgresClient.getActiveSyncRun(runKey.accountId);
    if (!activeRun) {
      console.error('❌ FAILED: getActiveSyncRun returned null but run should be active');
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    // Verify it's the same run we created
    if (activeRun.runStartedAt.getTime() !== runKey.runStartedAt.getTime()) {
      console.error('❌ FAILED: getActiveSyncRun returned different run');
      console.error(`   Expected: ${runKey.runStartedAt}`);
      console.error(`   Got: ${activeRun.runStartedAt}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ getActiveSyncRun returns correct run`);

    // Now check view vs table
    const viewResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, total_objects FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const tableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );

    const viewData = viewResult.rows[0];
    const tableData = tableResult.rows[0];

    if ((viewData.closed_at === null) !== (tableData.closed_at === null)) {
      console.error('❌ FAILED: sync_runs view and _sync_runs table out of sync');
      console.error(`   View closed_at: ${viewData.closed_at}`);
      console.error(`   Table closed_at: ${tableData.closed_at}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ View and table in sync: closed_at=${viewData.closed_at || 'NULL'}`);
    console.log(`   View shows: status=${viewData.status}, total_objects=${viewData.total_objects}`);
    console.log('');

    // Test 4: Process first object and verify run stays open with correct counts
    console.log('Test 4: Process first object and verify state');
    let hasMore = true;
    while (hasMore) {
      const result = await sync.processNext(objects[0], { runStartedAt: runKey.runStartedAt });
      hasMore = result.hasMore;
    }
    console.log(`✓ First object processed: ${objects[0]}`);

    // Check state after first object completion
    const afterFirstResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const afterFirst = afterFirstResult.rows[0];

    // Verify exact state (convert to numbers since PG may return bigints as strings)
    const completeCount = parseInt(afterFirst.complete_count);
    const totalObjects = parseInt(afterFirst.total_objects);
    const pendingCount = parseInt(afterFirst.pending_count);

    if (completeCount !== 1) {
      console.error('');
      console.error(`❌ FAILED: Expected complete_count=1, got ${completeCount}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    if (totalObjects !== objects.length) {
      console.error('');
      console.error(`❌ FAILED: Expected total_objects=${objects.length}, got ${totalObjects}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    if (afterFirst.closed_at !== null) {
      console.error('');
      console.error('❌ FAILED: PREMATURE CLOSE BUG DETECTED!');
      console.error(`   Run closed after only first object completed`);
      console.error(`   State: ${completeCount}/${totalObjects} complete, ${pendingCount} pending`);
      console.error('');
      console.error('   ROOT CAUSE: Object runs were created on-demand instead of upfront');
      console.error('   SYMPTOM: areAllObjectsComplete() only saw 1 object run, thought sync was done');
      console.error('   IMPACT: Remaining ${totalObjects - 1} objects will not be synced');
      console.error('   USER SEES: UI shows "All up to date" but backfill is incomplete');
      console.error('');
      console.error('   This is the exact bug reported - run closes before backfill finishes.');
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    console.log(`✓ Correct state after first object (NO PREMATURE CLOSE):`);
    console.log(`   - complete_count: 1/${totalObjects} ✓`);
    console.log(`   - pending_count: ${pendingCount} ✓`);
    console.log(`   - closed_at: NULL ✓ (run stays open as expected)`);
    console.log('');
    console.log('  ✓ Premature close bug prevented - run will stay open until all objects done');
    console.log('');

    // Test 5: Complete all remaining objects and verify final state
    console.log('Test 5: Complete all objects and verify final state');
    for (let i = 1; i < objects.length; i++) {
      hasMore = true;
      while (hasMore) {
        const result = await sync.processNext(objects[i], { runStartedAt: runKey.runStartedAt });
        hasMore = result.hasMore;
      }
    }
    console.log(`✓ All ${objects.length} objects processed`);

    // Check final state
    const finalResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const finalState = finalResult.rows[0];

    // Verify run closed properly (convert to numbers)
    const finalCompleteCount = parseInt(finalState.complete_count);
    const finalTotalObjects = parseInt(finalState.total_objects);
    const finalPendingCount = parseInt(finalState.pending_count);

    if (finalState.closed_at === null) {
      console.error('');
      console.error('❌ FAILED: Run did not close after all objects completed');
      console.error(`   State: ${finalCompleteCount}/${finalTotalObjects} complete`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    if (finalState.status !== 'complete') {
      console.error('');
      console.error(`❌ FAILED: Expected status='complete', got '${finalState.status}'`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    if (finalCompleteCount !== objects.length) {
      console.error('');
      console.error(`❌ FAILED: Expected ${objects.length} complete, got ${finalCompleteCount}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    if (finalPendingCount !== 0) {
      console.error('');
      console.error(`❌ FAILED: Expected 0 pending, got ${finalPendingCount}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    console.log(`✓ Correct final state:`);
    console.log(`   - status: ${finalState.status} ✓`);
    console.log(`   - complete_count: ${finalCompleteCount}/${finalTotalObjects} ✓`);
    console.log(`   - pending_count: ${finalPendingCount} ✓`);
    console.log(`   - closed_at: SET ✓`);
    console.log('');

    // Verify view and table still in sync at end
    const finalTableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const finalTableData = finalTableResult.rows[0];

    if (finalTableData.closed_at === null) {
      console.error('');
      console.error('❌ FAILED: _sync_runs table shows closed_at=NULL but view shows it closed');
      await sync.postgresClient.pool.end();
      process.exit(1);
    }

    console.log(`✓ View and table in sync at completion`);
    console.log('');

    // Test 6: Start a new run and verify it doesn't interfere with previous run
    console.log('Test 6: Start second run and verify isolation');
    const { runKey: runKey2, objects: objects2 } = await sync.joinOrCreateSyncRun('test-second-run');

    // Verify new run created (different started_at)
    if (runKey2.runStartedAt.getTime() === runKey.runStartedAt.getTime()) {
      console.error('');
      console.error('❌ FAILED: Second run has same started_at as first run');
      console.error('   Runs should be separate');
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ New run created with different timestamp`);

    // Verify object runs created for new run
    const run2ObjectsResult = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey2.accountId, runKey2.runStartedAt]
    );
    const run2ObjectCount = parseInt(run2ObjectsResult.rows[0].count);

    if (run2ObjectCount !== objects2.length) {
      console.error('');
      console.error(`❌ FAILED: Second run should have ${objects2.length} object runs, got ${run2ObjectCount}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ Second run has ${run2ObjectCount} object runs created`);

    // Verify first run still shows as complete and hasn't changed
    const run1CheckResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, complete_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    );
    const run1Check = run1CheckResult.rows[0];
    const run1CompleteCount = parseInt(run1Check.complete_count);

    if (run1Check.closed_at === null || run1Check.status !== 'complete') {
      console.error('');
      console.error('❌ FAILED: First run state changed after second run created');
      console.error(`   Expected: closed and complete`);
      console.error(`   Got: closed_at=${run1Check.closed_at}, status=${run1Check.status}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ First run unchanged (status=${run1Check.status}, complete_count=${run1CompleteCount})`);

    // Verify we can see both runs in the view
    const allRunsResult = await sync.postgresClient.pool.query(
      `SELECT account_id, started_at, status FROM stripe.sync_runs
       WHERE account_id = $1
       ORDER BY started_at`,
      [runKey.accountId]
    );

    if (allRunsResult.rows.length !== 2) {
      console.error('');
      console.error(`❌ FAILED: Expected 2 runs in view, got ${allRunsResult.rows.length}`);
      await sync.postgresClient.pool.end();
      process.exit(1);
    }
    console.log(`✓ Both runs visible in sync_runs view`);
    console.log('');

    console.log('================================================');
    console.log('✅ ALL TESTS PASSED');
    console.log('');
    console.log('Verified:');
    console.log('- Object runs created upfront (not on-demand)');
    console.log('- sync_runs view matches _sync_runs table');
    console.log('- Run stays open until all objects complete');
    console.log('- Run closes properly with correct status');
    console.log('- View and table stay in sync throughout lifecycle');
    console.log('- Multiple runs can exist without interference');
    console.log('');

    await sync.postgresClient.pool.end();
    process.exit(0);

  } catch (error) {
    console.error('');
    console.error('❌ Test error:', error.message);
    console.error(error.stack);
    await sync.postgresClient.pool.end();
    process.exit(1);
  }
}

testSyncRunLifecycle();
EOJS

# Run the test
cd "$SCRIPT_DIR/.."
node /tmp/test-sync-lifecycle.js
TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -ne 0 ]; then
    echo ""
    echo "❌ SYNC RUN LIFECYCLE TEST FAILED"
    echo ""
    exit 1
fi
