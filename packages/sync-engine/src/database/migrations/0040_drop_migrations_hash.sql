-- Remove legacy hash column from pg-node-migrations (checksums no longer validated)

ALTER TABLE "{{schema}}"."migrations" DROP COLUMN IF EXISTS hash;
