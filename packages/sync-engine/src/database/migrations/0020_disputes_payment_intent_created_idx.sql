ALTER TABLE "{{schema}}"."disputes" ADD COLUMN IF NOT EXISTS payment_intent TEXT;

CREATE INDEX IF NOT EXISTS stripe_dispute_created_idx ON "{{schema}}"."disputes" USING btree (created);