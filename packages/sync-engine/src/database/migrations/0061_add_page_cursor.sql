-- Add page_cursor column for pagination state within a single sync run.
-- This is used to store the starting_after ID for backfills using Stripe list calls.
ALTER TABLE "stripe"."_sync_obj_runs" ADD COLUMN IF NOT EXISTS page_cursor text;
