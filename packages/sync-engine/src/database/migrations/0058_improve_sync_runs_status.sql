-- Improve sync_runs view status logic
-- More granular status based on actual object run states

DROP VIEW IF EXISTS "stripe"."sync_runs";

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
    -- Run still open (closed_at IS NULL)
    WHEN r.closed_at IS NULL AND COUNT(*) FILTER (WHERE o.status = 'running') > 0 THEN 'running'
    WHEN r.closed_at IS NULL AND (COUNT(o.*) = 0 OR COUNT(o.*) = COUNT(*) FILTER (WHERE o.status = 'pending')) THEN 'pending'
    WHEN r.closed_at IS NULL THEN 'running'
    -- Run closed (closed_at IS NOT NULL)
    WHEN COUNT(*) FILTER (WHERE o.status = 'error') > 0 THEN 'error'
    ELSE 'complete'
  END as status
FROM "stripe"."_sync_runs" r
LEFT JOIN "stripe"."_sync_obj_runs" o
  ON o._account_id = r._account_id
  AND o.run_started_at = r.started_at
GROUP BY r._account_id, r.started_at, r.closed_at, r.triggered_by, r.max_concurrent;
