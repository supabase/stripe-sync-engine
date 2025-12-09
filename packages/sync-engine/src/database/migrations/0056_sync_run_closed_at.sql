-- Add closed_at column to _sync_run
-- closed_at IS NULL means the run is still active
-- Status is derived from object states when closed_at IS NOT NULL

-- Step 1: Drop dependent view first
DROP VIEW IF EXISTS "stripe"."sync_dashboard";

-- Step 2: Drop the old constraint, status column, and completed_at column
ALTER TABLE "stripe"."_sync_run" DROP CONSTRAINT IF EXISTS one_active_run_per_account;
ALTER TABLE "stripe"."_sync_run" DROP COLUMN IF EXISTS status;
ALTER TABLE "stripe"."_sync_run" DROP COLUMN IF EXISTS completed_at;

-- Step 3: Add closed_at column
ALTER TABLE "stripe"."_sync_run" ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Step 4: Create exclusion constraint (only one active run per account)
ALTER TABLE "stripe"."_sync_run"
ADD CONSTRAINT one_active_run_per_account
EXCLUDE ("_account_id" WITH =) WHERE (closed_at IS NULL);

-- Step 5: Recreate sync_dashboard view (run-level only, one row per run)
-- Base table: _sync_run (parent sync operation)
-- Child table: _sync_obj_run (individual object syncs)
CREATE OR REPLACE VIEW "stripe"."sync_dashboard" AS
SELECT
  run."_account_id" as account_id,
  run.started_at,
  run.closed_at,
  run.max_concurrent,
  run.triggered_by,
  run.updated_at,
  -- Derived status from object states
  CASE
    WHEN run.closed_at IS NULL THEN 'running'
    WHEN EXISTS (
      SELECT 1 FROM "stripe"."_sync_obj_run" obj
      WHERE obj."_account_id" = run."_account_id"
        AND obj.run_started_at = run.started_at
        AND obj.status = 'error'
    ) THEN 'error'
    ELSE 'complete'
  END as status,
  -- First error message from failed objects
  (SELECT obj.error_message FROM "stripe"."_sync_obj_run" obj
   WHERE obj."_account_id" = run."_account_id"
     AND obj.run_started_at = run.started_at
     AND obj.status = 'error'
   ORDER BY obj.object LIMIT 1) as error_message,
  -- Total processed count across all objects
  COALESCE((SELECT SUM(obj.processed_count) FROM "stripe"."_sync_obj_run" obj
   WHERE obj."_account_id" = run."_account_id"
     AND obj.run_started_at = run.started_at), 0) as processed_count
FROM "stripe"."_sync_run" run;
