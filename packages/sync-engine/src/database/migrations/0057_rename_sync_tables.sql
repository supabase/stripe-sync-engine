-- Rename sync observability tables and create public sync_runs view
-- Internal tables use _ prefix, public view is sync_runs

-- Step 1: Drop the old sync_dashboard view
DROP VIEW IF EXISTS "stripe"."sync_dashboard";

-- Step 2: Rename tables to plural (keep _ prefix for internal tables)
ALTER TABLE "stripe"."_sync_run" RENAME TO "_sync_runs";
ALTER TABLE "stripe"."_sync_obj_run" RENAME TO "_sync_obj_runs";

-- Step 3: Update foreign key constraint name
ALTER TABLE "stripe"."_sync_obj_runs"
  DROP CONSTRAINT IF EXISTS fk_sync_obj_run_parent;

ALTER TABLE "stripe"."_sync_obj_runs"
  ADD CONSTRAINT fk_sync_obj_runs_parent
    FOREIGN KEY ("_account_id", run_started_at)
    REFERENCES "stripe"."_sync_runs" ("_account_id", started_at);

-- Step 4: Recreate indexes with new table names
DROP INDEX IF EXISTS "stripe"."idx_sync_run_account_status";
DROP INDEX IF EXISTS "stripe"."idx_sync_obj_run_status";

CREATE INDEX idx_sync_runs_account_status
  ON "stripe"."_sync_runs" ("_account_id", closed_at);

CREATE INDEX idx_sync_obj_runs_status
  ON "stripe"."_sync_obj_runs" ("_account_id", run_started_at, status);

-- Step 5: Create public sync_runs view (one row per run with aggregates)
CREATE VIEW "stripe"."sync_runs" AS
SELECT
  r._account_id as account_id,
  r.started_at,
  r.closed_at,
  r.triggered_by,
  r.max_concurrent,
  -- Aggregate metrics from child objects
  COALESCE(SUM(o.processed_count), 0) as total_processed,
  COUNT(o.*) as total_objects,
  COUNT(*) FILTER (WHERE o.status = 'complete') as complete_count,
  COUNT(*) FILTER (WHERE o.status = 'error') as error_count,
  COUNT(*) FILTER (WHERE o.status = 'running') as running_count,
  COUNT(*) FILTER (WHERE o.status = 'pending') as pending_count,
  -- Collect error messages if any
  STRING_AGG(o.error_message, '; ') FILTER (WHERE o.error_message IS NOT NULL) as error_message,
  -- Derive overall status from run state and object states
  CASE
    WHEN r.closed_at IS NULL THEN 'running'
    WHEN COUNT(*) FILTER (WHERE o.status = 'error') > 0 THEN 'error'
    ELSE 'complete'
  END as status
FROM "stripe"."_sync_runs" r
LEFT JOIN "stripe"."_sync_obj_runs" o
  ON o._account_id = r._account_id
  AND o.run_started_at = r.started_at
GROUP BY r._account_id, r.started_at, r.closed_at, r.triggered_by, r.max_concurrent;
