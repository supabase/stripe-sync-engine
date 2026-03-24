import { sql } from '@stripe/util-postgres'

export default sql`
-- Drop unused Stripe metadata objects.
-- Keeps: _sync_runs table, sync_runs view (used by Supabase edge functions).

-- Drop views that reference tables being removed
DROP VIEW IF EXISTS {{sync_schema}}."sync_obj_progress";
DROP VIEW IF EXISTS {{sync_schema}}."sync_runs";

-- Recreate sync_runs view without _sync_obj_runs dependency
CREATE VIEW {{sync_schema}}."sync_runs" AS
SELECT
  r."_account_id" as account_id,
  r.started_at,
  r.closed_at,
  r.triggered_by,
  r.max_concurrent,
  r.error_message,
  CASE
    WHEN r.closed_at IS NULL THEN 'running'
    WHEN r.error_message IS NOT NULL THEN 'error'
    ELSE 'complete'
  END as status
FROM {{sync_schema}}."_sync_runs" r;

-- Drop FK from _sync_runs → accounts (accounts is being removed)
ALTER TABLE {{sync_schema}}."_sync_runs"
  DROP CONSTRAINT IF EXISTS "fk_sync_runs_account";

-- Drop tables with FKs first, then their targets
DROP TABLE IF EXISTS {{sync_schema}}."_sync_obj_runs";
DROP TABLE IF EXISTS {{sync_schema}}."_managed_webhooks";
DROP TABLE IF EXISTS {{sync_schema}}."accounts";

-- Drop rate limiting (superseded by util-postgres token bucket)
DROP FUNCTION IF EXISTS {{sync_schema}}.check_rate_limit(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS {{sync_schema}}."_rate_limits";
`
