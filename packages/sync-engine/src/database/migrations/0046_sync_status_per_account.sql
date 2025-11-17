-- Add _account_id to _sync_status table to track sync cursors per account
-- This enables proper cursor isolation when syncing multiple Stripe accounts
--
-- Breaking change: All existing cursor data will be deleted (clean slate)
-- Next sync will perform a full backfill for each account

-- Step 1: Delete all existing cursor data
DELETE FROM "stripe"."_sync_status";

-- Step 2: Add _account_id column
ALTER TABLE "stripe"."_sync_status" ADD COLUMN "_account_id" TEXT NOT NULL;

-- Step 3: Drop existing unique constraint on resource
ALTER TABLE "stripe"."_sync_status" DROP CONSTRAINT IF EXISTS _sync_status_resource_key;

-- Step 4: Add new composite unique constraint on (resource, _account_id)
ALTER TABLE "stripe"."_sync_status"
  ADD CONSTRAINT _sync_status_resource_account_key
  UNIQUE (resource, "_account_id");

-- Step 5: Add index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_sync_status_resource_account
  ON "stripe"."_sync_status" (resource, "_account_id");

-- Step 6: Create accounts table to track Stripe accounts (JSONB with generated columns)
CREATE TABLE IF NOT EXISTS "stripe"."accounts" (
  id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  first_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Generated columns extracted from raw_data
  business_name TEXT GENERATED ALWAYS AS ((raw_data->'business_profile'->>'name')::text) STORED,
  email TEXT GENERATED ALWAYS AS ((raw_data->>'email')::text) STORED,
  type TEXT GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED,
  charges_enabled BOOLEAN GENERATED ALWAYS AS ((raw_data->>'charges_enabled')::boolean) STORED,
  payouts_enabled BOOLEAN GENERATED ALWAYS AS ((raw_data->>'payouts_enabled')::boolean) STORED,
  details_submitted BOOLEAN GENERATED ALWAYS AS ((raw_data->>'details_submitted')::boolean) STORED,
  country TEXT GENERATED ALWAYS AS ((raw_data->>'country')::text) STORED,
  default_currency TEXT GENERATED ALWAYS AS ((raw_data->>'default_currency')::text) STORED,
  created INTEGER GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED
);

-- Step 7: Add index for account name lookups
CREATE INDEX IF NOT EXISTS idx_accounts_business_name
  ON "stripe"."accounts" (business_name);

-- Step 8: Add updated_at trigger for accounts
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."accounts"
  FOR EACH ROW
  EXECUTE PROCEDURE set_updated_at();

-- Step 9: Backfill accounts from existing data tables
INSERT INTO "stripe"."accounts" (id, raw_data, first_synced_at, last_synced_at)
SELECT DISTINCT
  "_account_id" as id,
  jsonb_build_object('id', "_account_id", 'type', 'unknown') as raw_data,
  now() as first_synced_at,
  now() as last_synced_at
FROM "stripe"."products"
WHERE "_account_id" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Step 10: Add foreign key constraints from data tables to accounts
ALTER TABLE "stripe"."active_entitlements" ADD CONSTRAINT fk_active_entitlements_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."charges" ADD CONSTRAINT fk_charges_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."checkout_session_line_items" ADD CONSTRAINT fk_checkout_session_line_items_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."checkout_sessions" ADD CONSTRAINT fk_checkout_sessions_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."credit_notes" ADD CONSTRAINT fk_credit_notes_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."customers" ADD CONSTRAINT fk_customers_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."disputes" ADD CONSTRAINT fk_disputes_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."early_fraud_warnings" ADD CONSTRAINT fk_early_fraud_warnings_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."features" ADD CONSTRAINT fk_features_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."invoices" ADD CONSTRAINT fk_invoices_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."_managed_webhooks" ADD CONSTRAINT fk_managed_webhooks_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."payment_intents" ADD CONSTRAINT fk_payment_intents_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."payment_methods" ADD CONSTRAINT fk_payment_methods_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."plans" ADD CONSTRAINT fk_plans_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."prices" ADD CONSTRAINT fk_prices_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."products" ADD CONSTRAINT fk_products_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."refunds" ADD CONSTRAINT fk_refunds_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."reviews" ADD CONSTRAINT fk_reviews_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."setup_intents" ADD CONSTRAINT fk_setup_intents_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscription_items" ADD CONSTRAINT fk_subscription_items_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscription_schedules" ADD CONSTRAINT fk_subscription_schedules_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscriptions" ADD CONSTRAINT fk_subscriptions_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."tax_ids" ADD CONSTRAINT fk_tax_ids_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

-- Step 11: Add foreign key from _sync_status to accounts
ALTER TABLE "stripe"."_sync_status" ADD CONSTRAINT fk_sync_status_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
