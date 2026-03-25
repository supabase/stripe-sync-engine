import { sql } from '@stripe/sync-util-postgres'

export default sql`
-- Generic sync state: per-stream cursor state keyed by sync_id.

CREATE TABLE IF NOT EXISTS {{sync_schema}}."_sync_state" (
  sync_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (sync_id, stream)
);
`
