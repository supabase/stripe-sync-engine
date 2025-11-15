-- Create _sync_status metadata table for tracking incremental sync cursors
-- This table tracks the state and progress of each resource's synchronization

CREATE TABLE IF NOT EXISTS "stripe"."_sync_status" (
  id serial PRIMARY KEY,
  resource text UNIQUE NOT NULL,
  status text CHECK (status IN ('idle', 'running', 'complete', 'error')) DEFAULT 'idle',
  last_synced_at timestamptz DEFAULT now(),
  last_incremental_cursor timestamptz,
  error_message text,
  updated_at timestamptz DEFAULT now()
);

-- Use existing set_updated_at() function created in migration 0012
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."_sync_status"
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();
