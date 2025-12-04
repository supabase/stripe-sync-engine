ALTER TABLE IF EXISTS "{{schema}}"."products" ADD COLUMN IF NOT EXISTS marketing_features JSONB;

