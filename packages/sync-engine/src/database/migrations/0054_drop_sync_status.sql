-- Drop the old _sync_status table
-- This table has been replaced by _sync_run and _sync_obj_run for better observability
-- See migration 0053_sync_observability.sql

DROP TABLE IF EXISTS "stripe"."_sync_status";
