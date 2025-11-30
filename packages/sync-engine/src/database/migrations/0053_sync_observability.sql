-- Observable Sync System: Track sync runs and individual object syncs
-- Enables observability for long-running syncs (days, not minutes)
--
-- Two-level hierarchy:
--   _sync_run: Parent sync operation (one active per account)
--   _sync_obj_run: Individual object syncs within a run
--
-- Features:
--   - Only one active run per account (EXCLUDE constraint)
--   - Configurable object concurrency (max_concurrent)
--   - Stale detection (is_stale in dashboard view)
--   - Progress tracking per object

-- Step 1: Create _sync_run table (parent sync operation)
CREATE TABLE IF NOT EXISTS "stripe"."_sync_run" (
  "_account_id" TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'error')),
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  triggered_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY ("_account_id", started_at),

  -- Only one active run per account
  CONSTRAINT one_active_run_per_account
    EXCLUDE ("_account_id" WITH =) WHERE (status = 'running'),

  -- Foreign key to accounts table
  CONSTRAINT fk_sync_run_account
    FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id)
);

-- Step 2: Add updated_at trigger for _sync_run
-- Use set_updated_at_metadata() since this is a metadata table with updated_at (not _updated_at)
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."_sync_run"
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at_metadata();

-- Step 3: Create _sync_obj_run table (individual object syncs)
CREATE TABLE IF NOT EXISTS "stripe"."_sync_obj_run" (
  "_account_id" TEXT NOT NULL,
  run_started_at TIMESTAMPTZ NOT NULL,
  object TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'error')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  processed_count INTEGER DEFAULT 0,
  cursor TEXT,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY ("_account_id", run_started_at, object),

  -- Foreign key to parent sync run
  CONSTRAINT fk_sync_obj_run_parent
    FOREIGN KEY ("_account_id", run_started_at) REFERENCES "stripe"."_sync_run" ("_account_id", started_at)
);

-- Step 4: Add updated_at trigger for _sync_obj_run
-- Use set_updated_at_metadata() since this is a metadata table with updated_at (not _updated_at)
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."_sync_obj_run"
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at_metadata();

-- Step 5: Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_sync_run_account_status
  ON "stripe"."_sync_run" ("_account_id", status);

CREATE INDEX IF NOT EXISTS idx_sync_obj_run_status
  ON "stripe"."_sync_obj_run" ("_account_id", run_started_at, status);

-- Step 6: Create sync_dashboard view for observability
CREATE OR REPLACE VIEW "stripe"."sync_dashboard" AS
SELECT
  r."_account_id" as account_id,
  r.started_at as run_started_at,
  r.status as run_status,
  r.completed_at as run_completed_at,
  r.max_concurrent,
  r.triggered_by,
  o.object,
  o.status as object_status,
  o.started_at as object_started_at,
  o.completed_at as object_completed_at,
  o.processed_count,
  o.error_message,
  o.updated_at,
  -- Duration in seconds
  EXTRACT(EPOCH FROM (COALESCE(o.completed_at, now()) - o.started_at))::integer as duration_seconds,
  -- Stale detection: running but no update in 5 min
  CASE
    WHEN o.status = 'running' AND o.updated_at < now() - interval '5 minutes'
    THEN true
    ELSE false
  END as is_stale
FROM "stripe"."_sync_run" r
LEFT JOIN "stripe"."_sync_obj_run" o
  ON o."_account_id" = r."_account_id"
  AND o.run_started_at = r.started_at;
